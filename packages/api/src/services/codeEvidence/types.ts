import type { CodeEvidenceActorType, CodeEvidenceLinkItem, CodeEvidenceType } from "@orcy/shared";

/** Identifies the actor (user or system) behind a code evidence action such as linking or resolving. */
export type CodeEvidenceActor = { type: CodeEvidenceActorType; id: string };

/** Outcome of parsing a code evidence URL into its provider, repository slug, and identifier, or `null` when the URL cannot be recognized. */
export type ParsedUrl = {
  evidenceType: CodeEvidenceType;
  provider: string;
  repoSlug: string;
  identifier: string;
  providerBaseUrl?: string;
} | null;

/** Result of an attempt to link code evidence, carrying either the created link, a soft warning, or a hard error. */
export type LinkResult = {
  link?: CodeEvidenceLinkItem;
  warning?: { code: string; message: string; inputRef?: string };
  error?: { code: string; message: string; inputRef?: string };
};
