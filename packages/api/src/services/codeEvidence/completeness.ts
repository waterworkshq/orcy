import type {
  CodeEvidenceActorType,
  CodeEvidenceCompletenessInfo,
  CodeEvidenceCorrectionInput,
  CodeEvidenceGapInput,
  CodeEvidenceGapResolveInput,
  CodeEvidenceNotApplicableInput,
  CodeEvidenceSummary,
  CodeEvidenceTargetType,
} from "@orcy/shared";

import { getDb } from "../../db/index.js";
import { codeEvidenceLinks } from "../../db/schema/index.js";
import * as codeEvidenceCompletenessRepo from "../../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import { conflictWithCode } from "../../errors.js";
import type { CodeEvidenceActor } from "./types.js";
import {
  acceptableSourcePairs,
  computeCompatibilityPairs,
  recomputeCompatibilityPairs,
  rowMatchesAcceptablePair,
} from "./targetCompatibility.js";

/**
 * Marks the evidence link `resourceId` as corrected or superseded with an
 * actor-supplied reason. The link must belong to the canonical target pair
 * the caller resolved, or to that pair's at-most-one VERIFIED legacy pair —
 * a stored pair that currently resolves to the same actual object and kind.
 * The final UPDATE fences the row's OWN stored exact pair plus the resource
 * id, so a legacy alias that has come to resolve to another real object can
 * never be adopted or mutated through this call.
 */
export function correctEvidenceLink(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  resourceId: string,
  input: CodeEvidenceCorrectionInput,
  actor: CodeEvidenceActor,
) {
  const pairs = computeCompatibilityPairs(targetType, targetId);
  const acceptable = acceptableSourcePairs(pairs);
  const link = codeEvidenceLinkRepo.getById(resourceId);
  if (!link || !rowMatchesAcceptablePair(link, acceptable)) return null;

  // Fence on the row's own stored pair, not the canonical spelling.
  return codeEvidenceLinkRepo.correctLink(
    link.targetType as CodeEvidenceTargetType,
    link.targetId,
    resourceId,
    input.status,
    actor.type,
    actor.id,
    input.reason,
    input.replacementLinkId,
  );
}

/**
 * Marks the canonical target not-applicable. The compatibility check and the
 * canonical upsert run in ONE immediate transaction: candidate
 * equivalence/collision and any verified-legacy override are re-read under
 * the writer reservation, so a legacy override that appears between the
 * precheck and the write refuses with 409 instead of manufacturing a
 * conflict. A competing writer may still create an override after commit —
 * that state surfaces as an explicit multi-override conflict on read.
 */
export function markCodeEvidenceNotApplicable(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  input: CodeEvidenceNotApplicableInput,
  actor: CodeEvidenceActor,
) {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const pairs = recomputeCompatibilityPairs(targetType, targetId, tx);
      if (pairs.legacy) {
        const legacyOverride = codeEvidenceCompletenessRepo.getByTargetWithClient(
          tx,
          pairs.legacy.type,
          pairs.legacy.id,
        );
        if (legacyOverride) {
          throw conflictWithCode(
            "EVIDENCE_OVERRIDE_CONFLICT",
            "A verified legacy not-applicable override exists for this target; clear all equivalent overrides before marking.",
          );
        }
      }
      return codeEvidenceCompletenessRepo.upsertNotApplicableWithClient(tx, {
        targetType,
        targetId,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        markedByType: actor.type,
        markedById: actor.id,
      });
    },
    { behavior: "immediate" },
  );
}

/**
 * Removes the not-applicable override for the canonical target AND its
 * verified legacy equivalent — at most two exact stored pairs from the
 * finite inverse rule, never a capped list inventory — in ONE immediate
 * transaction. Candidate validity is recomputed inside the transaction; any
 * repository exception rolls back every removal. Unresolvable or unrelated
 * pairs are never touched.
 */
export function clearCodeEvidenceNotApplicable(
  targetType: CodeEvidenceTargetType,
  targetId: string,
) {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const pairs = recomputeCompatibilityPairs(targetType, targetId, tx);
      let removed = codeEvidenceCompletenessRepo.deleteByTargetWithClient(
        tx,
        pairs.canonical.type,
        pairs.canonical.id,
      );
      if (pairs.legacy) {
        removed += codeEvidenceCompletenessRepo.deleteByTargetWithClient(
          tx,
          pairs.legacy.type,
          pairs.legacy.id,
        );
      }
      return removed > 0;
    },
    { behavior: "immediate" },
  );
}

/**
 * Records a new code evidence gap for the canonical target pair (the fetched
 * row id). Legacy alias pairs are not written here; historical gaps stay
 * visible in the labelled legacy section until resolved explicitly by
 * resource id.
 */
export function reportCodeEvidenceGap(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  input: CodeEvidenceGapInput,
  actor: CodeEvidenceActor,
) {
  return codeEvidenceGapRepo.create({
    targetType,
    targetId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    reportedByType: actor.type,
    reportedById: actor.id,
  });
}

/**
 * Marks the evidence gap `resourceId` as resolved, under the same canonical
 * or verified-legacy stored-pair containment as {@link correctEvidenceLink};
 * the final UPDATE fences the row's own stored exact pair.
 */
export function resolveCodeEvidenceGap(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  resourceId: string,
  input: CodeEvidenceGapResolveInput,
  actor: CodeEvidenceActor,
) {
  const pairs = computeCompatibilityPairs(targetType, targetId);
  const acceptable = acceptableSourcePairs(pairs);
  const gap = codeEvidenceGapRepo.getById(resourceId);
  if (!gap || !rowMatchesAcceptablePair(gap, acceptable)) return null;

  return codeEvidenceGapRepo.resolveGap(
    gap.targetType as CodeEvidenceTargetType,
    gap.targetId,
    resourceId,
    actor.type,
    actor.id,
    input.resolutionReason,
  );
}

/** Computes the completeness status for a target, honoring a not-applicable override then counting active links and gaps. */
export function deriveCompleteness(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  override: ReturnType<typeof codeEvidenceCompletenessRepo.getByTarget>,
): CodeEvidenceCompletenessInfo {
  if (override && override.status === "not_applicable") {
    return {
      status: "not_applicable",
      reasonCode: override.reasonCode ?? undefined,
      reasonNote: override.reasonNote ?? undefined,
      updatedAt: override.updatedAt,
      actor: { type: override.markedByType as CodeEvidenceActorType, id: override.markedById },
    };
  }

  const activeLinkCount = codeEvidenceLinkRepo.countActiveByTarget(targetType, targetId);
  const activeGapCount = codeEvidenceGapRepo.countActiveByTarget(targetType, targetId);

  if (activeLinkCount > 0 && activeGapCount === 0) {
    return { status: "complete" };
  }
  if (activeLinkCount > 0 && activeGapCount > 0) {
    return { status: "partial" };
  }
  if (activeLinkCount === 0 && activeGapCount > 0) {
    return { status: "missing" };
  }
  return { status: "unknown" };
}

/**
 * Aggregates link, gap, and verification counts for a stored target pair
 * into the summary shown in the evidence response. `totalLinks`/`activeLinks`
 * use the exact active-population SQL COUNT — deliberately independent of
 * the 100-row materialized-collection cap, fixing the old capped-array
 * undercount — and `historyCount`/`correctedCount` retain their existing
 * all-non-active meaning.
 */
export function computeSummary(
  targetType: CodeEvidenceTargetType,
  targetId: string,
): CodeEvidenceSummary {
  const activeCount = codeEvidenceLinkRepo.countActiveByTarget(targetType, targetId);
  const historyCount = codeEvidenceLinkRepo.countHistoryByTarget(targetType, targetId);
  const correctedCount = codeEvidenceLinkRepo.countCorrectedByTarget(targetType, targetId);
  const byType = codeEvidenceLinkRepo.countByTargetAndType(targetType, targetId);
  const byVerificationState = codeEvidenceLinkRepo.countByTargetAndVerification(
    targetType,
    targetId,
  );
  const hasExternalRepo = codeEvidenceLinkRepo.hasExternalRepoEvidence(targetType, targetId);
  const activeGapCount = codeEvidenceGapRepo.countActiveByTarget(targetType, targetId);

  return {
    totalLinks: activeCount,
    activeLinks: activeCount,
    historyCount,
    correctedCount,
    byType,
    byVerificationState,
    hasExternalRepositoryEvidence: hasExternalRepo,
    activeGapCount,
  };
}

/** Retained for callers that still hold a materialized active-link page; superseded by the exact-count path above. */
export function computeSummaryFromRows(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  _activeLinks: (typeof codeEvidenceLinks.$inferSelect)[],
): CodeEvidenceSummary {
  return computeSummary(targetType, targetId);
}
