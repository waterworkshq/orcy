import { describe, it, expect } from "vitest";
import { SIGNAL_TYPES, type SignalType } from "../types/signal.js";

describe("SIGNAL_TYPES (canonical shared const)", () => {
  it("includes all 9 original signal types", () => {
    expect(SIGNAL_TYPES).toEqual([
      "finding",
      "blocker",
      "offer",
      "warning",
      "question",
      "answer",
      "directive",
      "context",
      "handoff",
      "experience",
    ]);
  });

  it("includes the v0.20 experience self-reporting type", () => {
    expect(SIGNAL_TYPES).toContain("experience");
  });

  it("has exactly 10 values (no drift)", () => {
    expect(SIGNAL_TYPES).toHaveLength(10);
  });

  it("contains no duplicates", () => {
    expect(new Set(SIGNAL_TYPES).size).toBe(SIGNAL_TYPES.length);
  });

  it("exposes SignalType as a union including experience", () => {
    const sample: SignalType = "experience";
    expect(sample).toBe("experience");
  });
});
