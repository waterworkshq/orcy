import type { KanbanApiClient } from "../api.js";

export async function habitatListTaskCodeEvidence(
  client: KanbanApiClient,
  args: { taskId: string; includeHistory?: boolean },
) {
  return client.getTaskCodeEvidence(args.taskId, args.includeHistory);
}

export async function habitatLinkTaskCode(
  client: KanbanApiClient,
  args: {
    taskId: string;
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
      changeType: string;
      additions?: number;
      deletions?: number;
      commitSha?: string;
      pullRequestNumber?: number;
    }>;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  },
) {
  const { taskId, ...input } = args;
  return client.linkTaskCodeEvidence(taskId, input);
}

export async function habitatCorrectTaskEvidenceLink(
  client: KanbanApiClient,
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

export async function habitatMarkTaskEvidenceNotApplicable(
  client: KanbanApiClient,
  args: { taskId: string; reasonCode?: string; reasonNote?: string },
) {
  const { taskId, ...input } = args;
  return client.markTaskEvidenceNotApplicable(taskId, input);
}

export async function habitatClearTaskEvidenceNotApplicable(
  client: KanbanApiClient,
  args: { taskId: string },
) {
  return client.clearTaskEvidenceNotApplicable(args.taskId);
}

export async function habitatReportTaskEvidenceGap(
  client: KanbanApiClient,
  args: { taskId: string; reasonCode: string; reasonNote?: string },
) {
  const { taskId, ...input } = args;
  return client.reportTaskEvidenceGap(taskId, input);
}

export async function habitatResolveTaskEvidenceGap(
  client: KanbanApiClient,
  args: { taskId: string; gapId: string; resolutionReason: string },
) {
  const { taskId, gapId, ...input } = args;
  return client.resolveTaskEvidenceGap(taskId, gapId, input);
}

export async function habitatListMissionCodeEvidence(
  client: KanbanApiClient,
  args: { missionId: string; includeHistory?: boolean },
) {
  return client.getMissionCodeEvidence(args.missionId, args.includeHistory);
}

export async function habitatLinkMissionCode(
  client: KanbanApiClient,
  args: {
    missionId: string;
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
      changeType: string;
      additions?: number;
      deletions?: number;
      commitSha?: string;
      pullRequestNumber?: number;
    }>;
    pullRequestUrl?: string;
    pipelineUrl?: string;
    externalUrls?: string[];
    allowExternalRepository?: boolean;
  },
) {
  const { missionId, ...input } = args;
  return client.linkMissionCodeEvidence(missionId, input);
}

export async function habitatCorrectMissionEvidenceLink(
  client: KanbanApiClient,
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
