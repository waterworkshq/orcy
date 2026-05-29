import * as taskRepo from "../../repositories/task.js";
import * as agentRepo from "../../repositories/agent.js";
import * as eventRepo from "../../repositories/event.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import * as watcherService from "../watcherService.js";
import * as retryService from "../retryService.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import * as missionService from "../featureService.js";
import * as timeTrackingService from "../timeTrackingService.js";
import * as qualityGateService from "../qualityGateService.js";
import * as dependencyService from "../dependencyService.js";
import type { Task, Artifact } from "../../models/index.js";
import { validateTransition, mergeArtifacts, validateAgentCapabilities } from "./helpers.js";
import { logger } from "../../lib/logger.js";
import * as pulseService from "../pulseService.js";
import * as reviewAssignment from "../reviewAssignmentService.js";

export interface TaskEventOpts {
  taskId: string;
  habitatId: string;
  event: string;
  actorType: string;
  actorId: string;
  metadata?: Record<string, unknown>;
}

type TaskEventHook = (opts: TaskEventOpts) => void;
const taskEventHooks: TaskEventHook[] = [];

export function onTaskEvent(hook: TaskEventHook): void {
  taskEventHooks.push(hook);
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

  const result = taskRepo.claimTask(taskId, agentId);

  if (result.success) {
    const habitatId = getHabitatId(result.task);

    eventRepo.createEvent({
      taskId,
      actorType: "agent",
      actorId: agentId,
      action: "claimed",
      toStatus: "claimed",
    });

    sseBroadcaster.publish(habitatId, {
      type: "task.claimed",
      data: { taskId, agentId },
    });
    sseBroadcaster.publish(habitatId, { type: "task.updated", data: result.task });
    if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.claimed");

    const agent = agentRepo.getAgentById(agentId);
    if (agent) {
      pluginManager.emitTaskClaimed(result.task, agent).catch(() => {});
    }

    withMissionRecalc(taskId, current.missionId, () => {
      missionService.recalculateMissionStatus(current.missionId);
    });

    pulseService.emitAutoSignal({
      missionId: result.task.missionId,
      signalType: "context",
      subject: `${agent?.name ?? agentId} claimed '${result.task.title}'`,
      taskId: result.task.id,
    });
  }

  return result;
}

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

  eventRepo.createEvent({
    taskId,
    actorType: "agent",
    actorId: agentId,
    action: "started",
    toStatus: "in_progress",
  });

  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });
  return task;
}

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
    timeTrackingService.recordWork(taskId, agentId, 0, "submitted");
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to record work time");
  }

  eventRepo.createEvent({
    taskId,
    actorType: "agent",
    actorId: agentId,
    action: "submitted",
    toStatus: "submitted",
    metadata: { result },
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.submitted",
    data: { taskId, agentId },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.submitted");
  pluginManager.emitTaskSubmitted(task).catch(() => {});

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });

  pulseService.emitAutoSignal({
    missionId: current.missionId,
    signalType: "offer",
    subject: `Results for '${task.title}' available for review`,
    taskId: task.id,
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

  timeTrackingService.calculateAndSetCompletionMetrics(taskId);

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

  eventRepo.createEvent({
    taskId,
    actorType: "agent",
    actorId: agentId,
    action: "completed",
    toStatus: "done",
    metadata,
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.completed",
    data: { taskId },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });

  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.completed");
  pluginManager.emitTaskApproved(task).catch(() => {});

  unblockDependents(taskId);

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });

  const resolvingAgent = agentRepo.getAgentById(agentId);
  pulseService.emitAutoSignal({
    missionId: current.missionId,
    signalType: "context",
    subject: `${resolvingAgent?.name ?? agentId} completed '${current.title}'`,
    taskId: current.id,
  });

  if (current.labels?.includes("blocker-clearance")) {
    const clearedSubject = current.title.replace(/^Clear Blocker:\s*/, "");
    pulseService.emitAutoSignal({
      missionId: current.missionId,
      signalType: "context",
      subject: `Blocker cleared: ${clearedSubject}`,
      taskId: current.id,
    });
  }

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

  const task = taskRepo.approveTask(taskId);
  if (!task) return null;

  try {
    timeTrackingService.calculateAndSetCompletionMetrics(taskId);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to calculate completion metrics");
  }

  const habitatId = getHabitatId(task);

  eventRepo.createEvent({
    taskId,
    actorType: reviewerType,
    actorId: reviewerId,
    action: "approved",
    toStatus: "approved",
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.approved",
    data: { taskId, reviewerId },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.approved");

  pluginManager.emitTaskApproved(task).catch(() => {});

  unblockDependents(taskId);

  if (habitatId) {
    notifyTaskEvent({
      habitatId,
      taskId,
      event: "approved",
      actorType: reviewerType,
      actorId: reviewerId,
    });
  }

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });
  return task;
}

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

  const task = taskRepo.rejectTask(taskId, reason);
  if (!task) return null;

  const habitatId = getHabitatId(task);

  eventRepo.createEvent({
    taskId,
    actorType: reviewerType,
    actorId: reviewerId,
    action: "rejected",
    toStatus: "rejected",
    metadata: { reason },
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.rejected",
    data: { taskId, reason, reviewerId },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.rejected");

  if (retryService.shouldRetry(task)) {
    retryService.scheduleRetry(task);
  } else if (retryService.getEffectivePolicy(task)?.escalateToHuman) {
    retryService.escalateToHuman(task);
  }

  pluginManager.emitTaskRejected(task, reason).catch(() => {});

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

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });
  return task;
}

export function releaseTask(taskId: string, actorId: string, reason: string): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (current.status !== "claimed" && current.status !== "in_progress") return null;

  if (current.assignedAgentId && current.assignedAgentId !== actorId) return null;

  const task = taskRepo.releaseTask(taskId, reason);
  if (!task) return null;

  const habitatId = getHabitatId(task);

  eventRepo.createEvent({
    taskId,
    actorType: current.assignedAgentId ? "agent" : "human",
    actorId,
    action: "released",
    fromStatus: current.status,
    toStatus: "pending",
    metadata: { reason },
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.released",
    data: { taskId, reason },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.released");

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });

  pulseService.emitAutoSignal({
    missionId: current.missionId,
    signalType: "context",
    subject: `Task '${task.title}' released, available for claim`,
    taskId: task.id,
  });

  return task;
}

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

  eventRepo.createEvent({
    taskId,
    actorType,
    actorId,
    action: "failed",
    toStatus: "failed",
    metadata: { reason },
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.failed",
    data: { taskId, reason },
  });
  sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, "task.failed");

  if (retryService.shouldRetry(task)) {
    retryService.scheduleRetry(task);
  } else if (retryService.getEffectivePolicy(task)?.escalateToHuman) {
    retryService.escalateToHuman(task);
  }

  withMissionRecalc(taskId, current.missionId, () => {
    missionService.recalculateMissionStatus(current.missionId);
  });

  pulseService.emitAutoSignal({
    missionId: current.missionId,
    signalType: "warning",
    subject: `Task '${task.title}' failed: ${reason}`,
    taskId: task.id,
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

function unblockDependents(completedTaskId: string): void {
  const dependents = taskRepo.getTasksByDependency(completedTaskId);
  for (const dependent of dependents) {
    if (taskRepo.areAllDependenciesMet(dependent.id) && dependent.status === "pending") {
      const habitatId = getHabitatId(dependent);
      eventRepo.createEvent({
        taskId: dependent.id,
        actorType: "system",
        actorId: "system",
        action: "dependency_resolved",
        metadata: { unblockedBy: completedTaskId },
      });
      sseBroadcaster.publish(habitatId, { type: "task.updated", data: dependent });
    }
  }
}
