import { describe, it, expect } from "vitest";
import {
  FINDING_KINDS,
  FINDING_SEVERITIES,
  SIGNAL_TYPES,
  SUGGESTED_BUCKETS,
  findingMetadataSchema,
  type SignalType,
} from "../types/signal.js";

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

describe("findingMetadataSchema", () => {
  it("accepts free-form finding metadata with no structured fields", () => {
    const result = findingMetadataSchema.safeParse({ note: "Token flow changed" });
    expect(result.success).toBe(true);
  });

  it("accepts complete structured finding metadata", () => {
    const result = findingMetadataSchema.safeParse({
      findingKind: "pre_existing_bug",
      severity: "high",
      affectedFiles: ["src/auth/token.ts"],
      blocksCurrentWork: false,
      suggestedBucket: "defer_to_patch",
      releaseImpact: ["v0.21"],
      identifiedDuring: "v0.21 Phase 0",
    });
    expect(result.success).toBe(true);
  });

  it("rejects partial structured metadata with missing fields named", () => {
    const result = findingMetadataSchema.safeParse({ findingKind: "pre_existing_bug" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("severity");
      expect(result.error.message).toContain("affectedFiles");
      expect(result.error.message).toContain("blocksCurrentWork");
    }
  });

  it("rejects invalid enum values", () => {
    const result = findingMetadataSchema.safeParse({
      findingKind: "typo",
      severity: "high",
      affectedFiles: ["src/auth/token.ts"],
      blocksCurrentWork: false,
    });
    expect(result.success).toBe(false);
  });

  it("exports stable runtime arrays", () => {
    expect(FINDING_KINDS).toContain("schema_missing");
    expect(FINDING_SEVERITIES).toEqual(["low", "medium", "high", "critical"]);
    expect(SUGGESTED_BUCKETS).toContain("needs_investigation");
  });
});
