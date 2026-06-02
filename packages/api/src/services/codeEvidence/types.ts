import type { CodeEvidenceActorType, CodeEvidenceLinkItem, CodeEvidenceType } from "@orcy/shared";

export type CodeEvidenceActor = { type: CodeEvidenceActorType; id: string };

export type ParsedUrl = {
  evidenceType: CodeEvidenceType;
  provider: string;
  repoSlug: string;
  identifier: string;
  providerBaseUrl?: string;
} | null;

export type LinkResult = {
  link?: CodeEvidenceLinkItem;
  warning?: { code: string; message: string; inputRef?: string };
  error?: { code: string; message: string; inputRef?: string };
};
