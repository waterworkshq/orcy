/**
 * Extraction promotion eligibility + reservation service.
 *
 * Promotion is blocked when any citation is `dangling`/`changed`/`unauthorized`
 * or the finding is stale/withdrawn (authorization-review §Citation degradation).
 *
 * The Wiki destination adapter itself is ticket 7; this service owns the
 * eligibility check, reservation surface, and audit/SSE emission.
 */
import { getDb } from "../db/index.js";
import {
  reservePromotionWithClient,
  getFindingByIdWithClient,
  getCitationsByFindingWithClient,
} from "../repositories/extraction/index.js";
import { getAdapter, type ResolveRef, type ViewerContext } from "./extractionSourceCatalog/index.js";
import { notFound, badRequest } from "../errors.js";
import type {
  CitationResolutionState,
  ExtractionPromotionDestination,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

export interface PromotionEligibility {
  eligible: boolean;
  /** Blocking citation states that prevent promotion, if any. */
  blockingCitations: Array<{ sourceId: string; state: CitationResolutionState }>;
  /** Human-readable caveats for degraded citations. */
  caveats: string[];
}

/** Blocking citation states that prevent new promotion. */
const BLOCKING_STATES: ReadonlySet<CitationResolutionState> = new Set([
  "dangling",
  "changed",
  "unauthorized",
]);

/**
 * Check whether a finding is eligible for promotion.
 *
 * Returns `eligible: false` when:
 * - the finding is not in `accepted` status
 * - the finding has `stale` completeness
 * - any citation resolves to `dangling`, `changed`, or `unauthorized`
 *
 * Aggregate-only citations expose bands/caveats only (no drill-down).
 */
export function checkPromotionEligibility(
  habitatId: string,
  findingId: string,
): PromotionEligibility {
  const finding = getFindingByIdWithClient(getDb(), findingId);
  if (!finding || finding.habitatId !== habitatId) {
    throw notFound("Finding not found");
  }

  if (finding.status !== "accepted") {
    return {
      eligible: false,
      blockingCitations: [],
      caveats: [`Finding status is "${finding.status}", must be "accepted" to promote.`],
    };
  }

  if (finding.completeness === "stale") {
    return {
      eligible: false,
      blockingCitations: [],
      caveats: ["Finding completeness is stale — a new revision must be extracted/reviewed."],
    };
  }

  // Re-resolve all citation states
  const citations = getCitationsByFindingWithClient(getDb(), findingId);
  const viewer: ViewerContext = { habitatId };

  // Group by source type for adapter resolution
  const byType = new Map<string, ResolveRef[]>();
  for (const c of citations) {
    const group = byType.get(c.sourceType) ?? [];
    group.push({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      sourceVersion: c.sourceVersion,
      sourceDigest: c.sourceDigest,
    });
    byType.set(c.sourceType, group);
  }

  const stateMap = new Map<string, CitationResolutionState>();
  for (const [sourceType, refs] of byType) {
    try {
      const adapter = getAdapter(sourceType as never);
      const resolved = adapter.resolveByRefs(refs, viewer);
      for (const r of resolved) {
        stateMap.set(r.ref.sourceId, r.state);
      }
    } catch {
      for (const r of refs) {
        stateMap.set(r.sourceId, "dangling");
      }
    }
  }

  const blockingCitations: Array<{ sourceId: string; state: CitationResolutionState }> = [];
  const caveats: string[] = [];

  for (const c of citations) {
    const state = stateMap.get(c.sourceId) ?? "dangling";
    if (BLOCKING_STATES.has(state)) {
      blockingCitations.push({ sourceId: c.sourceId, state });
      const label = state === "dangling"
        ? "source no longer exists"
        : state === "changed"
          ? "source content has changed"
          : "source authorization revoked";
      caveats.push(`Citation ${c.sourceId}: ${label}`);
    }
    if (c.visibilityClass === "aggregate_only") {
      caveats.push(`Citation ${c.sourceId}: aggregate-only — bands and caveats only, no drill-down.`);
    }
  }

  if (citations.length === 0) {
    return {
      eligible: false,
      blockingCitations: [],
      caveats: ["Finding has no citations"],
    };
  }

  return {
    eligible: blockingCitations.length === 0,
    blockingCitations,
    caveats,
  };
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

export interface ReservePromotionServiceInput {
  habitatId: string;
  findingId: string;
  destinationType: ExtractionPromotionDestination;
  destinationKey: string;
  leaseOwner: string;
  leaseGeneration: number;
}

/**
 * Reserve a promotion after checking eligibility. Returns the reservation
 * outcome (created or already_exists). The caller (ticket 7) owns the
 * terminalization step that creates the actual Wiki draft.
 */
export function reservePromotion(input: ReservePromotionServiceInput) {
  const eligibility = checkPromotionEligibility(input.habitatId, input.findingId);
  if (!eligibility.eligible) {
    throw badRequest(
      "Finding is not eligible for promotion",
      {
        blockingCitations: eligibility.blockingCitations,
        caveats: eligibility.caveats,
      },
    );
  }

  const finding = getFindingByIdWithClient(getDb(), input.findingId);
  if (!finding) throw notFound("Finding not found");

  const db = getDb();
  const result = reservePromotionWithClient(db, {
    findingId: input.findingId,
    destinationType: input.destinationType,
    destinationKey: input.destinationKey,
    idempotencyKey: `${input.findingId}:${input.destinationType}:${input.destinationKey}`,
    leaseOwner: input.leaseOwner,
    leaseGeneration: input.leaseGeneration,
    consumedFindingRevision: finding.revision,
  });

  return result;
}
