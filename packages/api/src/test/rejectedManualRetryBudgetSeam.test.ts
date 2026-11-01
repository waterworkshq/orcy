/**
 * The transition-budget gate must live INSIDE the retry writer's BEGIN
 * IMMEDIATE — atomically with the meter count it reads (PR158 round-2 F1;
 * round-3 T8/T10). A read-only preflight outside the writer cannot guarantee
 * it: in the window where the preflight allows (count = ceiling-required) a
 * concurrent metered commit on the shared SQLite file moves the count past
 * the reservation, the preflight already answered, the retry consumes slots
 * the replacement path needs, and the row strands (required=2 proved
 * claimed-but-unstartable: `started`/`submitted`/`released` are metered too
 * — hence required=4: reset + claim + start + submit).
 *
 * The mid-window committer is simulated deterministically by wrapping the
 * REAL writer (`retryTransitionToPendingWithEffects`, transparent
 * importActual passthrough) to insert ONE metered `task_events` row
 * (`released`, agent actor) AFTER the service admission and BEFORE the
 * writer's transaction opens — exactly what a second connection does in the
 * admission→writer window. This placement is what makes the suite
 * FALSIFYING: a regression that re-introduces a service-level (non-atomic)
 * preflight counts BEFORE the wrapper's commit, allows, and then executes
 * through a guard-less writer — the assertions below flip red. (The
 * round-2 arm committed before the whole call and proved nothing.)
 *
 * Also pins: CAS-before-budget precedence (a stale preimage against an
 * exhausted budget answers the preimage conflict, never a spurious breach
 * escalation) and the background scheduler's snapshot-preimage fence (a
 * stale scheduler row cannot reset a recovered/restarted task). The typed
 * 409 wire itself is pinned UNMOCKED in rejectedManualRetryRecovery.test.ts.
 * (Note: a taskStateMachine-depth mock does not propagate through the full
 * app assembly under vitest 4 — the wrapper seam here is driven at the
 * service level, which is exactly where the audit prescribed it.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import { createEvent, getEventsByTaskId } from "../repositories/event.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import { RetryTransitionBudgetRefusedError } from "../repositories/retryBudgetRefusal.js";
import { executeRetry, executeRetryWithOutcome } from "../services/retryService.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";

// Module-seam mid-window arm: when armed, the wrapped writer commits one
// extra metered row for the task on entry — i.e. AFTER the service-layer
// admission and BEFORE the real writer's BEGIN IMMEDIATE — exactly what a
// second connection does in the admission→write window.
//
// Mechanism: vi.spyOn the module namespace (NOT a vi.mock factory — under
// vitest 4 an async importOriginal factory for this deep hub silently fails
// to intercept retryService's binding whenever the test file's import graph
// grows, and it never propagates through app assembly). The spy patches the
// namespace property that retryService's live import binding reads, and the
// captured `original` still runs the real writer.
let armedInsert: { taskId: string } | null = null;
const originalRetryTransition = taskStateMachine.retryTransitionToPendingWithEffects;
vi.spyOn(taskStateMachine, "retryTransitionToPendingWithEffects").mockImplementation(
  (...args: Parameters<typeof originalRetryTransition>) => {
    if (armedInsert && armedInsert.taskId === args[0]) {
      armedInsert = null;
      createEvent({
        taskId: args[0],
        actorType: "agent",
        actorId: "concurrent-committer",
        action: "released",
        fromStatus: "rejected",
        toStatus: "rejected",
      });
    }
    return originalRetryTransition(...args);
  },
);

const ESCALATING = {
  maxRetries: 0,
  escalateToHuman: true,
  retryOnStatuses: ["all"],
};

let habitatId: string;
let columnId: string;
let ownerAgentId: string;

function seedAgent(name: string): { id: string; key: string } {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  return { id: created.agent.id, key: created.plainApiKey };
}

async function loadTaskService() {
  return import("../services/tasks/index.js");
}

async function seedEscalatedRejectedTask(title: string, agentId: string): Promise<string> {
  const taskService = await loadTaskService();
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

/** Settle guardTransition's queueMicrotask breach-escalation scheduling. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// No app assembly in this file BY DESIGN: the writer-seam factory mock only
// propagates to a statically-imported service consumer when the huge app
// route graph is absent (vitest 4 factory-mock depth behavior). The typed
// 409 wire is pinned against the real app in rejectedManualRetryRecovery.
beforeAll(async () => {
  await initTestDb();

  const org = orgRepo.createOrganization({ name: "rbs-org", slug: "rbs-org" });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "rbs-team", slug: "rbs-team" });
  const habitat = habitatRepo.createHabitat({ name: "rbs-habitat", teamId: team.id });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false }).id;

  const owner = seedAgent("rbs-owner");
  ownerAgentId = owner.id;
}, 120_000);

afterAll(async () => {
  closeDb();
});

beforeEach(() => {
  armedInsert = null;
});

describe("in-writer budget gate (post-CAS, atomic with the meter count)", () => {
  it("mid-window metered commit flips the recovery to the typed refusal with zero effects (service level)", async () => {
    const taskId = await seedEscalatedRejectedTask("seam-service", ownerAgentId);
    const count = meteredCount(taskId);
    expect(count).toBeGreaterThanOrEqual(3);
    setCeiling(count + 4); // admission window: count = ceiling-4 → required=4 allows

    const before = taskRepo.getTaskById(taskId)!;

    // The concurrent commit lands INSIDE the admission→writer window (the
    // wrapped writer commits it on entry — after the service admission,
    // before the BEGIN IMMEDIATE). It does NOT touch the task row, so the
    // CAS preimage stays valid — only the budget headroom moved.
    armedInsert = { taskId };

    const out = executeRetryWithOutcome(taskRepo.getTaskById(taskId) as never, {
      expected: { status: before.status, version: before.version },
      preserveRejectionReason: true,
      requireClaimHeadroom: true,
    });

    expect(armedInsert).toBeNull(); // the wrapper really fired mid-window
    expect(meteredCount(taskId)).toBe(count + 1);

    // The in-writer required=4 check must refuse ATOMICALLY: typed refusal
    // carrying the in-transaction count, and NOTHING written.
    expect(out).toEqual({
      outcome: "refused",
      refusal: {
        outcome: "refused",
        reason: "transition_budget_exhausted",
        count: count + 1,
        ceiling: count + 4,
      },
    });

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(ownerAgentId);
    expect(after.version).toBe(before.version);
    expect(after.retryCount).toBe(before.retryCount);
    expect(retryExecutedCount(taskId)).toBe(0);

    // The refused attempt consumed NOTHING (beyond the injected committer's
    // own row): with one more slot granted (operator raises the ceiling by
    // 1), the retry executes AND the full replacement path — claim, start,
    // submit — fits. That full-path assertion is what required=4 reserves.
    setCeiling(count + 5);
    const executed = executeRetryWithOutcome(taskRepo.getTaskById(taskId) as never, {
      expected: { status: before.status, version: before.version },
      preserveRejectionReason: true,
      requireClaimHeadroom: true,
    });
    expect(executed.outcome).toBe("executed");
    const taskService = await loadTaskService();
    const replacement = seedAgent("rbs-claimant-seam");
    const claim = taskService.claimTask(taskId, replacement.id);
    expect(claim.success, JSON.stringify(claim)).toBe(true);
    const token = taskRepo.getTaskById(taskId)!.executionToken;
    expect(taskService.startTask(taskId, replacement.id, token)?.status).toBe("in_progress");
    const submitted = taskService.submitTask(taskId, replacement.id, "fix", [], token);
    expect(submitted.task?.status).toBe("submitted");
    expect(meteredCount(taskId)).toBe(count + 5); // exactly the ceiling, no overdraw

    setCeiling(null);
  });

  it("writer-level: requireClaimHeadroom refuses (typed throw, row unchanged) when the full path cannot fit", async () => {
    const taskId = await seedEscalatedRejectedTask("seam-writer", ownerAgentId);
    const count = meteredCount(taskId);
    setCeiling(count + 1); // one slot remains: required=4 must refuse
    const before = taskRepo.getTaskById(taskId)!;

    // The writer-level contract is the typed THROW (the service layer maps
    // it to the refused outcome); the whole reservation rolls back.
    expect(() =>
      taskStateMachine.retryTransitionToPendingWithEffects(taskId, before.retryCount + 1, {
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

  it("writer-level control: without requireClaimHeadroom the same one-slot row retries (required=1, in-writer post-CAS)", async () => {
    const taskId = await seedEscalatedRejectedTask("seam-writer-control", ownerAgentId);
    const count = meteredCount(taskId);
    setCeiling(count + 1); // one slot: required=1 allows
    const before = taskRepo.getTaskById(taskId)!;

    const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, before.retryCount + 1, {
      expected: { status: before.status, version: before.version },
    });

    expect(out?.status).toBe("pending");
    setCeiling(null);
  });

  it("CAS precedes budget: a stale preimage against an exhausted budget answers preimage_conflict, never a breach", async () => {
    const taskId = await seedEscalatedRejectedTask("seam-precedence", ownerAgentId);
    const count = meteredCount(taskId);
    // Budget is exhausted for even the required=1 reset…
    setCeiling(count);
    const before = taskRepo.getTaskById(taskId)!;

    // …and the preimage is stale (the row "moved" after admission).
    const out = executeRetryWithOutcome(before, {
      expected: { status: before.status, version: before.version - 1 },
    });

    // The CAS refuses FIRST: the outcome is the preimage conflict, not the
    // typed budget refusal — a stale retry must never masquerade as a
    // breach (no escalation, no "raise the ceiling" operator misdirection).
    expect(out).toEqual({ outcome: "failed", reason: "preimage_conflict" });
    await settle(); // settle any queued breach escalation
    const escalations = getEventsByTaskId(taskId).events.filter(
      (e) =>
        e.action === "escalated" &&
        (e.metadata as Record<string, unknown> | null)?.transitionBudget !== undefined,
    );
    expect(escalations).toHaveLength(0);
    expect(taskRepo.getTaskById(taskId)!.version).toBe(before.version);
    expect(retryExecutedCount(taskId)).toBe(0);

    setCeiling(null);
  });

  it("stale background-scheduler snapshot cannot reset a recovered task (T11): preimage fence, zero effects", async () => {
    const taskId = await seedEscalatedRejectedTask("seam-stale-scheduler", ownerAgentId);
    // Make the row due for the background ladder, then take the scheduler's
    // snapshot BEFORE the human recovery runs.
    taskRepo.updateTask(taskId, { nextRetryAt: new Date(Date.now() - 60_000).toISOString() });
    const snapshot = taskRepo.getTaskById(taskId)!;
    expect(snapshot.status).toBe("rejected");

    // The human recovery lands first (as it would over a slow scheduler
    // tick): row → pending, version bumped, feedback PRESERVED.
    const recovered = executeRetryWithOutcome(snapshot, {
      expected: { status: snapshot.status, version: snapshot.version },
      preserveRejectionReason: true,
      requireClaimHeadroom: true,
    });
    expect(recovered.outcome).toBe("executed");
    const pending = taskRepo.getTaskById(taskId)!;
    expect(pending.status).toBe("pending");
    expect(pending.rejectionReason).toBe("needs work");
    expect(retryExecutedCount(taskId)).toBe(1);

    // The scheduler's stale snapshot then processes — exactly what
    // processPendingRetries does per row now (expected pinned from the
    // snapshot). Pre-fix behavior: no CAS → the reset re-ran, the preserved
    // feedback was cleared, a duplicate retry_executed consumed a metered
    // slot with no state change.
    const meterBefore = meteredCount(taskId);
    expect(executeRetry(snapshot, { expected: { status: snapshot.status, version: snapshot.version } })).toBeNull();

    const after = taskRepo.getTaskById(taskId)!;
    expect(after.status).toBe("pending");
    expect(after.version).toBe(pending.version);
    expect(after.rejectionReason).toBe("needs work");
    expect(after.retryCount).toBe(pending.retryCount);
    expect(retryExecutedCount(taskId)).toBe(1); // no duplicate
    expect(meteredCount(taskId)).toBe(meterBefore); // no stolen slot
  });
});
