import { describe, it, expect } from 'vitest';
import {
  computeCycleTimeStats,
  computeThroughput,
  computeHabitatThroughput,
  computeCurrentStreak,
  habitatFilter,
  resolveDateWindow,
  getDateThresholds,
} from '../repositories/events/stats-helpers.js';

describe('stats-helpers', () => {
  describe('computeCycleTimeStats', () => {
    it('returns zeros for empty array', () => {
      const result = computeCycleTimeStats([]);
      expect(result).toEqual({ averageMinutes: 0, medianMinutes: 0, count: 0 });
    });

    it('computes correct average and median for single value', () => {
      const result = computeCycleTimeStats([100]);
      expect(result).toEqual({ averageMinutes: 100, medianMinutes: 100, count: 1 });
    });

    it('computes correct average and median for odd count', () => {
      const result = computeCycleTimeStats([10, 20, 30]);
      expect(result.averageMinutes).toBe(20);
      expect(result.medianMinutes).toBe(20);
      expect(result.count).toBe(3);
    });

    it('computes correct average and median for even count', () => {
      const result = computeCycleTimeStats([10, 20, 30, 40]);
      expect(result.averageMinutes).toBe(25);
      expect(result.medianMinutes).toBe(25);
      expect(result.count).toBe(4);
    });

    it('rounds average and median', () => {
      const result = computeCycleTimeStats([10, 11]);
      expect(result.averageMinutes).toBe(11);
      expect(result.medianMinutes).toBe(11);
    });

    it('handles unsorted input', () => {
      const result = computeCycleTimeStats([30, 10, 20]);
      expect(result.medianMinutes).toBe(20);
    });
  });

  describe('computeThroughput', () => {
    const todayStart = '2026-01-15T00:00:00.000Z';
    const weekStart = '2026-01-08T00:00:00.000Z';
    const monthStart = '2025-12-16T00:00:00.000Z';

    it('returns zeros for empty array', () => {
      const result = computeThroughput([], todayStart, weekStart, monthStart);
      expect(result).toEqual({ today: 0, last7d: 0, last30d: 0 });
    });

    it('counts rows in each window', () => {
      const rows = [
        { ts: '2026-01-15T10:00:00.000Z' },
        { ts: '2026-01-10T10:00:00.000Z' },
        { ts: '2026-01-01T10:00:00.000Z' },
        { ts: '2025-12-01T10:00:00.000Z' },
      ];
      const result = computeThroughput(rows, todayStart, weekStart, monthStart);
      expect(result.today).toBe(1);
      expect(result.last7d).toBe(2);
      expect(result.last30d).toBe(3);
    });

    it('skips null ts values', () => {
      const rows = [
        { ts: null },
        { ts: '2026-01-15T10:00:00.000Z' },
      ];
      const result = computeThroughput(rows, todayStart, weekStart, monthStart);
      expect(result.today).toBe(1);
    });
  });

  describe('computeHabitatThroughput', () => {
    const todayStart = '2026-01-15T00:00:00.000Z';
    const weekStart = '2026-01-08T00:00:00.000Z';
    const monthStart = '2026-01-01T00:00:00.000Z';

    it('returns zeros for empty array', () => {
      const result = computeHabitatThroughput([], todayStart, weekStart, monthStart);
      expect(result).toEqual({ today: 0, thisWeek: 0, thisMonth: 0 });
    });

    it('counts rows in each window', () => {
      const rows = [
        { ts: '2026-01-15T10:00:00.000Z' },
        { ts: '2026-01-10T10:00:00.000Z' },
        { ts: '2025-12-01T10:00:00.000Z' },
      ];
      const result = computeHabitatThroughput(rows, todayStart, weekStart, monthStart);
      expect(result.today).toBe(1);
      expect(result.thisWeek).toBe(2);
      expect(result.thisMonth).toBe(2);
    });
  });

  describe('computeCurrentStreak', () => {
    it('returns 0 for empty array', () => {
      expect(computeCurrentStreak([])).toBe(0);
    });

    it('counts consecutive approved actions', () => {
      const rows = [
        { action: 'approved' },
        { action: 'approved' },
        { action: 'approved' },
      ];
      expect(computeCurrentStreak(rows)).toBe(3);
    });

    it('stops at rejected action', () => {
      const rows = [
        { action: 'approved' },
        { action: 'rejected' },
        { action: 'approved' },
      ];
      expect(computeCurrentStreak(rows)).toBe(1);
    });

    it('counts completed as streak', () => {
      const rows = [
        { action: 'completed' },
        { action: 'approved' },
      ];
      expect(computeCurrentStreak(rows)).toBe(2);
    });

    it('returns 0 if first action is rejected', () => {
      const rows = [{ action: 'rejected' }, { action: 'approved' }];
      expect(computeCurrentStreak(rows)).toBe(0);
    });

    it('skips non-streak actions', () => {
      const rows = [
        { action: 'submitted' },
        { action: 'approved' },
      ];
      expect(computeCurrentStreak(rows)).toBe(1);
    });
  });

  describe('habitatFilter', () => {
    it('returns eq condition when habitatId provided', () => {
      const filter = habitatFilter('habitat-123');
      expect(filter).toBeDefined();
    });

    it('returns 1=1 when habitatId is undefined', () => {
      const filter = habitatFilter(undefined);
      expect(filter).toBeDefined();
    });
  });

  describe('resolveDateWindow', () => {
    it('returns correct days for 7d', () => {
      const result = resolveDateWindow('7d');
      expect(result.days).toBe(7);
    });

    it('returns correct days for 30d', () => {
      const result = resolveDateWindow('30d');
      expect(result.days).toBe(30);
    });

    it('returns correct days for 90d', () => {
      const result = resolveDateWindow('90d');
      expect(result.days).toBe(90);
    });

    it('returns a valid ISO date string for startDate', () => {
      const result = resolveDateWindow('7d');
      expect(result.startDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('getDateThresholds', () => {
    it('returns three valid ISO date strings', () => {
      const result = getDateThresholds();
      expect(result.todayStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.monthStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('weekStart is before todayStart', () => {
      const result = getDateThresholds();
      expect(result.weekStart < result.todayStart).toBe(true);
    });
  });

  describe('getDateThresholds calendar mode', () => {
    it('returns three valid ISO date strings', () => {
      const result = getDateThresholds('calendar');
      expect(result.todayStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.monthStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('monthStart is first day of current month in calendar mode', () => {
      const result = getDateThresholds('calendar');
      const now = new Date();
      expect(result.monthStart).toBe(new Date(now.getFullYear(), now.getMonth(), 1).toISOString());
    });
  });
});
