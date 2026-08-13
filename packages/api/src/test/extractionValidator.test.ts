/**
 * Learning Loop candidate validator — pure-function tests.
 *
 * Each test injects a specific defect and proves the validator catches it.
 * The validator must be able to fail for each defect it claims to catch.
 */
import { describe, it, expect } from "vitest";
import { validateCandidate, mostRestrictiveVisibility } from "../services/extractionValidator.js";
import type { ExtractionObservation } from "../services/extractionSourceCatalog/types.js";
import type { ExtractionCandidate, LearningLoopPolicyRow } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeObservation(overrides: Partial<ExtractionObservation> = {}): ExtractionObservation {
  return {
    observationId: "obs-valid-1",
    sourceType: "task_lifecycle_audit",
    underlyingId: "row-1",
    occurredAt: "2026-06-01T12:00:00Z",
    entityRefs: [{ type: "task", id: "task-001" }],
    domains: [],
    digest: "dig-1",
    contractVersion: "test-v1",
    collectorFamily: "lifecycle",
    habitatId: "hab-A",
    visibilityClass: "habitat_member",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<ExtractionCandidate> = {}): ExtractionCandidate {
  return {
    clientKey: "test-candidate",
    findingType: "lesson",
    subject: "Test subject",
    body: "Test body",
    structuredPayload: undefined,
    confidence: 0.8,
    sampleSize: 5,
    completeness: "complete",
    caveats: [],
    citations: [{ observationId: "obs-valid-1", role: "supporting" }],
    ...overrides,
  };
}

function makePolicy(overrides: Partial<LearningLoopPolicyRow> = {}): LearningLoopPolicyRow {
  return {
    id: "pol-1",
    habitatId: "hab-A",
    extractorKey: "builtin.pattern",
    enabled: true,
    sourceTypes: ["task_lifecycle_audit"],
    schedule: "0 */5 * * *",
    windowSeconds: 3600,
    lookbackSeconds: 86400,
    minConfidence: null,
    minSampleSize: null,
    config: {},
    version: 1,
    createdByType: "human",
    createdById: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeBatch(...observations: ExtractionObservation[]): Map<string, ExtractionObservation> {
  const map = new Map<string, ExtractionObservation>();
  for (const obs of observations) {
    map.set(obs.observationId, obs);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop candidate validator", () => {
  // -------------------------------------------------------------------------
  // 1. Zero-citation rejection
  // -------------------------------------------------------------------------

  it("rejects a candidate with zero citations", () => {
    const result = validateCandidate(
      makeCandidate({ citations: [] }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("zero_citations");
  });

  // -------------------------------------------------------------------------
  // 2. Fabricated observation ID rejection
  // -------------------------------------------------------------------------

  it("rejects a candidate citing a non-existent observation ID", () => {
    const result = validateCandidate(
      makeCandidate({ citations: [{ observationId: "obs-fabricated", role: "supporting" }] }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("fabricated_observation_id"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. Cross-Habitat citation rejection
  // -------------------------------------------------------------------------

  it("rejects a candidate citing a cross-habitat observation", () => {
    const crossObs = makeObservation({ observationId: "obs-cross", habitatId: "hab-B" });
    const result = validateCandidate(
      makeCandidate({ citations: [{ observationId: "obs-cross", role: "supporting" }] }),
      makeBatch(crossObs),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("cross_habitat_citation"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Feedback-source exclusion
  // -------------------------------------------------------------------------

  it("rejects a candidate citing a Learning Loop feedback source", () => {
    const feedbackObs = makeObservation({
      observationId: "obs-feedback",
      sourceType: "extraction_work_item" as ExtractionObservation["sourceType"],
      underlyingId: "extraction_work_item:abc",
    });
    const result = validateCandidate(
      makeCandidate({ citations: [{ observationId: "obs-feedback", role: "supporting" }] }),
      makeBatch(feedbackObs),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("feedback_source_citation"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Confidence below threshold
  // -------------------------------------------------------------------------

  it("rejects a candidate below the policy confidence threshold", () => {
    const result = validateCandidate(
      makeCandidate({ confidence: 0.3 }),
      makeBatch(makeObservation()),
      makePolicy({ minConfidence: 0.7 }),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("confidence_below_threshold"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. Sample-size below threshold
  // -------------------------------------------------------------------------

  it("rejects a candidate below the policy sample-size threshold", () => {
    const result = validateCandidate(
      makeCandidate({ sampleSize: 2 }),
      makeBatch(makeObservation()),
      makePolicy({ minSampleSize: 5 }),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("sample_size_below_threshold"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Rule recommendation with structured payload
  // -------------------------------------------------------------------------

  it("rejects a rule_recommendation with a machine-readable structured payload", () => {
    const result = validateCandidate(
      makeCandidate({
        findingType: "rule_recommendation",
        structuredPayload: { trigger: "task_completed", action: "send_notification" },
      }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("rule_recommendation_has_structured_payload");
  });

  // -------------------------------------------------------------------------
  // 8. Rule recommendation prose-only is accepted
  // -------------------------------------------------------------------------

  it("accepts a prose-only rule_recommendation (null structuredPayload)", () => {
    const result = validateCandidate(
      makeCandidate({
        findingType: "rule_recommendation",
        structuredPayload: null,
      }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9. Valid candidate accepted
  // -------------------------------------------------------------------------

  it("accepts a well-formed candidate with valid citations", () => {
    const result = validateCandidate(
      makeCandidate(),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 10. Visibility ceiling — most restrictive
  // -------------------------------------------------------------------------

  it("computes the most-restrictive visibility ceiling from mixed observations", () => {
    const obs1 = makeObservation({ observationId: "obs-1", visibilityClass: "habitat_member" });
    const obs2 = makeObservation({ observationId: "obs-2", visibilityClass: "aggregate_only" });
    const result = validateCandidate(
      makeCandidate({
        citations: [
          { observationId: "obs-1", role: "supporting" },
          { observationId: "obs-2", role: "context" },
        ],
      }),
      makeBatch(obs1, obs2),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(true);
    expect(result.visibilityCeiling).toBe("aggregate_only");
  });

  // -------------------------------------------------------------------------
  // 11. Shape validation
  // -------------------------------------------------------------------------

  it("rejects a candidate with an invalid finding type", () => {
    const result = validateCandidate(
      makeCandidate({ findingType: "invalid_type" as ExtractionCandidate["findingType"] }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("invalid_finding_type"))).toBe(true);
  });

  it("rejects a candidate with invalid confidence (out of range)", () => {
    const result = validateCandidate(
      makeCandidate({ confidence: 1.5 }),
      makeBatch(makeObservation()),
      makePolicy(),
      "hab-A",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("invalid_confidence"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 12. mostRestrictiveVisibility helper
  // -------------------------------------------------------------------------

  it("mostRestrictiveVisibility returns aggregate_only for mixed classes", () => {
    expect(mostRestrictiveVisibility(["habitat_member", "aggregate_only"])).toBe("aggregate_only");
    expect(mostRestrictiveVisibility(["human_reviewer", "habitat_member"])).toBe("human_reviewer");
    expect(mostRestrictiveVisibility(["habitat_member"])).toBe("habitat_member");
    expect(mostRestrictiveVisibility([])).toBe("human_reviewer");
  });
});
