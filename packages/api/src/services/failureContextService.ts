import { getDb } from "../db/index.js";
import { pulses, taskEvents, workflows, taskWorkflowGates } from "../db/schema/index.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import * as taskRepo from "../repositories/taskCrud.js";
import * as missionRepo from "../repositories/feature.js";
import * as failureContextRepo from "../repositories/failureContext.js";
import type {
  FailureContextRow,
  FailureKind,
  ResolutionKind,
} from "../repositories/failureContext.js";
import type {
  FailureBundle,
  TaskEventSnapshot,
  ExperienceSignalSnapshot,
  RetryAttemptSnapshot,
  ExperienceCategory,
} from "../models/index.js";
import { logger } from "../lib/logger.js";

export { type FailureKind, type ResolutionKind, type FailureContextRow };

/** Maximum number of lifecycle events retained in a `FailureBundle`. */
export const MAX_LIFECYCLE_EVENTS = 20;
/** Maximum number of experience signals retained in a `FailureBundle`. */
export const MAX_EXPERIENCE_SIGNALS = 50;
/** Maximum number of retry attempts retained in a `FailureBundle`. */
export const MAX_RETRY_ATTEMPTS = 10;
/** Current `bundleSchemaVersion` written on every newly built `FailureBundle`. */
export const CURRENT_BUNDLE_SCHEMA_VERSION = 1;

/** Maps a transition `action` that triggered failure capture to the persisted `FailureKind`. */
export function actionToFailureKind(action: string): FailureKind | null {
  switch (action) {
    case "failed":
      return "lifecycle_failed";
    case "rejected":
      return "lifecycle_rejected";
    case "released":
      return "heartbeat_lost";
    default:
      return null;
  }
}

/**
 * Assembles a `FailureBundle` for a failed task — capturing its artifacts, the last 20 lifecycle events,
 * up to 50 experience signals posted by the failing agent on the task, the per-category summary, and up
 * to 10 prior retry attempts — then persists a `failureContexts` row and returns it. Returns null when
 * the task does not exist.
 */
export function buildFailureContext(
  failedTaskId: string,
  failureKind: FailureKind,
  opts?: { failureReason?: string; triggeredByAction?: string },
): FailureContextRow | null {
  const task = taskRepo.getTaskById(failedTaskId);
  if (!task) return null;

  const mission = missionRepo.getMissionById(task.missionId);
  if (!mission) {
    logger.warn(
      { failedTaskId, missionId: task.missionId },
      "Mission missing during failure context build",
    );
    return null;
  }

  const failedByAgentId = task.assignedAgentId ?? null;
  const failureReason = opts?.failureReason ?? task.rejectionReason ?? "";

  const recentLifecycleEvents = collectLifecycleEvents(failedTaskId);
  const experienceSignals = collectExperienceSignals(failedTaskId, failedByAgentId);
  const retryHistory = collectRetryHistory(failedTaskId);
  const experienceCategorySummary = summarizeCategories(experienceSignals);

  const bundle: FailureBundle = {
    artifacts: task.artifacts ?? [],
    recentLifecycleEvents,
    experienceSignals,
    retryHistory,
    experienceCategorySummary,
  };

  const workflowId = resolveWorkflowId(failedTaskId, mission.id);

  return failureContextRepo.createFailureContext({
    failedTaskId,
    workflowId,
    habitatId: mission.habitatId,
    failureKind,
    failureReason,
    failedByAgentId,
    bundle,
    bundleSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
  });
}

/** Returns the most recent unresolved `failureContexts` row for a task, or null when none exist. */
export function getFailureContext(failedTaskId: string): FailureContextRow | null {
  return failureContextRepo.getUnresolvedFailureContextByTaskId(failedTaskId);
}

/** Returns all failure-context rows for a task (resolved or not), newest first. */
export function getFailureContextsForTask(taskId: string): FailureContextRow[] {
  return failureContextRepo.getFailureContextsByTaskId(taskId);
}

/** Marks a failure-context row resolved with a terminal resolution kind and a current timestamp. */
export function resolveFailureContext(contextId: string, resolution: ResolutionKind): void {
  failureContextRepo.resolveFailureContext(contextId, resolution);
}

/** Links a spawned recovery task back to its failure-context row (denormalized convenience field). */
export function linkRecoveryTask(contextId: string, recoveryTaskId: string): void {
  failureContextRepo.linkRecoveryTask(contextId, recoveryTaskId);
}

function collectLifecycleEvents(taskId: string): TaskEventSnapshot[] {
  const db = getDb();
  const rows = db
    .select({
      action: taskEvents.action,
      actorType: taskEvents.actorType,
      actorId: taskEvents.actorId,
      timestamp: taskEvents.timestamp,
      metadata: taskEvents.metadata,
    })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.timestamp))
    .limit(MAX_LIFECYCLE_EVENTS)
    .all();
  // Reverse so the bundle reads chronologically (oldest first).
  return rows
    .map((row) => ({
      action: String(row.action),
      actorType: String(row.actorType),
      actorId: String(row.actorId),
      timestamp: String(row.timestamp),
      metadata: (row.metadata as Record<string, unknown> | null) ?? undefined,
    }))
    .reverse();
}

function collectExperienceSignals(
  taskId: string,
  failedByAgentId: string | null,
): ExperienceSignalSnapshot[] {
  const db = getDb();
  const conditions = [eq(pulses.taskId, taskId), eq(pulses.signalType, "experience")];
  if (failedByAgentId) {
    conditions.push(eq(pulses.fromId, failedByAgentId));
  }
  const rows = db
    .select({
      subject: pulses.subject,
      metadata: pulses.metadata,
      taskId: pulses.taskId,
      createdAt: pulses.createdAt,
    })
    .from(pulses)
    .where(and(...conditions))
    .orderBy(desc(pulses.createdAt))
    .limit(MAX_EXPERIENCE_SIGNALS)
    .all();

  return rows.map((row) => {
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    return {
      experience: (meta.experience as ExperienceCategory) ?? "smooth",
      subject: String(row.subject),
      taskId: (row.taskId as string | null) ?? null,
      createdAt: String(row.createdAt),
    };
  });
}

function collectRetryHistory(taskId: string): RetryAttemptSnapshot[] {
  const db = getDb();
  const rows = db
    .select({
      action: taskEvents.action,
      timestamp: taskEvents.timestamp,
      metadata: taskEvents.metadata,
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        inArray(taskEvents.action, ["retry_scheduled", "retry_executed", "escalated"]),
      ),
    )
    .orderBy(desc(taskEvents.timestamp))
    .limit(MAX_RETRY_ATTEMPTS)
    .all();

  return rows
    .map((row, idx) => {
      const meta = (row.metadata as Record<string, unknown> | null) ?? {};
      const action = String(row.action);
      let result: RetryAttemptSnapshot["result"] = null;
      if (action === "retry_executed") result = "pending";
      else if (action === "escalated") result = "failed";
      return {
        attemptNumber: idx + 1,
        scheduledAt: String(row.timestamp),
        executedAt: action === "retry_scheduled" ? null : String(row.timestamp),
        result,
      } satisfies RetryAttemptSnapshot;
    })
    .reverse();
}

function summarizeCategories(
  signals: ExperienceSignalSnapshot[],
): Partial<Record<ExperienceCategory, number>> {
  const summary: Partial<Record<ExperienceCategory, number>> = {};
  for (const signal of signals) {
    summary[signal.experience] = (summary[signal.experience] ?? 0) + 1;
  }
  return summary;
}

function resolveWorkflowId(taskId: string, missionId: string): string | null {
  const db = getDb();
  // A task participates in a workflow either as an upstream or downstream node.
  // Look for any active workflow containing this task.
  const gate = db
    .select({ workflowId: taskWorkflowGates.workflowId })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(workflows.missionId, missionId),
        eq(workflows.status, "active"),
        sql`${taskWorkflowGates.upstreamTaskId} = ${taskId} OR ${taskWorkflowGates.downstreamTaskId} = ${taskId}`,
      ),
    )
    .limit(1)
    .get();
  return gate?.workflowId ?? null;
}
