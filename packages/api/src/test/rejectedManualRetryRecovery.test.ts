/**
 * Manual human retry at the rejected lane — the #150 corrective.
 *
 * Context (kody #4430281364 / landed-audit PR-A): an escalated rejected task
 * keeps its owner and continuation token (#137/#150 semantics), so when the
 * owner stops acting the row is unreachable — `startTask` is identity-bound
 * to the dead owner, the release lane accepts only `claimed|in_progress`,
 * and `deleteAgent` blocks on assigned `submitted|rejected`. The fix opens
 * the EXISTING `POST /tasks/:id/retry` operation to local human reviewers
 * (admin/editor, habitat-member) for the `failed|rejected` lanes: the
 * custody-ending CAS writer (`retryTransitionToPendingWithEffects`) returns
 * the task to the claim pool and `deleteAgent` unblocks through its own
 * existing lanes. The agent wire stays failed-only.
 *
 * Every test drives the REAL application assembly (`createHttpApplication`
 * + real auth guards + real task/agent services) against the sql.js test
 * DB — no route, service, or writer is mocked. The retry POLICY on the task
 * row is the discriminator, mirroring `rejectedReworkEscalation.test.ts`:
 * `{maxRetries:0, escalateToHuman:true}` makes the first reviewer rejection
 * take the escalation arm deterministically, leaving the #150 state
 * (rejected + owner + token preserved).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { getEventsByTaskId } from "../repositories/event.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";

const ESCALATING = {
  maxRetries: 0,
  escalateToHuman: true,
  retryOnStatuses: ["all"],
};

let app: HttpRuntimeHandle;
let habitatId: string;
let columnId: string;
let ownerKey: string;
let ownerAgentId: string;
let adminJwt: string;
let editorJwt: string;
let viewerJwt: string;
let outsiderJwt: string;

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

function seedTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "seed" }).id;
}

/** claim → start → submit through the real service spine; returns the epoch token. */
function claimStartSubmit(taskId: string, agentId: string): string {
  const claim = taskService.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const token = taskRepo.getTaskById(taskId)!.executionToken;
  expect(token).not.toBeNull();
  const started = taskService.startTask(taskId, agentId, token);
  expect(started?.status).toBe("in_progress");
  const submitted = taskService.submitTask(taskId, agentId, "first result", [], token);
  expect(submitted.task).not.toBeNull();
  expect(submitted.task!.status).toBe("submitted");
  return token as string;
}

/**
 * The #150 stranded state: reviewer rejection under an exhausted escalating
 * policy escalates for attention while PRESERVING owner + continuation
 * token. Returns the task id and the preserved epoch token.
 */
function seedEscalatedRejectedTask(title: string, agentId: string): { taskId: string; token: string } {
  const taskId = seedTask(title);
  taskRepo.updateTask(taskId, { retryPolicy: ESCALATING });
  const token = claimStartSubmit(taskId, agentId);
  expect(taskService.rejectTask(taskId, "rev", "needs work", "human")).not.toBeNull();
  const after = taskRepo.getTaskById(taskId)!;
  expect(after.status).toBe("rejected");
  expect(after.assignedAgentId).toBe(agentId);
  return { taskId, token };
}

function seedFailedTask(title: string, agentId: string): string {
  const taskId = seedTask(title);
  const claim = taskService.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const token = taskRepo.getTaskById(taskId)!.executionToken as string;
  expect(taskService.startTask(taskId, agentId, token)?.status).toBe("in_progress");
  expect(taskService.failTask(taskId, agentId, "agent", "boom", token)).not.toBeNull();
  return taskId;
}

function injectRetry(taskId: string, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/retry`, headers });
}

function humanHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function setCeiling(ceiling: number | null): void {
  getDb()
    .update(habitats)
    .set({ lifecycleSettings: { taskTransitionCeiling: ceiling } })
    .where(eq(habitats.id, habitatId))
    .run();
}

/** Settle guardTransition's queueMicrotask breach-escalation scheduling. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function retryExecutedCount(taskId: string): number {
  return getEventsByTaskId(taskId).events.filter((e) => e.action === "retry_executed").length;
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  const org = orgRepo.createOrganization({ name: "rmr-org", slug: "rmr-org" });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "rmr-team", slug: "rmr-team" });
  const habitat = habitatRepo.createHabitat({ name: "rmr-habitat", teamId: team.id });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false }).id;

  // Member humans (admin + editor + viewer) and a NON-member global admin —
  // the membership gate must refuse the outsider even with role admin.
  addMember({ teamId: team.id, userId: "rmr-admin" });
  addMember({ teamId: team.id, userId: "rmr-editor", role: "member" });
  addMember({ teamId: team.id, userId: "rmr-viewer", role: "member" });
  adminJwt = signHumanJwt("rmr-admin", "admin");
  editorJwt = signHumanJwt("rmr-editor", "editor");
  viewerJwt = signHumanJwt("rmr-viewer", "viewer");
  outsiderJwt = signHumanJwt("rmr-outsider", "admin");

  const owner = seedAgent("rmr-owner");
  ownerAgentId = owner.id;
  ownerKey = owner.key;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
  pluginManager.resetPlugins();
});

describe("human manual retry at the rejected lane (#150 corrective)", () => {
  it("admin member retry resets an escalated rejected task to claimable pending (custody ends)", async () => {
    const { taskId } = seedEscalatedRejectedTask("admin-retry", ownerAgentId);
    const before = taskRepo.getTaskById(taskId)!;

    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { status: string } };
    expect(body.task.status).toBe("pending");

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("pending");
    expect(after.assignedAgentId).toBeNull();
    expect(after.executionToken).toBeNull();
    expect(after.rejectionReason).toBeNull();
    expect(after.nextRetryAt).toBeNull();
    expect(after.retryCount).toBe(before.retryCount + 1);
    expect(after.version).toBeGreaterThan(before.version);
    expect(retryExecutedCount(taskId)).toBe(1);

    // Claimable again: a DIFFERENT agent claims through the ordinary lane.
    const other = seedAgent("rmr-claimant-1");
    expect(taskService.claimTask(taskId, other.id).success).toBe(true);
  });

  it("editor member retry has the same admission (reviewer population parity)", async () => {
    const { taskId } = seedEscalatedRejectedTask("editor-retry", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(editorJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
  });

  it("kody scenario end-to-end: deleteAgent 409 before human retry, 204 after, task re-claimable", async () => {
    const owner = seedAgent("rmr-dead-owner");
    const { taskId } = seedEscalatedRejectedTask("dead-owner", owner.id);

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${owner.id}`,
      headers: humanHeaders(adminJwt),
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { code: string }).code).toBe("deletion_blocked_review_in_flight");

    const retried = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(retried.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${owner.id}`,
      headers: humanHeaders(adminJwt),
    });
    expect(deleted.statusCode).toBe(204);

    const next = seedAgent("rmr-replacement");
    expect(taskService.claimTask(taskId, next.id).success).toBe(true);
  });

  it("member viewer is refused (403) and the rejected row is untouched", async () => {
    const { taskId } = seedEscalatedRejectedTask("viewer-refused", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(viewerJwt));
    expect(res.statusCode).toBe(403);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });

  it("non-member global admin is refused by the habitat membership gate (403, task untouched)", async () => {
    const { taskId } = seedEscalatedRejectedTask("outsider-refused", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(outsiderJwt));
    expect(res.statusCode).toBe(403);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });

  it("unauthenticated request is 401", async () => {
    const { taskId } = seedEscalatedRejectedTask("unauth", ownerAgentId);
    const res = await injectRetry(taskId, {});
    expect(res.statusCode).toBe(401);
  });

  it("agent API key cannot retry a rejected task — the agent lane stays failed-only (400)", async () => {
    const { taskId } = seedEscalatedRejectedTask("agent-rejected", ownerAgentId);
    const res = await injectRetry(taskId, { "x-agent-api-key": ownerKey });
    expect(res.statusCode).toBe(400);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });

  it("a submitted task is refused for both actor kinds (400) — review still blocks", async () => {
    const taskId = seedTask("submitted-blocked");
    claimStartSubmit(taskId, ownerAgentId);

    const human = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(human.statusCode).toBe(400);
    const agent = await injectRetry(taskId, { "x-agent-api-key": seedAgent("rmr-agent-b").key });
    expect(agent.statusCode).toBe(400);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("submitted");
  });

  it("agent retry of a failed task is unchanged (parity, 200 → pending)", async () => {
    const taskId = seedFailedTask("agent-failed-parity", ownerAgentId);
    const res = await injectRetry(taskId, { "x-agent-api-key": ownerKey });
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
  });

  it("human reviewer retry of a failed task is admitted (failed lane, 200)", async () => {
    const taskId = seedFailedTask("human-failed-lane", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
  });

  it("budget-exhausted rejected retry is refused with the task byte-identical (exact 500 INTERNAL_ERROR on main)", async () => {
    const { taskId } = seedEscalatedRejectedTask("budget-refused", ownerAgentId);
    const before = taskRepo.getTaskById(taskId)!;
    // The retry meters as the `system` actor, so the human invocation gets no
    // human budget exemption: ceiling 1 with the claim/start/submit meter
    // already spent (>= 3 metered rows) refuses before any write.
    setCeiling(1);

    try {
      const res = await injectRetry(taskId, humanHeaders(adminJwt));
      // Current-main contract, pinned EXACTLY: the refusal maps to 500
      // INTERNAL_ERROR (docs/API.md retry section). FOLD OBLIGATION for open
      // PR #152: when its typed-refusal layer lands, this assertion MUST be
      // updated to the exact typed refusal — 409 with code
      // TRANSITION_BUDGET_EXHAUSTED — and manualRetryBudgetRefusalWire.test.ts
      // must gain the human rejected-lane invocation pinning that same typed
      // code. Never widen this to a status-code family to make a merge pass;
      // the refusal MUST leave the task byte-identical on either layer.
      expect(res.statusCode).toBe(500);
      expect((res.json() as { code?: string }).code).toBe("INTERNAL_ERROR");
      await settle();

      const after = taskRepo.getTaskById(taskId)!;
      expect(after.status).toBe("rejected");
      expect(after.assignedAgentId).toBe(ownerAgentId);
      expect(after.executionToken).toBe(before.executionToken);
      expect(after.rejectionReason).toBe(before.rejectionReason);
      expect(after.version).toBe(before.version);
      expect(retryExecutedCount(taskId)).toBe(0);
    } finally {
      setCeiling(null);
    }
  });

  it("race, retry-first: the owner's stale startTask on the preserved token fails after the reset", async () => {
    const { taskId, token } = seedEscalatedRejectedTask("race-retry-first", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);

    // The reset ended custody under BEGIN IMMEDIATE with a full postimage
    // verify — the owner's restart is a stale preimage (pending + unowned)
    // and must fail without minting a fresh epoch.
    expect(taskService.startTask(taskId, ownerAgentId, token)).toBeNull();
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("pending");
    expect(after.assignedAgentId).toBeNull();
    expect(after.executionToken).toBeNull();
  });

  it("race, start-first: an owner restart moves the row to in_progress and retry is refused by the status gate (400)", async () => {
    const { taskId, token } = seedEscalatedRejectedTask("race-start-first", ownerAgentId);
    const restarted = taskService.startTask(taskId, ownerAgentId, token);
    expect(restarted?.status).toBe("in_progress");

    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(400);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("in_progress");
  });
});
