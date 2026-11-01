/**
 * Retry-ladder reason isolation — the receipt-driven failed-lane admission
 * must not filter on an earlier reviewer's `rejectionReason`.
 *
 * Discriminating contract (issue triage, maintainer ruling):
 *   - A rejected → reworked → failed task and a directly-failed control with
 *     the same current failure reason, retry count, and effective policy must
 *     receive the SAME retry admission from the durable `retry_ladder`
 *     receipt. The historical reviewer prose is provenance, never the failed
 *     phase's filter input.
 *   - Fresh failures keep their existing eligibility: a non-matching CURRENT
 *     failure reason under a non-`all` allowlist is not a newly introduced
 *     refusal (no current-failure-reason allowlist is activated).
 *   - The reviewer-rejection phase's own reason-string filtering (the legacy
 *     emitter path) is unchanged: non-matching reviewer text refuses,
 *     matching text schedules.
 *   - No destructive history clearing: the task row and the frozen causal
 *     snapshot keep the historical rejection text; the escalated branch
 *     records it as provenance alongside the current failure cause.
 *
 * Every test drives REAL production paths (claim/start/submit/reject/rework
 * service transitions, `failTask` act-tx, `processEffectReceipts` delivery
 * with its prerequisite barriers) against the real sql.js test DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../services/taskSuggestion.js", () => ({
  getSuggestionsForAgent: vi.fn(() => ({ suggestions: [] })),
}));

import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskEvents, effectReceipts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskService from "../services/tasks/index.js";
import { failTask } from "../services/tasks/task-lifecycle.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import type { RetryPolicy } from "@orcy/shared";

const REVIEWER_PROSE = "needs rework: cover the retry lane";

let habitatId: string;
let columnId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Retry Ladder Reason Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
  agentId = agentRepo.createAgent({
    name: "ladder-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
});

afterEach(() => {
  closeDb();
});

function seedTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" });
  return task.id;
}

/** Claim (mints X) → start; returns the execution token. */
function claimAndStart(taskId: string): string {
  const claim = taskStateMachine.claimTask(taskId, agentId);
  if (!claim.success) throw new Error("claim failed");
  const token = (claim as { success: true; task: { executionToken: string } }).task
    .executionToken;
  if (!taskService.startTask(taskId, agentId, token)) throw new Error("start failed");
  return token;
}

/** Claim → start → submit → reject (preserves X as continuation token). */
function seedRejected(taskId: string, reviewerText: string): string {
  const token = claimAndStart(taskId);
  const submitted = taskService.submitTask(taskId, agentId, "round-1 result", [], token);
  expect(submitted.task).not.toBeNull();
  const rejected = taskService.rejectTask(taskId, "human-1", reviewerText, "human");
  expect(rejected).not.toBeNull();
  return token;
}

function attachPolicy(taskId: string, policy: RetryPolicy): void {
  getDb().update(tasks).set({ retryPolicy: policy }).where(eq(tasks.id, taskId)).run();
}

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as Record<string, any>;
}

function eventsFor(taskId: string, action: (typeof taskEvents.$inferSelect)["action"]) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

function retryLadderReceipt(taskId: string) {
  return getDb()
    .select()
    .from(effectReceipts)
    .where(and(eq(effectReceipts.taskId, taskId), eq(effectReceipts.consumer, "retry_ladder")))
    .get() as
    | { id: string; state: string; subjectId: string; causalSnapshot: unknown }
    | undefined;
}

/** Runs real deliverer passes until every receipt settles (bounded). */
async function drainReceipts(maxPasses = 6): Promise<void> {
  for (let i = 0; i < maxPasses; i++) {
    await processEffectReceipts();
    const pending = getDb()
      .select({ id: effectReceipts.id })
      .from(effectReceipts)
      .where(eq(effectReceipts.state, "pending"))
      .all();
    if (pending.length === 0) return;
  }
}

/** The discriminating end-state assertions shared by paired tasks. */
function expectRetryAdmitted(taskId: string, cause: string) {
  const row = taskRow(taskId);
  expect(row.status).toBe("failed");
  expect(row.retryCount).toBe(0);
  expect(row.nextRetryAt).not.toBeNull();
  const scheduled = eventsFor(taskId, "retry_scheduled");
  expect(scheduled).toHaveLength(1);
  expect((scheduled[0]!.metadata as Record<string, unknown>).cause).toBe(cause);
  expect((scheduled[0]!.metadata as Record<string, unknown>).retryCount).toBe(0);
  const receipt = retryLadderReceipt(taskId);
  expect(receipt).toBeDefined();
  expect(receipt!.state).toBe("delivered");
  return receipt!;
}

describe("retry ladder — historical rejectionReason isolation (receipt era)", () => {
  it("rejected→reworked→failed and direct-fail receive the same admission for the same current failure", async () => {
    const policy: RetryPolicy = {
      maxRetries: 3,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: false,
      retryOnStatuses: ["timeout"],
    };
    // Task A: real reject → owner rework → fail under the rework token.
    const taskA = seedTask("reworked-then-failed");
    attachPolicy(taskA, policy);
    const continuation = seedRejected(taskA, REVIEWER_PROSE);
    const reworkStart = taskService.startTask(taskA, agentId, continuation);
    expect(reworkStart).not.toBeNull();
    const reworkToken = reworkStart!.executionToken;
    expect(reworkToken).not.toBeNull();
    const failedA = failTask(taskA, agentId, "agent", "timeout", reworkToken);
    expect(failedA).not.toBeNull();

    // Task B control: identical policy/count, direct fail, never rejected.
    const taskB = seedTask("direct-fail-control");
    attachPolicy(taskB, policy);
    const tokenB = claimAndStart(taskB);
    const failedB = failTask(taskB, agentId, "agent", "timeout", tokenB);
    expect(failedB).not.toBeNull();

    await drainReceipts();

    // Equal admission: BOTH schedule a retry off the current failure reason.
    const receiptA = expectRetryAdmitted(taskA, "timeout");
    expectRetryAdmitted(taskB, "timeout");

    // Provenance separation preserved: A's frozen snapshot still carries the
    // historical reviewer prose next to the current failure reason; B's does
    // not. The stale prose changed no decision.
    const snapshotA = receiptA.causalSnapshot as Record<string, unknown>;
    expect(snapshotA.reason).toBe("timeout");
    expect(snapshotA.rejectionReason).toBe(REVIEWER_PROSE);
    // History is not cleared on the task row either.
    expect(taskRow(taskA).rejectionReason).toBe(REVIEWER_PROSE);
    expect(taskRow(taskB).rejectionReason).toBeNull();
  });

  it("fresh failures keep existing eligibility: a non-matching current failure reason is not a new refusal", async () => {
    // Under the maintainer ruling the current failure reason is NOT activated
    // as an allowlist filter — a fresh failure (no rejection history) with a
    // reason outside the non-`all` allowlist stays admissible, exactly as
    // before the fix.
    const task = seedTask("fresh-fail-nonmatching-reason");
    attachPolicy(task, {
      maxRetries: 3,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: false,
      retryOnStatuses: ["timeout"],
    });
    const token = claimAndStart(task);
    expect(failTask(task, agentId, "agent", "syntax_error", token)).not.toBeNull();
    await drainReceipts();
    expectRetryAdmitted(task, "syntax_error");
  });

  it("rejection-phase reason filtering is unchanged: non-matching reviewer text refuses, matching text schedules", () => {
    const policy: RetryPolicy = {
      maxRetries: 3,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: false,
      retryOnStatuses: ["timeout"],
    };
    // Non-matching reviewer prose: the rejection phase's own filter refuses
    // (silent refusal with escalation off) — no retry is scheduled at reject.
    const refused = seedTask("rejected-nonmatching");
    attachPolicy(refused, policy);
    seedRejected(refused, REVIEWER_PROSE);
    expect(taskRow(refused).status).toBe("rejected");
    expect(taskRow(refused).nextRetryAt).toBeNull();
    expect(eventsFor(refused, "retry_scheduled")).toHaveLength(0);

    // Matching reviewer text still schedules through the legacy path.
    const admitted = seedTask("rejected-matching");
    attachPolicy(admitted, policy);
    seedRejected(admitted, "timeout");
    expect(taskRow(admitted).nextRetryAt).not.toBeNull();
    expect(eventsFor(admitted, "retry_scheduled")).toHaveLength(1);
  });

  it("exhausted ceiling with escalation: both histories escalate equally and the escalated event keeps provenance", async () => {
    const policy: RetryPolicy = {
      maxRetries: 0,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: true,
      retryOnStatuses: ["timeout"],
    };
    // Task A: build the rejection history with NO policy attached (rejecting
    // under this ceiling policy would escalate at rejection time — a
    // different phase), then attach it and fail in rework.
    const taskA = seedTask("reworked-then-failed-escalates");
    const continuation = seedRejected(taskA, REVIEWER_PROSE);
    attachPolicy(taskA, policy);
    const reworkStart = taskService.startTask(taskA, agentId, continuation);
    expect(reworkStart).not.toBeNull();
    expect(failTask(taskA, agentId, "agent", "timeout", reworkStart!.executionToken)).not.toBeNull();

    // Task B control: direct fail at the same ceiling.
    const taskB = seedTask("direct-fail-escalates");
    attachPolicy(taskB, policy);
    const tokenB = claimAndStart(taskB);
    expect(failTask(taskB, agentId, "agent", "timeout", tokenB)).not.toBeNull();

    await drainReceipts();

    for (const taskId of [taskA, taskB]) {
      const row = taskRow(taskId);
      expect(row.status).toBe("failed");
      expect(row.nextRetryAt).toBeNull();
      expect(row.assignedAgentId).toBeNull();
      expect(eventsFor(taskId, "retry_scheduled")).toHaveLength(0);
      const escalated = eventsFor(taskId, "escalated");
      expect(escalated).toHaveLength(1);
      expect((escalated[0]!.metadata as Record<string, unknown>).cause).toBe("timeout");
      const receipt = retryLadderReceipt(taskId);
      expect(receipt).toBeDefined();
      expect(receipt!.state).toBe("delivered");
    }
    // History/provenance retained, not cleared: the previously rejected
    // task's escalated event still records the reviewer prose alongside the
    // current failure cause; the control's records null.
    const escalatedA = eventsFor(taskA, "escalated")[0]!.metadata as Record<string, unknown>;
    expect(escalatedA.rejectionReason).toBe(REVIEWER_PROSE);
    const escalatedB = eventsFor(taskB, "escalated")[0]!.metadata as Record<string, unknown>;
    expect(escalatedB.rejectionReason).toBeNull();
  });

  it("exhausted ceiling without escalation: both histories settle to the same silent delivered ack", async () => {
    const policy: RetryPolicy = {
      maxRetries: 0,
      backoffBase: 60,
      backoffMultiplier: 2,
      maxBackoff: 3600,
      escalateToHuman: false,
      retryOnStatuses: ["timeout"],
    };
    const taskA = seedTask("reworked-then-failed-silent");
    const continuation = seedRejected(taskA, REVIEWER_PROSE);
    attachPolicy(taskA, policy);
    const reworkStart = taskService.startTask(taskA, agentId, continuation);
    expect(reworkStart).not.toBeNull();
    expect(failTask(taskA, agentId, "agent", "timeout", reworkStart!.executionToken)).not.toBeNull();

    const taskB = seedTask("direct-fail-silent");
    attachPolicy(taskB, policy);
    const tokenB = claimAndStart(taskB);
    expect(failTask(taskB, agentId, "agent", "timeout", tokenB)).not.toBeNull();

    await drainReceipts();

    for (const taskId of [taskA, taskB]) {
      const row = taskRow(taskId);
      expect(row.status).toBe("failed");
      expect(row.nextRetryAt).toBeNull();
      expect(eventsFor(taskId, "retry_scheduled")).toHaveLength(0);
      expect(eventsFor(taskId, "escalated")).toHaveLength(0);
      const receipt = retryLadderReceipt(taskId);
      expect(receipt).toBeDefined();
      expect(receipt!.state).toBe("delivered");
    }
  });
});
