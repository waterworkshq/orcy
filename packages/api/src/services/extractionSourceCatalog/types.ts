/**
 * Extraction source catalog — adapter interface and shared types.
 *
 * Each adapter owns boundary capture, collection, read-time resolution,
 * visibility classification, and canonical identity for one source family.
 * The catalog is total: exactly one adapter per `EXTRACTION_SOURCE_TYPES`.
 *
 * Citations store `(source_type, source_id, source_version)` plus a normalized
 * `source_digest`, `occurred_at`, bounded `entity_refs`, `completeness`, and
 * `visibility_class`. Adapters populate exactly these; no raw source bodies are
 * ever retained (authorization-review §Citation degradation; ADR-0044).
 *
 * See `docs/adr/0044-learning-loop-ledger-citations-and-lineage.md` for the
 * citation identity, read-time degradation, and scope-ref derivation rules.
 */
import type {
  CitationResolutionState,
  ExtractionSourceCompleteness,
  ExtractionSourceType,
  ExtractionVisibilityClass,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// Viewer + window request
// ---------------------------------------------------------------------------

/** Viewer requesting citation resolution. The habitat scopes every lookup. */
export interface ViewerContext {
  habitatId: string;
}

/**
 * Request to capture a collection boundary and then collect a bounded batch.
 *
 * `windowFrom` is the inclusive lookback lower bound; `windowTo` is the optional
 * exclusive policy upper bound. `boundaryToken` is the catalog-owned upper-bound
 * marker captured before reservation: collection returns only rows whose
 * `occurredAt` is at or below it, so rows arriving after capture wait for later
 * logical work (PATCH-CONSTRAINTS §Sources and citations #2).
 */
export interface SourceWindowRequest {
  habitatId: string;
  /** Inclusive lower-bound ISO timestamp (lookback window start). */
  windowFrom: string;
  /** Exclusive upper-bound ISO timestamp (policy window end). Optional. */
  windowTo?: string;
  /** Catalog-owned upper-bound token captured before reservation. */
  boundaryToken?: SourceBoundaryToken;
}

// ---------------------------------------------------------------------------
// Boundary token
// ---------------------------------------------------------------------------

/**
 * Catalog-owned upper-bound token. Captured before reservation so the runner can
 * reserve logical work against an immutable source snapshot. Rows whose
 * `occurredAt` exceeds `highWaterMark` are excluded from the current batch and
 * wait for later logical work. Free of raw source bodies.
 */
export interface SourceBoundaryToken {
  sourceType: ExtractionSourceType;
  /** Captured high-water mark: the max source-ordered timestamp at capture. */
  highWaterMark: string;
  /** ISO timestamp when the boundary was captured. */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Observation — the normalized, privacy-projected unit an extractor cites
// ---------------------------------------------------------------------------

/** Bounded entity reference carried on an observation. No raw bodies. */
export interface ObservationEntityRef {
  type: string;
  id: string;
}

/**
 * A normalized, privacy-projected observation of one source row. Extractors cite
 * the opaque `observationId`; the runner resolves it to a catalog-issued
 * citation row. The shape carries exactly the citation-persisted metadata
 * (`occurredAt`, `entityRefs`, `completeness`, `visibilityClass`) plus identity
 * fields — never raw Pulse bodies, contributor identifiers, or Notification
 * payloads.
 */
export interface ExtractionObservation {
  /** Opaque batch-local ID the extractor cites. */
  observationId: string;
  sourceType: ExtractionSourceType;
  /** Underlying row/run/resolution ID used for direct read-time resolution. */
  underlyingId: string;
  /** ISO timestamp the source event occurred. */
  occurredAt: string;
  /** Bounded entity references (task/mission/automation_run/plugin_run). */
  entityRefs: ObservationEntityRef[];
  /**
   * Source-owned explicit domain projections (e.g. a task's `requiredDomain`).
   * Free text, labels, subject text, and extractor payloads NEVER appear here.
   */
  domains: string[];
  /** Normalized digest of the projected observation (no raw payload). */
  digest: string;
  /** Stable projection-contract version stamp. */
  contractVersion: string;
  /** Stable collector-family discriminator. */
  collectorFamily: string;
  /** Habitat that owns the underlying row (for scope-ref same-Habitat guard). */
  habitatId: string;
  /** Visibility classification captured at extraction time. */
  visibilityClass: ExtractionVisibilityClass;
}

// ---------------------------------------------------------------------------
// Source batch
// ---------------------------------------------------------------------------

/**
 * A bounded batch of collected observations with honest completeness metadata.
 * A source whose collection fails records a partial/failed snapshot with
 * warnings — never an empty success (PATCH-CONSTRAINTS §Operational #22).
 *
 * `collectionOutcome` discriminates adapter-caught unavailability (`failed`)
 * from honest empty/success results (`collected`). A `failed` source does NOT
 * advance its watermark and cannot be confused with an honest empty success.
 */
export interface SourceBatch {
  sourceType: ExtractionSourceType;
  observations: ExtractionObservation[];
  completeness: ExtractionSourceCompleteness;
  /** Per-source warning codes (e.g. `source_unavailable`). */
  warnings: string[];
  /** The boundary token that bounded this batch. */
  boundaryToken: SourceBoundaryToken;
  /**
   * Discriminator: `collected` = the adapter successfully collected (even if
   * empty); `failed` = the adapter caught an internal error and returned a
   * partial/empty batch. Failed sources do NOT advance their watermark.
   */
  collectionOutcome: "collected" | "failed";
}

// ---------------------------------------------------------------------------
// Canonical identity + resolution
// ---------------------------------------------------------------------------

/**
 * Stable catalog-owned reference to one source occurrence. The persisted
 * citation row stores `(source_type, source_id, source_version)`; the
 * `underlyingId`, `collectorFamily`, and `contractVersion` drive direct
 * family-specific resolution.
 */
export interface ExtractionSourceRef {
  sourceType: ExtractionSourceType;
  sourceId: string;
  sourceVersion: string;
  /** Underlying row/run/resolution ID for direct resolution. */
  underlyingId: string;
  collectorFamily: string;
  contractVersion: string;
  /** Normalized digest captured at extraction time (drives `changed`). */
  digest: string;
}

/** A reference to resolve at read time. */
export interface ResolveRef {
  sourceType: ExtractionSourceType;
  sourceId: string;
  sourceVersion: string;
  /** Digest captured at extraction time, for `changed` detection. */
  sourceDigest?: string | null;
}

/**
 * A resolved citation at read time. Degradation never silently becomes complete
 * history: the state is exactly `available | dangling | unauthorized | changed`
 * (CITATION_RESOLUTION_STATES).
 *
 * For denial states (`unauthorized`, `dangling`), `entityRefs`, `digest`, and
 * `occurredAt` are omitted so an unauthorized viewer cannot learn whether the
 * cited row exists in another Habitat or what it contained.
 */
export interface ResolvedSource {
  ref: ResolveRef;
  state: CitationResolutionState;
  /** Current normalized digest (present for `available` and `changed`). */
  digest?: string;
  /** Resolved entity refs (present only for `available`). */
  entityRefs?: ObservationEntityRef[];
  occurredAt?: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Owns one source family end-to-end. The runner accepts only catalog output;
 * extractors receive observations with opaque batch-local IDs and must cite
 * those IDs in every candidate. Zero-citation, fabricated-ID, cross-Habitat, and
 * policy-excluded candidates are rejected by the downstream validator (ticket 4).
 */
export interface ExtractionSourceAdapter {
  /** One of `EXTRACTION_SOURCE_TYPES`. */
  type: ExtractionSourceType;
  /** Capture the upper-bound token before reservation. */
  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken;
  /** Collect a batch bounded by the captured token. */
  collect(request: SourceWindowRequest): SourceBatch;
  /** Resolve refs to `available | dangling | unauthorized | changed`. */
  resolveByRefs(refs: ResolveRef[], viewer: ViewerContext): ResolvedSource[];
  /** Visibility classification captured at extraction time. */
  classify(observation: ExtractionObservation): ExtractionVisibilityClass;
  /** Stable `(source_id, source_version)` per the identity matrix. */
  canonicalIdentity(observation: ExtractionObservation): ExtractionSourceRef;
}

/** Re-exported visibility alias (matches the catalog vocabulary). */
export type VisibilityClass = ExtractionVisibilityClass;
