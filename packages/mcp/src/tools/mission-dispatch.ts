import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  habitatListMissions,
  habitatCreateMission,
  habitatDeleteMission,
  missionArchive,
  missionUnarchive,
  missionGetContext,
  missionGetComments,
  missionAddComment,
} from "./mission.js";
import {
  habitatListMissionCodeEvidence,
  habitatLinkMissionCode,
  habitatCorrectMissionEvidenceLink,
  habitatMarkMissionEvidenceNotApplicable,
  habitatClearMissionEvidenceNotApplicable,
  habitatReportMissionEvidenceGap,
  habitatResolveMissionEvidenceGap,
} from "./code-evidence.js";
import { PRIORITY_LEVELS } from "./constants.js";

export const MISSION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_habitat_mission",
  description:
    "Mission operations: list (with optional isArchived), create, delete, archive, unarchive, get-context, get-comments, add-comment, code evidence (link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap)",
  actions: [
    "list",
    "create",
    "delete",
    "archive",
    "unarchive",
    "get-context",
    "get-comments",
    "add-comment",
    "link-code",
    "list-code-evidence",
    "correct-code-evidence-link",
    "mark-not-applicable",
    "clear-not-applicable",
    "report-gap",
    "resolve-gap",
  ],
  sharedParams: {
    boardId: { type: "string", description: "Habitat UUID (used with action=list, action=create)" },
    missionId: {
      type: "string",
      description:
        "Mission UUID (used with action=delete, action=archive, action=unarchive, action=get-context, action=get-comments, action=add-comment, action=link-code, action=list-code-evidence, action=correct-code-evidence-link)",
    },
    title: { type: "string", description: "Mission title (action=create)" },
    description: { type: "string", description: "Mission description (action=create)" },
    acceptanceCriteria: { type: "string", description: "What defines completion (action=create)" },
    priority: {
      type: "string",
      enum: [...PRIORITY_LEVELS],
      description: "Mission priority (action=create)",
    },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Labels to categorize the mission (action=create)",
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description: "Mission IDs this mission depends on (action=create)",
    },
    dueAt: { type: "string", description: "ISO 8601 deadline (action=create)" },
    slaMinutes: {
      type: "number",
      description: "Service-level agreement in minutes (action=create)",
    },
    blocks: {
      type: "array",
      items: { type: "string" },
      description: "Mission IDs that this mission blocks (action=create)",
    },
    isArchived: {
      type: "boolean",
      description: "Set to true to list archived missions instead of active ones (action=list)",
    },
    status: {
      type: "string",
      description: "Filter by mission status (action=list)",
    },
    limit: { type: "number", description: "Maximum number of missions to return (action=list)" },
    content: { type: "string", description: "Comment text (action=add-comment)" },
    parentId: {
      type: "string",
      description: "Optional parent comment UUID to reply to (action=add-comment)",
    },
    includeHistory: {
      type: "boolean",
      description: "Include historical links and resolved gaps (action=list-code-evidence)",
    },
    linkId: {
      type: "string",
      description: "Evidence link UUID (action=correct-code-evidence-link)",
    },
    linkStatus: {
      type: "string",
      enum: ["incorrect", "removed", "superseded"],
      description: "Correction status (action=correct-code-evidence-link)",
    },
    correctionReason: {
      type: "string",
      description: "Reason for correction (action=correct-code-evidence-link)",
    },
    customReason: {
      type: "string",
      description:
        'Custom reason if correctionReason is "other" (action=correct-code-evidence-link)',
    },
    replacementLinkId: {
      type: "string",
      description: "UUID of replacement link (action=correct-code-evidence-link)",
    },
    pullRequestUrl: { type: "string", description: "Pull request URL to link (action=link-code)" },
    pipelineUrl: { type: "string", description: "Pipeline URL to link (action=link-code)" },
    externalUrls: {
      type: "array",
      items: { type: "string" },
      description: "External URLs to link (action=link-code)",
    },
    allowExternalRepository: {
      type: "boolean",
      description: "Allow evidence from external repositories (action=link-code)",
    },
    branchName: { type: "string", description: "Branch name (action=link-code)" },
    branchHeadSha: { type: "string", description: "Branch head SHA (action=link-code)" },
    branchBaseBranch: { type: "string", description: "Branch base branch (action=link-code)" },
    branchUrl: { type: "string", description: "Branch URL (action=link-code)" },
    commitSha: { type: "string", description: "Commit SHA (action=link-code)" },
    commitMessage: { type: "string", description: "Commit message (action=link-code)" },
    commitAuthorName: { type: "string", description: "Commit author name (action=link-code)" },
    commitAuthorEmail: { type: "string", description: "Commit author email (action=link-code)" },
    commitAuthoredAt: {
      type: "string",
      description: "Commit authored timestamp (action=link-code)",
    },
    commitUrl: { type: "string", description: "Commit URL (action=link-code)" },
    commitBranch: { type: "string", description: "Branch name for the commit (action=link-code)" },
    filePath: { type: "string", description: "File path (action=link-code)" },
    filePreviousPath: { type: "string", description: "Previous file path (action=link-code)" },
    fileChangeType: {
      type: "string",
      enum: ["added", "modified", "deleted", "renamed"],
      description: "Change type (action=link-code)",
    },
    fileAdditions: { type: "number", description: "Lines added (action=link-code)" },
    fileDeletions: { type: "number", description: "Lines deleted (action=link-code)" },
    reasonCode: {
      type: "string",
      description: "Reason code (action=mark-not-applicable, action=report-gap)",
    },
    reasonNote: {
      type: "string",
      description: "Reason note (action=mark-not-applicable, action=report-gap)",
    },
    gapId: {
      type: "string",
      description: "Gap UUID (action=resolve-gap)",
    },
    gapReasonCode: {
      type: "string",
      description: "Gap reason code (action=report-gap)",
    },
    resolutionReason: {
      type: "string",
      description: "Resolution reason (action=resolve-gap)",
    },
  },
});

export const MISSION_ACTIONS: Record<string, Handler> = {
  list: habitatListMissions,
  create: habitatCreateMission,
  delete: habitatDeleteMission,
  archive: missionArchive,
  unarchive: missionUnarchive,
  "get-context": missionGetContext,
  "get-comments": missionGetComments,
  "add-comment": missionAddComment,
  "link-code": habitatLinkMissionCode,
  "list-code-evidence": habitatListMissionCodeEvidence,
  "correct-code-evidence-link": habitatCorrectMissionEvidenceLink,
  "mark-not-applicable": habitatMarkMissionEvidenceNotApplicable,
  "clear-not-applicable": habitatClearMissionEvidenceNotApplicable,
  "report-gap": habitatReportMissionEvidenceGap,
  "resolve-gap": habitatResolveMissionEvidenceGap,
};

const MISSION_REQUIRED_PARAMS: Record<string, string[]> = {
  create: ["boardId", "title"],
  delete: ["missionId"],
  archive: ["missionId"],
  unarchive: ["missionId"],
  "get-context": ["missionId"],
  "get-comments": ["missionId"],
  "add-comment": ["missionId", "content"],
  "link-code": ["missionId"],
  "list-code-evidence": ["missionId"],
  "correct-code-evidence-link": ["missionId", "linkId", "linkStatus", "correctionReason"],
  "mark-not-applicable": ["missionId"],
  "clear-not-applicable": ["missionId"],
  "report-gap": ["missionId", "gapReasonCode"],
  "resolve-gap": ["missionId", "gapId", "resolutionReason"],
};

export const MISSION_DISPATCH_HANDLER = createDispatchHandler(
  MISSION_ACTIONS,
  MISSION_REQUIRED_PARAMS,
);
