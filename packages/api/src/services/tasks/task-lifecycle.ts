import * as taskRepo from "../../repositories/task.js";
import * as agentRepo from "../../repositories/agent.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import * as watcherService from "../watcherService.js";
import * as retryService from "../retryService.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import * as missionService from "../featureService.js";
import * as timeTrackingService from "../timeTrackingService.js";
import * as effortRepo from "../../repositories/effortEntry.js";
import * as qualityGateService from "../qualityGateService.js";
import * as dependencyService from "../dependencyService.js";
import type { Task, Artifact } from "../../models/index.js";
import { validateTransition, mergeArtifacts, validateAgentCapabilities } from "./helpers.js";
import { logger } from "../../lib/logger.js";
import { InterceptorVetoError } from "../../errors.js";
import * as pulseService from "../pulseService.js";
import * as reviewAssignment from "../reviewAssignmentService.js";
import { emitTransition } from "./transition-emitter.js";

/** Arguments passed to every registered {@link TaskEventHook} when a task lifecycle event fires. */
export interface TaskEventOpts {
  taskId: string;
  habitatId: string;
  event: string;
  actorType: string;
  actorId: string;
  metadata?: Record<string, unknown>;
}

/** Subscriber callback fired by {@link onTaskEvent} for each task lifecycle event; receives a {@link TaskEventOpts}. */
export type TaskEventHook = (opts: TaskEventOpts) => void;
const taskEventHooks: TaskEventHook[] = [];

/** Registers a {@link TaskEventHook} to fire on task lifecycle events and returns an unsubscribe function; side effect: mutates the internal hook list. */
export function onTaskEvent(hook: TaskEventHook): () => void {
  taskEventHooks.push(hook);
  return () => {
    const idx = taskEventHooks.indexOf(hook);
    if (idx >= 0) taskEventHooks.splice(idx, 1);
  };
}

function notifyTaskEvent(opts: TaskEventOpts): void {
  for (const hook of taskEventHooks) {
    try {
      hook(opts);
    } catch (err) {
      logger.error({ err }, "Task event hook failed");
    }
  }
}

function getHabitatId(task: Task): string {
  const habitatId = taskRepo.getHabitatIdForTask(task.id);
  if (!habitatId) {
    logger.warn({ taskId: task.id }, "Task has no associated habitat");
    return "";
  }
  return habitatId;
}

/** Runs `fn` and logs+swallows any error it throws, returning its value on success or `undefined` on failure; side effect: writes an error log entry on failure. */
export function withMissionRecalc<T>(
  taskId: string,
  missionId: string,
  fn: () => T,
): T | undefined {
  try {
    return fn();
  } catch (err) {
    logger.error({ err, taskId, missionId }, "Mission recalculation failed");
  }
}

/** Atomically claims the {@link Task} for the given agent when capability requirements are met; side effect: emits a `claimed` transition via {@link emitTransition} on success. */
export function claimTask(
  taskId: string,
  agentId: string,
):
  | { success: true; task: Task }
  | { success: false; reason: string; message?: string; missingCapabilities?: string[] } {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { success: false, reason: "not_found" };

  if (current.requiredCapabilities && current.requiredCapabilities.length > 0) {
    const agent = agentRepo.getAgentById(agentId);
    if (!agent) return { success: false, reason: "not_found" };

    const missing = validateAgentCapabilities(
      agent.capabilities || [],
      current.requiredCapabilities as string[],
    );

    if (missing.length > 0) {
      return {
        success: false,
        reason: "capability_mismatch",
        message: `Agent lacks required capabilities: ${missing.join(", ")}`,
        missingCapabilities: missing,
      };
    }
  }

  // Pre-interceptor seam (ADR-0014): gates run BEFORE the DB write so a veto
  // leaves the task row untouched. The hook sees the pre-claim task state.
  const preHabitatId = getHabitatId(current);
  const veto = pluginManager.runPreInterceptors(taskId, "taskClaimed", preHabitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "claimed",
    assignedAgentId: agentId,
    task: current,
  });
  if (veto) throw new InterceptorVetoError(veto);

  const result = taskRepo.claimTask(taskId, agentId);

  if (result.success) {
    const habitatId = getHabitatId(result.task);

    emitTransition(taskId, "claimed", habitatId, {
      actorType: "agent",
      actorId: agentId,
      oldStatus: "pending",
      newStatus: "claimed",
      assignedAgentId: agentId,
      task: result.task,
    });

    // Post-interceptor seam (ADR-0014): fire-and-forget after the transition.
    pluginManager.runPostInterceptors(taskId, "taskClaimed", habitatId, {
      actorType: "agent",
      actorId: agentId,
      oldStatus: "pending",
      newStatus: "claimed",
      assignedAgentId: agentId,
      task: result.task,
    });
  }

  return result;
}

/** Transitions a claimed {@link Task} to `in_progress` for its assigned agent; side effect: ensures quality checklists and emits a `started` transition. */
export function startTask(taskId: string, agentId: string): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (current.assignedAgentId !== agentId) return null;

  if (!validateTransition(current.status, "in_progress")) return null;

  const task = taskRepo.startTask(taskId, agentId);
  if (!task) return null;

  try {
    qualityGateService.ensureTaskChecklists(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to ensure task quality checklists");
  }

  const habitatId = getHabitatId(task);

  emitTransition(taskId, "started", habitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "in_progress",
    task,
  });

  return task;
}

/** Submits an in-progress {@link Task} for review after validating quality gates; side effect: recalculates effort metrics, emits a `submitted` transition, and triggers reviewer assignment with `task.review_assigned` SSE events. */
export function submitTask(
  taskId: string,
  agentId: string,
  result: string,
  artifacts: Artifact[],
): {
  task: Task | null;
  error?: string;
  missingQualityItems?: { category: string; missingItems: string[] }[];
} {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { task: null };

  if (current.assignedAgentId !== agentId) return { task: null };

  if (!validateTransition(current.status, "submitted")) return { task: null };

  // Pre-interceptor seam (ADR-0014): veto before the quality gate check and
  // DB write. A blocking interceptor stops the submission from committing.
  {
    const preHabitatId = getHabitatId(current);
    const veto = pluginManager.runPreInterceptors(taskId, "taskSubmitted", preHabitatId, {
      actorType: "agent",
      actorId: agentId,
      oldStatus: current.status,
      newStatus: "submitted",
      metadata: { result },
      task: current,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  const qualityValidation = qualityGateService.validateQualityGates(taskId);
  if (!qualityValidation.passed) {
    return {
      task: null,
      error: "QUALITY_GATES_NOT_MET",
      missingQualityItems: qualityValidation.failures,
    };
  }

  const task = taskRepo.submitTask(taskId, agentId, result, artifacts);
  if (!task) return { task: null };

  const habitatId = getHabitatId(task);

  try {
    effortRepo.recalculateTaskEffortMetrics(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to recalculate effort metrics on submit");
  }

  emitTransition(taskId, "submitted", habitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "submitted",
    metadata: { result },
    task,
  });

  // Post-interceptor seam (ADR-0014): fire-and-forget after the transition.
  pluginManager.runPostInterceptors(taskId, "taskSubmitted", habitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "submitted",
    metadata: { result },
    task,
  });

  try {
    const reviewResult = reviewAssignment.assignReviewers(taskId, habitatId, agentId);
    if (!reviewResult.skipped) {
      for (const reviewer of reviewResult.assigned) {
        sseBroadcaster.publish(habitatId, {
          type: "task.review_assigned",
          data: {
            taskId,
            reviewerId: reviewer.reviewerId,
            reviewerType: "human",
            actorId: agentId,
          },
        });
      }
    }
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to assign reviewers — task still submitted");
  }

  return { task };
}

/** Marks a submitted or approved {@link Task} as `done` after dependency and quality-gate checks; side effect: merges supplied {@link Artifact}s, persists any review note, recalculates time/effort metrics, emits a `completed` transition, and notifies the task-event hook bus. */
export function completeTask(
  taskId: string,
  agentId: string,
  reviewNote?: string,
  artifacts?: Artifact[],
  skipQualityGates?: boolean,
): {
  task: Task | null;
  error?: string;
  blockedBy?: { taskId: string; title: string; status: string }[];
  missingQualityItems?: { category: string; missingItems: string[] }[];
} {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { task: null };

  if (current.assignedAgentId !== agentId) return { task: null };

  if (current.status !== "submitted" && current.status !== "approved") return { task: null };

  if (current.status === "submitted") {
    if (reviewAssignment.hasAssignedReviewers(taskId)) {
      return { task: null, error: "REVIEW_REQUIRED" };
    }
  }

  const depValidation = dependencyService.validateTaskCompletion(taskId);
  if (!depValidation.canComplete) {
    return {
      task: null,
      error: "TASK_BLOCKED_BY_DEPENDENCIES",
      blockedBy: depValidation.blockedBy,
    };
  }

  if (!skipQualityGates) {
    const qualityValidation = qualityGateService.validateQualityGates(taskId);
    if (!qualityValidation.passed) {
      return {
        task: null,
        error: "QUALITY_GATES_NOT_MET",
        missingQualityItems: qualityValidation.failures,
      };
    }
  }

  // Pre-interceptor seam (ADR-0014): veto BEFORE any completion DB writes.
  // Event is `taskApproved` because completeTask intentionally shares the taskApproved
  // interceptor event with approveTask — both reach a terminal "done-ish" state.
  {
    const preHabitatId = getHabitatId(current);
    const veto = pluginManager.runPreInterceptors(taskId, "taskApproved", preHabitatId, {
      actorType: "agent",
      actorId: agentId,
      oldStatus: current.status,
      newStatus: "done",
      metadata: { reviewNote },
      task: current,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  timeTrackingService.calculateAndSetCompletionMetrics(taskId);

  try {
    effortRepo.recalculateTaskEffortMetrics(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to recalculate effort metrics on complete");
  }

  mergeArtifacts(taskId, current, artifacts);

  if (reviewNote) {
    const existingResult = current.result || "";
    const separator = existingResult ? "\n\n---\n\nReview: " : "Review: ";
    taskRepo.updateTask(taskId, { result: existingResult + separator + reviewNote });
  }

  const task = taskRepo.markTaskDone(taskId);
  if (!task) return { task: null };

  const habitatId = getHabitatId(task);
  const metadata = {
    reviewNote,
    isSelfApproval: !reviewAssignment.hasAssignedReviewers(taskId),
  };

  emitTransition(taskId, "completed", habitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "done",
    metadata,
    task,
  });

  // Post-interceptor seam (ADR-0014): fire-and-forget after the transition.
  // Event is `taskApproved` (shared with approveTask — both reach a terminal state).
  pluginManager.runPostInterceptors(taskId, "taskApproved", habitatId, {
    actorType: "agent",
    actorId: agentId,
    oldStatus: current.status,
    newStatus: "done",
    metadata,
    task,
  });

  if (habitatId) {
    notifyTaskEvent({
      habitatId,
      taskId,
      event: "completed",
      actorType: "agent",
      actorId: agentId,
    });
  }

  return { task };
}

/** Approves a submitted {@link Task}, recording each assigned reviewer's approval until all required approvals are gathered; side effect: broadcasts `task.review_completed` over SSE, recalculates time/effort metrics, emits an `approved` transition, and notifies the task-event hook bus. */
export function approveTask(
  taskId: string,
  reviewerId: string,
  reviewerType: "human" | "agent" = "human",
): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (!validateTransition(current.status, "approved")) return null;

  if (reviewAssignment.hasAssignedReviewers(taskId)) {
    if (!reviewAssignment.isAssignedReviewer(taskId, reviewerId)) {
      return null;
    }

    reviewAssignment.recordApproval(taskId, reviewerId);

    const habitatId = getHabitatId(current);
    sseBroadcaster.publish(habitatId, {
      type: "task.review_completed",
      data: { taskId, reviewerId, status: "approved" },
    });

    if (!reviewAssignment.hasAllRequiredApprovals(taskId)) {
      return taskRepo.getTaskById(taskId);
    }

    // Race condition guard: re-read to ensure task hasn't been transitioned by a concurrent approval
    const fresh = taskRepo.getTaskById(taskId);
    if (!fresh || fresh.status !== "submitted") return fresh ?? null;
  }

  // Pre-interceptor seam (ADR-0014): veto before the approval DB write.
  {
    const preHabitatId = getHabitatId(current);
    const veto = pluginManager.runPreInterceptors(taskId, "taskApproved", preHabitatId, {
      actorType: reviewerType,
      actorId: reviewerId,
      reviewerId,
      oldStatus: current.status,
      newStatus: "approved",
      task: current,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  const task = taskRepo.approveTask(taskId);
  if (!task) return null;

  try {
    timeTrackingService.calculateAndSetCompletionMetrics(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to calculate completion metrics");
  }

  try {
    effortRepo.recalculateTaskEffortMetrics(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to recalculate effort metrics on approve");
  }

  const habitatId = getHabitatId(task);

  emitTransition(taskId, "approved", habitatId, {
    actorType: reviewerType,
    actorId: reviewerId,
    reviewerId,
    oldStatus: current.status,
    newStatus: "approved",
    task,
  });

  // Post-interceptor seam (ADR-0014): fire-and-forget after the transition.
  pluginManager.runPostInterceptors(taskId, "taskApproved", habitatId, {
    actorType: reviewerType,
    actorId: reviewerId,
    reviewerId,
    oldStatus: current.status,
    newStatus: "approved",
    task,
  });

  if (habitatId) {
    notifyTaskEvent({
      habitatId,
      taskId,
      event: "approved",
      actorType: reviewerType,
      actorId: reviewerId,
    });
  }

  return task;
}

/** Rejects a submitted {@link Task} with the supplied reason from an assigned reviewer; side effect: persists the reason, emits a `rejected` transition, and notifies the task-event hook bus. */
export function rejectTask(
  taskId: string,
  reviewerId: string,
  reason: string,
  reviewerType: "human" | "agent" = "human",
): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (!validateTransition(current.status, "rejected")) return null;

  if (reviewAssignment.hasAssignedReviewers(taskId)) {
    if (!reviewAssignment.isAssignedReviewer(taskId, reviewerId)) {
      return null;
    }
  }

  // Pre-interceptor seam (ADR-0014): veto before the rejection DB write.
  {
    const preHabitatId = getHabitatId(current);
    const veto = pluginManager.runPreInterceptors(taskId, "taskRejected", preHabitatId, {
      actorType: reviewerType,
      actorId: reviewerId,
      reviewerId,
      oldStatus: current.status,
      newStatus: "rejected",
      reason,
      metadata: { reason },
      task: current,
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  const task = taskRepo.rejectTask(taskId, reason);
  if (!task) return null;

  const habitatId = getHabitatId(task);

  emitTransition(taskId, "rejected", habitatId, {
    actorType: reviewerType,
    actorId: reviewerId,
    reviewerId,
    oldStatus: current.status,
    newStatus: "rejected",
    reason,
    metadata: { reason },
    task,
  });

  // Post-interceptor seam (ADR-0014): fire-and-forget after the transition.
  pluginManager.runPostInterceptors(taskId, "taskRejected", habitatId, {
    actorType: reviewerType,
    actorId: reviewerId,
    reviewerId,
    oldStatus: current.status,
    newStatus: "rejected",
    reason,
    metadata: { reason },
    task,
  });

  if (habitatId) {
    notifyTaskEvent({
      taskId,
      habitatId,
      event: "rejected",
      actorType: reviewerType,
      actorId: reviewerId,
      metadata: { reason },
    });
  }

  return task;
}

/** Releases a claimed or in-progress {@link Task} back to `pending` for the given actor; side effect: emits a `released` transition with the supplied reason. */
export function releaseTask(taskId: string, actorId: string, reason: string): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (current.status !== "claimed" && current.status !== "in_progress") return null;

  if (current.assignedAgentId && current.assignedAgentId !== actorId) return null;

  const task = taskRepo.releaseTask(taskId, reason);
  if (!task) return null;

  const habitatId = getHabitatId(task);

  emitTransition(taskId, "released", habitatId, {
    actorType: current.assignedAgentId ? "agent" : "human",
    actorId,
    oldStatus: current.status,
    newStatus: "pending",
    reason,
    metadata: { reason },
    task,
  });

  return task;
}

/** Transitions a {@link Task} to `failed` for the given actor with a reason; side effect: emits a `failed` transition and notifies the task-event hook bus. */
export function failTask(
  taskId: string,
  actorId: string,
  actorType: "agent" | "system",
  reason: string,
): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (!validateTransition(current.status, "failed")) return null;

  if (actorType === "agent" && current.assignedAgentId !== actorId) return null;

  const task = taskRepo.failTask(taskId, reason);
  if (!task) return null;

  const habitatId = getHabitatId(task);

  emitTransition(taskId, "failed", habitatId, {
    actorType,
    actorId,
    oldStatus: current.status,
    newStatus: "failed",
    reason,
    metadata: { reason },
    task,
  });

  if (habitatId) {
    notifyTaskEvent({
      taskId,
      habitatId,
      event: "failed",
      actorType,
      actorId,
      metadata: { reason },
    });
  }

  return task;
}
