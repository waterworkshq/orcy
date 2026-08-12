/**
 * Experience-aggregate source adapter — k-anonymous privacy projection.
 *
 * Replaces the ticket-2 placeholder with a real adapter that reads raw
 * experience signals, projects them through the privacy boundary in
 * `experiencePrivacy.ts`, and admits only cohorts meeting the non-configurable
 * floor (≥5 signals, ≥3 agents, ≥7-day windows). Every isolating field is
 * suppressed before the extractor batch is formed — de-anonymizing data never
 * enters the extractor input.
 *
 * Citation contract:
 * - `canonicalIdentity(obs).digest` is persisted as the citation `sourceDigest`.
 * - `resolveByRefs` recomputes the current aggregate; if the cohort fell below
 *   the privacy floor, resolve **`unauthorized`** (fail closed, withdraw from
 *   agent reads) — do not reveal why. Otherwise compare digests for `changed`.
 *
 * Experience observations carry **no task/mission entity refs** (aggregate-only),
 * so `projectScopeRefs` grants no scope from them; findings are human-only for
 * agent reads.
 *
 * See authorization-review §Experience-signal privacy for the binding contract.
 */
import { getAllSignalsByHabitat } from "../../../repositories/habitatSkill.js";
import {
  EPOCH_ISO,
  isWithinWindow,
  makeBoundaryToken,
  mintObservationId,
} from "../helpers.js";
import {
  EXPERIENCE_PRIVACY_POLICY_VERSION,
  defaultFloor,
  projectExperienceSignals,
  resolveExperienceCohort,
} from "../experiencePrivacy.js";
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
const COLLECTOR_FAMILY = "experience";
const CONTRACT_VERSION = EXPERIENCE_PRIVACY_POLICY_VERSION;

/**
 * Map a suppressed aggregate to an extraction observation. The observation
 * carries NO entity refs (aggregate-only), NO domains, and the `occurredAt`
 * is the coarse window bucket — never an exact timestamp.
 */
function aggregateToObservation(
  sourceId: string,
  skillCategory: string,
  coarseWindow: string,
  signalCountBand: string,
  agentCountBand: string,
  digest: string,
  habitatId: string,
): ExtractionObservation {
  return {
    observationId: mintObservationId(SOURCE_TYPE, sourceId),
    sourceType: SOURCE_TYPE,
    underlyingId: sourceId,
    occurredAt: coarseWindow,
    entityRefs: [],
    domains: [],
    digest,
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId,
    visibilityClass: "aggregate_only",
  };
}

/** Read all raw experience signals for a habitat (filtered to experience categories inside the projection). */
function readRawSignals(habitatId: string) {
  return getAllSignalsByHabitat(habitatId);
}

export const experienceAggregateAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken {
    try {
      const signals = readRawSignals(request.habitatId);
      // High-water mark is the latest lastSeenAt across all signals.
      const highWaterMark = signals.reduce(
        (max, s) => (s.lastSeenAt > max ? s.lastSeenAt : max),
        EPOCH_ISO,
      );
      return makeBoundaryToken(SOURCE_TYPE, highWaterMark);
    } catch {
      return makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO);
    }
  },

  collect(request: SourceWindowRequest): SourceBatch {
    let boundaryToken = request.boundaryToken;
    try {
      boundaryToken = boundaryToken ?? this.captureBoundary(request);
      const allSignals = readRawSignals(request.habitatId);

      // Filter signals to those within the captured boundary.
      const boundedSignals = allSignals.filter((s) =>
        isWithinWindow(s.lastSeenAt, request, boundaryToken!.highWaterMark),
      );

      const floor = defaultFloor();
      const aggregates = projectExperienceSignals(
        boundedSignals,
        request.habitatId,
        floor,
        request.windowFrom,
        request.windowTo,
      );

      const observations = aggregates.map((agg) =>
        aggregateToObservation(
          agg.sourceId,
          agg.skillCategory,
          agg.coarseWindow,
          agg.signalCountBand,
          agg.agentCountBand,
          agg.digest,
          request.habitatId,
        ),
      );

      return {
        sourceType: SOURCE_TYPE,
        observations,
        completeness: observations.length > 0 ? "complete" : "partial",
        warnings:
          observations.length > 0 ? [] : ["experience_no_eligible_cohorts"],
        boundaryToken: boundaryToken!,
      };
    } catch {
      // Failed source honesty: a source whose collection fails records a
      // partial/failed snapshot with warnings — never an empty success.
      return {
        sourceType: SOURCE_TYPE,
        observations: [],
        completeness: "partial",
        warnings: ["experience_source_unavailable"],
        boundaryToken: boundaryToken ?? makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO),
      };
    }
  },

  resolveByRefs(refs: ResolveRef[], viewer: ViewerContext): ResolvedSource[] {
    // Read all raw signals once; re-project per cited coarse window.
    let allSignals: ReturnType<typeof readRawSignals>;
    try {
      allSignals = readRawSignals(viewer.habitatId);
    } catch {
      // If signal read fails, all citations are dangling (we can't verify).
      return refs.map((ref) => ({ ref, state: "dangling" }));
    }

    const floor = defaultFloor();
    // Cache re-projected cohorts by coarse window to avoid redundant work
    // when multiple citations share the same window.
    const cohortCache = new Map<string, ReturnType<typeof projectExperienceSignals>>();

    return refs.map((ref) => {
      // The coarse window is encoded in sourceVersion during canonicalIdentity.
      // The coarse window is ≥7 days wide — not identifying.
      const coarseWindow = ref.sourceVersion || null;
      if (!coarseWindow) {
        return { ref, state: "dangling" as const };
      }

      // Re-project using the cited coarse window so HMAC identities match.
      let cohorts = cohortCache.get(coarseWindow);
      if (!cohorts) {
        cohorts = projectExperienceSignals(
          allSignals,
          viewer.habitatId,
          floor,
          coarseWindow,
          undefined,
        );
        cohortCache.set(coarseWindow, cohorts);
      }

      const result = resolveExperienceCohort(
        ref.sourceId,
        coarseWindow,
        ref.sourceDigest,
        cohorts,
      );

      if (result.state === "available") {
        return {
          ref,
          state: "available" as const,
          digest: result.digest,
          // No entity refs — aggregate-only source.
          entityRefs: [],
          occurredAt: result.occurredAt,
        };
      }

      // Denial states carry no content — an unauthorized viewer learns nothing.
      return { ref, state: result.state };
    });
  },

  classify(): "aggregate_only" {
    return "aggregate_only";
  },

  canonicalIdentity(observation: ExtractionObservation): ExtractionSourceRef {
    return {
      sourceType: SOURCE_TYPE,
      sourceId: observation.underlyingId,
      // sourceVersion carries the coarse window so the resolver can
      // re-project the correct window without a DB lookup. The coarse window
      // is ≥7 days wide — not identifying.
      sourceVersion: observation.occurredAt,
      underlyingId: observation.underlyingId,
      collectorFamily: observation.collectorFamily,
      contractVersion: observation.contractVersion,
      digest: observation.digest,
    };
  },
};
