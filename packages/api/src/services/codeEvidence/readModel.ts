import type {
  CodeEvidenceCompletenessInfo,
  CodeEvidenceCompatibility,
  CodeEvidenceResponse,
  CodeEvidenceTargetType,
  CodeEvidenceTruncationKey,
  CodeEvidenceLegacySection,
} from "@orcy/shared";

import * as codeEvidenceCompletenessRepo from "../../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import { computeSummary, deriveCompleteness } from "./completeness.js";
import { groupByEvidenceType, mapGapToItem, mapLinkToItem } from "./mappers.js";
import { computeCompatibilityPairs } from "./targetCompatibility.js";

const COMPAT_SECTION_LIMIT = 100;

/** Assembles the full code evidence response — active links, gaps, completeness, summary, and optional history — for a task. */
export function getTaskCodeEvidence(
  taskId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("task", taskId, options);
}

/** Assembles the full code evidence response for a mission by delegating to the shared target read model. */
export function getMissionCodeEvidence(
  missionId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("mission", missionId, options);
}

function overrideRowToInfo(
  override: NonNullable<ReturnType<typeof codeEvidenceCompletenessRepo.getByTarget>>,
): CodeEvidenceCompletenessInfo {
  return {
    status: "not_applicable",
    reasonCode: override.reasonCode ?? undefined,
    reasonNote: override.reasonNote ?? undefined,
    updatedAt: override.updatedAt,
    actor: { type: override.markedByType as never, id: override.markedById },
  };
}

function buildLegacySection(
  targetType: CodeEvidenceTargetType,
  legacyPair: { type: CodeEvidenceTargetType; id: string },
  includeHistory: boolean,
): CodeEvidenceLegacySection {
  const activeLinks = codeEvidenceLinkRepo.getActiveByTarget(legacyPair.type, legacyPair.id);
  const activeGaps = codeEvidenceGapRepo.getActiveByTarget(legacyPair.type, legacyPair.id);

  return {
    label: "Verified legacy evidence",
    storedTarget: legacyPair,
    groups: groupByEvidenceType(activeLinks),
    activeGaps: activeGaps.map(mapGapToItem),
    history: includeHistory
      ? {
          links: codeEvidenceLinkRepo
            .getHistoryByTarget(legacyPair.type, legacyPair.id)
            .map(mapLinkToItem),
          resolvedGaps: codeEvidenceGapRepo
            .getResolvedByTarget(legacyPair.type, legacyPair.id)
            .map(mapGapToItem),
        }
      : undefined,
    summary: computeSummary(legacyPair.type, legacyPair.id),
  };
}

function buildCompatibility(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  includeHistory: boolean,
): CodeEvidenceCompatibility {
  const pairs = computeCompatibilityPairs(targetType, targetId);

  const canonicalActiveLinkCount = codeEvidenceLinkRepo.countActiveByTarget(
    pairs.canonical.type,
    pairs.canonical.id,
  );
  const canonicalActiveGapCount = codeEvidenceGapRepo.countActiveByTarget(
    pairs.canonical.type,
    pairs.canonical.id,
  );

  const truncation: Partial<Record<CodeEvidenceTruncationKey, boolean>> = {
    canonicalActiveLinks: canonicalActiveLinkCount > COMPAT_SECTION_LIMIT,
    canonicalActiveGaps: canonicalActiveGapCount > COMPAT_SECTION_LIMIT,
  };

  let legacy: CodeEvidenceLegacySection | undefined;
  let legacyActiveLinkCount = 0;
  let legacyActiveGapCount = 0;
  if (pairs.legacy) {
    legacy = buildLegacySection(targetType, pairs.legacy, includeHistory);
    legacyActiveLinkCount = codeEvidenceLinkRepo.countActiveByTarget(
      pairs.legacy.type,
      pairs.legacy.id,
    );
    legacyActiveGapCount = codeEvidenceGapRepo.countActiveByTarget(
      pairs.legacy.type,
      pairs.legacy.id,
    );
    truncation.legacyActiveLinks = legacyActiveLinkCount > COMPAT_SECTION_LIMIT;
    truncation.legacyActiveGaps = legacyActiveGapCount > COMPAT_SECTION_LIMIT;
  }

  if (includeHistory) {
    truncation.canonicalHistoryLinks =
      codeEvidenceLinkRepo.countHistoryByTarget(pairs.canonical.type, pairs.canonical.id) >
      COMPAT_SECTION_LIMIT;
    truncation.canonicalResolvedGaps =
      codeEvidenceGapRepo.countResolvedByTarget(pairs.canonical.type, pairs.canonical.id) >
      COMPAT_SECTION_LIMIT;
    if (pairs.legacy) {
      truncation.legacyHistoryLinks =
        codeEvidenceLinkRepo.countHistoryByTarget(pairs.legacy.type, pairs.legacy.id) >
        COMPAT_SECTION_LIMIT;
      truncation.legacyResolvedGaps =
        codeEvidenceGapRepo.countResolvedByTarget(pairs.legacy.type, pairs.legacy.id) >
        COMPAT_SECTION_LIMIT;
    }
  }

  const canonicalOverride = codeEvidenceCompletenessRepo.getByTarget(
    pairs.canonical.type,
    pairs.canonical.id,
  );
  const legacyOverride = pairs.legacy
    ? codeEvidenceCompletenessRepo.getByTarget(pairs.legacy.type, pairs.legacy.id)
    : null;

  const overrides: CodeEvidenceCompatibility["overrides"] = [];
  if (canonicalOverride && canonicalOverride.status === "not_applicable") {
    overrides.push({
      storedTarget: pairs.canonical,
      classification: "canonical",
      value: overrideRowToInfo(canonicalOverride),
    });
  }
  if (legacyOverride && legacyOverride.status === "not_applicable") {
    overrides.push({
      storedTarget: pairs.legacy!,
      classification: "verified_legacy",
      value: overrideRowToInfo(legacyOverride),
    });
  }

  let effectiveCompleteness: CodeEvidenceCompletenessInfo;
  if (overrides.length >= 2) {
    // Explicit conflict: every override is shown, no inferred winner.
    effectiveCompleteness = { status: "unknown" };
  } else if (overrides.length === 1) {
    effectiveCompleteness = overrides[0]!.value;
  } else {
    const combinedLinks = canonicalActiveLinkCount + legacyActiveLinkCount;
    const combinedGaps = canonicalActiveGapCount + legacyActiveGapCount;
    if (combinedLinks > 0 && combinedGaps === 0) effectiveCompleteness = { status: "complete" };
    else if (combinedLinks > 0 && combinedGaps > 0) effectiveCompleteness = { status: "partial" };
    else if (combinedLinks === 0 && combinedGaps > 0) effectiveCompleteness = { status: "missing" };
    else effectiveCompleteness = { status: "unknown" };
  }

  return { legacy, overrides, effectiveCompleteness, truncation };
}

function getTargetCodeEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { includeHistory?: boolean; habitatId?: string },
): CodeEvidenceResponse {
  const includeHistory = options?.includeHistory ?? false;
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
  const summary = computeSummary(targetType, targetId);
  const groups = groupByEvidenceType(activeLinks);

  const history = includeHistory
    ? {
        links: codeEvidenceLinkRepo.getHistoryByTarget(targetType, targetId).map(mapLinkToItem),
        resolvedGaps: codeEvidenceGapRepo
          .getResolvedByTarget(targetType, targetId)
          .map(mapGapToItem),
      }
    : undefined;

  const compatibility = buildCompatibility(targetType, targetId, includeHistory);

  const warnings: string[] = [];
  if (compatibility.overrides.length >= 2) {
    warnings.push(
      "Multiple not-applicable overrides exist across canonical and verified legacy targets; no winner is applied. Clear all equivalents to resolve.",
    );
  }
  if (Object.values(compatibility.truncation).some(Boolean)) {
    warnings.push(
      `One or more code evidence collections were truncated at ${COMPAT_SECTION_LIMIT} items; exact counts are in the summaries.`,
    );
  }

  return {
    target,
    repository,
    completeness,
    summary,
    groups,
    activeGaps: activeGaps.map(mapGapToItem),
    history,
    warnings,
    compatibility,
  };
}
