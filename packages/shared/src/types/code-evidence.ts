/** Discriminator for the kind of code artifact a piece of evidence points at. */
export type CodeEvidenceType =
  | "branch"
  | "pull_request"
  | "commit"
  | "changed_file"
  | "pipeline_run"
  | "review"
  | "external_url";

/** Identifies how a code-evidence link was discovered or reported. */
export type CodeEvidenceLinkSource =
  | "webhook"
  | "branch_pattern"
  | "commit_trailer"
  | "agent_reported"
  | "human_manual"
  | "migration"
  | "api"
  | "artifact_mirror"
  | "remote";

/** Lifecycle state describing whether a link's backing artifact has been confirmed to exist. */
export type CodeEvidenceVerificationState = "verified" | "unverified" | "stale" | "failed";
/** Status of a link's correctness over time — active, superseded, marked incorrect, or removed. */
export type CodeEvidenceLinkStatus = "active" | "superseded" | "incorrect" | "removed";
/** Roll-up status indicating whether a task or mission has the code evidence its lifecycle expects. */
export type CodeEvidenceCompletenessStatus =
  | "complete"
  | "partial"
  | "missing"
  | "not_applicable"
  | "unknown";
/** Lifecycle state of a reported evidence gap — active or resolved. */
export type CodeEvidenceGapStatus = "active" | "resolved";
/** The kind of Orcy object that code evidence is attached to — a task or a mission. */
export type CodeEvidenceTargetType = "task" | "mission";
/** Who performed an evidence-related action: a local human/agent/system or a remote participant. */
export type CodeEvidenceActorType = "human" | "agent" | "system" | "remote_human" | "remote_orcy";
/** Outcome states for provider code reviews (pending, approved, changes requested, etc.). */
export type CodeEvidenceReviewStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";
/** File-level diff classification describing how a changed file was altered. */
export type CodeEvidenceChangeType = "added" | "modified" | "deleted" | "renamed";
/** Opaque string identifier for a code provider (e.g. a git host slug). */
export type CodeEvidenceProvider = string;

/** Runtime list of every valid {@link CodeEvidenceType} value. */
export const CODE_EVIDENCE_TYPES: CodeEvidenceType[] = [
  "branch",
  "pull_request",
  "commit",
  "changed_file",
  "pipeline_run",
  "review",
  "external_url",
];

/** Runtime list of every valid {@link CodeEvidenceLinkSource} value (excludes the internal-only `remote` source). */
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

/** Runtime list of every valid {@link CodeEvidenceVerificationState} value. */
export const CODE_EVIDENCE_VERIFICATION_STATES: CodeEvidenceVerificationState[] = [
  "verified",
  "unverified",
  "stale",
  "failed",
];
/** Runtime list of every valid {@link CodeEvidenceLinkStatus} value. */
export const CODE_EVIDENCE_LINK_STATUSES: CodeEvidenceLinkStatus[] = [
  "active",
  "superseded",
  "incorrect",
  "removed",
];
/** Runtime list of every valid {@link CodeEvidenceCompletenessStatus} value. */
export const CODE_EVIDENCE_COMPLETENESS_STATUSES: CodeEvidenceCompletenessStatus[] = [
  "complete",
  "partial",
  "missing",
  "not_applicable",
  "unknown",
];
/** Runtime list of every valid {@link CodeEvidenceGapStatus} value. */
export const CODE_EVIDENCE_GAP_STATUSES: CodeEvidenceGapStatus[] = ["active", "resolved"];
/** Runtime list of every valid {@link CodeEvidenceReviewStatus} value. */
export const CODE_EVIDENCE_REVIEW_STATUSES: CodeEvidenceReviewStatus[] = [
  "pending",
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
];
/** Runtime list of every valid {@link CodeEvidenceChangeType} value. */
export const CODE_EVIDENCE_CHANGE_TYPES: CodeEvidenceChangeType[] = [
  "added",
  "modified",
  "deleted",
  "renamed",
];

/** Built-in set of provider identifiers Orcy ships support for. */
export const KNOWN_PROVIDERS = ["github", "gitlab", "local", "external"] as const;
/** Union of the provider identifiers in {@link KNOWN_PROVIDERS}. */
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** Closed set of reasons explaining why code evidence is not applicable to a task or mission. */
export const NOT_APPLICABLE_REASONS = [
  "research_only",
  "planning_design",
  "documentation_only_no_code",
  "triage_support",
  "review_only",
  "other",
] as const;
/** Union of the reason codes in {@link NOT_APPLICABLE_REASONS}. */
export type NotApplicableReason = (typeof NOT_APPLICABLE_REASONS)[number];

/** Closed set of reason codes explaining why expected code evidence is currently missing. */
export const GAP_REASONS = [
  "work_outside_orcy",
  "pr_commit_not_created_yet",
  "provider_webhook_missing",
  "local_branch_deleted",
  "evidence_unavailable_permissions",
  "waiting_for_reviewer_provider",
  "other",
] as const;
/** Union of the reason codes in {@link GAP_REASONS}. */
export type GapReason = (typeof GAP_REASONS)[number];

/** Closed set of reason codes explaining why a recorded evidence link is being corrected or invalidated. */
export const CORRECTION_REASONS = [
  "wrong_task",
  "wrong_mission",
  "duplicate_evidence",
  "external_repo",
  "obsolete_link",
  "bad_url",
  "other",
] as const;
/** Union of the reason codes in {@link CORRECTION_REASONS}. */
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

/** Per-source baseline confidence score (0–1) assigned to a newly discovered link. */
export const DEFAULT_CONFIDENCE: Record<CodeEvidenceLinkSource, number> = {
  webhook: 1.0,
  branch_pattern: 0.9,
  commit_trailer: 1.0,
  agent_reported: 0.75,
  human_manual: 0.8,
  migration: 0.6,
  api: 0.8,
  artifact_mirror: 0.6,
  remote: 0.5,
};

/** Confidence score for evidence from a repository Orcy does not directly control. */
export const EXTERNAL_REPO_CONFIDENCE = 0.5;
/** Confidence score assigned when a link's backing artifact failed provider verification. */
export const FAILED_VERIFICATION_CONFIDENCE = 0.3;

/** Git commit trailer key used to associate a commit with a specific task ID. */
export const ORCY_TASK_TRAILER = "Orcy-Task";
/** Git commit trailer key used to associate a commit with a specific mission ID. */
export const ORCY_MISSION_TRAILER = "Orcy-Mission";

/** Regex capturing owner, repo, and number from a GitHub pull-request URL. */
export const GITHUB_PR_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
/** Regex capturing owner, repo, and SHA from a GitHub commit URL. */
export const GITHUB_COMMIT_URL_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;
/** Regex capturing owner, repo, and run id from a GitHub Actions run URL. */
export const GITHUB_ACTIONS_RUN_URL_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/;
/** Regex capturing project path and merge-request id from a GitLab merge-request URL. */
export const GITLAB_MR_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/;
/** Regex capturing project path and SHA from a GitLab commit URL. */
export const GITLAB_COMMIT_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/commit\/([0-9a-f]{7,40})/;
/** Regex capturing project path and pipeline id from a GitLab pipeline URL. */
export const GITLAB_PIPELINE_URL_PATTERN =
  /^https:\/\/gitlab\.com\/([^/]+(?:\/[^/]+)*)\/-\/pipelines\/(\d+)/;

/** Raw input payload describing code artifacts submitted for linking to a task or mission. */
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

/** Serialized representation of a single recorded evidence link with verification state and lifecycle status. */
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

/** Serialized representation of a reported evidence gap and its resolution lifecycle. */
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

/** Snapshot of a target's evidence-completeness verdict with reason and actor. */
export interface CodeEvidenceCompletenessInfo {
  status: CodeEvidenceCompletenessStatus;
  reasonCode?: string;
  reasonNote?: string;
  updatedAt?: string;
  actor?: { type: CodeEvidenceActorType; id: string; name?: string };
}

/** Aggregate counts describing the volume and health of evidence attached to a target. */
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

/** Full read model for code evidence on a single task or mission, including links, gaps, and history. */
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

/** Historical view containing superseded/removed links and resolved gaps for a target. */
export interface CodeEvidenceHistory {
  links: CodeEvidenceLinkItem[];
  resolvedGaps: CodeEvidenceGapItem[];
}

/** Extended {@link CodeEvidenceResponse} for missions, adding rolled-up task evidence and per-task completeness. */
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

/** Result of a bulk link-ingestion operation with created links, warnings, and errors. */
export interface CodeEvidenceBulkResult {
  links: CodeEvidenceLinkItem[];
  warnings: Array<{ code: string; message: string; inputRef?: string }>;
  errors: Array<{ code: string; message: string; inputRef?: string }>;
}

/** Persisted record identifying a git repository linked to Orcy, including provider and verification state. */
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

/** Partial input used when resolving or registering a {@link RepositoryIdentity} from external signals. */
export interface RepositoryIdentityInput {
  provider?: string;
  providerBaseUrl?: string;
  externalId?: string;
  repoSlug?: string;
  displayName?: string;
  localPath?: string;
}

/** Input for marking an existing link as incorrect, removed, or superseded. */
export interface CodeEvidenceCorrectionInput {
  status: "incorrect" | "removed" | "superseded";
  reason: CorrectionReason | string;
  customReason?: string;
  replacementLinkId?: string;
}

/** Input for declaring that code evidence is not applicable to a target. */
export interface CodeEvidenceNotApplicableInput {
  reasonCode?: NotApplicableReason | string;
  reasonNote?: string;
}

/** Input for reporting a new evidence gap with a structured {@link GapReason}. */
export interface CodeEvidenceGapInput {
  reasonCode: GapReason | string;
  reasonNote?: string;
}

/** Input for resolving an existing evidence gap with a resolution reason. */
export interface CodeEvidenceGapResolveInput {
  resolutionReason: string;
}
