import type { CodeEvidenceResponse, CodeEvidenceTargetType } from "@orcy/shared";

import * as codeEvidenceCompletenessRepo from "../../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import { computeSummary, deriveCompleteness } from "./completeness.js";
import { groupByEvidenceType, mapGapToItem, mapLinkToItem } from "./mappers.js";

export function getTaskCodeEvidence(
  taskId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("task", taskId, options);
}

export function getMissionCodeEvidence(
  missionId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("mission", missionId, options);
}

function getTargetCodeEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  const activeLinks = codeEvidenceLinkRepo.getActiveByTarget(targetType, targetId);
  const activeGaps = codeEvidenceGapRepo.getActiveByTarget(targetType, targetId);
  const completenessOverride = codeEvidenceCompletenessRepo.getByTarget(targetType, targetId);

  const target: CodeEvidenceResponse["target"] = {
    type: targetType,
    id: targetId,
    habitatId: options?.habitatId ?? "",
  };

  const repository = null;
  const completeness = deriveCompleteness(targetType, targetId, completenessOverride);
  const summary = computeSummary(targetType, targetId, activeLinks);
  const groups = groupByEvidenceType(activeLinks);

  const history = options?.includeHistory
    ? {
        links: codeEvidenceLinkRepo.getHistoryByTarget(targetType, targetId).map(mapLinkToItem),
        resolvedGaps: codeEvidenceGapRepo
          .getResolvedByTarget(targetType, targetId)
          .map(mapGapToItem),
      }
    : undefined;

  return {
    target,
    repository,
    completeness,
    summary,
    groups,
    activeGaps: activeGaps.map(mapGapToItem),
    history,
    warnings: [],
  };
}
