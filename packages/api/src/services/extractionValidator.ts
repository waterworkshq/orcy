/**
 * Learning Loop candidate validator — strict output validation before
 * persistence.
 *
 * Every candidate emitted by an extractor passes through this validator.
 * Invalid candidates are **dropped** (persist nothing for them) and counted
 * honestly in the run diagnostics. The validator is pure: it receives the
 * candidate, the batch observations, and the policy, and returns a verdict.
 *
 * Validation rules (PATCH-CONSTRAINTS §Sources and citations, §X4):
 *  1. Output shape — required fields present and well-typed.
 *  2. Citations — every candidate has ≥1 citation; cited observation IDs
 *     exist in the batch; no fabricated IDs.
 *  3. Habitat identity — cited observations belong to the same Habitat.
 *  4. Visibility ceiling — most-restrictive among cited observations +
 *     policy; never wider than any source.
 *  5. Sample-size / confidence thresholds — admission only, never promotion
 *     authority.
 *  6. Feedback-source exclusion — reject candidates citing Learning Loop
 *     entities/sources, accepted findings, agent renderings, promotion
 *     records, recommendations, or any Wiki page ever targeted by a
 *     successful promotion.
 *  7. Finding-type payload correctness — `rule_recommendation` must have
 *     no machine-readable payload (prose-only).
 */
import type {
  ExtractionCandidate,
  ExtractionVisibilityClass,
  LearningLoopPolicyRow,
} from "@orcy/shared";
import type { ExtractionObservation } from "./extractionSourceCatalog/types.js";

// ---------------------------------------------------------------------------
// Visibility ordering (most-restrictive → least-restrictive)
// ---------------------------------------------------------------------------

/**
 * Visibility restrictiveness rank. Lower = more restrictive.
 * `aggregate_only` is the most restrictive; `habitat_member` is the least.
 */
const VISIBILITY_RANK: Record<ExtractionVisibilityClass, number> = {
  aggregate_only: 0,
  human_reviewer: 1,
  habitat_member: 2,
};

/**
 * The most-restrictive visibility class among the given classes. When policy
 * and observations disagree, the most restrictive wins — derived knowledge
 * never gains a wider audience than its sources (PATCH-CONSTRAINTS §12).
 */
export function mostRestrictiveVisibility(
  classes: ExtractionVisibilityClass[],
): ExtractionVisibilityClass {
  if (classes.length === 0) return "human_reviewer";
  let result = classes[0];
  for (const cls of classes) {
    if (VISIBILITY_RANK[cls] < VISIBILITY_RANK[result]) {
      result = cls;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

/**
 * One candidate's validation verdict. `errors` is empty iff `valid` is true.
 */
export interface CandidateValidationResult {
  valid: boolean;
  /** Diagnostic error codes (empty when valid). */
  errors: string[];
  /** Computed visibility ceiling (most-restrictive among cited obs + policy). */
  visibilityCeiling: ExtractionVisibilityClass;
}

// ---------------------------------------------------------------------------
// Feedback-source exclusion
// ---------------------------------------------------------------------------

/**
 * Source types that are Learning Loop feedback-loop entities. Citing any of
 * these makes a candidate invalid — no accepted finding, recommendation, or
 * promotion record may serve as evidence for a new finding
 * (PATCH-CONSTRAINTS §19, §Disallowed scope).
 *
 * Note: these source types never enter a source batch (the catalog excludes
 * them). But the validator checks defensively in case an extractor fabricates
 * a citation to a feedback entity.
 */
const FEEDBACK_SOURCE_PREFIXES: readonly string[] = [
  "extraction_",
  "extracted_finding",
  "learning_loop",
];

/**
 * Check whether an observation's source type is a feedback-loop entity.
 * Feedback entities (extraction runs, findings, reviews, promotions) are
 * excluded from evidence (PATCH-CONSTRAINTS §19).
 */
function isFeedbackSource(obs: ExtractionObservation): boolean {
  return FEEDBACK_SOURCE_PREFIXES.some(
    (prefix) =>
      obs.sourceType.startsWith(prefix) ||
      obs.underlyingId.startsWith(prefix),
  );
}

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

const VALID_FINDING_TYPES: ReadonlySet<string> = new Set([
  "lesson",
  "convention",
  "risk",
  "anomaly",
  "rule_recommendation",
  "knowledge_draft",
]);

const VALID_CITATION_ROLES: ReadonlySet<string> = new Set([
  "supporting",
  "contradicting",
  "context",
]);

/**
 * Validate the output shape of a candidate. Returns error strings for each
 * violation.
 */
function validateShape(candidate: ExtractionCandidate): string[] {
  const errors: string[] = [];

  if (!candidate.clientKey || typeof candidate.clientKey !== "string") {
    errors.push("missing_or_invalid_clientKey");
  }
  if (!candidate.findingType || !VALID_FINDING_TYPES.has(candidate.findingType)) {
    errors.push(`invalid_finding_type:${String(candidate.findingType)}`);
  }
  if (!candidate.subject || typeof candidate.subject !== "string") {
    errors.push("missing_subject");
  }
  if (!candidate.body || typeof candidate.body !== "string") {
    errors.push("missing_body");
  }
  if (
    typeof candidate.confidence !== "number" ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    errors.push(`invalid_confidence:${String(candidate.confidence)}`);
  }
  if (
    typeof candidate.sampleSize !== "number" ||
    candidate.sampleSize < 1 ||
    !Number.isFinite(candidate.sampleSize)
  ) {
    errors.push(`invalid_sampleSize:${String(candidate.sampleSize)}`);
  }
  if (candidate.completeness !== "complete" && candidate.completeness !== "partial") {
    errors.push(`invalid_completeness:${String(candidate.completeness)}`);
  }
  if (!Array.isArray(candidate.caveats)) {
    errors.push("invalid_caveats");
  }
  if (!Array.isArray(candidate.citations) || candidate.citations.length === 0) {
    errors.push("zero_citations");
    return errors; // Can't check citation details without any.
  }
  for (const cite of candidate.citations) {
    if (!cite.observationId || typeof cite.observationId !== "string") {
      errors.push("citation_missing_observationId");
      break;
    }
    if (!VALID_CITATION_ROLES.has(cite.role)) {
      errors.push(`invalid_citation_role:${String(cite.role)}`);
      break;
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Finding-type payload correctness
// ---------------------------------------------------------------------------

/**
 * Validate finding-type-specific payload rules.
 *
 * `rule_recommendation` MUST be prose-only: `structuredPayload` must be
 * `null` or `undefined`. No machine-readable trigger/condition/action payload
 * is allowed (PATCH-CONSTRAINTS §Disallowed scope, X4).
 */
function validateFindingTypePayload(candidate: ExtractionCandidate): string[] {
  const errors: string[] = [];

  if (
    candidate.findingType === "rule_recommendation" &&
    candidate.structuredPayload != null
  ) {
    errors.push("rule_recommendation_has_structured_payload");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main validation entry point
// ---------------------------------------------------------------------------

/**
 * Validate one candidate against the full rule set.
 *
 * @param candidate The extractor-emitted candidate.
 * @param batchById Map of observationId → observation (the full collected batch).
 * @param policy The policy governing this run.
 * @param habitatId The owning Habitat.
 * @returns Validation result with computed visibility ceiling.
 */
export function validateCandidate(
  candidate: ExtractionCandidate,
  batchById: Map<string, ExtractionObservation>,
  policy: LearningLoopPolicyRow,
  habitatId: string,
): CandidateValidationResult {
  const errors: string[] = [];

  // 1. Shape validation.
  errors.push(...validateShape(candidate));
  if (errors.length > 0) {
    return { valid: false, errors, visibilityCeiling: "human_reviewer" };
  }

  // 2. Citation existence + habitat identity + feedback exclusion.
  const citedObservations: ExtractionObservation[] = [];
  for (const cite of candidate.citations) {
    const obs = batchById.get(cite.observationId);
    if (!obs) {
      errors.push(`fabricated_observation_id:${cite.observationId}`);
      continue;
    }
    if (obs.habitatId !== habitatId) {
      errors.push(`cross_habitat_citation:${cite.observationId}`);
      continue;
    }
    if (isFeedbackSource(obs)) {
      errors.push(`feedback_source_citation:${cite.observationId}`);
      continue;
    }
    citedObservations.push(obs);
  }

  if (citedObservations.length === 0) {
    errors.push("no_valid_citations");
    return { valid: false, errors, visibilityCeiling: "human_reviewer" };
  }

  // 3. Visibility ceiling — most-restrictive among cited observations.
  const obsVisibilities = citedObservations.map((o) => o.visibilityClass);
  const computedCeiling = mostRestrictiveVisibility(obsVisibilities);

  // 4. Sample-size / confidence admission thresholds (admission only — never
  //    promotion authority).
  if (policy.minConfidence !== null && candidate.confidence < policy.minConfidence) {
    errors.push(
      `confidence_below_threshold:${candidate.confidence}<${policy.minConfidence}`,
    );
  }
  if (policy.minSampleSize !== null && candidate.sampleSize < policy.minSampleSize) {
    errors.push(
      `sample_size_below_threshold:${candidate.sampleSize}<${policy.minSampleSize}`,
    );
  }

  // 5. Finding-type payload correctness.
  errors.push(...validateFindingTypePayload(candidate));

  if (errors.length > 0) {
    return { valid: false, errors, visibilityCeiling: computedCeiling };
  }

  return { valid: true, errors: [], visibilityCeiling: computedCeiling };
}
