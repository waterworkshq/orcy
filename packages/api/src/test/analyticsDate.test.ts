import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  utcDateKey,
  daysAgoISO,
  utcNowISO,
  diffDays,
  daysUntil,
  dateRange,
} from "../services/analyticsDate.js";

describe("analyticsDate", () => {
  describe("MS_PER_DAY", () => {
    it("is 86_400_000 milliseconds", () => {
      expect(MS_PER_DAY).toBe(86_400_000);
      expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe("utcDateKey", () => {
    it("extracts YYYY-MM-DD from a UTC date", () => {
      const date = new Date("2026-06-15T23:59:59.999Z");
      expect(utcDateKey(date)).toBe("2026-06-15");
    });

    it("extracts YYYY-MM-DD from midnight UTC", () => {
      const date = new Date("2026-01-01T00:00:00.000Z");
      expect(utcDateKey(date)).toBe("2026-01-01");
    });
  });

  describe("daysAgoISO", () => {
    it("returns ISO string for N days before the reference date", () => {
      const now = new Date("2026-06-15T12:00:00.000Z");
      const result = daysAgoISO(7, now);
      expect(result).toBe("2026-06-08T12:00:00.000Z");
    });

    it("returns ISO string for 0 days ago (same instant)", () => {
      const now = new Date("2026-06-15T12:00:00.000Z");
      const result = daysAgoISO(0, now);
      expect(result).toBe("2026-06-15T12:00:00.000Z");
    });
  });

  describe("utcNowISO", () => {
    it("returns a valid ISO string", () => {
      const result = utcNowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("diffDays", () => {
    it("computes days between two ISO dates", () => {
      expect(diffDays("2026-06-01T00:00:00.000Z", "2026-06-08T00:00:00.000Z")).toBe(7);
    });

    it("returns at least 1 day", () => {
      expect(diffDays("2026-06-01T00:00:00.000Z", "2026-06-01T12:00:00.000Z")).toBe(1);
    });

    it("returns 1 for invalid dates", () => {
      expect(diffDays("invalid", "2026-06-08T00:00:00.000Z")).toBe(1);
    });
  });

  describe("daysUntil", () => {
    it("computes days until a future date", () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      expect(daysUntil("2026-06-08T00:00:00.000Z", now)).toBe(7);
    });

    it("returns 0 for past dates", () => {
      const now = new Date("2026-06-15T00:00:00.000Z");
      expect(daysUntil("2026-06-01T00:00:00.000Z", now)).toBe(0);
    });

    it("returns 0 for invalid dates", () => {
      expect(daysUntil("invalid")).toBe(0);
    });
  });

  describe("dateRange", () => {
    it("generates N consecutive UTC date keys ending at today", () => {
      const now = new Date("2026-06-15T12:00:00.000Z");
      const range = dateRange(3, now);
      expect(range).toEqual(["2026-06-13", "2026-06-14", "2026-06-15"]);
    });

    it("generates a single-element range", () => {
      const now = new Date("2026-06-15T00:00:00.000Z");
      const range = dateRange(1, now);
      expect(range).toEqual(["2026-06-15"]);
    });

    it("generates 30-day range", () => {
      const now = new Date("2026-06-30T00:00:00.000Z");
      const range = dateRange(30, now);
      expect(range).toHaveLength(30);
      expect(range[0]).toBe("2026-06-01");
      expect(range[29]).toBe("2026-06-30");
    });
  });
});
