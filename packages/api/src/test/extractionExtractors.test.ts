/**
 * Learning Loop built-in extractors — pure-function tests.
 *
 * Proves each detector produces candidates of the right finding type,
 * rule recommendations are prose-only (no structured payload), and the
 * extractor is deterministic over the same input.
 */
import { describe, it, expect } from "vitest";
import {
  runBuiltinExtractor,
  BUILTIN_EXTRACTOR_KEY,
  BUILTIN_EXTRACTOR_VERSION,
} from "../services/extractionExtractors.js";
import type { ExtractionObservation } from "../services/extractionSourceCatalog/types.js";
import type { ExtractionCandidate } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Observation factory
// ---------------------------------------------------------------------------

function makeObservation(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return {
    observationId: `obs-${Math.random().toString(36).slice(2, 10)}`,
    sourceType: "task_lifecycle_audit",
    underlyingId: `row-${Math.random().toString(36).slice(2, 10)}`,
    occurredAt: "2026-06-01T12:00:00Z",
    entityRefs: [{ type: "task", id: "task-001" }, { type: "mission", id: "mission-001" }],
    domains: [],
    digest: `dig-${Math.random().toString(36).slice(2, 10)}`,
    contractVersion: "test-v1",
    collectorFamily: "lifecycle",
    habitatId: "hab-A",
    visibilityClass: "habitat_member",
    ...overrides,
  };
}

function makeAutomationRunObs(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return makeObservation({
    sourceType: "automation_run_audit",
    underlyingId: `run-${Math.random().toString(36).slice(2, 10)}`,
    collectorFamily: "automation",
    entityRefs: [{ type: "automation_run", id: `ar-${Math.random().toString(36).slice(2, 10)}` }],
    ...overrides,
  });
}

function makePluginRunObs(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return makeObservation({
    sourceType: "plugin_run_audit",
    underlyingId: `prun-${Math.random().toString(36).slice(2, 10)}`,
    collectorFamily: "detector",
    entityRefs: [{ type: "plugin_run", id: `pr-${Math.random().toString(36).slice(2, 10)}` }],
    ...overrides,
  });
}

function makeTriageObs(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return makeObservation({
    sourceType: "triage_resolution",
    underlyingId: `tri-${Math.random().toString(36).slice(2, 10)}`,
    collectorFamily: "triage",
    entityRefs: [],
    ...overrides,
  });
}

function makeExperienceObs(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return makeObservation({
    sourceType: "experience_aggregate",
    underlyingId: `exp_agg:${Math.random().toString(36).slice(2, 10)}`,
    collectorFamily: "experience",
    entityRefs: [],
    visibilityClass: "aggregate_only",
    occurredAt: "2026-06-01T00:00:00Z",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop built-in extractors", () => {
  it("BUILTIN_EXTRACTOR_KEY and VERSION are stable", () => {
    expect(BUILTIN_EXTRACTOR_KEY).toBe("builtin.pattern");
    expect(BUILTIN_EXTRACTOR_VERSION).toBe(1);
  });

  it("produces lesson candidates from task lifecycle patterns", () => {
    // 4 observations for the same task → ≥3 events → lesson detected.
    const observations = [
      makeObservation({ observationId: "obs-1" }),
      makeObservation({ observationId: "obs-2", underlyingId: "row-2", occurredAt: "2026-06-02T12:00:00Z" }),
      makeObservation({ observationId: "obs-3", underlyingId: "row-3", occurredAt: "2026-06-03T12:00:00Z" }),
      makeObservation({ observationId: "obs-4", underlyingId: "row-4", occurredAt: "2026-06-04T12:00:00Z" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    const lessons = candidates.filter((c) => c.findingType === "lesson");
    expect(lessons.length).toBeGreaterThanOrEqual(1);
    expect(lessons[0]!.citations.length).toBeGreaterThanOrEqual(1);
    // Every cited observationId must exist in the batch.
    for (const cite of lessons[0]!.citations) {
      expect(observations.some((o) => o.observationId === cite.observationId)).toBe(true);
    }
  });

  it("produces risk candidates from automation run batches", () => {
    const observations = [
      makeAutomationRunObs({ observationId: "ar-1" }),
      makeAutomationRunObs({ observationId: "ar-2" }),
      makeAutomationRunObs({ observationId: "ar-3" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    const risks = candidates.filter((c) => c.findingType === "risk");
    expect(risks.length).toBeGreaterThanOrEqual(1);
  });

  it("produces anomaly candidates from concentrated plugin runs", () => {
    // 4 plugin runs from the same family → >80% concentration → anomaly.
    const observations = [
      makePluginRunObs({ observationId: "pr-1", collectorFamily: "detector" }),
      makePluginRunObs({ observationId: "pr-2", collectorFamily: "detector" }),
      makePluginRunObs({ observationId: "pr-3", collectorFamily: "detector" }),
      makePluginRunObs({ observationId: "pr-4", collectorFamily: "detector" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    const anomalies = candidates.filter((c) => c.findingType === "anomaly");
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("produces rule_recommendation candidates that are PROSE-ONLY", () => {
    const observations = [
      makeTriageObs({ observationId: "tri-1" }),
      makeTriageObs({ observationId: "tri-2", underlyingId: "tri-2" }),
      makeTriageObs({ observationId: "tri-3", underlyingId: "tri-3" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    const ruleRecs = candidates.filter((c) => c.findingType === "rule_recommendation");
    expect(ruleRecs.length).toBeGreaterThanOrEqual(1);

    // PROSE-ONLY: structuredPayload must be null.
    for (const rec of ruleRecs) {
      expect(rec.structuredPayload).toBeNull();
    }
  });

  it("produces knowledge_draft candidates from experience aggregates", () => {
    const observations = [
      makeExperienceObs({ observationId: "exp-1" }),
      makeExperienceObs({ observationId: "exp-2", underlyingId: "exp_agg:b" }),
      makeExperienceObs({ observationId: "exp-3", underlyingId: "exp_agg:c" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    const drafts = candidates.filter((c) => c.findingType === "knowledge_draft");
    expect(drafts.length).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic — same input produces same output", () => {
    const observations = [
      makeObservation({ observationId: "obs-1" }),
      makeObservation({ observationId: "obs-2", underlyingId: "row-2" }),
      makeObservation({ observationId: "obs-3", underlyingId: "row-3" }),
    ];

    const ctx = { observations, policyConfig: {}, habitatId: "hab-A" };
    const result1 = runBuiltinExtractor(ctx);
    const result2 = runBuiltinExtractor(ctx);

    expect(result1.length).toBe(result2.length);
    expect(result1.map((c) => c.clientKey)).toEqual(result2.map((c) => c.clientKey));
  });

  it("returns empty array for empty observations", () => {
    const candidates = runBuiltinExtractor({
      observations: [],
      policyConfig: {},
      habitatId: "hab-A",
    });
    expect(candidates).toEqual([]);
  });

  it("every candidate has ≥1 citation", () => {
    const observations = [
      makeObservation({ observationId: "obs-1" }),
      makeObservation({ observationId: "obs-2", underlyingId: "row-2" }),
      makeObservation({ observationId: "obs-3", underlyingId: "row-3" }),
      makeObservation({ observationId: "obs-4", underlyingId: "row-4" }),
    ];

    const candidates = runBuiltinExtractor({
      observations,
      policyConfig: {},
      habitatId: "hab-A",
    });

    for (const c of candidates) {
      expect(c.citations.length).toBeGreaterThanOrEqual(1);
    }
  });
});
