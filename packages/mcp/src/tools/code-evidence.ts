import type { CodeEvidenceClient } from "../api/interfaces.js";

function buildReasonInput(args: {
  reasonCode?: string;
  reasonNote?: string;
  notApplicableReasonCode?: string;
  notApplicableReasonNote?: string;
  gapReasonCode?: string;
  gapReasonNote?: string;
}) {
  const input: { reasonCode?: string; reasonNote?: string } = {};
  const reasonCode = args.reasonCode ?? args.notApplicableReasonCode ?? args.gapReasonCode;
  const reasonNote = args.reasonNote ?? args.notApplicableReasonNote ?? args.gapReasonNote;
  if (reasonCode !== undefined) input.reasonCode = reasonCode;
  if (reasonNote !== undefined) input.reasonNote = reasonNote;
  return input;
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatListTaskCodeEvidence(
  client: CodeEvidenceClient,
  args: { taskId: string; includeHistory?: boolean },
) {
  return client.getTaskCodeEvidence(args.taskId, args.includeHistory);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatLinkTaskCode(
  client: CodeEvidenceClient,
  args: {
    taskId: string;
    branchName?: string;
    branchHeadSha?: string;
    branchBaseBranch?: string;
    branchUrl?: string;
    commitSha?: string;
    commitMessage?: string;
    commitAuthorName?: string;
    commitAuthorEmail?: string;
    commitAuthoredAt?: string;
    commitUrl?: string;
    commitBranch?: string;
    filePath?: string;
    filePreviousPath?: string;
    fileChangeType?: "added" | "modified" | "deleted" | "renamed";
    fileAdditions?: number;
    fileDeletions?: number;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  },
) {
  const {
    taskId,
    branchName,
    branchHeadSha,
    branchBaseBranch,
    branchUrl,
    commitSha,
    commitMessage,
    commitAuthorName,
    commitAuthorEmail,
    commitAuthoredAt,
    commitUrl,
    commitBranch,
    filePath,
    filePreviousPath,
    fileChangeType,
    fileAdditions,
    fileDeletions,
    ...rest
  } = args;

  const input: {
    branch?: { name: string; headSha?: string; baseBranch?: string; url?: string };
    commits?: Array<{
      sha: string;
      message?: string;
      authorName?: string;
      authorEmail?: string;
      authoredAt?: string;
      url?: string;
      branch?: string;
    }>;
    changedFiles?: Array<{
      path: string;
      previousPath?: string;
      changeType: "added" | "modified" | "deleted" | "renamed";
      additions?: number;
      deletions?: number;
    }>;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  } = { ...rest };

  if (branchName) {
    input.branch = {
      name: branchName,
      headSha: branchHeadSha,
      baseBranch: branchBaseBranch,
      url: branchUrl,
    };
  }

  if (commitSha) {
    input.commits = [
      {
        sha: commitSha,
        message: commitMessage,
        authorName: commitAuthorName,
        authorEmail: commitAuthorEmail,
        authoredAt: commitAuthoredAt,
        url: commitUrl,
        branch: commitBranch,
      },
    ];
  }

  if (filePath && fileChangeType) {
    input.changedFiles = [
      {
        path: filePath,
        previousPath: filePreviousPath,
        changeType: fileChangeType,
        additions: fileAdditions,
        deletions: fileDeletions,
      },
    ];
  }

  return client.linkTaskCodeEvidence(taskId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatCorrectTaskEvidenceLink(
  client: CodeEvidenceClient,
  args: {
    taskId: string;
    linkId: string;
    status: "incorrect" | "removed" | "superseded";
    reason: string;
    customReason?: string;
    replacementLinkId?: string;
  },
) {
  const { taskId, linkId, ...input } = args;
  return client.correctTaskEvidenceLink(taskId, linkId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatMarkTaskEvidenceNotApplicable(
  client: CodeEvidenceClient,
  args: {
    taskId: string;
    reasonCode?: string;
    reasonNote?: string;
    notApplicableReasonCode?: string;
    notApplicableReasonNote?: string;
  },
) {
  const { taskId, ...reasonArgs } = args;
  const input = buildReasonInput(reasonArgs);
  return client.markTaskEvidenceNotApplicable(taskId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatClearTaskEvidenceNotApplicable(
  client: CodeEvidenceClient,
  args: { taskId: string },
) {
  return client.clearTaskEvidenceNotApplicable(args.taskId);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatReportTaskEvidenceGap(
  client: CodeEvidenceClient,
  args: {
    taskId: string;
    reasonCode?: string;
    reasonNote?: string;
    gapReasonCode?: string;
    gapReasonNote?: string;
  },
) {
  const { taskId, ...reasonArgs } = args;
  const input = buildReasonInput(reasonArgs);
  return client.reportTaskEvidenceGap(taskId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatResolveTaskEvidenceGap(
  client: CodeEvidenceClient,
  args: { taskId: string; gapId: string; resolutionReason: string },
) {
  const { taskId, gapId, ...input } = args;
  return client.resolveTaskEvidenceGap(taskId, gapId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatListMissionCodeEvidence(
  client: CodeEvidenceClient,
  args: { missionId: string; includeHistory?: boolean },
) {
  return client.getMissionCodeEvidence(args.missionId, args.includeHistory);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatLinkMissionCode(
  client: CodeEvidenceClient,
  args: {
    missionId: string;
    branchName?: string;
    branchHeadSha?: string;
    branchBaseBranch?: string;
    branchUrl?: string;
    commitSha?: string;
    commitMessage?: string;
    commitAuthorName?: string;
    commitAuthorEmail?: string;
    commitAuthoredAt?: string;
    commitUrl?: string;
    commitBranch?: string;
    filePath?: string;
    filePreviousPath?: string;
    fileChangeType?: "added" | "modified" | "deleted" | "renamed";
    fileAdditions?: number;
    fileDeletions?: number;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  },
) {
  const {
    missionId,
    branchName,
    branchHeadSha,
    branchBaseBranch,
    branchUrl,
    commitSha,
    commitMessage,
    commitAuthorName,
    commitAuthorEmail,
    commitAuthoredAt,
    commitUrl,
    commitBranch,
    filePath,
    filePreviousPath,
    fileChangeType,
    fileAdditions,
    fileDeletions,
    ...rest
  } = args;

  const input: {
    branch?: { name: string; headSha?: string; baseBranch?: string; url?: string };
    commits?: Array<{
      sha: string;
      message?: string;
      authorName?: string;
      authorEmail?: string;
      authoredAt?: string;
      url?: string;
      branch?: string;
    }>;
    changedFiles?: Array<{
      path: string;
      previousPath?: string;
      changeType: "added" | "modified" | "deleted" | "renamed";
      additions?: number;
      deletions?: number;
    }>;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  } = { ...rest };

  if (branchName) {
    input.branch = {
      name: branchName,
      headSha: branchHeadSha,
      baseBranch: branchBaseBranch,
      url: branchUrl,
    };
  }

  if (commitSha) {
    input.commits = [
      {
        sha: commitSha,
        message: commitMessage,
        authorName: commitAuthorName,
        authorEmail: commitAuthorEmail,
        authoredAt: commitAuthoredAt,
        url: commitUrl,
        branch: commitBranch,
      },
    ];
  }

  if (filePath && fileChangeType) {
    input.changedFiles = [
      {
        path: filePath,
        previousPath: filePreviousPath,
        changeType: fileChangeType,
        additions: fileAdditions,
        deletions: fileDeletions,
      },
    ];
  }

  return client.linkMissionCodeEvidence(missionId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatCorrectMissionEvidenceLink(
  client: CodeEvidenceClient,
  args: {
    missionId: string;
    linkId: string;
    status: "incorrect" | "removed" | "superseded";
    reason: string;
    customReason?: string;
    replacementLinkId?: string;
  },
) {
  const { missionId, linkId, ...input } = args;
  return client.correctMissionEvidenceLink(missionId, linkId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatMarkMissionEvidenceNotApplicable(
  client: CodeEvidenceClient,
  args: {
    missionId: string;
    reasonCode?: string;
    reasonNote?: string;
    notApplicableReasonCode?: string;
    notApplicableReasonNote?: string;
  },
) {
  const { missionId, ...reasonArgs } = args;
  const input = buildReasonInput(reasonArgs);
  return client.markMissionEvidenceNotApplicable(missionId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatClearMissionEvidenceNotApplicable(
  client: CodeEvidenceClient,
  args: { missionId: string },
) {
  return client.clearMissionEvidenceNotApplicable(args.missionId);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatReportMissionEvidenceGap(
  client: CodeEvidenceClient,
  args: {
    missionId: string;
    reasonCode?: string;
    reasonNote?: string;
    gapReasonCode?: string;
    gapReasonNote?: string;
  },
) {
  const { missionId, ...reasonArgs } = args;
  const input = buildReasonInput(reasonArgs);
  return client.reportMissionEvidenceGap(missionId, input);
}

/**
 * @requires CodeEvidenceClient
 */
export async function habitatResolveMissionEvidenceGap(
  client: CodeEvidenceClient,
  args: { missionId: string; gapId: string; resolutionReason: string },
) {
  const { missionId, gapId, ...input } = args;
  return client.resolveMissionEvidenceGap(missionId, gapId, input);
}
