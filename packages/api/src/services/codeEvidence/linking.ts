import type {
  CodeEvidenceBulkResult,
  CodeEvidenceLinkInput,
  CodeEvidenceLinkItem,
  CodeEvidenceLinkSource,
  CodeEvidenceTargetType,
  CodeEvidenceType,
  CodeEvidenceVerificationState,
} from "@orcy/shared";
import { DEFAULT_CONFIDENCE } from "@orcy/shared";

import { codeEvidenceLinks } from "../../db/schema/index.js";
import * as codeBranchRepo from "../../repositories/codeBranchRepository.js";
import * as codeChangedFileRepo from "../../repositories/codeChangedFileRepository.js";
import * as codeCommitRepo from "../../repositories/codeCommitRepository.js";
import * as codeEvidenceRepository from "../../repositories/codeEvidenceRepository.js";
import * as codeEvidenceGapRepo from "../../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../../repositories/codeEvidenceLinkRepository.js";
import { determineVerificationState, inferInitialConfidence } from "./confidence.js";
import { mapLinkToItem } from "./mappers.js";
import type { CodeEvidenceActor, LinkResult, ParsedUrl } from "./types.js";
import { normalizeUrl, parseUrl } from "./urlParsing.js";

export function linkTaskCodeEvidence(
  taskId: string,
  input: CodeEvidenceLinkInput,
  actor: CodeEvidenceActor,
  options?: { habitatId?: string },
): CodeEvidenceBulkResult {
  return linkTargetCodeEvidence("task", taskId, input, actor, options?.habitatId);
}

export function linkMissionCodeEvidence(
  missionId: string,
  input: CodeEvidenceLinkInput,
  actor: CodeEvidenceActor,
  options?: { habitatId?: string },
): CodeEvidenceBulkResult {
  return linkTargetCodeEvidence("mission", missionId, input, actor, options?.habitatId);
}

function linkTargetCodeEvidence(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  input: CodeEvidenceLinkInput,
  actor: CodeEvidenceActor,
  habitatId?: string,
): CodeEvidenceBulkResult {
  const links: CodeEvidenceLinkItem[] = [];
  const warnings: Array<{ code: string; message: string; inputRef?: string }> = [];
  const errors: Array<{ code: string; message: string; inputRef?: string }> = [];

  const repository = habitatId ? codeEvidenceRepository.getByHabitatId(habitatId) : null;
  const isRepoVerified = repository?.verificationState === "verified";

  if (input.branch) {
    pushResult(
      linkBranch(
        targetType,
        targetId,
        input.branch,
        actor,
        isRepoVerified,
        input.allowExternalRepository ?? false,
      ),
      links,
      warnings,
      errors,
    );
  }

  if (input.commits?.length) {
    for (const commit of input.commits) {
      pushResult(
        linkCommit(
          targetType,
          targetId,
          commit,
          actor,
          isRepoVerified,
          input.allowExternalRepository ?? false,
        ),
        links,
        warnings,
        errors,
      );

      if (commit.trailers) {
        for (const trailer of commit.trailers) {
          if (trailer.key.toLowerCase() === "orcy-task") {
            if (targetType !== "task" || trailer.value !== targetId) {
              pushResult(
                linkCommitTrailerTarget("task", trailer.value, commit, actor, isRepoVerified),
                links,
                warnings,
                errors,
              );
            }
          }
          if (trailer.key.toLowerCase() === "orcy-mission") {
            if (targetType !== "mission" || trailer.value !== targetId) {
              pushResult(
                linkCommitTrailerTarget("mission", trailer.value, commit, actor, isRepoVerified),
                links,
                warnings,
                errors,
              );
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
    pushResult(
      parsed && parsed.evidenceType === "pull_request"
        ? linkParsedUrl(
            targetType,
            targetId,
            parsed,
            input.pullRequestUrl,
            "human_manual",
            actor,
            isRepoVerified,
            input.allowExternalRepository ?? false,
          )
        : linkExternalUrl(
            targetType,
            targetId,
            input.pullRequestUrl,
            "human_manual",
            actor,
            input.allowExternalRepository ?? false,
          ),
      links,
      warnings,
      errors,
    );
  }

  if (input.pipelineUrl) {
    const parsed = parseUrl(input.pipelineUrl);
    pushResult(
      parsed && parsed.evidenceType === "pipeline_run"
        ? linkParsedUrl(
            targetType,
            targetId,
            parsed,
            input.pipelineUrl,
            "human_manual",
            actor,
            isRepoVerified,
            input.allowExternalRepository ?? false,
          )
        : linkExternalUrl(
            targetType,
            targetId,
            input.pipelineUrl,
            "human_manual",
            actor,
            input.allowExternalRepository ?? false,
          ),
      links,
      warnings,
      errors,
    );
  }

  if (input.externalUrls?.length) {
    for (const url of input.externalUrls) {
      const parsed = parseUrl(url);
      pushResult(
        parsed
          ? linkParsedUrl(
              targetType,
              targetId,
              parsed,
              url,
              "human_manual",
              actor,
              isRepoVerified,
              input.allowExternalRepository ?? false,
            )
          : linkExternalUrl(
              targetType,
              targetId,
              url,
              "human_manual",
              actor,
              input.allowExternalRepository ?? false,
            ),
        links,
        warnings,
        errors,
      );
    }
  }

  codeEvidenceGapRepo.autoResolveByReasonCodes(targetType, targetId, [
    "pr_commit_not_created_yet",
    "provider_webhook_missing",
    "waiting_for_reviewer_provider",
  ]);

  return { links, warnings, errors };
}

function pushResult(
  result: LinkResult,
  links: CodeEvidenceLinkItem[],
  warnings: Array<{ code: string; message: string; inputRef?: string }>,
  errors: Array<{ code: string; message: string; inputRef?: string }>,
) {
  if (result.link) links.push(result.link);
  if (result.warning) warnings.push(result.warning);
  if (result.error) errors.push(result.error);
}

function linkBranch(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  branch: { name: string; headSha?: string; baseBranch?: string; url?: string },
  actor: CodeEvidenceActor,
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): LinkResult {
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

export function linkCommit(
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
  actor: CodeEvidenceActor,
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): LinkResult {
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
  actor: CodeEvidenceActor,
  isRepoVerified: boolean | null,
): LinkResult {
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
  _targetType: CodeEvidenceTargetType,
  _targetId: string,
  file: {
    path: string;
    previousPath?: string;
    changeType: "added" | "modified" | "deleted" | "renamed";
    additions?: number;
    deletions?: number;
    commitSha?: string;
    pullRequestNumber?: number;
  },
  actor: CodeEvidenceActor,
  _isRepoVerified: boolean | null,
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

export function linkParsedUrl(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  parsed: NonNullable<ParsedUrl>,
  originalUrl: string,
  source: CodeEvidenceLinkSource,
  actor: CodeEvidenceActor,
  isRepoVerified: boolean | null,
  allowExternalRepo: boolean,
): LinkResult {
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

export function linkExternalUrl(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  url: string,
  source: CodeEvidenceLinkSource,
  actor: CodeEvidenceActor,
  allowExternalRepo: boolean,
): LinkResult {
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

export function ensureEvidenceLink(
  targetType: CodeEvidenceTargetType,
  targetId: string,
  evidenceType: CodeEvidenceType,
  evidenceId: string | null,
  externalUrl: string | null,
  title: string | null,
  linkSource: CodeEvidenceLinkSource,
  actor: CodeEvidenceActor,
  verificationState: CodeEvidenceVerificationState,
  confidence: number,
  allowExternalRepo: boolean,
  normalizedExternalUrl?: string,
): typeof codeEvidenceLinks.$inferSelect | null {
  const result = codeEvidenceLinkRepo.findOrCreateActive({
    targetType,
    targetId,
    evidenceType,
    evidenceId,
    externalUrl,
    normalizedExternalUrl:
      normalizedExternalUrl ?? (externalUrl ? normalizeUrl(externalUrl) : null),
    title,
    linkSource,
    linkedByType: actor.type,
    linkedById: actor.id,
    verificationState,
    confidence,
    allowExternalRepository: allowExternalRepo,
  });

  if (!result) return null;

  if (!result.created) {
    codeEvidenceLinkRepo.addCorroboratingSource(result.link.id, linkSource);
    const refreshed = codeEvidenceLinkRepo.getById(result.link.id);
    return refreshed ?? result.link;
  }

  return result.link;
}

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

  return ensureEvidenceLink(
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

  return ensureEvidenceLink(
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
}
