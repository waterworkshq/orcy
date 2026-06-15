import type { CodeEvidenceLinkSource, CodeEvidenceVerificationState } from "@orcy/shared";
import {
  DEFAULT_CONFIDENCE,
  EXTERNAL_REPO_CONFIDENCE,
  FAILED_VERIFICATION_CONFIDENCE,
} from "@orcy/shared";

/** Computes the initial confidence score for a newly created code evidence link based on its source, repository scope, and verification state. */
export function inferInitialConfidence(
  source: CodeEvidenceLinkSource,
  isExternalRepo: boolean,
  verificationState: CodeEvidenceVerificationState,
): number {
  if (verificationState === "failed") return FAILED_VERIFICATION_CONFIDENCE;
  if (isExternalRepo) return EXTERNAL_REPO_CONFIDENCE;
  return DEFAULT_CONFIDENCE[source] ?? 0.5;
}

/** Resolves the initial verification state for a code evidence link based on its source and whether the originating repository is verified. */
export function determineVerificationState(
  source: CodeEvidenceLinkSource,
  repositoryVerified: boolean | null,
  isExternalRepo: boolean,
): CodeEvidenceVerificationState {
  if (isExternalRepo) return "unverified";
  if (source === "webhook" || source === "migration")
    return repositoryVerified ? "verified" : "unverified";
  if (source === "commit_trailer") return repositoryVerified ? "verified" : "unverified";
  if (source === "branch_pattern") return "unverified";
  if (source === "human_manual") return "unverified";
  if (source === "agent_reported") return "unverified";
  if (source === "api") return "unverified";
  if (source === "artifact_mirror") return "unverified";
  return "unverified";
}
