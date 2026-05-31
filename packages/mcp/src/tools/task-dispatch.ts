import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  habitatClaimTask,
  habitatSubmitTask,
  habitatCompleteTask,
  habitatReleaseTask,
  habitatRetryTask,
} from "./task-lifecycle.js";
import { habitatUpdateTask, habitatDeleteTask } from "./task-crud.js";
import {
  habitatGetTaskContext,
  habitatGetTaskEvents,
  habitatGetTaskComments,
  habitatAddTaskComment,
} from "./task-detail.js";
import {
  habitatGetTaskTimeReport,
  habitatGetTaskBlockedStatus,
  habitatGetTaskApprovalStatus,
  habitatAddTaskDependency,
  habitatRemoveTaskDependency,
  habitatGetTaskQualityChecklist,
  habitatUpdateQualityChecklistItem,
  habitatValidateQualityGates,
  habitatLogEffort,
  habitatListEffort,
  habitatGetEffortReport,
  habitatCorrectEffortEntry,
} from "./lifecycle-gaps.js";
import {
  habitatListTaskSubtasks,
  habitatCreateTaskSubtask,
  habitatDeleteTaskSubtask,
} from "./subtask.js";
import { missionListTasks, missionCreateTask } from "./mission.js";
import {
  habitatListTaskCodeEvidence,
  habitatLinkTaskCode,
  habitatCorrectTaskEvidenceLink,
  habitatMarkTaskEvidenceNotApplicable,
  habitatClearTaskEvidenceNotApplicable,
  habitatReportTaskEvidenceGap,
  habitatResolveTaskEvidenceGap,
} from "./code-evidence.js";
import { PRIORITY_LEVELS, ARTIFACT_TYPES } from "./constants.js";

export const TASK_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_habitat_task",
  description:
    "Task operations: lifecycle (claim, submit, complete, release, retry), CRUD (list-in-mission, create-in-mission, update, delete), detail (get-context, get-events, get-comments, add-comment, query (get-time-report, get-blocked-status, get-approval-status)), effort (log-effort, list-effort, get-effort-report, correct-effort-entry), code evidence (link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap)",
  actions: [
    "list-in-mission",
    "create-in-mission",
    "update",
    "delete",
    "claim",
    "submit",
    "complete",
    "release",
    "retry",
    "get-context",
    "get-events",
    "get-comments",
    "add-comment",
    "get-time-report",
    "get-blocked-status",
    "get-approval-status",
    "add-dependency",
    "remove-dependency",
    "get-quality-checklist",
    "update-quality-checklist-item",
    "validate-quality-gates",
    "list-subtasks",
    "create-subtask",
    "delete-subtask",
    "link-code",
    "list-code-evidence",
    "correct-code-evidence-link",
    "mark-not-applicable",
    "clear-not-applicable",
    "report-gap",
    "resolve-gap",
    "log-effort",
    "list-effort",
    "get-effort-report",
    "correct-effort-entry",
  ],
  sharedParams: {
    taskId: { type: "string", description: "Task UUID (used with most task actions)" },
    missionId: {
      type: "string",
      description: "Mission UUID (action=list-in-mission, action=create-in-mission)",
    },
    boardId: { type: "string", description: "Habitat UUID (action=list-in-mission)" },
    title: { type: "string", description: "Task title (action=create-in-mission, action=update)" },
    description: {
      type: "string",
      description: "Task description (action=create-in-mission, action=update)",
    },
    priority: {
      type: "string",
      enum: [...PRIORITY_LEVELS],
      description: "Task priority (action=create-in-mission, action=update)",
    },
    requiredDomain: {
      type: "string",
      description: "Required agent domain (action=create-in-mission, action=update)",
    },
    requiredCapabilities: {
      type: "array",
      items: { type: "string" },
      description: "Required capabilities (action=create-in-mission, action=update)",
    },
    estimatedMinutes: {
      type: "number",
      description: "Estimated time in minutes (action=create-in-mission, action=update)",
    },
    version: {
      type: "number",
      description: "Expected version for optimistic locking (action=update)",
    },
    result: { type: "string", description: "Summary of what was accomplished (action=submit)" },
    reviewNote: {
      type: "string",
      description: "Review note describing what was verified (action=complete)",
    },
    reason: { type: "string", description: "Why the task is being released (action=release)" },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ARTIFACT_TYPES] },
          url: { type: "string" },
          description: { type: "string" },
        },
      },
      description: "Artifact links (action=submit, action=complete)",
    },
    limit: {
      type: "number",
      description:
        "Max items to return (action=list-in-mission, action=get-events, action=get-comments)",
    },
    offset: {
      type: "number",
      description: "Items to skip for pagination (action=get-events, action=get-comments)",
    },
    content: { type: "string", description: "Comment text (action=add-comment)" },
    parentId: {
      type: "string",
      description: "Optional parent comment UUID to reply to (action=add-comment)",
    },
    status: { type: "string", description: "Filter by mission status (action=list-in-mission)" },
    dependsOnTaskId: {
      type: "string",
      description: "The UUID of the task that must be completed first (action=add-dependency)",
    },
    dependencyTaskId: {
      type: "string",
      description: "The UUID of the dependency to remove (action=remove-dependency)",
    },
    checklistId: {
      type: "string",
      description: "The UUID of the quality checklist (action=update-quality-checklist-item)",
    },
    itemId: {
      type: "string",
      description:
        "The UUID of the checklist item to update (action=update-quality-checklist-item)",
    },
    isCompleted: {
      type: "boolean",
      description: "Whether the item is completed (action=update-quality-checklist-item)",
    },
    evidenceUrl: {
      type: "string",
      description: "URL to evidence (action=update-quality-checklist-item)",
    },
    notes: {
      type: "string",
      description: "Notes about the completion (action=update-quality-checklist-item)",
    },
    order: {
      type: "number",
      description: "Optional sort order within the parent task (action=create-subtask)",
    },
    assigneeId: {
      type: "string",
      description: "Optional UUID of an agent to assign this subtask to (action=create-subtask)",
    },
    subtaskId: { type: "string", description: "The UUID of the subtask (action=delete-subtask)" },
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
        "Custom reason if correctionReason is 'other' (action=correct-code-evidence-link)",
    },
    replacementLinkId: {
      type: "string",
      description: "UUID of replacement link (action=correct-code-evidence-link)",
    },
    notApplicableReasonCode: {
      type: "string",
      description: "Reason code for not-applicable (action=mark-not-applicable)",
    },
    notApplicableReasonNote: {
      type: "string",
      description: "Freeform reason note (action=mark-not-applicable)",
    },
    gapReasonCode: {
      type: "string",
      description: "Reason code for evidence gap (action=report-gap)",
    },
    gapReasonNote: {
      type: "string",
      description: "Freeform reason note for gap (action=report-gap)",
    },
    gapId: { type: "string", description: "UUID of the evidence gap (action=resolve-gap)" },
    resolutionReason: {
      type: "string",
      description: "Reason for resolving a gap (action=resolve-gap)",
    },
    branchName: { type: "string", description: "Branch name (action=link-code)" },
    branchHeadSha: { type: "string", description: "Branch head SHA (action=link-code)" },
    branchBaseBranch: { type: "string", description: "Branch base branch (action=link-code)" },
    branchUrl: { type: "string", description: "Branch URL (action=link-code)" },
    commitSha: { type: "string", description: "Commit SHA (action=link-code)" },
    commitMessage: { type: "string", description: "Commit message (action=link-code)" },
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
    minutes: {
      type: "number",
      description: "Minutes of effort to log (action=log-effort)",
    },
    note: {
      type: "string",
      description: "Optional note (action=log-effort, action=correct-effort-entry)",
    },
    startedAt: {
      type: "string",
      description: "ISO timestamp when effort started (action=log-effort)",
    },
    endedAt: {
      type: "string",
      description: "ISO timestamp when effort ended (action=log-effort)",
    },
    entryId: {
      type: "string",
      description: "Effort entry UUID (action=correct-effort-entry)",
    },
    minutesDelta: {
      type: "number",
      description: "Minutes to add/subtract from entry (action=correct-effort-entry)",
    },
    includeCorrections: {
      type: "boolean",
      description: "Include correction records in listing (action=list-effort)",
    },
  },
});

export const TASK_ACTIONS: Record<string, Handler> = {
  "list-in-mission": missionListTasks,
  "create-in-mission": missionCreateTask,
  update: habitatUpdateTask,
  delete: habitatDeleteTask,
  claim: habitatClaimTask,
  submit: habitatSubmitTask,
  complete: habitatCompleteTask,
  release: habitatReleaseTask,
  retry: habitatRetryTask,
  "get-context": habitatGetTaskContext,
  "get-events": habitatGetTaskEvents,
  "get-comments": habitatGetTaskComments,
  "add-comment": habitatAddTaskComment,
  "get-time-report": habitatGetTaskTimeReport,
  "get-blocked-status": habitatGetTaskBlockedStatus,
  "get-approval-status": habitatGetTaskApprovalStatus,
  "add-dependency": habitatAddTaskDependency,
  "remove-dependency": habitatRemoveTaskDependency,
  "get-quality-checklist": habitatGetTaskQualityChecklist,
  "update-quality-checklist-item": habitatUpdateQualityChecklistItem,
  "validate-quality-gates": habitatValidateQualityGates,
  "list-subtasks": habitatListTaskSubtasks,
  "create-subtask": habitatCreateTaskSubtask,
  "delete-subtask": habitatDeleteTaskSubtask,
  "link-code": habitatLinkTaskCode,
  "list-code-evidence": habitatListTaskCodeEvidence,
  "correct-code-evidence-link": habitatCorrectTaskEvidenceLink,
  "mark-not-applicable": habitatMarkTaskEvidenceNotApplicable,
  "clear-not-applicable": habitatClearTaskEvidenceNotApplicable,
  "report-gap": habitatReportTaskEvidenceGap,
  "resolve-gap": habitatResolveTaskEvidenceGap,
  "log-effort": habitatLogEffort,
  "list-effort": habitatListEffort,
  "get-effort-report": habitatGetEffortReport,
  "correct-effort-entry": habitatCorrectEffortEntry,
};

export const TASK_DISPATCH_HANDLER = createDispatchHandler(TASK_ACTIONS);
