import type {
  CodeEvidenceActorType,
  CodeEvidenceGapItem,
  CodeEvidenceGapStatus,
  CodeEvidenceLinkItem,
  CodeEvidenceLinkSource,
  CodeEvidenceLinkStatus,
  CodeEvidenceTargetType,
  CodeEvidenceType,
  CodeEvidenceVerificationState,
} from "@orcy/shared";
import type { GapReason } from "@orcy/shared";

import { codeEvidenceGaps, codeEvidenceLinks } from "../../db/schema/index.js";

/** Groups code evidence link rows by evidence type, mapping each row to its API-facing item shape. */
export function groupByEvidenceType(
  links: (typeof codeEvidenceLinks.$inferSelect)[],
): Array<{ evidenceType: CodeEvidenceType; items: CodeEvidenceLinkItem[] }> {
  const groups: Record<string, CodeEvidenceLinkItem[]> = {};
  for (const link of links) {
    const type = link.evidenceType as CodeEvidenceType;
    if (!groups[type]) groups[type] = [];
    groups[type].push(mapLinkToItem(link));
  }
  return Object.entries(groups).map(([evidenceType, items]) => ({
    evidenceType: evidenceType as CodeEvidenceType,
    items,
  }));
}

/** Maps a stored code evidence link row to its API-facing item shape. */
export function mapLinkToItem(link: typeof codeEvidenceLinks.$inferSelect): CodeEvidenceLinkItem {
  return {
    linkId: link.id,
    evidenceType: link.evidenceType as CodeEvidenceType,
    evidenceId: link.evidenceId,
    title: link.title,
    url: link.externalUrl,
    verificationState: link.verificationState as CodeEvidenceVerificationState,
    linkSources: Array.isArray(link.linkSources)
      ? (link.linkSources as CodeEvidenceLinkSource[])
      : [],
    confidence: link.confidence,
    linkedBy: { type: link.linkedByType as CodeEvidenceActorType, id: link.linkedById },
    linkedAt: link.linkedAt,
    status: link.status as CodeEvidenceLinkStatus,
    correctionReason: link.correctionReason,
    replacementLinkId: link.replacementLinkId,
  };
}

/** Maps a stored code evidence gap row to its API-facing item shape. */
export function mapGapToItem(gap: typeof codeEvidenceGaps.$inferSelect): CodeEvidenceGapItem {
  return {
    id: gap.id,
    targetType: gap.targetType as CodeEvidenceTargetType,
    targetId: gap.targetId,
    reasonCode: (gap.reasonCode as GapReason) ?? "other",
    reasonNote: gap.reasonNote,
    status: gap.status as CodeEvidenceGapStatus,
    reportedBy: { type: gap.reportedByType as CodeEvidenceActorType, id: gap.reportedById },
    reportedAt: gap.reportedAt,
    resolvedBy: gap.resolvedByType
      ? { type: gap.resolvedByType as CodeEvidenceActorType, id: gap.resolvedById! }
      : null,
    resolvedAt: gap.resolvedAt,
    resolutionReason: gap.resolutionReason,
  };
}
