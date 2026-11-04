/**
 * Due-row retirement: rows whose EFFECTIVE policy will never act on them are
 * retired from the due scan instead of being rescanned forever.
 * Real storage, real service spine; arming driven through the effect-receipt
 * delivery pass (failTask itself does not arm the ETA).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";
import { processPendingRetries, getEffectivePolicy } from "../services/retryService.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import {
  updateTaskFixtureForTests,
  type FixtureTaskUpdateInput,
} from "./helpers/taskFixtures.js";
import { getEventsByTaskId } from "../repositories/event.js";
import type { RetryPolicy } from "@orcy/shared";

const PAST = "2000-01-01T00:00:00.000Z";
const P1_NOESC: RetryPolicy = {
  maxRetries: 1,
  backoffBase: 1,
  backoffMultiplier: 1,
  escalateToHuman: false,
  retryOnStatuses: ["all"],
};
const P1_ESC: RetryPolicy = { ...P1_NOESC, escalateToHuman: true };
const P3: RetryPolicy = { ...P1_NOESC, maxRetries: 3, escalateToHuman: true };

let habitatId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  habitatId = habitatRepo.createHabitat({ name: "retire-habitat" }).id;
  agentId = agentRepo.createAgent({ name: "retire-agent", type: "codex", domain: "fullstack" })
    .agent.id;
});
afterEach(() => closeDb());

function seedTask(retryPolicy: RetryPolicy): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "m",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "user-1" });
  taskRepo.updateTask(task.id, { retryPolicy });
  return task.id;
}

function failIt(taskId: string): void {
  const claimed = taskRepo.claimTask(taskId, agentId);
  if (!claimed.success) throw new Error(claimed.reason);
  if (!taskRepo.startTask(taskId, agentId)) throw new Error("start failed");
  const failed = taskLifecycle.failTask(taskId, agentId, "agent", "fixture failure");
  if (!failed || failed.status !== "failed") throw new Error("fail failed");
}

/** Rejected-lane seeding: claim → start → submit → human reject. */
function rejectIt(taskId: string): void {
  const claimed = taskRepo.claimTask(taskId, agentId);
  if (!claimed.success) throw new Error(claimed.reason);
  const token = taskRepo.getTaskById(taskId)!.executionToken;
  if (!token) throw new Error("claim minted no execution token");
  if (!taskRepo.startTask(taskId, agentId)) throw new Error("start failed");
  const submitted = taskLifecycle.submitTask(taskId, agentId, "fixture result", [], token);
  if (!submitted.task) throw new Error(submitted.error ?? "submit failed");
  if (!taskLifecycle.rejectTask(taskId, "rev-1", "fixture rejection", "human"))
    throw new Error("reject failed");
}

type ArmExtra = FixtureTaskUpdateInput & { retryPolicy?: RetryPolicy | null };

async function armAndForceDue(taskId: string, extra: ArmExtra = {}): Promise<void> {
  await processEffectReceipts(); // workflow_gates / failure_context siblings first
  await processEffectReceipts(); // then retry_ladder arms nextRetryAt
  // `retryPolicy` goes through the generic writer: it is declared on taskCrud's
  // UpdateTaskInput but NOT on FixtureTaskUpdateInput — the fixture writer's
  // copy-all-keys loop is not a declared part of its contract.
  const { retryPolicy, ...fixture } = extra;
  if (retryPolicy !== undefined) {
    taskRepo.updateTask(taskId, { retryPolicy });
  }
  updateTaskFixtureForTests(taskId, { nextRetryAt: PAST, ...fixture });
}

const selected = (taskId: string) => taskRepo.getTasksPendingRetry().some((t) => t.id === taskId);
const countEvents = (taskId: string, action: string) =>
  getEventsByTaskId(taskId).events.filter((e) => e.action === action).length;

describe("due-row retirement", () => {
  // GROUND: PRD AC1.1 + AC1.5 (DESIGN D1 row 1) — no-effective-policy due row
  // retires by clearing nextRetryAt only, with no counters/status/events and
  // no re-selection on the next pass.
  it("retires a due row whose effective policy became absent", async () => {
    const taskId = seedTask(P3);
    failIt(taskId);
    await armAndForceDue(taskId, { retryPolicy: null });
    expect(getEffectivePolicy(taskRepo.getTaskById(taskId)!)).toBeNull();

    const before = taskRepo.getTaskById(taskId)!;
    processPendingRetries();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.nextRetryAt).toBeNull(); // retired from the due scan
    expect(after.status).toBe("failed"); // no status change
    expect(after.retryCount).toBe(0); // no counter consumption
    expect(after.assignedAgentId).toBe(before.assignedAgentId); // assignment unchanged
    expect(countEvents(taskId, "retry_executed")).toBe(0);
    expect(countEvents(taskId, "escalated")).toBe(0);
    processPendingRetries();
    expect(selected(taskId)).toBe(false); // not rescanned on the next pass
  });

  // GROUND: PRD AC1.2 + AC1.5 (DESIGN D1 row 2) — exhausted with
  // escalateToHuman:false retires WITHOUT an escalation event (explicit
  // disable semantics retained).
  it("retires an exhausted no-escalation row WITHOUT escalating (explicit disable retained)", async () => {
    const taskId = seedTask(P1_NOESC);
    failIt(taskId);
    await armAndForceDue(taskId, { retryCount: 1 }); // exhausted under maxRetries:1

    processPendingRetries();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.nextRetryAt).toBeNull();
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(1);
    expect(countEvents(taskId, "escalated")).toBe(0); // escalateToHuman:false means no escalation
    expect(selected(taskId)).toBe(false);
  });

  // GROUND: PRD AC1.2 (rejected-lane policy-shrink strand, probe S2c) —
  // rejectionReason preserved, no re-escalation arm, no status change.
  it("retires a REJECTED policy-shrink row without escalating or clearing the reason", async () => {
    const taskId = seedTask(P3); // armed under an escalating policy
    rejectIt(taskId);
    await armAndForceDue(taskId, { retryPolicy: P1_NOESC, retryCount: 1 }); // shrunk to exhausted + no escalation

    const before = taskRepo.getTaskById(taskId)!;
    processPendingRetries();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.nextRetryAt).toBeNull();
    expect(after.status).toBe("rejected"); // rejected lane: no status change
    expect(after.retryCount).toBe(1);
    expect(after.assignedAgentId).toBe(before.assignedAgentId); // assignment unchanged
    expect(after.rejectionReason).toBe("fixture rejection"); // preserved, not cleared
    expect(countEvents(taskId, "escalated")).toBe(0);
    processPendingRetries();
    expect(selected(taskId)).toBe(false);
  });

  // GROUND: PRD AC1.3 (DESIGN D1 row 3) — exhausted + escalation keeps the
  // delivered baseline: exactly one escalation retires the row.
  it("exhausted + escalation still escalates exactly once (delivered baseline, unchanged)", async () => {
    const taskId = seedTask(P1_ESC);
    failIt(taskId);
    await armAndForceDue(taskId, { retryCount: 1 });

    processPendingRetries();
    processPendingRetries();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.nextRetryAt).toBeNull();
    expect(countEvents(taskId, "escalated")).toBe(1);
    expect(selected(taskId)).toBe(false);
  });

  // GROUND: PRD AC1.4 (DESIGN D1 row; habitat fallback discriminator) — a
  // task-policy removal that still resolves a habitat policy is NOT retired;
  // the due pass executes it (live-policy semantics preserved).
  it("does NOT retire when task policy removal still resolves a HABITAT policy", async () => {
    habitatRepo.updateHabitat(habitatId, { retrySettings: P3 });
    const taskId = seedTask(P3);
    failIt(taskId);
    await armAndForceDue(taskId, { retryPolicy: null });
    expect(getEffectivePolicy(taskRepo.getTaskById(taskId)!)!.maxRetries).toBe(3);

    processPendingRetries();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("pending"); // executed, not retired
    expect(after.retryCount).toBe(1);
  });
});
