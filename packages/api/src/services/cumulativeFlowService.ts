import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { columns, missions, tasks } from "../db/schema/index.js";
import * as snapshotRepo from "../repositories/cumulativeFlowSnapshot.js";
import type { AnalyticsWarning } from "../repositories/cumulativeFlowSnapshot.js";

export interface CumulativeFlowResponse {
  habitatId: string;
  days: number;
  generatedAt: string;
  columns: Array<{ columnId: string; name: string; order: number }>;
  data: CumulativeFlowPoint[];
  warnings: AnalyticsWarning[];
}

export interface CumulativeFlowPoint {
  date: string;
  countsByColumn: Record<string, number>;
  countsByStatus: Record<string, number>;
  interpolated?: boolean;
}

function dateKey(date: Date): string {
  return date.toISOString().split("T")[0];
}

function dateRange(days: number, now = new Date()): string[] {
  const msDay = 24 * 60 * 60 * 1000;
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(dateKey(new Date(now.getTime() - i * msDay)));
  }
  return dates;
}

function normalizeCounts(
  counts: Record<string, number> | null | undefined,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    normalized[key] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }
  return normalized;
}

function zeroColumnCounts(columnRows: Array<{ columnId: string }>): Record<string, number> {
  return Object.fromEntries(columnRows.map((column) => [column.columnId, 0]));
}

function getColumns(habitatId: string): Array<{ columnId: string; name: string; order: number }> {
  return getDb()
    .select({ columnId: columns.id, name: columns.name, order: columns.order })
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(asc(columns.order))
    .all();
}

function getCurrentStatePoint(
  habitatId: string,
  currentDate: string,
  columnRows: Array<{ columnId: string }>,
): CumulativeFlowPoint {
  const db = getDb();
  const columnCounts = zeroColumnCounts(columnRows);
  const missionRows = db
    .select({ columnId: missions.columnId, count: sql<number>`count(*)` })
    .from(missions)
    .where(and(eq(missions.habitatId, habitatId), eq(missions.isArchived, false)))
    .groupBy(missions.columnId)
    .all();
  for (const row of missionRows) {
    columnCounts[row.columnId] = row.count ?? 0;
  }

  const taskStatusRows = db
    .select({ status: tasks.status, count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.habitatId, habitatId))
    .groupBy(tasks.status)
    .all();
  const countsByStatus: Record<string, number> = {};
  for (const row of taskStatusRows) {
    countsByStatus[row.status] = row.count ?? 0;
  }

  return { date: currentDate, countsByColumn: columnCounts, countsByStatus };
}

function addWarning(warnings: AnalyticsWarning[], warning: AnalyticsWarning): void {
  if (warnings.some((existing) => existing.code === warning.code)) return;
  warnings.push(warning);
}

export function getCumulativeFlow(habitatId: string, requestedDays = 30): CumulativeFlowResponse {
  const days = Math.max(7, Math.min(90, Math.round(requestedDays)));
  const generatedAt = new Date().toISOString();
  const dates = dateRange(days, new Date(generatedAt));
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];
  const columnRows = getColumns(habitatId);
  const snapshots = snapshotRepo.listSnapshotsForRange(habitatId, startDate, endDate);
  const byDate = new Map(snapshots.map((snapshot) => [snapshot.snapshotDate, snapshot]));
  const warnings: AnalyticsWarning[] = [];
  const data: CumulativeFlowPoint[] = [];
  let lastKnown: {
    countsByColumn: Record<string, number>;
    countsByStatus: Record<string, number>;
  } | null = null;

  for (const date of dates) {
    const snapshot = byDate.get(date);
    if (snapshot) {
      const point = {
        date,
        countsByColumn: normalizeCounts(snapshot.countsByColumn),
        countsByStatus: normalizeCounts(snapshot.countsByStatus),
      };
      data.push(point);
      lastKnown = { countsByColumn: point.countsByColumn, countsByStatus: point.countsByStatus };
      if (snapshot.completeness === "partial") {
        addWarning(warnings, {
          code: "partial_history",
          message: "One or more cumulative-flow snapshots are marked partial.",
          severity: "warning",
        });
      }
      for (const warning of snapshot.warnings ?? []) addWarning(warnings, warning);
      continue;
    }

    if (date === endDate) {
      data.push(getCurrentStatePoint(habitatId, date, columnRows));
      addWarning(warnings, {
        code: "current_state_projection",
        message:
          "The current day is projected from live board state because no daily snapshot exists yet.",
        severity: "info",
      });
    } else if (lastKnown) {
      data.push({
        date,
        countsByColumn: { ...lastKnown.countsByColumn },
        countsByStatus: { ...lastKnown.countsByStatus },
        interpolated: true,
      });
      addWarning(warnings, {
        code: "interpolated_history",
        message: "Some days carry forward the most recent known snapshot.",
        severity: "info",
      });
    } else {
      data.push({ date, countsByColumn: zeroColumnCounts(columnRows), countsByStatus: {} });
      addWarning(warnings, {
        code: "partial_history",
        message: "Some requested days do not have captured cumulative-flow snapshots.",
        severity: "warning",
      });
    }
  }

  return { habitatId, days, generatedAt, columns: columnRows, data, warnings };
}
