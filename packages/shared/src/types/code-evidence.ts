export type CodeEvidenceType =
  | "branch"
  | "pull_request"
  | "commit"
  | "changed_file"
  | "pipeline_run"
  | "review"
  | "external_url";

export type CodeEvidenceLinkSource =
  | "webhook"
  | "branch_pattern"
  | "commit_trailer"
  | "agent_reported"
  | "human_manual"
  | "migration"
  | "api"
  | "artifact_mirror";

export type CodeEvidenceVerificationState = "verified" | "unverified" | "stale" | "failed";
export type CodeEvidenceLinkStatus = "active" | "superseded" | "incorrect" | "removed";
export type CodeEvidenceCompletenessStatus =
  | "complete"
  | "partial"
  | "missing"
  | "not_applicable"
  | "unknown";
export type CodeEvidenceGapStatus = "active" | "resolved";
export type CodeEvidenceTargetType = "task" | "mission";
export type CodeEvidenceActorType = "human" | "agent" | "system";
export type CodeEvidenceReviewStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";
export type CodeEvidenceChangeType = "added" | "modified" | "deleted" | "renamed";
export type CodeEvidenceProvider = string;

export const CODE_EVIDENCE_TYPES: CodeEvidenceType[] = [
  "branch",
  "pull_request",
  "commit",
  "changed_file",
  "pipeline_run",
  "review",
  "external_url",
];

export const CODE_EVIDENCE_LINK_SOURCES: CodeEvidenceLinkSource[] = [
  "webhook",
  "branch_pattern",
  "commit_trailer",
  "agent_reported",
  "human_manual",
  "migration",
  "api",
  "artifact_mirror",
];

export const CODE_EVIDENCE_VERIFICATION_STATES: CodeEvidenceVerificationState[] = [
  "verified",
  "unverified",
  "stale",
  "failed",
];
export const CODE_EVIDENCE_LINK_STATUSES: CodeEvidenceLinkStatus[] = [
  "active",
  "superseded",
  "incorrect",
  "removed",
];
export const CODE_EVIDENCE_COMPLETENESS_STATUSES: CodeEvidenceCompletenessStatus[] = [
  "complete",
  "partial",
  "missing",
  "not_applicable",
  "unknown",
];
export const CODE_EVIDENCE_GAP_STATUSES: CodeEvidenceGapStatus[] = ["active", "resolved"];
export const CODE_EVIDENCE_REVIEW_STATUSES: CodeEvidenceReviewStatus[] = [
  "pending",
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
];
export const CODE_EVIDENCE_CHANGE_TYPES: CodeEvidenceChangeType[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
];

export const KNOWN_PROVIDERS = ["github", "gitlab", "local", "external"] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export const NOT_APPLICABLE_REASONS = [
  "research_only",
  "planning_design",
  "documentation_only_no_code",
  "triage_support",
  "review_only",
  "other",
] as const;
export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

export const GAP_REASONS = [
  "work_outside_orcy",
  "pr_commit_not_created_yet",
  "provider_webhook_missing",
  "local_branch_deleted",
  "evidence_unavailable_permissions",
  "waiting_for_reviewer_provider",
  "other",
] as const;
export type GapReason = (typeof GAP_REASONS)[number];

export const CORRECTION_REASONS = [
  "wrong_task",
  "wrong_mission",
  "duplicate_evidence",
  "external_repo",
  "obsolete_link",
  "bad_url",
  "other",
] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

export const DEFAULT_CONFIDENCE: Record<CodeEvidenceLinkSource, number> = {
  webhook: 1.0,
  branch_pattern: 0.9,
  commit_trailer: 1.0,
  agent_reported: 0.75,
  human_manual: 0.8,
  migration: 0.6,
  api: 0.8,
  artifact_mirror: 0.6,
};

export const EXTERNAL_REPO_CONFIDENCE = 0.5;
export const FAILED_VERIFICATION_CONFIDENCE = 0.3;

export const ORCY_TASK_TRAILER = "Orcy-Task";
export const ORCY_MISSION_TRAILER = "Orcy-Mission";

export const GITHUB_PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
export const GITHUB_COMMIT_URL_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;
export const GITHUB_ACTIONS_RUN_URL_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/;
export const GITLAB_MR_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/;
export const GITLAB_COMMIT_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/commit\/([0-9a-f]{7,40})/;
export const GITLAB_PIPELINE_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/pipelines\/(\d+)/;

export interface CodeEvidenceLinkInput {
  branch?: { name: string; headSha?: string; baseBranch?: string; url?: string };
  commits?: Array<{
    sha: string;
    message?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    url?: string;
    branch?: string;
    trailers?: Array<{ key: string; value: string }>;
  }>;
  changedFiles?: Array<{
    path: string;
    previousPath?: string;
    changeType: CodeEvidenceChangeType;
    additions?: number;
    deletions?: number;
    commitSha?: string;
    pullRequestNumber?: number;
  }>;
  pullRequestUrl?: string;
  pipelineUrl?: string;
  externalUrls?: string[];
  allowExternalRepository?: boolean;
}

export interface CodeEvidenceLinkItem {
  linkId: string;
  evidenceType: CodeEvidenceType;
  evidenceId: string | null;
  title: string | null;
  url: string | null;
  verificationState: CodeEvidenceVerificationState;
  linkSources: CodeEvidenceLinkSource[];
  confidence: number | null;
  linkedBy: { type: CodeEvidenceActorType; id: string };
  linkedAt: string;
  status: CodeEvidenceLinkStatus;
  correctionReason: string | null;
  replacementLinkId: string | null;
}

export interface CodeEvidenceGapItem {
  id: string;
  targetType: CodeEvidenceTargetType;
  targetId: string;
  reasonCode: GapReason;
  reasonNote: string | null;
  status: CodeEvidenceGapStatus;
  reportedBy: { type: CodeEvidenceActorType; id: string };
  reportedAt: string;
  resolvedBy: { type: CodeEvidenceActorType; id: string } | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
}

export interface CodeEvidenceCompletenessInfo {
  status: CodeEvidenceCompletenessStatus;
  reasonCode?: string;
  reasonNote?: string;
  updatedAt?: string;
  actor?: { type: CodeEvidenceActorType; id: string; name?: string };
}

export interface CodeEvidenceSummary {
  totalLinks: number;
  activeLinks: number;
  historyCount: number;
  correctedCount: number;
  byType: Record<string, number>;
  byVerificationState: Record<string, number>;
  hasExternalRepositoryEvidence: boolean;
  activeGapCount: number;
}

export interface CodeEvidenceResponse {
  target: { type: CodeEvidenceTargetType; id: string; missionId?: string; habitatId: string };
  repository: {
    id: string;
    provider: string;
    providerBaseUrl: string | null;
    repoSlug: string;
    displayName: string | null;
    verificationState: CodeEvidenceVerificationState;
  } | null;
  completeness: CodeEvidenceCompletenessInfo;
  summary: CodeEvidenceSummary;
  groups: Array<{ evidenceType: CodeEvidenceType; items: CodeEvidenceLinkItem[] }>;
  activeGaps: CodeEvidenceGapItem[];
  history?: CodeEvidenceHistory;
  warnings: string[];
}

export interface CodeEvidenceHistory {
  links: CodeEvidenceLinkItem[];
  resolvedGaps: CodeEvidenceGapItem[];
}

export interface MissionCodeEvidenceResponse extends CodeEvidenceResponse {
  directEvidence: Array<{ evidenceType: CodeEvidenceType; items: CodeEvidenceLinkItem[] }>;
  rolledUpEvidence: Array<{ evidenceType: CodeEvidenceType; items: CodeEvidenceLinkItem[] }>;
  tasks: Array<{
    taskId: string;
    title: string;
    completeness: CodeEvidenceCompletenessInfo;
    summary: CodeEvidenceSummary;
  }>;
}

export interface CodeEvidenceBulkResult {
  links: CodeEvidenceLinkItem[];
  warnings: Array<{ code: string; message: string; inputRef?: string }>;
  errors: Array<{ code: string; message: string; inputRef?: string }>;
}

export interface RepositoryIdentity {
  id: string;
  habitatId: string;
  provider: string;
  providerBaseUrl: string | null;
  externalId: string | null;
  repoSlug: string | null;
  displayName: string | null;
  localPath: string | null;
  verificationState: CodeEvidenceVerificationState;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryIdentityInput {
  provider?: string;
  providerBaseUrl?: string;
  externalId?: string;
  repoSlug?: string;
  displayName?: string;
  localPath?: string;
}

export interface CodeEvidenceCorrectionInput {
  status: "incorrect" | "removed" | "superseded";
  reason: CorrectionReason | string;
  customReason?: string;
  replacementLinkId?: string;
}

export interface CodeEvidenceNotApplicableInput {
  reasonCode?: NotApplicableReason | string;
  reasonNote?: string;
}

export interface CodeEvidenceGapInput {
  reasonCode: GapReason | string;
  reasonNote?: string;
}

export interface CodeEvidenceGapResolveInput {
  resolutionReason: string;
}
