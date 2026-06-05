import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { columns, missions, taskEvents, tasks } from "../db/schema/index.js";
import type { AnalyticsWarning } from "../repositories/cumulativeFlowSnapshot.js";

export type AnalyticsConfidence = "high" | "medium" | "low" | "insufficient_data";

export interface TimeInColumnSummary {
  habitatId: string;
  days: number;
  generatedAt: string;
  columns: TimeInColumnColumnSummary[];
  warnings: AnalyticsWarning[];
}

export interface TimeInColumnColumnSummary {
  columnId: string;
  columnName: string;
  sampleSize: number;
  averageMinutes: number | null;
  medianMinutes: number | null;
  p90Minutes: number | null;
  confidence: AnalyticsConfidence;
}

interface TransitionEventRow {
  taskId: string;
  fromColumnId: string | null;
  toColumnId: string | null;
  timestamp: string;
}

function confidenceForSample(sampleSize: number): AnalyticsConfidence {
  if (sampleSize <= 2) return "insufficient_data";
  if (sampleSize <= 9) return "low";
  if (sampleSize <= 29) return "medium";
  return "high";
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundMinutes(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function computeSamples(rows: TransitionEventRow[]): Map<string, number[]> {
  const byTask = new Map<string, TransitionEventRow[]>();
  for (const row of rows) {
    const events = byTask.get(row.taskId) ?? [];
    events.push(row);
    byTask.set(row.taskId, events);
  }

  const samples = new Map<string, number[]>();
  for (const events of byTask.values()) {
    let activeColumnId: string | null = null;
    let enteredAt: number | null = null;

    for (const event of events.toSorted((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      const timestamp = new Date(event.timestamp).getTime();
      if (!Number.isFinite(timestamp)) continue;

      if (event.fromColumnId && activeColumnId === event.fromColumnId && enteredAt !== null) {
        const minutes = (timestamp - enteredAt) / (60 * 1000);
        if (minutes >= 0) {
          const columnSamples = samples.get(event.fromColumnId) ?? [];
          columnSamples.push(minutes);
          samples.set(event.fromColumnId, columnSamples);
        }
        activeColumnId = null;
        enteredAt = null;
      }

      if (event.toColumnId) {
        activeColumnId = event.toColumnId;
        enteredAt = timestamp;
      }
    }
  }

  return samples;
}

export function getTimeInColumnSummary(habitatId: string, requestedDays = 30): TimeInColumnSummary {
  const db = getDb();
  const days = Math.max(7, Math.min(90, Math.round(requestedDays)));
  const generatedAt = new Date().toISOString();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const lookbackStart = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000).toISOString();
  const columnRows = db
    .select({ columnId: columns.id, columnName: columns.name, order: columns.order })
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(asc(columns.order))
    .all();

  const eventRows = db
    .select({
      taskId: taskEvents.taskId,
      fromColumnId: taskEvents.fromColumnId,
      toColumnId: taskEvents.toColumnId,
      timestamp: taskEvents.timestamp,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        sql`${taskEvents.timestamp} >= ${lookbackStart}`,
        or(isNotNull(taskEvents.fromColumnId), isNotNull(taskEvents.toColumnId)),
      ),
    )
    .orderBy(asc(taskEvents.taskId), asc(taskEvents.timestamp))
    .all();

  const samples = computeSamples(eventRows);
  const warnings: AnalyticsWarning[] = [];
  const summaries = columnRows.map((column) => {
    const sorted = (samples.get(column.columnId) ?? []).toSorted((a, b) => a - b);
    const sampleSize = sorted.length;
    const confidence = confidenceForSample(sampleSize);
    if (confidence === "insufficient_data") {
      warnings.push({
        code: "insufficient_data",
        message: `Column ${column.columnName} has fewer than 3 completed dwell samples.`,
        severity: "info",
      });
    }
    const average =
      sampleSize > 0 ? sorted.reduce((sum, value) => sum + value, 0) / sampleSize : null;
    return {
      columnId: column.columnId,
      columnName: column.columnName,
      sampleSize,
      averageMinutes: roundMinutes(average),
      medianMinutes: roundMinutes(median(sorted)),
      p90Minutes: roundMinutes(percentile(sorted, 90)),
      confidence,
    };
  });

  return { habitatId, days, generatedAt, columns: summaries, warnings };
}
