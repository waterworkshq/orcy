import { and, eq, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/index.js";
import { columns, missions, taskDependencies, tasks } from "../db/schema/index.js";
import type { AnalyticsWarning } from "../repositories/cumulativeFlowSnapshot.js";
import { getTimeInColumnSummary, type AnalyticsConfidence } from "./timeInColumnService.js";
import { utcNowISO } from "./analyticsDate.js";

export interface BottleneckReport {
  habitatId: string;
  days: number;
  generatedAt: string;
  bottlenecks: BottleneckFinding[];
  warnings: AnalyticsWarning[];
}

export interface BottleneckFinding {
  columnId?: string;
  columnName?: string;
  missionId?: string;
  severity: "low" | "medium" | "high" | "critical";
  signal: "dwell_time" | "wip_exceeded" | "blocked_dependencies";
  confidence: AnalyticsConfidence;
  summary: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}

function dwellSeverity(minutes: number): BottleneckFinding["severity"] {
  if (minutes >= 3 * 24 * 60) return "high";
  if (minutes >= 24 * 60) return "medium";
  return "low";
}

function wipSeverity(current: number, limit: number): BottleneckFinding["severity"] {
  const ratio = current / Math.max(limit, 1);
  if (ratio >= 2) return "high";
  if (ratio > 1.25) return "medium";
  return "low";
}

export function getBottlenecks(habitatId: string, requestedDays = 30): BottleneckReport {
  const db = getDb();
  const dependencyTask = alias(tasks, "dependency_task");
  const days = Math.max(7, Math.min(90, Math.round(requestedDays)));
  const generatedAt = utcNowISO();
  const warnings: AnalyticsWarning[] = [];
  const bottlenecks: BottleneckFinding[] = [];
  const dwell = getTimeInColumnSummary(habitatId, days);
  warnings.push(...dwell.warnings);

  for (const column of dwell.columns) {
    if (column.confidence === "insufficient_data" || column.averageMinutes === null) continue;
    if (column.averageMinutes >= 24 * 60) {
      bottlenecks.push({
        columnId: column.columnId,
        columnName: column.columnName,
        severity: dwellSeverity(column.averageMinutes),
        signal: "dwell_time",
        confidence: column.confidence,
        summary: `${column.columnName} averages ${Math.round(column.averageMinutes / 60)}h of dwell time.`,
        evidence: {
          sampleSize: column.sampleSize,
          averageMinutes: column.averageMinutes,
          medianMinutes: column.medianMinutes,
          p90Minutes: column.p90Minutes,
        },
        recommendation:
          "Review work in this column and reduce handoff or review delay before starting more work.",
      });
    }
  }

  const wipRows = db
    .select({
      columnId: columns.id,
      columnName: columns.name,
      wipLimit: columns.wipLimit,
      current: sql<number>`count(${missions.id})`,
    })
    .from(columns)
    .leftJoin(missions, and(eq(missions.columnId, columns.id), eq(missions.isArchived, false)))
    .where(eq(columns.habitatId, habitatId))
    .groupBy(columns.id)
    .all();

  for (const row of wipRows) {
    if (row.wipLimit === null || row.wipLimit === 0 || row.current <= row.wipLimit) continue;
    bottlenecks.push({
      columnId: row.columnId,
      columnName: row.columnName,
      severity: wipSeverity(row.current, row.wipLimit),
      signal: "wip_exceeded",
      confidence: "high",
      summary: `${row.columnName} has ${row.current} missions against a WIP limit of ${row.wipLimit}.`,
      evidence: { currentCount: row.current, wipLimit: row.wipLimit },
      recommendation:
        "Finish or unblock existing work before pulling more missions into this column.",
    });
  }

  const blockedRows = db
    .select({ missionId: missions.id, count: sql<number>`count(distinct ${tasks.id})` })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .innerJoin(dependencyTask, eq(taskDependencies.dependsOnId, dependencyTask.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        notInArray(dependencyTask.status, ["approved", "done"]),
        sql`${missions.isArchived} IS NOT TRUE`,
      ),
    )
    .groupBy(missions.id)
    .all();

  for (const row of blockedRows) {
    if (row.count <= 0) continue;
    bottlenecks.push({
      missionId: row.missionId,
      severity: row.count >= 3 ? "high" : row.count >= 2 ? "medium" : "low",
      signal: "blocked_dependencies",
      confidence: "high",
      summary: `${row.count} task${row.count === 1 ? "" : "s"} blocked by unfinished dependencies.`,
      evidence: { blockedTaskCount: row.count },
      recommendation:
        "Resolve dependency tasks first or split blocked work into a follow-up mission.",
    });
  }

  return { habitatId, days, generatedAt, bottlenecks, warnings };
}
