import type { KanbanApiClient } from "../api.js";
import { defineActions, field } from "./field-descriptor.js";
import {
  habitatClaimTask,
  habitatStartTask,
  habitatSubmitTask,
  habitatCompleteTask,
  habitatReleaseTask,
  habitatRetryTask,
  habitatFailTask,
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
import { habitatGetTaskAuditBundle } from "./audit.js";
import {
  habitatBatchAssignTasks,
  habitatBatchSetTaskPriority,
  habitatBatchDeleteTasks,
} from "./task-batch.js";
import { PRIORITY_LEVELS, ARTIFACT_TYPES } from "./constants.js";

// Field registry — the single home for every shared parameter. Key order is the
// agent-visible `properties` order (firewall-locked); wire fragments are the
// JSON-schema definitions formerly inlined in the `sharedParams` block.
const f = {
  taskId: field.string({ description: "Task UUID (used with most task actions)" }),
  missionId: field.string({
    description: "Mission UUID (action=list-in-mission, action=create-in-mission)",
  }),
  habitatId: field.string({
    description:
      "Habitat UUID (action=list-in-mission, action=batch-assign, action=batch-set-priority, action=batch-delete)",
  }),
  title: field.string({ description: "Task title (action=create-in-mission, action=update)" }),
  description: field.string({
    description: "Task description (action=create-in-mission, action=update)",
  }),
  priority: field.enum([...PRIORITY_LEVELS], {
    description:
      "Task priority (action=create-in-mission, action=update, action=batch-set-priority)",
  }),
  requiredDomain: field.string({
    description: "Required agent domain (action=create-in-mission, action=update)",
  }),
  requiredCapabilities: field.array(
    { type: "string" },
    {
      description: "Required capabilities (action=create-in-mission, action=update)",
    },
  ),
  estimatedMinutes: field.number({
    description: "Estimated time in minutes (action=create-in-mission, action=update)",
  }),
  version: field.number({
    description: "Expected version for optimistic locking (action=update)",
  }),
  result: field.string({ description: "Summary of what was accomplished (action=submit)" }),
  reviewNote: field.string({
    description: "Review note describing what was verified (action=complete)",
  }),
  reason: field.string({ description: "Why the task is being released (action=release)" }),
  artifacts: field.array(
    {
      type: "object",
      properties: {
        type: { type: "string", enum: [...ARTIFACT_TYPES] },
        url: { type: "string" },
        description: { type: "string" },
      },
    },
    { description: "Artifact links (action=submit, action=complete)" },
  ),
  limit: field.number({
    description:
      "Max items to return (action=list-in-mission, action=get-events, action=get-comments)",
  }),
  offset: field.number({
    description: "Items to skip for pagination (action=get-events, action=get-comments)",
  }),
  content: field.string({ description: "Comment text (action=add-comment)" }),
  parentId: field.string({
    description: "Optional parent comment UUID to reply to (action=add-comment)",
  }),
  status: field.string({ description: "Filter by mission status (action=list-in-mission)" }),
  dependsOnTaskId: field.string({
    description: "The UUID of the task that must be completed first (action=add-dependency)",
  }),
  dependencyTaskId: field.string({
    description: "The UUID of the dependency to remove (action=remove-dependency)",
  }),
  checklistId: field.string({
    description: "The UUID of the quality checklist (action=update-quality-checklist-item)",
  }),
  itemId: field.string({
    description: "The UUID of the checklist item to update (action=update-quality-checklist-item)",
  }),
  isCompleted: field.boolean({
    description: "Whether the item is completed (action=update-quality-checklist-item)",
  }),
  evidenceUrl: field.string({
    description: "URL to evidence (action=update-quality-checklist-item)",
  }),
  notes: field.string({
    description: "Notes about the completion (action=update-quality-checklist-item)",
  }),
  order: field.number({
    description: "Optional sort order within the parent task (action=create-subtask)",
  }),
  assigneeId: field.string({
    description:
      "Agent UUID to assign subtask to (action=create-subtask) or batch-assign tasks to (action=batch-assign)",
  }),
  taskIds: field.array<string>(
    { type: "string" },
    {
      minItems: 1,
      maxItems: 100,
      description:
        "Array of task UUIDs (action=batch-assign, action=batch-set-priority, action=batch-delete)",
    },
  ),
  subtaskId: field.string({ description: "The UUID of the subtask (action=delete-subtask)" }),
  includeHistory: field.boolean({
    description: "Include historical links and resolved gaps (action=list-code-evidence)",
  }),
  linkId: field.string({
    description: "Evidence link UUID (action=correct-code-evidence-link)",
  }),
  linkStatus: field.enum(["incorrect", "removed", "superseded"], {
    description: "Correction status (action=correct-code-evidence-link)",
  }),
  correctionReason: field.string({
    description:
      "Reason for correction (action=correct-code-evidence-link, action=correct-effort-entry)",
  }),
  customReason: field.string({
    description: "Custom reason if correctionReason is 'other' (action=correct-code-evidence-link)",
  }),
  replacementLinkId: field.string({
    description: "UUID of replacement link (action=correct-code-evidence-link)",
  }),
  notApplicableReasonCode: field.string({
    description: "Reason code for not-applicable (action=mark-not-applicable)",
  }),
  notApplicableReasonNote: field.string({
    description: "Freeform reason note (action=mark-not-applicable)",
  }),
  gapReasonCode: field.string({
    description: "Reason code for evidence gap (action=report-gap)",
  }),
  gapReasonNote: field.string({
    description: "Freeform reason note for gap (action=report-gap)",
  }),
  gapId: field.string({ description: "UUID of the evidence gap (action=resolve-gap)" }),
  resolutionReason: field.string({
    description: "Reason for resolving a gap (action=resolve-gap)",
  }),
  branchName: field.string({ description: "Branch name (action=link-code)" }),
  branchHeadSha: field.string({ description: "Branch head SHA (action=link-code)" }),
  branchBaseBranch: field.string({ description: "Branch base branch (action=link-code)" }),
  branchUrl: field.string({ description: "Branch URL (action=link-code)" }),
  commitSha: field.string({ description: "Commit SHA (action=link-code)" }),
  commitMessage: field.string({ description: "Commit message (action=link-code)" }),
  pullRequestUrl: field.string({ description: "Pull request URL to link (action=link-code)" }),
  pipelineUrl: field.string({ description: "Pipeline URL to link (action=link-code)" }),
  externalUrls: field.array(
    { type: "string" },
    {
      description: "External URLs to link (action=link-code)",
    },
  ),
  allowExternalRepository: field.boolean({
    description: "Allow evidence from external repositories (action=link-code)",
  }),
  minutes: field.number({ description: "Minutes of effort to log (action=log-effort)" }),
  note: field.string({
    description: "Optional note (action=log-effort, action=correct-effort-entry)",
  }),
  startedAt: field.string({
    description: "ISO timestamp when effort started (action=log-effort)",
  }),
  endedAt: field.string({ description: "ISO timestamp when effort ended (action=log-effort)" }),
  entryId: field.string({
    description: "Effort entry UUID (action=correct-effort-entry)",
  }),
  minutesDelta: field.number({
    description: "Minutes to add/subtract from entry (action=correct-effort-entry)",
  }),
  includeCorrections: field.boolean({
    description: "Include correction records in listing (action=list-effort)",
  }),
  includeHealthSnapshots: field.boolean({
    description: "Include habitat health snapshots in audit evidence bundles",
  }),
};

// Single declaration: derives the action enum, shared `properties`, per-action
// required map, and handler map. Entry order is the handler-map order (drives
// the "Valid actions:" list); `fail` carries `enumLast` so the descriptor
// action-enum appends it last, preserving both firewall-locked orderings.
const TASK = defineActions({
  name: "orcy_habitat_task",
  description:
    "Task operations: lifecycle (claim, start, submit, complete, release, retry, fail), CRUD (list-in-mission, create-in-mission, update, delete), detail (get-context, get-events, get-comments, add-comment, query (get-time-report, get-blocked-status, get-approval-status)), effort (log-effort, list-effort, get-effort-report, correct-effort-entry), code evidence (link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap), audit evidence bundle (get-audit-bundle), batch (batch-assign, batch-set-priority, batch-delete)",
  fields: f,
  actions: {
    "list-in-mission": { args: {}, execute: missionListTasks },
    "create-in-mission": { args: {}, execute: missionCreateTask },
    update: { args: {}, execute: habitatUpdateTask },
    delete: { args: {}, execute: habitatDeleteTask },
    claim: { args: {}, execute: habitatClaimTask },
    start: { args: {}, execute: habitatStartTask },
    submit: { args: { taskId: f.taskId, result: f.result }, execute: habitatSubmitTask },
    complete: { args: {}, execute: habitatCompleteTask },
    release: { args: {}, execute: habitatReleaseTask },
    retry: { args: {}, execute: habitatRetryTask },
    fail: { args: {}, execute: habitatFailTask, enumLast: true },
    "get-context": { args: {}, execute: habitatGetTaskContext },
    "get-events": { args: {}, execute: habitatGetTaskEvents },
    "get-comments": { args: {}, execute: habitatGetTaskComments },
    "add-comment": {
      args: { taskId: f.taskId, content: f.content },
      execute: habitatAddTaskComment,
    },
    "get-time-report": { args: {}, execute: habitatGetTaskTimeReport },
    "get-blocked-status": { args: {}, execute: habitatGetTaskBlockedStatus },
    "get-approval-status": { args: {}, execute: habitatGetTaskApprovalStatus },
    "add-dependency": {
      args: { taskId: f.taskId, dependsOnTaskId: f.dependsOnTaskId },
      execute: habitatAddTaskDependency,
    },
    "remove-dependency": {
      args: { taskId: f.taskId, dependencyTaskId: f.dependencyTaskId },
      execute: habitatRemoveTaskDependency,
    },
    "get-quality-checklist": { args: {}, execute: habitatGetTaskQualityChecklist },
    "update-quality-checklist-item": {
      args: { taskId: f.taskId, checklistId: f.checklistId, itemId: f.itemId },
      execute: habitatUpdateQualityChecklistItem,
    },
    "validate-quality-gates": { args: {}, execute: habitatValidateQualityGates },
    "list-subtasks": { args: {}, execute: habitatListTaskSubtasks },
    "create-subtask": {
      args: { taskId: f.taskId, title: f.title },
      execute: habitatCreateTaskSubtask,
    },
    "delete-subtask": { args: {}, execute: habitatDeleteTaskSubtask },
    "link-code": { args: { taskId: f.taskId }, execute: habitatLinkTaskCode },
    "list-code-evidence": { args: { taskId: f.taskId }, execute: habitatListTaskCodeEvidence },
    "correct-code-evidence-link": {
      args: {
        taskId: f.taskId,
        linkId: f.linkId,
        linkStatus: f.linkStatus,
        correctionReason: f.correctionReason,
      },
      execute: habitatCorrectTaskEvidenceLink,
    },
    "mark-not-applicable": {
      args: { taskId: f.taskId },
      execute: habitatMarkTaskEvidenceNotApplicable,
    },
    "clear-not-applicable": {
      args: { taskId: f.taskId },
      execute: habitatClearTaskEvidenceNotApplicable,
    },
    "report-gap": {
      args: { taskId: f.taskId, gapReasonCode: f.gapReasonCode },
      execute: habitatReportTaskEvidenceGap,
    },
    "resolve-gap": {
      args: { taskId: f.taskId, gapId: f.gapId, resolutionReason: f.resolutionReason },
      execute: habitatResolveTaskEvidenceGap,
    },
    "log-effort": { args: { taskId: f.taskId, minutes: f.minutes }, execute: habitatLogEffort },
    "list-effort": { args: {}, execute: habitatListEffort },
    "get-effort-report": { args: {}, execute: habitatGetEffortReport },
    "correct-effort-entry": {
      args: {
        taskId: f.taskId,
        entryId: f.entryId,
        minutesDelta: f.minutesDelta,
        correctionReason: f.correctionReason,
      },
      execute: habitatCorrectEffortEntry,
    },
    "get-audit-bundle": { args: { taskId: f.taskId }, execute: habitatGetTaskAuditBundle },
    "batch-assign": {
      args: { habitatId: f.habitatId, taskIds: f.taskIds, assigneeId: f.assigneeId },
      execute: (client: KanbanApiClient, args) =>
        habitatBatchAssignTasks(client, {
          habitatId: args.habitatId,
          taskIds: args.taskIds,
          agentId: args.assigneeId,
        }),
    },
    "batch-set-priority": {
      args: { habitatId: f.habitatId, taskIds: f.taskIds, priority: f.priority },
      execute: (client: KanbanApiClient, args) =>
        habitatBatchSetTaskPriority(client, {
          habitatId: args.habitatId,
          taskIds: args.taskIds,
          priority: args.priority,
        }),
    },
    "batch-delete": {
      args: { habitatId: f.habitatId, taskIds: f.taskIds },
      execute: (client: KanbanApiClient, args) =>
        habitatBatchDeleteTasks(client, { habitatId: args.habitatId, taskIds: args.taskIds }),
    },
  },
});

/** MCP `Tool` schema for task-domain operations: lifecycle (claim/submit/complete/release/retry), CRUD, comments, subtasks, code evidence, effort tracking, audit bundles, and batch operations. */
export const TASK_DISPATCH_TOOL = TASK.tool;

/** Maps each `orcy_habitat_task` action name to its handler function. */
export const TASK_ACTIONS = TASK.actions;

/** {@link ToolHandler} registered as the `orcy_habitat_task` MCP tool; routes calls to the matching entry in {@link TASK_ACTIONS} and validates required parameters per action. */
export const TASK_DISPATCH_HANDLER = TASK.handler;
