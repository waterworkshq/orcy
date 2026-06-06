export const MS_PER_DAY = 86_400_000;

export function utcDateKey(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

export function daysAgoISO(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

export function utcNowISO(): string {
  return new Date().toISOString();
}

export function diffDays(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.ceil((end - start) / MS_PER_DAY));
}

export function daysUntil(date: string, now: Date = new Date()): number {
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - now.getTime()) / MS_PER_DAY));
}

export function dateRange(days: number, now: Date = new Date()): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(utcDateKey(new Date(now.getTime() - i * MS_PER_DAY)));
  }
  return dates;
}

export type AnalyticsConfidence = "high" | "medium" | "low" | "insufficient_data";

export function confidenceForSample(sampleSize: number): AnalyticsConfidence {
  if (sampleSize <= 2) return "insufficient_data";
  if (sampleSize <= 9) return "low";
  if (sampleSize <= 29) return "medium";
  return "high";
}

export type { AnalyticsWarning } from "../repositories/cumulativeFlowSnapshot.js";
