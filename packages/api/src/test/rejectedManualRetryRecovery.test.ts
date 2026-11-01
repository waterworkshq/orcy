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
import { habitats, users } from "../db/schema/index.js";
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
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
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
let globalAdminJwt: string;

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

  // Member humans + persisted users rows (round-3 policy: the human retry
  // lane authorizes on the persisted users row via the recovery policy —
  // persisted global admin; personal owner; team owner/admin — never the
  // JWT role alone and never plain habitat READ admission).
  //   rmr-admin  : users editor + team member role 'admin' → team-admin path
  //   rmr-editor : users editor + team member role 'member' → refused (T6)
  //   rmr-viewer : persisted viewer → refused everywhere
  //   rmr-outsider: NO users row, JWT claims admin, non-member → refused
  //   rmr-gadmin : persisted global admin, NON-member → admitted
  for (const [id, role] of [
    ["rmr-admin", "editor"],
    ["rmr-editor", "editor"],
    ["rmr-viewer", "viewer"],
    ["rmr-gadmin", "admin"],
    ["rmr-powner", "editor"],
    ["rmr-pother", "editor"],
  ] as const) {
    getDb()
      .insert(users)
      .values({ id, username: id, passwordHash: "x", displayName: id, role })
      .run();
  }
  addMember({ teamId: team.id, userId: "rmr-admin", role: "admin" });
  addMember({ teamId: team.id, userId: "rmr-editor", role: "member" });
  addMember({ teamId: team.id, userId: "rmr-viewer", role: "member" });
  adminJwt = signHumanJwt("rmr-admin", "admin");
  editorJwt = signHumanJwt("rmr-editor", "editor");
  viewerJwt = signHumanJwt("rmr-viewer", "viewer");
  outsiderJwt = signHumanJwt("rmr-outsider", "admin");
  globalAdminJwt = signHumanJwt("rmr-gadmin", "viewer"); // JWT hint deliberately wrong

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
  it("team-admin member retry resets an escalated rejected task to claimable pending (custody ends)", async () => {
    const { taskId } = seedEscalatedRejectedTask("admin-retry", ownerAgentId);
    const before = taskRepo.getTaskById(taskId)!;
    // rmr-admin: persisted users role EDITOR + team member role ADMIN —
    // admitted through the team-owner/admin branch of the recovery policy,
    // NOT a global role (proves the team branch admits without global admin).
    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { task: { status: string } };
    expect(body.task.status).toBe("pending");

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("pending");
    expect(after.assignedAgentId).toBeNull();
    expect(after.executionToken).toBeNull();
    // Preserved (PR158 review): the rejected-lane reset keeps the reviewer's
    // feedback for the replacement claimant instead of clearing it.
    expect(after.rejectionReason).toBe("needs work");
    expect(after.nextRetryAt).toBeNull();
    expect(after.retryCount).toBe(before.retryCount + 1);
    expect(after.version).toBeGreaterThan(before.version);
    expect(retryExecutedCount(taskId)).toBe(1);

    // Claimable again: a DIFFERENT agent claims through the ordinary lane.
    const other = seedAgent("rmr-claimant-1");
    expect(taskService.claimTask(taskId, other.id).success).toBe(true);
  });

  it("plain team member (editor, not owner/admin) is REFUSED (403) — the recovery lane is governor-bound", async () => {
    const { taskId } = seedEscalatedRejectedTask("editor-refused", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(editorJwt));
    // Round-3 policy (T6): the manual retry is a custody-ending MUTATION —
    // the broad READ admission (any member / any JWT admin-editor) no longer
    // applies; team habitats admit owner/admin members only.
    expect(res.statusCode).toBe(403);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
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

  it("JWT-claim admin with NO persisted users row is refused (403) — the JWT role is a hint, never authority", async () => {
    const { taskId } = seedEscalatedRejectedTask("outsider-refused", ownerAgentId);
    const res = await injectRetry(taskId, humanHeaders(outsiderJwt));
    // rmr-outsider signs an admin JWT but has no persisted users row and no
    // team membership: the recovery policy reads PERSISTED rows only.
    expect(res.statusCode).toBe(403);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });

  it("persisted global admin (non-member, wrong JWT hint) is admitted (200) — persisted role decides", async () => {
    const { taskId } = seedEscalatedRejectedTask("gadmin-admitted", ownerAgentId);
    // rmr-gadmin: persisted users.role = admin, NOT a team member, and the
    // JWT deliberately claims viewer — authorization reads the users row.
    const res = await injectRetry(taskId, humanHeaders(globalAdminJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
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

  it("budget-exhausted rejected retry is refused typed (409 TRANSITION_BUDGET_EXHAUSTED) with the task byte-identical", async () => {
    const { taskId } = seedEscalatedRejectedTask("budget-refused", ownerAgentId);
    const before = taskRepo.getTaskById(taskId)!;
    // The retry meters as the `system` actor, so the human invocation gets no
    // human budget exemption: ceiling 1 with the claim/start/submit meter
    // already spent (>= 3 metered rows) refuses inside the writer's
    // transaction — capacity for retry_executed AND the replacement claim is
    // required before custody may end (PR158 review: never strand an
    // unclaimable pending row).
    setCeiling(1);

    try {
      const res = await injectRetry(taskId, humanHeaders(adminJwt));
      // Both-lane contract, pinned EXACTLY (docs/API.md retry section; #152
      // vocabulary): the refusal is the typed 409 with code
      // TRANSITION_BUDGET_EXHAUSTED and details {category, count, ceiling}.
      // Never widen this to a status-code family; the refusal MUST leave the
      // task byte-identical.
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        code?: string;
        details?: { category: string; count: number; ceiling: number };
      };
      expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
      expect(body.details).toMatchObject({ category: "transition_budget_exhausted", ceiling: 1 });
      expect(body.details!.count).toBeGreaterThanOrEqual(3);
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

  it("agent lane budget refusal is the SAME typed 409 (one wire, both lanes)", async () => {
    const taskId = seedFailedTask("agent-budget-typed", ownerAgentId);
    setCeiling(1);
    try {
      const res = await injectRetry(taskId, { "x-agent-api-key": ownerKey });
      // Vocabulary decision (round-2 review F3): this branch adopts #152's
      // ExecuteRetryOutcome + conflictWithCode-details wire VERBATIM and
      // types BOTH lanes now — the historical 500 was a mislabeled policy
      // refusal. #152's manualRetryBudgetRefusalWire.test.ts (agent lane)
      // carries the identical pin when it folds; no parallel union remains.
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        code?: string;
        error?: string;
        details?: { category: string; count: number; ceiling: number };
      };
      expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
      expect(body.error).toBe("Manual retry refused: the task's transition budget is exhausted");
      expect(body.details).toMatchObject({ category: "transition_budget_exhausted", ceiling: 1 });
      await settle();
      expect(taskRepo.getTaskById(taskId)!.status).toBe("failed");
      expect(retryExecutedCount(taskId)).toBe(0);
    } finally {
      setCeiling(null);
    }
  });

  it("recovery at count = ceiling-3 refuses (409, unchanged row): the reset must afford claim+start+submit too", async () => {
    const { taskId } = seedEscalatedRejectedTask("ceiling-minus-three", ownerAgentId);
    const count = countMeteredTransitions(getDb(), taskId);
    expect(count).toBeGreaterThanOrEqual(3);
    // required=4 (reset + claim + start + submit): count+4 > ceiling=count+3
    // → typed refusal. required=2 admitted here and stranded the row
    // claimed-but-unstartable (started/submitted/released are all metered).
    setCeiling(count + 3);

    try {
      const res = await injectRetry(taskId, humanHeaders(adminJwt));
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        code?: string;
        details?: { count: number; ceiling: number };
      };
      expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
      expect(body.details).toMatchObject({ count, ceiling: count + 3 });
      await settle();

      // Refused while the task was unchanged: byte-identical rejected row.
      const after = taskRepo.getTaskById(taskId)!;
      expect(after.status).toBe("rejected");
      expect(after.assignedAgentId).toBe(ownerAgentId);
      expect(after.retryCount).toBe(0);
      expect(retryExecutedCount(taskId)).toBe(0);
    } finally {
      setCeiling(null);
    }
  });

  it("recovery at count = ceiling-4 succeeds and the FULL replacement path (claim→start→submit) fits", async () => {
    const { taskId } = seedEscalatedRejectedTask("ceiling-minus-four", ownerAgentId);
    const count = countMeteredTransitions(getDb(), taskId);
    setCeiling(count + 4); // reset(+1) + claim(+1) + start(+1) + submit(+1)

    try {
      const res = await injectRetry(taskId, humanHeaders(adminJwt));
      expect(res.statusCode).toBe(200);
      expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");

      // The whole point of the required=4 reservation: the replacement's
      // ENTIRE deterministic path is admitted by the budget gate — never a
      // claimed-but-unstartable (or unsubmittable) stranded row.
      const replacement = seedAgent("rmr-claimant-ceiling");
      const claim = taskService.claimTask(taskId, replacement.id);
      expect(claim.success).toBe(true);
      const token = taskRepo.getTaskById(taskId)!.executionToken;
      expect(taskService.startTask(taskId, replacement.id, token)?.status).toBe("in_progress");
      const submitted = taskService.submitTask(taskId, replacement.id, "fixed", [], token);
      expect(submitted.task?.status).toBe("submitted");
      // Exactly at the ceiling — the reservation consumed it to the last
      // slot and not beyond.
      expect(countMeteredTransitions(getDb(), taskId)).toBe(count + 4);
    } finally {
      setCeiling(null);
    }
  });

  it("replacement claimant sees the preserved rejection feedback in task detail, with audit provenance", async () => {
    const { taskId } = seedEscalatedRejectedTask("replacement-context", ownerAgentId);

    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);

    // The replacement agent reads the task through the ordinary detail route.
    const replacement = seedAgent("rmr-claimant-detail");
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}`,
      headers: { "x-agent-api-key": replacement.key },
    });
    expect(detail.statusCode).toBe(200);
    const task = (detail.json() as { task: { rejectionReason: string | null; status: string } }).task;
    expect(task.status).toBe("pending");
    expect(task.rejectionReason).toBe("needs work");

    // Audit provenance: the reset's own trail carries the preserved reason.
    const retriedEvent = getEventsByTaskId(taskId).events.find(
      (e) => e.action === "retry_executed",
    );
    expect(retriedEvent).toBeDefined();
    expect((retriedEvent!.metadata as Record<string, unknown>)?.rejectionReason).toBe("needs work");
  });

  it("failed-lane human retry still clears a leftover rejectionReason (unchanged semantics)", async () => {
    const taskId = seedFailedTask("failed-lane-clears", ownerAgentId);
    taskRepo.updateTask(taskId, { rejectionReason: "stale reason" });

    const res = await injectRetry(taskId, humanHeaders(adminJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.rejectionReason).toBeNull();
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

describe("personal-habitat recovery authority (T6: owner or persisted global admin only)", () => {
  let pHabitatId: string;
  let pColumnId: string;
  let ownerJwt: string;
  let otherJwt: string;

  beforeAll(() => {
    const habitat = habitatRepo.createHabitat({ name: "rmr-personal" });
    pHabitatId = habitat.id;
    // Explicit personal owner (migration 0083 adapter): rmr-powner.
    getDb()
      .update(habitats)
      .set({ ownerUserId: "rmr-powner" })
      .where(eq(habitats.id, pHabitatId))
      .run();
    pColumnId = columnRepo.createColumn({
      habitatId: pHabitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    }).id;
    ownerJwt = signHumanJwt("rmr-powner", "editor"); // NOT an admin anywhere
    otherJwt = signHumanJwt("rmr-pother", "editor"); // same persisted role, not the owner
  });

  function seedPersonalRejectedTask(title: string): string {
    const mission = missionRepo.createMission({
      habitatId: pHabitatId,
      columnId: pColumnId,
      title: `m-${title}`,
      createdBy: "seed",
    });
    const taskId = taskRepo.createTask({ missionId: mission.id, title, createdBy: "seed" }).id;
    taskRepo.updateTask(taskId, { retryPolicy: ESCALATING });
    const claim = taskService.claimTask(taskId, ownerAgentId);
    expect(claim.success).toBe(true);
    const token = taskRepo.getTaskById(taskId)!.executionToken;
    expect(taskService.startTask(taskId, ownerAgentId, token)?.status).toBe("in_progress");
    expect(
      taskService.submitTask(taskId, ownerAgentId, "first", [], token).task,
    ).not.toBeNull();
    expect(taskService.rejectTask(taskId, "rev", "needs work", "human")).not.toBeNull();
    expect(taskRepo.getTaskById(taskId)!.status).toBe("rejected");
    return taskId;
  }

  it("the personal habitat's explicit owner (plain editor) is admitted (200)", async () => {
    const taskId = seedPersonalRejectedTask("personal-owner");
    const res = await injectRetry(taskId, humanHeaders(ownerJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
  });

  it("a DIFFERENT editor (any-authenticated-human READ rule) is refused (403, row untouched)", async () => {
    const taskId = seedPersonalRejectedTask("personal-other");
    const res = await injectRetry(taskId, humanHeaders(otherJwt));
    // Pre-fix behavior: personal habitats admitted any authenticated human,
    // so any editor could reset ANY user's personal task. The recovery
    // policy admits only the owner or a persisted global admin.
    expect(res.statusCode).toBe(403);
    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
  });

  it("persisted global admin may recover a personal habitat task (200)", async () => {
    const taskId = seedPersonalRejectedTask("personal-gadmin");
    const res = await injectRetry(taskId, humanHeaders(globalAdminJwt));
    expect(res.statusCode).toBe(200);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("pending");
  });

  it("persisted viewer is refused even on personal habitats (403)", async () => {
    const taskId = seedPersonalRejectedTask("personal-viewer");
    const res = await injectRetry(taskId, humanHeaders(viewerJwt));
    expect(res.statusCode).toBe(403);
    expect(taskRepo.getTaskById(taskId)!.status).toBe("rejected");
  });
});
