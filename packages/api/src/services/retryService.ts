import * as taskRepo from "../repositories/task.js";
import {
  retryTransitionToPendingWithEffects,
  retryEscalateClearOwnerWithEffects,
} from "../repositories/taskStateMachine.js";
import * as habitatRepo from "../repositories/habitat.js";
import { logger } from "../lib/logger.js";
import type { Task, RetryPolicy } from "../models/index.js";
import { emitTransition } from "./tasks/transition-emitter.js";
import { guardTransitionTop } from "./tasks/transitionBudget.js";

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

/** Resets a task back to pending for the next attempt, increments its retry count, and emits a transition. */
export function executeRetry(task: Task): Task | null {
  // Transition budget (plan §5): retry_executed is the metered progression of
  // the retry ladder (retry_scheduled is bookkeeping — counted in the meter
  // when written, but scheduling itself is not guarded). The retry processor
  // is a system actor: metered. Refusal follows this function's null-on-
  // failed-update convention; the task keeps its nextRetryAt until a human
  // resolves it or the ceiling is raised. The first refusal escalates (plan
  // §6) — emitted once, outside this module, by the guard's breach site.
  const budgetHabitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";
  const budget = guardTransitionTop(task.id, budgetHabitatId, "system", "retry_executed");
  if (budget.outcome === "refused") return null;

  const newRetryCount = task.retryCount + 1;

  // Dedicated immediate retry writer (review safety): the privileged
  // status/assignee reset and the requirement ownership-end invariant share
  // one reservation — the generic task update can no longer perform this.
  const updated = retryTransitionToPendingWithEffects(task.id, newRetryCount);
  if (!updated) return null;

  const habitatId = taskRepo.getHabitatIdForTask(task.id) ?? "";

  emitTransition(task.id, "retry_executed", habitatId, {
    actorType: "system",
    actorId: "retry-service",
    oldStatus: task.status,
    newStatus: "pending",
    retryCount: newRetryCount,
    metadata: { retryCount: newRetryCount },
    task: updated,
  });

  return updated;
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
      executeRetry(task);
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
