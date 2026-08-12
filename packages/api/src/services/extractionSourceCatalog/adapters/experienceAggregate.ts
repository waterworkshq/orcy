/**
 * Experience-aggregate source adapter — PLACEHOLDER (ticket 3).
 *
 * Registers for catalog totality (`assertExtractionCatalogCoverage` requires
 * exactly one adapter per `EXTRACTION_SOURCE_TYPES`) but does NOT collect real
 * data. The privacy-projected Experience aggregate (authorization-review
 * §Experience-signal privacy) is implemented in ticket 3.
 *
 * Every method that would touch real data returns an explicit empty/deferred
 * result carrying the `experience_aggregate_deferred_to_ticket_3` marker so the
 * runner can never mistake the placeholder for a live source.
 */
import { EPOCH_ISO, makeBoundaryToken } from "../helpers.js";
import type {
  ExtractionSourceAdapter,
  ExtractionObservation,
  ExtractionSourceRef,
  ResolvedSource,
  ResolveRef,
  SourceBatch,
  SourceBoundaryToken,
  SourceWindowRequest,
  ViewerContext,
} from "../types.js";

const SOURCE_TYPE = "experience_aggregate" as const;
const DEFERRED_MARKER = "experience_aggregate_deferred_to_ticket_3";

export const experienceAggregateAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(_request: SourceWindowRequest): SourceBoundaryToken {
    // No real capture until ticket 3 lands the privacy projection.
    return makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO);
  },

  collect(request: SourceWindowRequest): SourceBatch {
    return {
      sourceType: SOURCE_TYPE,
      observations: [],
      completeness: "partial",
      warnings: [DEFERRED_MARKER],
      boundaryToken: request.boundaryToken ?? this.captureBoundary(request),
    };
  },

  resolveByRefs(refs: ResolveRef[], _viewer: ViewerContext): ResolvedSource[] {
    // No Experience citation can be resolved until ticket 3.
    return refs.map((ref) => ({ ref, state: "dangling" }));
  },

  // `aggregate_only` is the correct ceiling for Experience findings; it is
  // honoured fully once ticket 3 implements the privacy projection.
  classify(): "aggregate_only" {
    return "aggregate_only";
  },

  canonicalIdentity(_observation: ExtractionObservation): ExtractionSourceRef {
    // Unreachable for real observations: collect never returns any. Kept
    // structurally valid so the adapter satisfies the interface.
    return {
      sourceType: SOURCE_TYPE,
      sourceId: `${SOURCE_TYPE}:deferred`,
      sourceVersion: DEFERRED_MARKER,
      underlyingId: DEFERRED_MARKER,
      collectorFamily: DEFERRED_MARKER,
      contractVersion: DEFERRED_MARKER,
      digest: DEFERRED_MARKER,
    };
  },
};
