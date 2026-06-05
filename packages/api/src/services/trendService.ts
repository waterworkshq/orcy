import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { missions, tasks } from "../db/schema/index.js";

export type TrendConfidence = "high" | "medium" | "low" | "insufficient_data";
export type TrendDirection = "improving" | "worsening" | "stable" | "unknown";

export interface MetricTrend {
  metric: "throughput" | "cycle_time";
  current: number;
  previous: number;
  absoluteDelta: number;
  relativeDelta: number | null;
  direction: TrendDirection;
  sampleSize: number;
  confidence: TrendConfidence;
}

export interface HabitatTrends {
  habitatId: string;
  periodDays: number;
  generatedAt: string;
  trends: MetricTrend[];
}

function confidenceForSample(sampleSize: number): TrendConfidence {
  if (sampleSize <= 2) return "insufficient_data";
  if (sampleSize <= 9) return "low";
  if (sampleSize <= 29) return "medium";
  return "high";
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function compareMetric(
  metric: MetricTrend["metric"],
  current: number,
  previous: number,
  sampleSize: number,
  lowerIsBetter: boolean,
): MetricTrend {
  const absoluteDelta = rounded(current - previous);
  const relativeDelta = previous === 0 ? null : rounded(absoluteDelta / previous);
  const confidence = confidenceForSample(sampleSize);
  let direction: TrendDirection = "unknown";

  if (confidence !== "insufficient_data") {
    if (Math.abs(absoluteDelta) < 0.01) {
      direction = "stable";
    } else {
      const improved = lowerIsBetter ? absoluteDelta < 0 : absoluteDelta > 0;
      direction = improved ? "improving" : "worsening";
    }
  }

  return {
    metric,
    current: rounded(current),
    previous: rounded(previous),
    absoluteDelta,
    relativeDelta,
    direction,
    sampleSize,
    confidence,
  };
}

function windowBounds(periodDays: number): {
  currentStart: string;
  previousStart: string;
  currentEnd: string;
} {
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;
  return {
    currentStart: new Date(now - periodDays * msDay).toISOString(),
    previousStart: new Date(now - periodDays * 2 * msDay).toISOString(),
    currentEnd: new Date(now).toISOString(),
  };
}

function countCompleted(habitatId: string, start: string, end: string): number {
  const db = getDb();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} >= ${start}`,
        sql`${tasks.completedAt} < ${end}`,
      ),
    )
    .get();
  return row?.count ?? 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianCycleMinutes(
  habitatId: string,
  start: string,
  end: string,
): {
  value: number;
  sampleSize: number;
} {
  const db = getDb();
  const rows = db
    .select({
      minutes: sql<number>`round((julianday(${tasks.completedAt}) - julianday(${tasks.claimedAt})) * 1440)`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.claimedAt),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} >= ${start}`,
        sql`${tasks.completedAt} < ${end}`,
      ),
    )
    .all();

  const samples = rows.map((r) => r.minutes).filter((m) => m > 0);
  return {
    value: samples.length > 0 ? median(samples) : 0,
    sampleSize: samples.length,
  };
}

export function getHabitatTrends(habitatId: string, periodDays = 7): HabitatTrends {
  const days = Math.max(1, Math.min(90, Math.round(periodDays)));
  const { currentStart, previousStart, currentEnd } = windowBounds(days);
  const currentCompleted = countCompleted(habitatId, currentStart, currentEnd);
  const previousCompleted = countCompleted(habitatId, previousStart, currentStart);
  const currentCycle = medianCycleMinutes(habitatId, currentStart, currentEnd);
  const previousCycle = medianCycleMinutes(habitatId, previousStart, currentStart);

  return {
    habitatId,
    periodDays: days,
    generatedAt: currentEnd,
    trends: [
      compareMetric(
        "throughput",
        currentCompleted / days,
        previousCompleted / days,
        currentCompleted + previousCompleted,
        false,
      ),
      compareMetric(
        "cycle_time",
        currentCycle.value,
        previousCycle.value,
        currentCycle.sampleSize + previousCycle.sampleSize,
        true,
      ),
    ],
  };
}
