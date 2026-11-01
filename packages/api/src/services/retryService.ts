import * as taskRepo from "../repositories/task.js";
import {
  retryTransitionToPendingWithEffects,
  retryEscalateClearOwnerWithEffects,
  type RetryPreimage,
  type RetryTransitionOptions,
} from "../repositories/taskStateMachine.js";
import { RetryTransitionBudgetRefusedError } from "../repositories/retryBudgetRefusal.js";
import * as habitatRepo from "../repositories/habitat.js";
import { logger } from "../lib/logger.js";
import type { Task, RetryPolicy } from "../models/index.js";
import { emitTransition } from "./tasks/transition-emitter.js";
import type { BudgetRefusedOutcome } from "./tasks/transitionBudget.js";

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBase: 60,
  backoffMultiplier: 2,
  maxBackoff: 3600,
  escalateToHuman: true,
  retryOnStatuses: ["all"],
};

/** Returns a copy of the built-in default retry policy used when none is configured. */
export function getDefaultPolicy(): RetryPolicy {
  return { ...DEFAULT_POLICY };
}

/** Resolves the retry policy for a task by checking the task first, then falling back to its habitat. */
export function getEffectivePolicy(task: Task): RetryPolicy | null {
  if (task.retryPolicy) return task.retryPolicy;
  const habitatId = taskRepo.getHabitatIdForTask(task.id);
  if (!habitatId) return null;
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (habitat?.retrySettings) return habitat.retrySettings;
  return null;
}

/** Returns whether a task is still eligible for another retry under its policy. */
export function shouldRetry(task: Task, explicitPolicy?: RetryPolicy | null): boolean {
  const policy = explicitPolicy !== undefined ? explicitPolicy : getEffectivePolicy(task);
  if (!policy) return false;
  if ((task.retryCount ?? 0) >= (policy.maxRetries ?? 3)) return false;
  const statuses = policy.retryOnStatuses ?? ["all"];
  if (task.rejectionReason && statuses.length > 0 && !statuses.includes("all")) {
    return statuses.includes(task.rejectionReason);
  }
  return true;
}

/** Computes the exponential backoff delay in seconds for a retry attempt, capped at the policy maximum. */
export function calculateBackoff(policy: RetryPolicy, retryCount: number): number {
  const base = policy.backoffBase ?? 60;
  const multiplier = policy.backoffMultiplier ?? 2;
  const max = policy.maxBackoff ?? 3600;
  const delay = base * Math.pow(multiplier, retryCount);
  return Math.min(delay, max);
}

/** Schedules a task for a future retry by applying backoff, updates the task, and emits a transition. */
export function scheduleRetry(task: Task): Task | null {
  const policy = getEffectivePolicy(task);
  if (!policy) return null;

  const backoffSeconds = calculateBackoff(policy, task.retryCount);
  const nextRetryAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  const result = taskRepo.updateTask(task.id, { nextRetryAt });
  if (!result.success) return null;

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";

  emitTransition(task.id, "retry_scheduled", habitatId, {
    actorType: "system",
    actorId: "retry-service",
    retryCount: task.retryCount,
    nextRetryAt,
    backoffSeconds,
    metadata: { nextRetryAt, retryCount: task.retryCount, backoffSeconds },
    task: result.task,
  });

  return result.task;
}

/** Options for {@link executeRetryWithOutcome} (all default to the historical behavior). */
export interface ExecuteRetryOptions {
  /**
   * Preimage CAS pinned from the caller's OWN read of the task: the writer
   * refuses (no effects) when the row moved between that read and the write.
   * Manual REST retries pin it from the request's fetch; the background
   * processor pins it from the scheduler snapshot — a stale snapshot (the
   * row reset/restarted/claimed after the tick's read) refuses instead of
   * overwriting the newer state.
   */
  expected?: RetryPreimage;
  /**
   * Preserve `rejectionReason` on the reset row (human rejected-lane
   * recovery) so the replacement claimant keeps the prior attempt's
   * feedback. Also carries the preserved reason on the emitted
   * `retry_executed` event for audit provenance.
   */
  preserveRejectionReason?: boolean;
  /**
   * Require transition-budget headroom for FOUR metered slots — this reset's
   * `retry_executed` AND the replacement's claim, start, and submit —
   * enforced INSIDE the writer's BEGIN IMMEDIATE, atomically with the meter
   * count (the manual recovery lane; see the writer's headroom guard). The
   * refusal surfaces as the typed `refused` outcome with zero effects.
   */
  requireClaimHeadroom?: boolean;
  /**
   * In-transaction authority re-check passed through to the retry writer
   * (manual human recovery lane): evaluated inside the writer's BEGIN
   * IMMEDIATE after the preimage CAS and before the budget gate; a `false`
   * return throws the typed 403 with zero effects. See
   * {@link RetryTransitionOptions.authorize}.
   */
  authorize?: RetryTransitionOptions["authorize"];
}

/** Distinguishes execution, budget refusal, and a stale manual-retry preimage. */
export type ExecuteRetryOutcome =
  | { outcome: "executed"; task: Task }
  | { outcome: "refused"; refusal: BudgetRefusedOutcome }
  | { outcome: "failed"; reason?: "preimage_conflict" };

/**
 * Resets a task back to pending for the next attempt, increments its retry
 * count, and emits a transition — preserving the typed refusal distinction.
 */
export function executeRetryWithOutcome(
  task: Task,
  opts?: ExecuteRetryOptions,
): ExecuteRetryOutcome {
  const newRetryCount = task.retryCount + 1;

  // Dedicated immediate retry writer (review safety): the privileged
  // status/assignee reset and the requirement ownership-end invariant share
  // one reservation — the generic task update can no longer perform this.
  // Inside that BEGIN IMMEDIATE, in order: the preimage CAS (a moved row
  // refuses with NO effects) and the transition-budget gate — required=1
  // (every lane: retry_executed is the metered progression of the retry
  // ladder; retry_scheduled is bookkeeping — counted in the meter when
  // written, but scheduling itself is not guarded) or required=4 on the
  // human recovery lane (reset + replacement claim/start/submit). No
  // service-level preflight exists BY DESIGN: a stale preimage must always
  // surface as the CAS refusal (VERSION_CONFLICT), never as a spurious
  // budget breach — CAS takes precedence over the budget check, and the
  // first genuine refusal escalates from the guard's breach site (plan §6).
  try {
    const updated = opts
      ? retryTransitionToPendingWithEffects(task.id, newRetryCount, opts)
      : retryTransitionToPendingWithEffects(task.id, newRetryCount);
    if (!updated) {
      return { outcome: "failed", ...(opts?.expected ? { reason: "preimage_conflict" as const } : {}) };
    }

    const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";

    // Audit provenance for the preserved-feedback recovery: the replacement
    // claimant's trail shows WHY the prior attempt was rejected, not just a
    // bare reset. (With `expected` pinned, `task.rejectionReason` equals the
    // row's — the CAS refused otherwise.)
    const preservedReason =
      opts?.preserveRejectionReason === true ? (task.rejectionReason ?? undefined) : undefined;

    emitTransition(task.id, "retry_executed", habitatId, {
      actorType: "system",
      actorId: "retry-service",
      oldStatus: task.status,
      newStatus: "pending",
      retryCount: newRetryCount,
      ...(preservedReason !== undefined ? { reason: preservedReason } : {}),
      metadata: {
        retryCount: newRetryCount,
        ...(preservedReason !== undefined ? { rejectionReason: preservedReason } : {}),
      },
      task: updated,
    });

    return { outcome: "executed", task: updated };
  } catch (err) {
    if (err instanceof RetryTransitionBudgetRefusedError) {
      return { outcome: "refused", refusal: err.refusal };
    }
    throw err;
  }
}

/**
 * Null-on-failure wrapper over {@link executeRetryWithOutcome} — the
 * background retry processor's established convention (a refusal or an
 * unsuccessful write collapses to null and the tick skips the task).
 */
export function executeRetry(task: Task, opts?: ExecuteRetryOptions): Task | null {
  const result = executeRetryWithOutcome(task, opts);
  return result.outcome === "executed" ? result.task : null;
}

/**
 * Moves an exhausted task out of the retry loop for human attention and emits an escalation transition.
 * A `rejected` task escalates as attention bookkeeping only — its owner and
 * continuation token survive so the documented rework restart keeps working;
 * the custody-ending writer stays exclusive to the failed lane (#137).
 */
export function escalateToHuman(task: Task): Task | null {
  const policy = getEffectivePolicy(task);

  if (task.status === "rejected") {
    return escalateRejectedAttention(task, policy);
  }

  const updated = retryEscalateClearOwnerWithEffects(task.id);
  if (!updated) return null;

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";

  emitTransition(task.id, "escalated", habitatId, {
    actorType: "system",
    actorId: "retry-service",
    reason: task.rejectionReason ?? "max retries exceeded",
    retryCount: task.retryCount,
    metadata: {
      retryCount: task.retryCount,
      maxRetries: policy?.maxRetries ?? DEFAULT_POLICY.maxRetries,
      rejectionReason: task.rejectionReason,
    },
    task: updated,
  });

  return updated;
}

/**
 * Rejected-lane escalation arm (#137): records `escalated` attention WITHOUT
 * ending custody — the still-assigned owner keeps the rejected-continuation
 * token and restarts rework under existing review semantics. A stale
 * `nextRetryAt` (policy-shrink edge) is retired so the retry processor
 * cannot re-escalate the row on every tick.
 */
function escalateRejectedAttention(task: Task, policy: RetryPolicy | null): Task | null {
  let current = task;
  if (task.nextRetryAt != null) {
    const updated = taskRepo.updateTask(task.id, { nextRetryAt: null });
    if (!updated.success || !updated.task) return null;
    current = updated.task;
  }

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";

  emitTransition(task.id, "escalated", habitatId, {
    actorType: "system",
    actorId: "retry-service",
    reason: task.rejectionReason ?? "max retries exceeded",
    retryCount: task.retryCount,
    metadata: {
      retryCount: task.retryCount,
      maxRetries: policy?.maxRetries ?? DEFAULT_POLICY.maxRetries,
      rejectionReason: task.rejectionReason,
    },
    task: current,
  });

  return current;
}

/** Advances all due retry tasks, either executing the next attempt or escalating once the limit is reached. */
export function processPendingRetries(): void {
  const pendingTasks = taskRepo.getTasksPendingRetry();
  for (const task of pendingTasks) {
    const policy = getEffectivePolicy(task);
    if (!policy) continue;

    if (task.retryCount < (policy.maxRetries ?? 3)) {
      // The scheduler snapshot's preimage is pinned into the writer: a row
      // that moved after this tick's read (a human rejected-recovery reset
      // to pending, an owner rework restart, a fresh claim) refuses with NO
      // effects instead of being overwritten by the stale snapshot — no
      // duplicate `retry_executed`, no cleared preserved feedback, no
      // stolen metered slot. A benign version bump only defers the row to
      // the next tick (nextRetryAt survives the refusal).
      executeRetry(task, {
        expected: { status: task.status, version: task.version },
      });
    } else if (policy.escalateToHuman) {
      escalateToHuman(task);
    }
  }
}

/** Starts an interval timer that periodically runs {@link processPendingRetries} and returns the handle. */
export function startRetryProcessor(intervalMs: number = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      processPendingRetries();
    } catch (err) {
      logger.error({ err }, "Error processing pending retries");
    }
  }, intervalMs);
}
