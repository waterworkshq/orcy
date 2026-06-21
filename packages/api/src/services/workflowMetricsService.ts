import { getDb } from "../db/index.js";
import { workflows, taskWorkflowGates, failureContexts } from "../db/schema/index.js";
import { eq, and, count, gt, isNotNull, sql } from "drizzle-orm";
import { daysAgoISO } from "./analyticsDate.js";

/** Recovery attempt count grouped by recovery depth (0 = original failure, 1+ = recovery attempts). */
export interface RecoveryAttemptByDepth {
  recoveryDepth: number;
  total: number;
}

/** Workflow health metrics for the admin dashboard. */
export interface WorkflowMetricsResult {
  activeWorkflowsCount: number;
  failureRate: number;
  recoverySuccessRate: number;
  recoveryAttemptsByDepth: RecoveryAttemptByDepth[];
  generatedAt: string;
}

/** Computes workflow health metrics (active count, failure rate, recovery success rate, depth distribution) for a habitat within a trailing-day window. */
export function getWorkflowMetrics(habitatId: string, days = 30): WorkflowMetricsResult {
  const db = getDb();
  const since = days && days > 0 ? daysAgoISO(days) : undefined;

  const activeWorkflowsRows = db
    .select({ total: count() })
    .from(workflows)
    .where(and(eq(workflows.habitatId, habitatId), eq(workflows.status, "active")))
    .all();
  const activeWorkflowsCount = activeWorkflowsRows[0]?.total ?? 0;

  const gateConditions = [eq(taskWorkflowGates.habitatId, habitatId)];
  if (since) {
    gateConditions.push(gt(taskWorkflowGates.createdAt, since));
  }

  const totalTasksRows = db
    .select({ total: sql<number>`COUNT(DISTINCT ${taskWorkflowGates.downstreamTaskId})` })
    .from(taskWorkflowGates)
    .where(and(...gateConditions))
    .all();
  const totalTasksInWorkflows = totalTasksRows[0]?.total ?? 0;

  const failedTasksRows = db
    .select({
      total: sql<number>`COUNT(DISTINCT ${taskWorkflowGates.downstreamTaskId})`,
    })
    .from(taskWorkflowGates)
    .where(
      and(
        ...gateConditions,
        eq(taskWorkflowGates.gateType, "on_fail"),
        eq(taskWorkflowGates.satisfied, true),
      ),
    )
    .all();
  const failedTasksCount = failedTasksRows[0]?.total ?? 0;
  const failureRate =
    totalTasksInWorkflows > 0
      ? Math.round((failedTasksCount / totalTasksInWorkflows) * 100) / 100
      : 0;

  const ctxConditions = [eq(failureContexts.habitatId, habitatId)];
  if (since) {
    ctxConditions.push(gt(failureContexts.failedAt, since));
  }

  const resolvedRows = db
    .select({ total: count() })
    .from(failureContexts)
    .where(and(...ctxConditions, isNotNull(failureContexts.resolvedAt)))
    .all();
  const resolvedCount = resolvedRows[0]?.total ?? 0;

  const redeemedRows = db
    .select({ total: count() })
    .from(failureContexts)
    .where(
      and(
        ...ctxConditions,
        isNotNull(failureContexts.resolvedAt),
        eq(failureContexts.resolutionKind, "redeemed"),
      ),
    )
    .all();
  const redeemedCount = redeemedRows[0]?.total ?? 0;
  const recoverySuccessRate =
    resolvedCount > 0 ? Math.round((redeemedCount / resolvedCount) * 100) / 100 : 0;

  const depthRows = db
    .select({
      recoveryDepth: failureContexts.recoveryDepth,
      total: count(),
    })
    .from(failureContexts)
    .where(and(...ctxConditions))
    .groupBy(failureContexts.recoveryDepth)
    .all();
  const recoveryAttemptsByDepth = depthRows.map((r) => ({
    recoveryDepth: r.recoveryDepth,
    total: r.total,
  }));

  return {
    activeWorkflowsCount,
    failureRate,
    recoverySuccessRate,
    recoveryAttemptsByDepth,
    generatedAt: new Date().toISOString(),
  };
}
