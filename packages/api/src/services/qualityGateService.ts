import * as qualityRepo from "../repositories/qualityGate.js";
import * as taskRepo from "../repositories/task.js";
import * as effortRepo from "../repositories/effortEntry.js";
import { getDb } from "../db/index.js";
import { taskDependencies, tasks } from "../db/schema/index.js";
import { eq, and, notInArray, count } from "drizzle-orm";
import type { TaskQualityReport, ApprovalStatus } from "../models/index.js";

/** Loads the aggregated quality checklist report for a task. */
export function getQualityReport(taskId: string): TaskQualityReport {
  return qualityRepo.getQualityReport(taskId);
}

/** Updates a single checklist item and recomputes the parent checklist's completion status. */
export function updateChecklistItem(
  taskId: string,
  checklistId: string,
  itemId: string,
  input: {
    isCompleted?: boolean;
    completedBy?: string;
    evidenceUrl?: string;
    notes?: string;
  },
) {
  const result = qualityRepo.updateChecklistItem(checklistId, itemId, input);
  if (result) {
    qualityRepo.updateChecklistStatus(checklistId);
  }
  return result;
}

/** Evaluates the quality gates for a task and returns the list of failing categories. */
export function validateQualityGates(taskId: string): {
  passed: boolean;
  failures: { category: string; missingItems: string[] }[];
} {
  return qualityRepo.validateQualityGates(taskId);
}

/** Computes whether a task meets all approval requirements, detailing any blockers when it does not. */
export function getApprovalStatus(taskId: string): ApprovalStatus {
  const task = taskRepo.getTaskById(taskId);
  if (!task) {
    return {
      canBeApproved: false,
      reasons: ["TASK_NOT_FOUND"],
      requirements: {
        qualityChecklist: { status: "unknown", completed: 0, total: 0 },
        dependencies: { status: "unknown" },
        timeTracking: { status: "unknown" },
        effortLogging: { status: "unknown" },
      },
    };
  }

  const qualityReport = qualityRepo.getQualityReport(taskId);
  const reasons: string[] = [];

  const qualityCompleted = qualityReport.checklists.reduce((s, c) => s + c.progress.completed, 0);
  const qualityTotal = qualityReport.checklists.reduce((s, c) => s + c.progress.total, 0);
  const qualityStatus = qualityReport.canApprove
    ? "complete"
    : qualityCompleted > 0
      ? "incomplete"
      : "not_started";

  if (!qualityReport.canApprove) {
    reasons.push("QUALITY_GATES_INCOMPLETE");
  }

  const db = getDb();
  const depResult = db
    .select({ count: count() })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(and(eq(taskDependencies.taskId, taskId), notInArray(tasks.status, ["done", "approved"])))
    .get();
  const depStatus = (depResult?.count ?? 0) === 0 ? "complete" : "blocked";
  if ((depResult?.count ?? 0) > 0) {
    reasons.push("DEPENDENCIES_PENDING");
  }

  const timeStatus =
    task.actualMinutes !== null && task.actualMinutes > 0 ? "complete" : "not_started";
  if (timeStatus === "not_started" && task.estimatedMinutes) {
    reasons.push("TIME_TRACKING_INCOMPLETE");
  }

  const effortEntriesList = effortRepo.getEffortEntriesByTask(taskId, {
    includeCorrections: false,
  });
  const nonCorrectionEntries = effortEntriesList.filter(
    (e) => e.source !== "correction_adjustment",
  );
  const effortStatus = nonCorrectionEntries.length > 0 ? "complete" : "not_started";
  if (effortStatus === "not_started" && task.estimatedMinutes) {
    reasons.push("EFFORT_LOGGING_INCOMPLETE");
  }

  return {
    canBeApproved: reasons.length === 0,
    reasons,
    requirements: {
      qualityChecklist: { status: qualityStatus, completed: qualityCompleted, total: qualityTotal },
      dependencies: { status: depStatus },
      timeTracking: { status: timeStatus },
      effortLogging: { status: effortStatus },
    },
  };
}

/** Ensures the expected quality checklists exist for a task, creating any that are missing. */
export function ensureTaskChecklists(taskId: string): void {
  qualityRepo.ensureTaskChecklists(taskId);
}

export { seedDefaultTemplates } from "../repositories/qualityGate.js";
