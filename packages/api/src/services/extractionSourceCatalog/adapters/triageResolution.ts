/**
 * Terminal triage-resolution source adapter.
 *
 * Canonical identity: `triage_resolution:<rowId>` with the underlying resolution
 * row ID. `source_version` is the normalized row digest + adapter contract
 * version. Every `triage_resolutions` row is terminal by construction (written
 * only on resolution), so admission is unconditional over listed rows.
 *
 * Resolution resolves by ID and Habitat and never implicitly traverses to
 * source pulses or non-terminal Engineering Findings (architecture §First-release
 * sources). Changed digest → `changed`; missing → `dangling`. Direct row-by-ID
 * lookup — never a whole-habitat audit-projection rebuild.
 */
import type { TriageResolution } from "../../../repositories/triageResolutions.js";
import { getById, listByHabitat } from "../../../repositories/triageResolutions.js";
import { computeDigest, composeVersion } from "../digest.js";
import {
  EPOCH_ISO,
  isWithinWindow,
  makeBoundaryToken,
  mintObservationId,
  parseUnderlyingId,
} from "../helpers.js";
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

const SOURCE_TYPE = "triage_resolution" as const;
const COLLECTOR_FAMILY = "triage";
const CONTRACT_VERSION = "triage-resolution-v1";
const SOURCE_ID_PREFIX = "triage_resolution";

/** Normalized digest of a terminal resolution's content. */
function normalizedResolutionDigest(row: TriageResolution): string {
  return computeDigest({
    clusterKey: row.clusterKey,
    skillCategory: row.skillCategory,
    source: row.source,
    sourceId: row.sourceId,
    rootCause: row.rootCause,
    resolution: row.resolution,
    resolutionKind: row.resolutionKind,
    resolvedAt: row.resolvedAt,
    resolvedByType: row.resolvedByType,
    resolvedById: row.resolvedById,
  });
}

function rowToObservation(row: TriageResolution): ExtractionObservation {
  const digest = normalizedResolutionDigest(row);
  return {
    observationId: mintObservationId(SOURCE_TYPE, row.id),
    sourceType: SOURCE_TYPE,
    underlyingId: row.id,
    occurredAt: row.resolvedAt,
    // Terminal historical resolution. Carries its own entity ref only — no
    // implicit traversal to source pulses, findings, or missions. Never projects
    // task/mission/domain scope (habitat-wide historical evidence, human-only).
    entityRefs: [{ type: "triage_resolution", id: row.id }],
    domains: [],
    digest,
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId: row.habitatId,
    visibilityClass: "habitat_member",
  };
}

export const triageResolutionAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken {
    const rows = listByHabitat(request.habitatId);
    const highWaterMark = rows.reduce(
      (max, row) => (row.resolvedAt > max ? row.resolvedAt : max),
      EPOCH_ISO,
    );
    return makeBoundaryToken(SOURCE_TYPE, highWaterMark);
  },
  collect(request: SourceWindowRequest): SourceBatch {
    let boundaryToken = request.boundaryToken;
    try {
      boundaryToken = boundaryToken ?? this.captureBoundary(request);
      const rows = listByHabitat(request.habitatId).filter((row) =>
        isWithinWindow(row.resolvedAt, request, boundaryToken!.highWaterMark),
      );
      return {
        sourceType: SOURCE_TYPE,
        observations: rows.map(rowToObservation),
        completeness: "complete",
        warnings: [],
        boundaryToken: boundaryToken!,
        collectionOutcome: "collected" as const,
      };
    } catch {
      return {
        sourceType: SOURCE_TYPE,
        observations: [],
        completeness: "partial",
        warnings: ["triage_resolution_source_unavailable"],
        boundaryToken: boundaryToken ?? makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO),
        collectionOutcome: "failed" as const,
      };
    }
  },

  resolveByRefs(refs: ResolveRef[], viewer: ViewerContext): ResolvedSource[] {
    return refs.map((ref) => {
      const underlyingId = parseUnderlyingId(ref.sourceId, SOURCE_ID_PREFIX);
      if (!underlyingId) {
        return { ref, state: "dangling" };
      }
      const row = getById(underlyingId);
      if (!row) return { ref, state: "dangling" };

      if (row.habitatId !== viewer.habitatId) {
        return { ref, state: "unauthorized" };
      }
      const currentDigest = normalizedResolutionDigest(row);
      if (
        ref.sourceDigest !== undefined &&
        ref.sourceDigest !== null &&
        ref.sourceDigest !== currentDigest
      ) {
        return { ref, state: "changed", digest: currentDigest };
      }
      return {
        ref,
        state: "available",
        digest: currentDigest,
        entityRefs: [{ type: "triage_resolution", id: row.id }],
        occurredAt: row.resolvedAt,
      };
    });
  },

  classify(): "habitat_member" {
    return "habitat_member";
  },

  canonicalIdentity(observation: ExtractionObservation): ExtractionSourceRef {
    return {
      sourceType: SOURCE_TYPE,
      sourceId: `${SOURCE_ID_PREFIX}:${observation.underlyingId}`,
      sourceVersion: composeVersion(observation.contractVersion, {
        digest: observation.digest,
      }),
      underlyingId: observation.underlyingId,
      collectorFamily: observation.collectorFamily,
      contractVersion: observation.contractVersion,
      digest: observation.digest,
    };
  },
};
