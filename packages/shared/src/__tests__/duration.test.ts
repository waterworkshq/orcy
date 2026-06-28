import { describe, it, expect } from "vitest";
import { parseDurationWindow } from "../duration.js";

describe("parseDurationWindow", () => {
  const now = new Date("2026-06-28T12:00:00.000Z");

  it("returns null for falsy input", () => {
    expect(parseDurationWindow(undefined, now)).toBeNull();
    expect(parseDurationWindow("", now)).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseDurationWindow("banana", now)).toBeNull();
    expect(parseDurationWindow("7", now)).toBeNull();
    expect(parseDurationWindow("7 fortnights", now)).toBeNull();
  });

  it.each([
    ["7 days", 7 * 24 * 60 * 60_000],
    ["30 days", 30 * 24 * 60 * 60_000],
    ["90 days", 90 * 24 * 60 * 60_000],
    ["12h", 12 * 60 * 60_000],
    ["45m", 45 * 60_000],
    ["2w", 2 * 7 * 24 * 60 * 60_000],
    ["30 seconds", 30_000],
    ["1 day", 24 * 60 * 60_000],
  ])("parses %s into now - duration", (input, expectedMs) => {
    expect(parseDurationWindow(input, now)).toBe(
      new Date(now.getTime() - expectedMs).toISOString(),
    );
  });

  it("is case-insensitive and tolerates singular/plural/abbreviated forms", () => {
    expect(parseDurationWindow("7 DAYS", now)).toBe(parseDurationWindow("7 days", now));
    expect(parseDurationWindow("1 day", now)).toBe(parseDurationWindow("1d", now));
    expect(parseDurationWindow("5 min", now)).toBe(parseDurationWindow("5m", now));
  });

  it("defaults `now` to the current time when omitted", () => {
    const result = parseDurationWindow("7 days");
    expect(result).not.toBeNull();
    // Within a small window of Date.now() - 7 days.
    const approx = Date.now() - 7 * 24 * 60 * 60_000;
    expect(Math.abs(Date.parse(result!) - approx)).toBeLessThan(5000);
  });
});
