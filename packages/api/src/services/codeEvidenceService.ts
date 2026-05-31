import type {
  CodeEvidenceType,
  CodeEvidenceLinkSource,
  CodeEvidenceVerificationState,
  CodeEvidenceLinkStatus,
  CodeEvidenceTargetType,
  CodeEvidenceActorType,
  CodeEvidenceLinkInput,
  CodeEvidenceLinkItem,
  CodeEvidenceBulkResult,
  CodeEvidenceCorrectionInput,
  CodeEvidenceNotApplicableInput,
  CodeEvidenceGapInput,
  CodeEvidenceGapResolveInput,
  CodeEvidenceCompletenessInfo,
  CodeEvidenceSummary,
  CodeEvidenceResponse,
  CodeEvidenceHistory,
  CodeEvidenceGapItem,
  CodeEvidenceGapStatus,
  RepositoryIdentity,
} from "@orcy/shared";
import {
  DEFAULT_CONFIDENCE,
  EXTERNAL_REPO_CONFIDENCE,
  FAILED_VERIFICATION_CONFIDENCE,
  GITHUB_PR_URL_PATTERN,
  GITHUB_COMMIT_URL_PATTERN,
  GITHUB_ACTIONS_RUN_URL_PATTERN,
  GITLAB_MR_URL_PATTERN,
  GITLAB_COMMIT_URL_PATTERN,
  GITLAB_PIPELINE_URL_PATTERN,
  GAP_REASONS,
  ORCY_TASK_TRAILER,
  ORCY_MISSION_TRAILER,
} from "@orcy/shared";

import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeBranchRepo from "../repositories/codeBranchRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeChangedFileRepo from "../repositories/codeChangedFileRepository.js";
import * as codeReviewRepo from "../repositories/codeReviewRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as taskRepo from "../repositories/task.js";
import * as pipelineEventRepo from "../repositories/pipelineEvent.js";

type ParsedUrl = {
  evidenceType: CodeEvidenceType;
  provider: string;
  repoSlug: string;
  identifier: string;
  providerBaseUrl?: string;
} | null;

function parseUrl(url: string): ParsedUrl {
  let match: RegExpMatchArray | null;

  match = url.match(GITHUB_PR_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pull_request",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITHUB_COMMIT_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "commit",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITHUB_ACTIONS_RUN_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pipeline_run",
      provider: "github",
      repoSlug: `${match[1]}/${match[2]}`,
      identifier: match[3],
    };
  }

  match = url.match(GITLAB_MR_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pull_request",
      provider: "gitlab",
      repoSlug: match[1],
      identifier: match[2],
    };
  }

  match = url.match(GITLAB_COMMIT_URL_PATTERN);
  if (match) {
    return { evidenceType: "commit", provider: "gitlab", repoSlug: match[1], identifier: match[2] };
  }

  match = url.match(GITLAB_PIPELINE_URL_PATTERN);
  if (match) {
    return {
      evidenceType: "pipeline_run",
      provider: "gitlab",
      repoSlug: match[1],
      identifier: match[2],
    };
  }

  return null;
}

function parseCommitTrailers(message: string): { taskId?: string; missionId?: string } {
  const result: { taskId?: string; missionId?: string } = {};
  const lines = message.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const taskMatch = trimmed.match(/^(Orcy-Task|orcy-task):\s*(.+)$/i);
    if (taskMatch) result.taskId = taskMatch[2].trim();
    const missionMatch = trimmed.match(/^(Orcy-Mission|orcy-mission):\s*(.+)$/i);
    if (missionMatch) result.missionId = missionMatch[2].trim();
  }
  return result;
}

function matchBranchPattern(branchName: string, branchPrefix: string): string | null {
  const prefix = branchPrefix.endsWith("/") ? branchPrefix : `${branchPrefix}/`;
  if (branchName.startsWith(prefix)) {
    const afterPrefix = branchName.slice(prefix.length);
    const taskId = afterPrefix.split("-")[0] || afterPrefix.split("/")[0];
    if (taskId && taskId.length > 0) return taskId;
  }
  return null;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hashIdx = parsed.href.indexOf("#");
    return hashIdx >= 0 ? parsed.href.slice(0, hashIdx).toLowerCase() : parsed.href.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function inferInitialConfidence(
  source: CodeEvidenceLinkSource,
  isExternalRepo: boolean,
  verificationState: CodeEvidenceVerificationState,
): number {
  if (verificationState === "failed") return FAILED_VERIFICATION_CONFIDENCE;
  if (isExternalRepo) return EXTERNAL_REPO_CONFIDENCE;
  return DEFAULT_CONFIDENCE[source] ?? 0.5;
}

function determineVerificationState(
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

export function getTaskCodeEvidence(
  taskId: string,
  options?: { includeHistory?: boolean },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("task", taskId, options);
}

export function getMissionCodeEvidence(
  missionId: string,
  options?: { includeHistory?: boolean },
): CodeEvidenceResponse {
  return getTargetCodeEvidence("mission", missionId, options);
}

function getTargetCodeEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  options?: { includeHistory?: boolean },
): CodeEvidenceResponse {
  const activeLinks = codeEvidenceLinkRepo.getActiveByTarget(targetType, targetId);
  const activeGaps = codeEvidenceGapRepo.getActiveByTarget(targetType, targetId);
  const completenessOverride = codeEvidenceCompletenessRepo.getByTarget(targetType, targetId);

  const target =
    activeLinks.length > 0
      ? { type: targetType, id: targetId, habitatId: "" }
      : { type: targetType, id: targetId, habitatId: "" };

  const repository = null;

  const completeness = deriveCompleteness(targetType, targetId, completenessOverride);
  const summary = computeSummary(targetType, targetId, activeLinks);

  const groups = groupByEvidenceType(activeLinks);

  let history: CodeEvidenceHistory | undefined;
  if (options?.includeHistory) {
    const historyLinks = codeEvidenceLinkRepo.getHistoryByTarget(targetType, targetId);
    const resolvedGaps = codeEvidenceGapRepo.getResolvedByTarget(targetType, targetId);
    history = {
      links: historyLinks.map(mapLinkToItem),
      resolvedGaps: resolvedGaps.map(mapGapToItem),
    };
  }

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

export function linkTaskCodeEvidence(
  taskId: string,
  input: CodeEvidenceLinkInput,
  actor: { type: CodeEvidenceActorType; id: string },
): CodeEvidenceBulkResult {
  return linkTargetCodeEvidence("task", taskId, input, actor);
}

export function linkMissionCodeEvidence(
  missionId: string,
  input: CodeEvidenceLinkInput,
  actor: { type: CodeEvidenceActorType; id: string },
): CodeEvidenceBulkResult {
  return linkTargetCodeEvidence("mission", missionId, input, actor);
}

function linkTargetCodeEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  input: CodeEvidenceLinkInput,
  actor: { type: CodeEvidenceActorType; id: string },
): CodeEvidenceBulkResult {
  const links: CodeEvidenceLinkItem[] = [];
  const warnings: Array<{ code: string; message: string; inputRef?: string }> = [];
  const errors: Array<{ code: string; message: string; inputRef?: string }> = [];

  const repository = codeEvidenceRepository.getByHabitatId("");
  const isRepoVerified = repository?.verificationState === "verified";

  if (input.branch) {
    const result = linkBranch(
      targetType,
      targetId,
      input.branch,
      actor,
      isRepoVerified,
      input.allowExternalRepository ?? false,
    );
    if (result.link) links.push(result.link);
    if (result.warning) warnings.push(result.warning);
    if (result.error) errors.push(result.error);
  }

  if (input.commits?.length) {
    for (let i = 0; i < input.commits.length; i++) {
      const commit = input.commits[i];
      const result = linkCommit(
        targetType,
        targetId,
        commit,
        actor,
        isRepoVerified,
        input.allowExternalRepository ?? false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
      if (result.error) errors.push(result.error);

      if (commit.trailers) {
        for (const trailer of commit.trailers) {
          if (trailer.key.toLowerCase() === "orcy-task") {
            if (targetType !== "task" || trailer.value !== targetId) {
              const trailerResult = linkCommitTrailerTarget(
                "task",
                trailer.value,
                commit,
                actor,
                isRepoVerified,
              );
              if (trailerResult.link) links.push(trailerResult.link);
              if (trailerResult.warning) warnings.push(trailerResult.warning);
            }
          }
          if (trailer.key.toLowerCase() === "orcy-mission") {
            if (targetType !== "mission" || trailer.value !== targetId) {
              const trailerResult = linkCommitTrailerTarget(
                "mission",
                trailer.value,
                commit,
                actor,
                isRepoVerified,
              );
              if (trailerResult.link) links.push(trailerResult.link);
              if (trailerResult.warning) warnings.push(trailerResult.warning);
            }
          }
        }
      }
    }
  }

  if (input.changedFiles?.length) {
    for (const file of input.changedFiles) {
      linkChangedFile(targetType, targetId, file, actor, isRepoVerified);
    }
  }

  if (input.pullRequestUrl) {
    const parsed = parseUrl(input.pullRequestUrl);
    if (parsed && parsed.evidenceType === "pull_request") {
      const result = linkParsedUrl(
        targetType,
        targetId,
        parsed,
        input.pullRequestUrl,
        "human_manual",
        actor,
        isRepoVerified,
        input.allowExternalRepository ?? false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
      if (result.error) errors.push(result.error);
    } else {
      const result = linkExternalUrl(
        targetType,
        targetId,
        input.pullRequestUrl,
        "human_manual",
        actor,
        input.allowExternalRepository ?? false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
    }
  }

  if (input.pipelineUrl) {
    const parsed = parseUrl(input.pipelineUrl);
    if (parsed && parsed.evidenceType === "pipeline_run") {
      const result = linkParsedUrl(
        targetType,
        targetId,
        parsed,
        input.pipelineUrl,
        "human_manual",
        actor,
        isRepoVerified,
        input.allowExternalRepository ?? false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
    } else {
      const result = linkExternalUrl(
        targetType,
        targetId,
        input.pipelineUrl,
        "human_manual",
        actor,
        input.allowExternalRepository ?? false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
    }
  }

  if (input.externalUrls?.length) {
    for (const url of input.externalUrls) {
      const parsed = parseUrl(url);
      if (parsed) {
        const result = linkParsedUrl(
          targetType,
          targetId,
          parsed,
          url,
          "human_manual",
          actor,
          isRepoVerified,
          input.allowExternalRepository ?? false,
        );
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
      } else {
        const result = linkExternalUrl(
          targetType,
          targetId,
          url,
          "human_manual",
          actor,
          input.allowExternalRepository ?? false,
        );
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
      }
    }
  }

  const autoResolveCodes = [
    "pr_commit_not_created_yet",
    "provider_webhook_missing",
    "waiting_for_reviewer_provider",
  ];
  codeEvidenceGapRepo.autoResolveByReasonCodes(targetType, targetId, autoResolveCodes);

  return { links, warnings, errors };
}

function linkBranch(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  branch: { name: string; headSha?: string; baseBranch?: string; url?: string },
  actor: { type: CodeEvidenceActorType; id: string },
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): {
  link?: CodeEvidenceLinkItem;
  warning?: { code: string; message: string };
  error?: { code: string; message: string };
} {
  const source: CodeEvidenceLinkSource = "human_manual";
  const verificationState = determineVerificationState(source, isRepoVerified, false);
  const confidence = inferInitialConfidence(source, false, verificationState);

  const branchRecord = codeBranchRepo.upsertByRepoAndName({
    name: branch.name,
    headSha: branch.headSha,
    baseBranch: branch.baseBranch,
    url: branch.url,
    provider: "local",
    verificationState,
    createdFromTaskId: targetType === "task" ? targetId : undefined,
  });

  if (!branchRecord) {
    return {
      error: {
        code: "BRANCH_CREATE_FAILED",
        message: `Failed to create branch evidence for ${branch.name}`,
      },
    };
  }

  const link = ensureEvidenceLink(
    targetType,
    targetId,
    "branch",
    branchRecord.id,
    null,
    branch.name,
    source,
    actor,
    verificationState,
    confidence,
    allowExternalRepo,
  );
  return { link: link ? mapLinkToItem(link) : undefined };
}

function linkCommit(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  commit: {
    sha: string;
    message?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    url?: string;
    branch?: string;
  },
  actor: { type: CodeEvidenceActorType; id: string },
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): {
  link?: CodeEvidenceLinkItem;
  warning?: { code: string; message: string };
  error?: { code: string; message: string };
} {
  const source: CodeEvidenceLinkSource = actor.type === "agent" ? "agent_reported" : "human_manual";
  const verificationState = determineVerificationState(source, isRepoVerified, false);
  const confidence = inferInitialConfidence(source, false, verificationState);

  const commitRecord = codeCommitRepo.upsertByRepoAndSha({
    sha: commit.sha,
    message: commit.message,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    authoredAt: commit.authoredAt,
    url: commit.url,
    provider: "local",
    verificationState,
  });

  if (!commitRecord) {
    return {
      error: {
        code: "COMMIT_CREATE_FAILED",
        message: `Failed to create commit evidence for ${commit.sha}`,
      },
    };
  }

  const link = ensureEvidenceLink(
    targetType,
    targetId,
    "commit",
    commitRecord.id,
    commit.url ?? null,
    commit.sha.slice(0, 7),
    source,
    actor,
    verificationState,
    confidence,
    allowExternalRepo,
  );
  return { link: link ? mapLinkToItem(link) : undefined };
}

function linkCommitTrailerTarget(
  trailerTargetType: CodeEvidenceTargetType,
  trailerTargetId: string,
  commit: {
    sha: string;
    message?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    url?: string;
  },
  actor: { type: CodeEvidenceActorType; id: string },
  isRepoVerified: boolean | null,
): { link?: CodeEvidenceLinkItem; warning?: { code: string; message: string } } {
  const source: CodeEvidenceLinkSource = "commit_trailer";
  const verificationState = determineVerificationState(source, isRepoVerified, false);
  const confidence = inferInitialConfidence(source, false, verificationState);

  const commitRecord = codeCommitRepo.upsertByRepoAndSha({
    sha: commit.sha,
    message: commit.message,
    provider: "local",
    verificationState,
  });

  if (!commitRecord) {
    return {
      warning: {
        code: "TRAILER_COMMIT_FAILED",
        message: `Failed to create commit evidence for trailer target`,
      },
    };
  }

  const link = ensureEvidenceLink(
    trailerTargetType,
    trailerTargetId,
    "commit",
    commitRecord.id,
    null,
    commit.sha.slice(0, 7),
    source,
    actor,
    verificationState,
    confidence,
    false,
  );
  return { link: link ? mapLinkToItem(link) : undefined };
}

function linkChangedFile(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  file: {
    path: string;
    previousPath?: string;
    changeType: "added" | "modified" | "deleted" | "renamed";
    additions?: number;
    deletions?: number;
    commitSha?: string;
    pullRequestNumber?: number;
  },
  actor: { type: CodeEvidenceActorType; id: string },
  isRepoVerified: boolean | null,
) {
  codeChangedFileRepo.create({
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.changeType,
    additions: file.additions,
    deletions: file.deletions,
    provider: "local",
    source: actor.type === "agent" ? "agent_reported" : "human_manual",
  });
}

function linkParsedUrl(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  parsed: NonNullable<ParsedUrl>,
  originalUrl: string,
  source: CodeEvidenceLinkSource,
  actor: { type: CodeEvidenceActorType; id: string },
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): {
  link?: CodeEvidenceLinkItem;
  warning?: { code: string; message: string };
  error?: { code: string; message: string };
} {
  const verificationState = determineVerificationState(source, isRepoVerified, false);
  const confidence = inferInitialConfidence(source, false, verificationState);

  const title = `${parsed.evidenceType.replace("_", " ")} ${parsed.identifier}`;
  const link = ensureEvidenceLink(
    targetType,
    targetId,
    parsed.evidenceType,
    null,
    originalUrl,
    title,
    source,
    actor,
    verificationState,
    confidence,
    allowExternalRepo,
  );

  if (!link) {
    return {
      error: {
        code: "EVIDENCE_LINK_FAILED",
        message: `Failed to link ${parsed.evidenceType} evidence`,
      },
    };
  }
  return { link: mapLinkToItem(link) };
}

function linkExternalUrl(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  url: string,
  source: CodeEvidenceLinkSource,
  actor: { type: CodeEvidenceActorType; id: string },
  allowExternalRepo: boolean,
): { link?: CodeEvidenceLinkItem; warning?: { code: string; message: string } } {
  const normalized = normalizeUrl(url);
  const verificationState: CodeEvidenceVerificationState = "unverified";
  const confidence = 0.5;

  const link = ensureEvidenceLink(
    targetType,
    targetId,
    "external_url",
    null,
    url,
    url,
    source,
    actor,
    verificationState,
    confidence,
    allowExternalRepo,
    normalized,
  );

  if (!link) {
    return {
      warning: { code: "EXTERNAL_URL_LINK_FAILED", message: `Failed to link external URL` },
    };
  }
  return { link: mapLinkToItem(link) };
}

function ensureEvidenceLink(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  evidenceType: CodeEvidenceType,
  evidenceId: string | null,
  externalUrl: string | null,
  title: string | null,
  linkSource: CodeEvidenceLinkSource,
  actor: { type: CodeEvidenceActorType; id: string },
  verificationState: CodeEvidenceVerificationState,
  confidence: number,
  allowExternalRepo: boolean,
  normalizedExternalUrl?: string,
): typeof codeEvidenceLinks.$inferSelect | null {
  const existing = codeEvidenceLinkRepo.findActiveDuplicate(
    targetType,
    targetId,
    evidenceType,
    evidenceId,
    normalizedExternalUrl ?? externalUrl,
  );

  if (existing) {
    codeEvidenceLinkRepo.addCorroboratingSource(existing.id, linkSource);
    return codeEvidenceLinkRepo.getById(existing.id);
  }

  return codeEvidenceLinkRepo.create({
    targetType,
    targetId,
    evidenceType,
    evidenceId,
    externalUrl,
    normalizedExternalUrl:
      normalizedExternalUrl ?? (externalUrl ? normalizeUrl(externalUrl) : null),
    title,
    linkSource,
    linkSources: [linkSource],
    linkedByType: actor.type,
    linkedById: actor.id,
    verificationState,
    confidence,
    allowExternalRepository: allowExternalRepo,
  });
}

export function correctEvidenceLink(
  linkId: string,
  input: CodeEvidenceCorrectionInput,
  actor: { type: CodeEvidenceActorType; id: string },
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
  actor: { type: CodeEvidenceActorType; id: string },
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
  actor: { type: CodeEvidenceActorType; id: string },
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
  actor: { type: CodeEvidenceActorType; id: string },
) {
  return codeEvidenceGapRepo.resolveGap(gapId, actor.type, actor.id, input.resolutionReason);
}

function deriveCompleteness(
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

function computeSummary(
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

function groupByEvidenceType(
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

function mapLinkToItem(link: typeof codeEvidenceLinks.$inferSelect): CodeEvidenceLinkItem {
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

function mapGapToItem(gap: typeof codeEvidenceGaps.$inferSelect): CodeEvidenceGapItem {
  return {
    id: gap.id,
    targetType: gap.targetType as CodeEvidenceTargetType,
    targetId: gap.targetId,
    reasonCode: gap.reasonCode as any,
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

import { codeEvidenceLinks, codeEvidenceGaps } from "../db/schema/index.js";

export function ensureEvidenceLinkForPullRequest(
  pr: {
    id: string;
    taskId: string;
    provider: string;
    repo: string;
    prNumber: number;
    prTitle: string | null;
    prUrl: string;
    branchName: string | null;
  },
  source: CodeEvidenceLinkSource,
  habitatId: string,
) {
  const repository = codeEvidenceRepository.getByHabitatId(habitatId);
  const isRepoVerified = repository?.verificationState === "verified";
  const verificationState =
    source === "webhook" && isRepoVerified
      ? ("verified" as CodeEvidenceVerificationState)
      : ("unverified" as CodeEvidenceVerificationState);
  const confidence = DEFAULT_CONFIDENCE[source] ?? 0.5;

  const link = ensureEvidenceLink(
    "task",
    pr.taskId,
    "pull_request",
    pr.id,
    pr.prUrl,
    pr.prTitle ?? `PR #${pr.prNumber}`,
    source,
    { type: "system", id: "webhook" },
    verificationState,
    confidence,
    false,
  );

  return link;
}

export function ensureEvidenceLinkForPipelineEvent(
  event: {
    id: string;
    taskId: string;
    provider: string;
    repo: string;
    runId: string;
    branch: string;
    commitSha: string | null;
  },
  source: CodeEvidenceLinkSource,
  habitatId: string,
) {
  const repository = codeEvidenceRepository.getByHabitatId(habitatId);
  const isRepoVerified = repository?.verificationState === "verified";
  const verificationState =
    source === "webhook" && isRepoVerified
      ? ("verified" as CodeEvidenceVerificationState)
      : ("unverified" as CodeEvidenceVerificationState);
  const confidence = DEFAULT_CONFIDENCE[source] ?? 0.5;

  const link = ensureEvidenceLink(
    "task",
    event.taskId,
    "pipeline_run",
    event.id,
    null,
    `Pipeline ${event.runId}`,
    source,
    { type: "system", id: "webhook" },
    verificationState,
    confidence,
    false,
  );

  return link;
}

export function mirrorArtifactsToCodeEvidence(
  taskId: string,
  artifacts: Array<{ type: string; url: string; description: string }>,
  actor: { type: CodeEvidenceActorType; id: string },
): CodeEvidenceBulkResult {
  const links: CodeEvidenceLinkItem[] = [];
  const warnings: Array<{ code: string; message: string; inputRef?: string }> = [];
  const errors: Array<{ code: string; message: string; inputRef?: string }> = [];

  for (let i = 0; i < artifacts.length; i++) {
    const artifact = artifacts[i];
    const source: CodeEvidenceLinkSource = "artifact_mirror";

    if (artifact.type === "pr") {
      const parsed = parseUrl(artifact.url);
      if (parsed && parsed.evidenceType === "pull_request") {
        const result = linkParsedUrl(
          "task",
          taskId,
          parsed,
          artifact.url,
          source,
          actor,
          null,
          false,
        );
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
        if (result.error) errors.push(result.error);
      } else {
        const result = linkExternalUrl("task", taskId, artifact.url, source, actor, false);
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
      }
    } else if (artifact.type === "commit") {
      const result = linkCommit(
        "task",
        taskId,
        { sha: artifact.url, message: artifact.description },
        actor,
        null,
        false,
      );
      if (result.link) links.push(result.link);
      if (result.warning) warnings.push(result.warning);
      if (result.error) errors.push(result.error);
    } else if (artifact.type === "log") {
      const parsed = parseUrl(artifact.url);
      if (parsed && parsed.evidenceType === "pipeline_run") {
        const result = linkParsedUrl(
          "task",
          taskId,
          parsed,
          artifact.url,
          source,
          actor,
          null,
          false,
        );
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
      } else {
        const result = linkExternalUrl("task", taskId, artifact.url, source, actor, false);
        if (result.link) links.push(result.link);
        if (result.warning) warnings.push(result.warning);
      }
    }
  }

  return { links, warnings, errors };
}

export function backfillExistingCodeEvidence(): {
  prCount: number;
  pipelineCount: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let prCount = 0;
  let pipelineCount = 0;

  try {
    const prRows = prRepo.getAll();
    for (const pr of prRows) {
      try {
        const habitatId = taskRepo.getHabitatIdForTask(pr.taskId);
        if (!habitatId) {
          warnings.push(`PR ${pr.id}: could not resolve habitat for task ${pr.taskId}`);
          continue;
        }
        ensureEvidenceLinkForPullRequest(
          {
            id: pr.id,
            taskId: pr.taskId,
            provider: pr.provider,
            repo: pr.repo,
            prNumber: pr.prNumber,
            prTitle: pr.prTitle,
            prUrl: pr.prUrl,
            branchName: pr.branchName,
          },
          "migration",
          habitatId,
        );
        prCount++;
      } catch (err) {
        warnings.push(`PR ${pr.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`PR backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const pipelineRows = pipelineEventRepo.getAll();
    for (const event of pipelineRows) {
      try {
        const habitatId = taskRepo.getHabitatIdForTask(event.taskId);
        if (!habitatId) {
          warnings.push(`Pipeline ${event.id}: could not resolve habitat for task ${event.taskId}`);
          continue;
        }
        ensureEvidenceLinkForPipelineEvent(
          {
            id: event.id,
            taskId: event.taskId,
            provider: event.provider,
            repo: event.repo,
            runId: event.runId,
            branch: event.branch ?? "",
            commitSha: event.commitSha,
          },
          "migration",
          habitatId,
        );
        pipelineCount++;
      } catch (err) {
        warnings.push(`Pipeline ${event.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    warnings.push(`Pipeline backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { prCount, pipelineCount, warnings };
}
