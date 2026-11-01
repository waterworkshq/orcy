/**
 * Deterministic interleave at the REAL route seam (PR158 review, critical
 * finding): the human retry route fetches the task, then AWAITS
 * `authorizeTaskAccess` (membership check), then admits + writes off the
 * FETCHED snapshot. That await is the only interleave window inside one
 * request — the sequential race tests in `rejectedManualRetryRecovery.test.ts`
 * cannot reach it. Here the membership middleware is wrapped (vi.mock,
 * transparent passthrough) to run the rejected owner's rework restart
 * (`startTask`: rejected→in_progress, minting a FRESH epoch token, #150/#158
 * semantics) exactly inside that window, between the route's fetch and the
 * custody-ending writer.
 *
 * Nothing else is mocked: real app assembly, real writer, real budget meter.
 * The writer's in-transaction preimage CAS (status+version pinned from the
 * request's own read) must refuse with ZERO effects — the restarted owner's
 * epoch, ownership, status and retryCount survive byte-identical.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import * as taskService from "../services/tasks/index.js";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import { addMember } from "../repositories/teamMember.js";
import { getEventsByTaskId } from "../repositories/event.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import type { Task } from "../models/index.js";

// Armed per-test by taskId; consumed once (shared vi.mock state must not
// leak between tests — the wrapper is a no-op when unarmed).
let armed: { taskId: string; agentId: string; token: string } | null = null;
let interleaveResult: Task | null = null;

vi.mock("../middleware/realtimeAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/realtimeAuth.js")>();
  return {
    ...actual,
    authorizeTaskAccess: async (
      request: Parameters<typeof actual.authorizeTaskAccess>[0],
      taskId: string,
    ) => {
      const habitatId = await actual.authorizeTaskAccess(request, taskId);
      if (armed && armed.taskId === taskId) {
        const shot = armed;
        armed = null;
        // The concurrent owner restart, INSIDE the route's await window.
        // Dynamic import: the vi.mock factory must not close over bindings
        // that are still in TDZ at module-graph init time.
        const svc = await import("../services/tasks/index.js");
        interleaveResult = svc.startTask(shot.taskId, shot.agentId, shot.token);
      }
      return habitatId;
    },
  };
});

const ESCALATING = {
  maxRetries: 0,
  escalateToHuman: true,
  retryOnStatuses: ["all"],
};

let app: HttpRuntimeHandle;
let habitatId: string;
let columnId: string;
let ownerAgentId: string;
let adminJwt: string;

function signHumanJwt(sub: string, role: string): string {
  return jwt.sign({ sub, username: sub, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

function seedAgent(name: string): { id: string; key: string } {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  return { id: created.agent.id, key: created.plainApiKey };
}

function seedEscalatedRejectedTask(title: string, agentId: string): { taskId: string; token: string } {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "seed",
  });
  const taskId = taskRepo.createTask({ missionId: mission.id, title, createdBy: "seed" }).id;
  taskRepo.updateTask(taskId, { retryPolicy: ESCALATING });
  const claim = taskService.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const token = taskRepo.getTaskById(taskId)!.executionToken;
  expect(token).not.toBeNull();
  expect(taskService.startTask(taskId, agentId, token)?.status).toBe("in_progress");
  expect(taskService.submitTask(taskId, agentId, "first result", [], token).task).not.toBeNull();
  expect(taskService.rejectTask(taskId, "rev", "needs work", "human")).not.toBeNull();
  const after = taskRepo.getTaskById(taskId)!;
  expect(after.status).toBe("rejected");
  expect(after.assignedAgentId).toBe(agentId);
  return { taskId, token: token as string };
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  const org = orgRepo.createOrganization({ name: "rmi-org", slug: "rmi-org" });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "rmi-team", slug: "rmi-team" });
  const habitat = habitatRepo.createHabitat({ name: "rmi-habitat", teamId: team.id });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false }).id;

  addMember({ teamId: team.id, userId: "rmi-admin" });
  adminJwt = signHumanJwt("rmi-admin", "admin");

  const owner = seedAgent("rmi-owner");
  ownerAgentId = owner.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
  pluginManager.resetPlugins();
});

beforeEach(() => {
  armed = null;
  interleaveResult = null;
});

describe("deterministic interleave at the route's authorizeTaskAccess await (critical race)", () => {
  it("owner restart lands between fetch and writer → HTTP retry refuses 409 with ZERO effects", async () => {
    const { taskId, token } = seedEscalatedRejectedTask("interleave-restart-first", ownerAgentId);
    const preRestart = taskRepo.getTaskById(taskId)!;

    // Arm the window: when the retry route awaits membership auth, the owner
    // restarts rework — rejected→in_progress, minting a FRESH epoch token.
    armed = { taskId, agentId: ownerAgentId, token };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/retry`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });

    // The restart really happened inside the window (fresh epoch, version
    // bump) — the route then evaluated admission off a STALE snapshot, which
    // is exactly what the writer's in-tx CAS must catch.
    expect(interleaveResult?.status).toBe("in_progress");
    const mintedToken = interleaveResult!.executionToken;
    expect(mintedToken).not.toBeNull();
    expect(mintedToken).not.toBe(token);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code?: string; details?: { expectedStatus: string } };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.details?.expectedStatus).toBe("rejected");

    // ZERO effects: the restarted owner's custody is byte-identical to the
    // moment the interleave fired — status, owner, minted epoch token,
    // retryCount, version (no second bump), and no retry_executed event.
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("in_progress");
    expect(after.assignedAgentId).toBe(ownerAgentId);
    expect(after.executionToken).toBe(mintedToken);
    expect(after.retryCount).toBe(preRestart.retryCount);
    expect(after.version).toBe(interleaveResult!.version);
    expect(
      getEventsByTaskId(taskId).events.filter((e) => e.action === "retry_executed").length,
    ).toBe(0);
  });

  it("opposite order: retry commits, replacement claims, the stale owner's old token is refused", async () => {
    const { taskId, token } = seedEscalatedRejectedTask("interleave-retry-first", ownerAgentId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/retry`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect(interleaveResult).toBeNull(); // wrapper stayed transparent

    // The replacement owner claims through the ordinary lane and gets its own
    // fresh epoch.
    const replacement = seedAgent("rmi-replacement");
    expect(taskService.claimTask(taskId, replacement.id).success).toBe(true);
    const claimed = taskRepo.getTaskById(taskId)!;
    expect(claimed.assignedAgentId).toBe(replacement.id);
    expect(claimed.executionToken).not.toBeNull();
    expect(claimed.executionToken).not.toBe(token);

    // The stranded prior owner's stale-epoch restart is refused (identity
    // mismatch AND epoch mismatch) — no custody theft, no second reset.
    expect(taskService.startTask(taskId, ownerAgentId, token)).toBeNull();
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.assignedAgentId).toBe(replacement.id);
    expect(after.executionToken).toBe(claimed.executionToken);
  });
});
