/** Milliseconds in one UTC day, used for day-based date arithmetic across analytics utilities. */
export const MS_PER_DAY = 86_400_000;

/** Formats a date as a UTC YYYY-MM-DD key for bucketing analytics by day. */
export function utcDateKey(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

/** Returns an ISO timestamp offset backwards from `now` by the given number of days. */
export function daysAgoISO(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/** Returns the current time as an ISO 8601 UTC string. */
export function utcNowISO(): string {
  return new Date().toISOString();
}

/** Returns the number of whole days between two ISO dates, clamped to a minimum of 1. */
export function diffDays(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.ceil((end - start) / MS_PER_DAY));
}

/** Returns whole days remaining until a future ISO date, clamped to a minimum of 0. */
export function daysUntil(date: string, now: Date = new Date()): number {
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - now.getTime()) / MS_PER_DAY));
}

/** Builds a list of UTC date keys spanning the last `days` days ending at `now`, oldest first. */
export function dateRange(days: number, now: Date = new Date()): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(utcDateKey(new Date(now.getTime() - i * MS_PER_DAY)));
  }
  return dates;
}

/** Confidence tier assigned to an analytics result based on how much sample data backs it. */
export type AnalyticsConfidence = "high" | "medium" | "low" | "insufficient_data";

/** Maps a sample size to an {@link AnalyticsConfidence} tier using fixed thresholds. */
export function confidenceForSample(sampleSize: number): AnalyticsConfidence {
  if (sampleSize <= 2) return "insufficient_data";
  if (sampleSize <= 9) return "low";
  if (sampleSize <= 29) return "medium";
  return "high";
}

export type { AnalyticsWarning } from "../repositories/cumulativeFlowSnapshot.js";
