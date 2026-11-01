/**
 * The budget-of-2 headroom must live INSIDE the retry writer's BEGIN
 * IMMEDIATE — atomically with the meter count it reads (PR158 round-2 review
 * F1). A read-only preflight outside the writer cannot guarantee it: in the
 * window where the preflight allows (count = ceiling-2) a concurrent metered
 * commit on the shared SQLite file moves the count to ceiling-1, the legacy
 * required-1 guard still allows, the retry consumes the final slot, and the
 * replacement claim is refused — the exact custody-ended-but-unclaimable
 * strand this finding exists to prevent.
 *
 * The mid-window committer is simulated deterministically by inserting ONE
 * metered `task_events` row (`released`, agent actor) between admission and
 * the writer — the same stand-in the round-2 reviewer's reproducer used.
 * After the in-writer fix the attempts must flip to the typed refusal with
 * ZERO effects and the last slot stays reserved for the replacement claim.
 *
 * Also pins the #152-compatible typed wire for BOTH lanes (409
 * TRANSITION_BUDGET_EXHAUSTED, details {category, count, ceiling}) — one
 * vocabulary for the operation, no parallel union.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import * as taskService from "../services/tasks/index.js";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import { addMember } from "../repositories/teamMember.js";
import { createEvent, getEventsByTaskId } from "../repositories/event.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import { RetryTransitionBudgetRefusedError } from "../repositories/retryBudgetRefusal.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";

// HTTP-level mid-window arm: when armed, the route's authorizeTaskAccess
// await commits one extra metered row for the task — exactly what a second
// connection does in the preflight→writer window.
let armedInsert: { taskId: string } | null = null;

vi.mock("../middleware/realtimeAuth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/realtimeAuth.js")>();
  return {
    ...actual,
    authorizeTaskAccess: async (
      request: Parameters<typeof actual.authorizeTaskAccess>[0],
      taskId: string,
    ) => {
      const habitatId = await actual.authorizeTaskAccess(request, taskId);
      if (armedInsert && armedInsert.taskId === taskId) {
        armedInsert = null;
        createEvent({
          taskId,
          actorType: "agent",
          actorId: "concurrent-committer",
          action: "released",
          fromStatus: "rejected",
          toStatus: "rejected",
        });
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

function seedEscalatedRejectedTask(title: string, agentId: string): string {
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
  expect(taskService.startTask(taskId, agentId, token)?.status).toBe("in_progress");
  expect(taskService.submitTask(taskId, agentId, "first result", [], token).task).not.toBeNull();
  expect(taskService.rejectTask(taskId, "rev", "needs work", "human")).not.toBeNull();
  expect(taskRepo.getTaskById(taskId)!.status).toBe("rejected");
  return taskId;
}

function setCeiling(ceiling: number | null): void {
  getDb()
    .update(habitats)
    .set({ lifecycleSettings: { taskTransitionCeiling: ceiling } })
    .where(eq(habitats.id, habitatId))
    .run();
}

function meteredCount(taskId: string): number {
  return countMeteredTransitions(getDb(), taskId);
}

function retryExecutedCount(taskId: string): number {
  return getEventsByTaskId(taskId).events.filter((e) => e.action === "retry_executed").length;
}

/** One metered row committed by "another connection" — raises the count by 1. */
function commitMeteredRow(taskId: string): void {
  createEvent({
    taskId,
    actorType: "agent",
    actorId: "concurrent-committer",
    action: "released",
    fromStatus: "rejected",
    toStatus: "rejected",
  });
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  const org = orgRepo.createOrganization({ name: "rbs-org", slug: "rbs-org" });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "rbs-team", slug: "rbs-team" });
  const habitat = habitatRepo.createHabitat({ name: "rbs-habitat", teamId: team.id });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false }).id;

  addMember({ teamId: team.id, userId: "rbs-admin" });
  adminJwt = signHumanJwt("rbs-admin", "admin");

  const owner = seedAgent("rbs-owner");
  ownerAgentId = owner.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
  pluginManager.resetPlugins();
});

beforeEach(() => {
  armedInsert = null;
});

describe("in-writer required=2 headroom (atomic with the meter count)", () => {
  it("mid-window metered commit flips the recovery to the typed refusal with zero effects (service level)", async () => {
    const { executeRetryWithOutcome } = await import("../services/retryService.js");
    const taskId = seedEscalatedRejectedTask("seam-service", ownerAgentId);
    const count = meteredCount(taskId);
    expect(count).toBeGreaterThanOrEqual(3);
    setCeiling(count + 2); // preflight window: count = ceiling-2 → admission would allow

    const before = taskRepo.getTaskById(taskId)!;

    // The concurrent commit lands INSIDE the admission→writer window. It
    // does NOT touch the task row, so the CAS preimage stays valid — only
    // the budget headroom moved.
    commitMeteredRow(taskId);
    expect(meteredCount(taskId)).toBe(count + 1); // ceiling-1

    const out = executeRetryWithOutcome(taskRepo.getTaskById(taskId) as never, {
      expected: { status: before.status, version: before.version },
      preserveRejectionReason: true,
      requireClaimHeadroom: true,
    });

    // The in-writer required=2 check must refuse ATOMICICALLY: typed refusal
    // carrying the in-transaction count, and NOTHING written.
    expect(out).toEqual({
      outcome: "refused",
      refusal: { outcome: "refused", reason: "transition_budget_exhausted", count: count + 1, ceiling: count + 2 },
    });

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
    expect(after.version).toBe(before.version);
    expect(after.retryCount).toBe(before.retryCount);
    expect(retryExecutedCount(taskId)).toBe(0);

    // The refused attempt consumed NOTHING: with one more slot granted
    // (operator raises the ceiling by 1), the retry executes and the
    // replacement claim is admitted — the previously reserved slot was
    // genuinely still there (a wrongly-executed reset would have made this
    // claim the refused one).
    setCeiling(count + 3);
    const executed = executeRetryWithOutcome(taskRepo.getTaskById(taskId) as never, {
      expected: { status: before.status, version: before.version },
      preserveRejectionReason: true,
      requireClaimHeadroom: true,
    });
    expect(executed.outcome).toBe("executed");
    const replacement = seedAgent("rbs-claimant-seam");
    const claim = taskService.claimTask(taskId, replacement.id);
    expect(claim.success, JSON.stringify(claim)).toBe(true);

    setCeiling(null);
  });

  it("writer-level: requireClaimHeadroom refuses (null, row unchanged) when only one slot remains", async () => {
    const { retryTransitionToPendingWithEffects } = await import(
      "../repositories/taskStateMachine.js"
    );
    const taskId = seedEscalatedRejectedTask("seam-writer", ownerAgentId);
    const count = meteredCount(taskId);
    setCeiling(count + 1); // exactly one slot remains: required=2 must refuse
    const before = taskRepo.getTaskById(taskId)!;

    // The writer-level contract is the typed THROW (the service layer maps
    // it to the refused outcome); the whole reservation rolls back.
    expect(() =>
      retryTransitionToPendingWithEffects(taskId, before.retryCount + 1, {
        expected: { status: before.status, version: before.version },
        requireClaimHeadroom: true,
      }),
    ).toThrow(RetryTransitionBudgetRefusedError);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.version).toBe(before.version);
    expect(after.assignedAgentId).toBe(ownerAgentId);
    expect(retryExecutedCount(taskId)).toBe(0);

    setCeiling(null);
  });

  it("writer-level control: without requireClaimHeadroom the same one-slot row retries (legacy required=1)", async () => {
    const { retryTransitionToPendingWithEffects } = await import(
      "../repositories/taskStateMachine.js"
    );
    const taskId = seedEscalatedRejectedTask("seam-writer-control", ownerAgentId);
    const count = meteredCount(taskId);
    setCeiling(count + 1); // one slot: required=1 allows
    const before = taskRepo.getTaskById(taskId)!;

    const out = retryTransitionToPendingWithEffects(taskId, before.retryCount + 1, {
      expected: { status: before.status, version: before.version },
    });

    expect(out?.status).toBe("pending");
    setCeiling(null);
  });

  it("HTTP mid-window: the typed 409 answers with #152's exact wire and the last slot stays reserved", async () => {
    const taskId = seedEscalatedRejectedTask("seam-http", ownerAgentId);
    const count = meteredCount(taskId);
    setCeiling(count + 2); // admission (preflight-era) window: ceiling-2

    armedInsert = { taskId };

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/retry`,
      headers: { authorization: `Bearer ${adminJwt}` },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      code?: string;
      details?: { category: string; count: number; ceiling: number };
    };
    expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
    expect(body.details).toMatchObject({
      category: "transition_budget_exhausted",
      ceiling: count + 2,
    });
    expect(body.details!.count).toBe(count + 1);

    // Zero effects: the row is byte-identical to the interleave moment —
    // still the owner's rejected row, nothing consumed by the refusal.
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
    expect(after.executionToken).not.toBeNull();
    expect(retryExecutedCount(taskId)).toBe(0);

    setCeiling(null);
  });
});
