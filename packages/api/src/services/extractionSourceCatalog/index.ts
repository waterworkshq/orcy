/**
 * Extraction source catalog — public exports.
 *
 * Total core-owned source catalog with direct family-specific adapters and
 * resolvers for the five non-private v1 source families (task/mission lifecycle
 * audit, terminal automation run, terminal plugin run, terminal triage
 * resolution) plus an Experience-aggregate placeholder for catalog totality
 * (ticket 3 implements the real privacy projection).
 *
 * See `docs/adr/0044-learning-loop-ledger-citations-and-lineage.md` and the
 * Learning Loop architecture artifact for the identity/resolution matrix and
 * scope-ref derivation rules.
 */
export {
  EXTRACTION_SOURCE_CATALOG,
  assertExtractionCatalogCoverage,
  getAdapter,
  selectAdapters,
  validateCatalogCoverage,
} from "./catalog.js";
export { canonicalStringify, computeDigest, composeVersion } from "./digest.js";
export { EXCLUDED_AUDIT_ENTITY_TYPES, EXCLUDED_AUDIT_SOURCE } from "./helpers.js";
export {
  normalizeDomain,
  projectScopeRefs,
  type DerivedScopeRef,
  type ScopeProjectionObservation,
  type TaskMissionLink,
} from "./scopeProjection.js";
export type {
  ExtractionSourceAdapter,
  ExtractionObservation,
  ExtractionSourceRef,
  ObservationEntityRef,
  ResolveRef,
  ResolvedSource,
  SourceBatch,
  SourceBoundaryToken,
  SourceWindowRequest,
  ViewerContext,
  VisibilityClass,
} from "./types.js";
