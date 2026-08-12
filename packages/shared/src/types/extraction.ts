/**
 * Learning Loop — closed vocabulary, domain types, and repository contracts.
 *
 * This module owns the canonical typed constants and derived unions for the
 * extraction ledger. It is the single source of truth for every enum-like
 * domain string that appears in a ledger table column, a repository result
 * union, or a cross-package API surface.
 *
 * The vocabulary is **closed**: adding a new value requires updating the
 * runtime array here, the Drizzle schema enum, and the hand-written SQL
 * migration. Plugin or runtime extension is not permitted in v1.
 *
 * See ADR-0044 for the architectural record.
 */

// ---------------------------------------------------------------------------
// Source types — the closed allowlist of source families the catalog owns
// ---------------------------------------------------------------------------

/** Closed set of source families the extraction source catalog may own. */
export const EXTRACTION_SOURCE_TYPES = [
  "task_lifecycle_audit",
  "mission_lifecycle_audit",
  "automation_run_audit",
  "plugin_run_audit",
  "triage_resolution",
  "experience_aggregate",
] as const;

/** Source family identifier within the extraction catalog. */
export type ExtractionSourceType = (typeof EXTRACTION_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Work-item status
// ---------------------------------------------------------------------------

/** Closed set of logical-work lifecycle statuses. */
export const EXTRACTION_WORK_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
] as const;

/** Lifecycle status of a logical extraction work item. */
export type ExtractionWorkStatus = (typeof EXTRACTION_WORK_STATUSES)[number];

// ---------------------------------------------------------------------------
// Attempt status
// ---------------------------------------------------------------------------

/** Closed set of physical-attempt lifecycle statuses. */
export const EXTRACTION_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "failed",
  "skipped",
] as const;

/** Lifecycle status of a physical extraction attempt. */
export type ExtractionAttemptStatus = (typeof EXTRACTION_ATTEMPT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Delivery mode (diagnostic only — excluded from logical-work identity)
// ---------------------------------------------------------------------------

/** Closed set of delivery channels through which an attempt is created. */
export const EXTRACTION_DELIVERY_MODES = [
  "scheduled",
  "manual",
  "boot_recovery",
] as const;

/** Channel through which an attempt was delivered. Never part of logical dedupe. */
export type ExtractionDeliveryMode = (typeof EXTRACTION_DELIVERY_MODES)[number];

// ---------------------------------------------------------------------------
// Finding type
// ---------------------------------------------------------------------------

/** Closed set of finding categories an extractor may emit. */
export const EXTRACTION_FINDING_TYPES = [
  "lesson",
  "convention",
  "risk",
  "anomaly",
  "rule_recommendation",
  "knowledge_draft",
] as const;

/** Category of an extracted finding. */
export type ExtractionFindingType = (typeof EXTRACTION_FINDING_TYPES)[number];

// ---------------------------------------------------------------------------
// Finding completeness
// ---------------------------------------------------------------------------

/** Closed set of evidence-completeness classifications. */
export const EXTRACTION_FINDING_COMPLETENESS = [
  "complete",
  "partial",
  "stale",
] as const;

/** Evidence-completeness classification of a finding revision. */
export type ExtractionFindingCompleteness =
  (typeof EXTRACTION_FINDING_COMPLETENESS)[number];

// ---------------------------------------------------------------------------
// Visibility class (authorization ceiling)
// ---------------------------------------------------------------------------

/** Closed set of visibility ceilings. Derived knowledge never exceeds its sources. */
export const EXTRACTION_VISIBILITY_CLASSES = [
  "habitat_member",
  "human_reviewer",
  "aggregate_only",
] as const;

/**
 * Most restrictive visibility class among all cited observations and the
 * extractor policy. Captured at extraction time for audit; current
 * authorization is still rechecked on read and promotion.
 */
export type ExtractionVisibilityClass =
  (typeof EXTRACTION_VISIBILITY_CLASSES)[number];

// ---------------------------------------------------------------------------
// Finding status (mutable CAS-protected decision envelope)
// ---------------------------------------------------------------------------

/** Closed set of finding review lifecycle statuses. */
export const EXTRACTION_FINDING_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "withdrawn",
] as const;

/** Review lifecycle status of a finding (CAS-protected via `decisionVersion`). */
export type ExtractionFindingStatus = (typeof EXTRACTION_FINDING_STATUSES)[number];

// ---------------------------------------------------------------------------
// Citation role
// ---------------------------------------------------------------------------

/** Closed set of roles a citation may play relative to its finding. */
export const EXTRACTION_CITATION_ROLES = [
  "supporting",
  "contradicting",
  "context",
] as const;

/** Role of a cited source relative to its finding. */
export type ExtractionCitationRole = (typeof EXTRACTION_CITATION_ROLES)[number];

// ---------------------------------------------------------------------------
// Source completeness (per-citation quality metadata)
// ---------------------------------------------------------------------------

/** Closed set of per-citation completeness classifications. */
export const EXTRACTION_SOURCE_COMPLETENESS = [
  "complete",
  "partial",
] as const;

/** Completeness of a single cited source at capture time. */
export type ExtractionSourceCompleteness =
  (typeof EXTRACTION_SOURCE_COMPLETENESS)[number];

/**
 * Bounded per-source metadata recorded on each citation row. Preserves
 * completeness classification and any warning codes the source adapter emitted
 * at capture time. Does NOT retain raw source bodies.
 */
export interface SourceCompletenessMeta {
  status: ExtractionSourceCompleteness;
  warningCodes: string[];
}

// ---------------------------------------------------------------------------
// Scope type (authorization/query scope)
// ---------------------------------------------------------------------------

/** Closed set of server-derived scope dimensions. */
export const EXTRACTION_SCOPE_TYPES = [
  "task",
  "mission",
  "domain",
] as const;

/**
 * Server-derived authorization scope dimension. Habitat-wide is represented
 * by **no scope refs** and is human-only in v1.
 */
export type ExtractionScopeType = (typeof EXTRACTION_SCOPE_TYPES)[number];

// ---------------------------------------------------------------------------
// Review decision
// ---------------------------------------------------------------------------

/** Closed set of human review decisions. */
export const EXTRACTION_REVIEW_DECISIONS = [
  "accept",
  "reject",
  "request_revision",
] as const;

/** Human review decision on a finding proposal. */
export type ExtractionReviewDecision =
  (typeof EXTRACTION_REVIEW_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Promotion destination
// ---------------------------------------------------------------------------

/** Closed set of promotion destination types. */
export const EXTRACTION_PROMOTION_DESTINATIONS = [
  "wiki_draft",
] as const;

/** Destination type for a finding promotion. */
export type ExtractionPromotionDestination =
  (typeof EXTRACTION_PROMOTION_DESTINATIONS)[number];

// ---------------------------------------------------------------------------
// Promotion status
// ---------------------------------------------------------------------------

/** Closed set of promotion lifecycle statuses. */
export const EXTRACTION_PROMOTION_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "superseded",
] as const;

/** Lifecycle status of a finding promotion. */
export type ExtractionPromotionStatus =
  (typeof EXTRACTION_PROMOTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Read-time citation resolution state
// ---------------------------------------------------------------------------

/** Closed set of citation resolution outcomes at read time. */
export const CITATION_RESOLUTION_STATES = [
  "available",
  "dangling",
  "unauthorized",
  "changed",
] as const;

/**
 * Read-time resolution state of a polymorphic citation. Degradation never
 * silently becomes complete history.
 */
export type CitationResolutionState =
  (typeof CITATION_RESOLUTION_STATES)[number];

// ---------------------------------------------------------------------------
// Domain row types — public projections of ledger rows
// ---------------------------------------------------------------------------

/** Row projection of a `learning_loop_policies` record. */
export interface LearningLoopPolicyRow {
  id: string;
  habitatId: string;
  extractorKey: string;
  enabled: boolean;
  sourceTypes: ExtractionSourceType[];
  schedule: string;
  windowSeconds: number;
  lookbackSeconds: number;
  minConfidence: number | null;
  minSampleSize: number | null;
  config: Record<string, unknown>;
  version: number;
  createdByType: "human" | "agent" | "system";
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row projection of an `extraction_work_items` record. */
export interface ExtractionWorkItemRow {
  id: string;
  habitatId: string;
  policyId: string | null;
  extractorKey: string;
  extractorVersion: number;
  policyVersion: number;
  windowFrom: string;
  windowTo: string;
  sourceBoundaryTokens: Record<string, unknown>;
  logicalWorkKey: string;
  rerunGeneration: number;
  supersedesWorkId: string | null;
  freshReason: string | null;
  status: ExtractionWorkStatus;
  completedByAttemptId: string | null;
  policySnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Row projection of an `extraction_attempts` record. */
export interface ExtractionAttemptRow {
  id: string;
  workItemId: string;
  attemptNo: number;
  parentAttemptId: string | null;
  deliveryMode: ExtractionDeliveryMode;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  sourceSnapshot: Record<string, unknown>[];
  status: ExtractionAttemptStatus;
  candidateCount: number;
  persistedCount: number;
  deduplicatedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row projection of an `extracted_findings` record. */
export interface ExtractedFindingRow {
  id: string;
  habitatId: string;
  firstAttemptId: string;
  lastSeenAttemptId: string;
  lineageRootId: string;
  supersedesFindingId: string | null;
  revision: number;
  extractorKey: string;
  extractorVersion: number;
  findingType: ExtractionFindingType;
  subject: string;
  body: string;
  structuredPayload: unknown;
  confidence: number;
  sampleSize: number;
  completeness: ExtractionFindingCompleteness;
  visibilityCeiling: ExtractionVisibilityClass;
  fingerprint: string;
  evidenceDigest: string;
  status: ExtractionFindingStatus;
  decisionVersion: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  caveats: string[];
  createdAt: string;
  updatedAt: string;
}

/** Row projection of an `extracted_finding_sources` record (citation). */
export interface ExtractedFindingSourceRow {
  id: string;
  findingId: string;
  sourceType: ExtractionSourceType;
  sourceId: string;
  sourceVersion: string;
  role: ExtractionCitationRole;
  sourceDigest: string | null;
  occurredAt: string | null;
  entityRefs: Array<{ type: string; id: string }>;
  completeness: ExtractionSourceCompleteness;
  visibilityClass: ExtractionVisibilityClass;
  createdAt: string;
}

/** Row projection of an `extracted_finding_scope_refs` record. */
export interface ExtractedFindingScopeRefRow {
  id: string;
  findingId: string;
  scopeType: ExtractionScopeType;
  scopeId: string;
  derivedFromSourceId: string;
  createdAt: string;
}

/** Row projection of an `extracted_finding_reviews` record. */
export interface ExtractedFindingReviewRow {
  id: string;
  findingId: string;
  decision: ExtractionReviewDecision;
  reason: string | null;
  reviewerType: "human" | "agent" | "system";
  reviewerId: string;
  expectedDecisionVersion: number;
  resultingDecisionVersion: number;
  resolvedCitationStates: Array<{
    sourceId: string;
    state: CitationResolutionState;
  }>;
  createdAt: string;
}

/** Row projection of an `extracted_finding_promotions` record. */
export interface ExtractedFindingPromotionRow {
  id: string;
  findingId: string;
  destinationType: ExtractionPromotionDestination;
  destinationKey: string;
  status: ExtractionPromotionStatus;
  idempotencyKey: string;
  leaseOwner: string;
  leaseGeneration: number;
  targetType: string | null;
  targetId: string | null;
  targetVersion: string | null;
  consumedFindingRevision: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Extractor candidate contract (what the extractor emits)
// ---------------------------------------------------------------------------

/**
 * One candidate finding emitted by a built-in extractor. The runner validates
 * shape, citations, Habitat identity, visibility ceiling, sample size,
 * confidence, and feedback exclusions before persisting.
 *
 * `citations` reference batch-local observation IDs that the runner resolves
 * to catalog-issued source rows. Zero-citation candidates are rejected.
 */
export interface ExtractionCandidate {
  clientKey: string;
  findingType: ExtractionFindingType;
  subject: string;
  body: string;
  structuredPayload?: unknown;
  confidence: number;
  sampleSize: number;
  completeness: ExtractionSourceCompleteness;
  caveats: string[];
  citations: Array<{ observationId: string; role: ExtractionCitationRole }>;
}

// ---------------------------------------------------------------------------
// Server-derived scope ref input (ticket 2 owns derivation)
// ---------------------------------------------------------------------------

/**
 * Server-derived authorization scope reference. The repository treats these as
 * already derived from successfully resolved cited-source entity refs; ticket 2
 * owns the derivation logic. Extractor payloads never grant scope.
 */
export interface ServerDerivedScopeRef {
  scopeType: ExtractionScopeType;
  scopeId: string;
  derivedFromSourceId: string;
}
