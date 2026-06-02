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

import { codeEvidenceLinks } from "../../db/schema/index.js";
import * as codeEvidenceCompletenessRepo from "../../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import type { CodeEvidenceActor } from "./types.js";

export function correctEvidenceLink(
  linkId: string,
  input: CodeEvidenceCorrectionInput,
  actor: CodeEvidenceActor,
) {
  const link = codeEvidenceLinkRepo.getById(linkId);
  if (!link) return null;

  return codeEvidenceLinkRepo.correctLink(
    linkId,
    input.status,
    actor.type,
    actor.id,
    input.reason,
    input.replacementLinkId,
  );
}

export function markCodeEvidenceNotApplicable(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  input: CodeEvidenceNotApplicableInput,
  actor: CodeEvidenceActor,
) {
  return codeEvidenceCompletenessRepo.upsertNotApplicable({
    targetType,
    targetId,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    markedByType: actor.type,
    markedById: actor.id,
  });
}

export function clearCodeEvidenceNotApplicable(
  targetType: CodeEvidenceTargetType,
  targetId: string,
) {
  return codeEvidenceCompletenessRepo.clearNotApplicable(targetType, targetId);
}

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

export function resolveCodeEvidenceGap(
  gapId: string,
  input: CodeEvidenceGapResolveInput,
  actor: CodeEvidenceActor,
) {
  return codeEvidenceGapRepo.resolveGap(gapId, actor.type, actor.id, input.resolutionReason);
}

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

export function computeSummary(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  activeLinks: (typeof codeEvidenceLinks.$inferSelect)[],
): CodeEvidenceSummary {
  const totalLinks = activeLinks.length;
  const activeCount = activeLinks.filter((l) => l.status === "active").length;
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
    totalLinks,
    activeLinks: activeCount,
    historyCount,
    correctedCount,
    byType,
    byVerificationState,
    hasExternalRepositoryEvidence: hasExternalRepo,
    activeGapCount,
  };
}
