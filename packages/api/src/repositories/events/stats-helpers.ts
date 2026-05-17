import { eq, sql } from 'drizzle-orm';
import { missions } from '../../db/schema/index.js';

export function boardFilter(boardId: string | undefined) {
  return boardId ? eq(missions.habitatId, boardId) : sql`1=1`;
}

export function resolveDateWindow(period: '7d' | '30d' | '90d'): { days: number; startDate: string } {
  const periodDays: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
  const days = periodDays[period];
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return { days, startDate };
}

export function computeCycleTimeStats(cycleTimes: number[]): {
  averageMinutes: number;
  medianMinutes: number;
  count: number;
} {
  const sorted = [...cycleTimes].sort((a, b) => a - b);
  const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const median =
    sorted.length > 0
      ? sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)]
      : 0;
  return {
    averageMinutes: Math.round(avg),
    medianMinutes: Math.round(median),
    count: sorted.length,
  };
}

export function computeThroughput(
  rows: { ts: string | null }[],
  todayStart: string,
  weekStart: string,
  monthStart: string,
): { today: number; last7d: number; last30d: number } {
  let today = 0,
    last7d = 0,
    last30d = 0;
  for (const row of rows) {
    if (row.ts && row.ts >= todayStart) today++;
    if (row.ts && row.ts >= weekStart) last7d++;
    if (row.ts && row.ts >= monthStart) last30d++;
  }
  return { today, last7d, last30d };
}

export function computeBoardThroughput(
  rows: { ts: string }[],
  todayStart: string,
  weekStart: string,
  monthStart: string,
): { today: number; thisWeek: number; thisMonth: number } {
  let today = 0,
    thisWeek = 0,
    thisMonth = 0;
  for (const row of rows) {
    if (row.ts >= todayStart) today++;
    if (row.ts >= weekStart) thisWeek++;
    if (row.ts >= monthStart) thisMonth++;
  }
  return { today, thisWeek, thisMonth };
}

export function computeCurrentStreak(rows: { action: string }[]): number {
  let currentStreak = 0;
  for (const row of rows) {
    if (row.action === 'rejected') break;
    if (row.action === 'approved' || row.action === 'completed') currentStreak++;
  }
  return currentStreak;
}

export type DateWindowMode = 'rolling' | 'calendar';

export function getDateThresholds(mode: DateWindowMode = 'rolling'): {
  todayStart: string;
  weekStart: string;
  monthStart: string;
} {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthStart =
    mode === 'calendar'
      ? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { todayStart, weekStart, monthStart };
}
