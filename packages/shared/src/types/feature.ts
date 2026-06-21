import type { TaskPriority, TaskStatus } from "./task.js";
import type { ActorType } from "./events.js";
import type { WorkflowFailureHandlerConfig, WorkflowTemplateDefinition } from "./workflow.js";

export { TaskPriority };
export { ActorType };

/** Represents one task definition embedded inside a mission template. */
export interface TaskTemplateEntry {
  /** Stable cross-reference for gate source/target; auto-generated as `task_1`, `task_2` etc. if absent. */
  key?: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string;
  requiredCapabilities?: string[];
  estimatedMinutes?: number;
  order?: number;
  /** Initial lifecycle status for the task at creation; defaults to `pending`. */
  initialStatus?: TaskStatus;
  /** Per-task override of the workflow-level failure handler; `null` explicitly disables it. */
  failureHandlerOverride?: WorkflowFailureHandlerConfig | null;
}

/** Lifecycle states a {@link Mission} can occupy across its board. */
export type MissionStatus = "not_started" | "in_progress" | "review" | "done" | "failed";

/** Discrete actions recordable in a {@link MissionEvent} audit entry. */
export type MissionEventAction =
  | "created"
  | "updated"
  | "moved"
  | "status_changed"
  | "completed"
  | "deleted"
  | "dependency_resolved"
  | "code_evidence_linked"
  | "code_evidence_corrected"
  | "code_evidence_gap_reported"
  | "code_evidence_gap_resolved"
  | "code_evidence_marked_not_applicable"
  | "code_evidence_cleared_not_applicable";

/** A single unit of tracked work within a habitat, including dependencies, SLA, and effort accounting. */
export interface Mission {
  id: string;
  habitatId: string;
  columnId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: TaskPriority;
  labels: string[];
  status: MissionStatus;
  displayOrder: number;
  dependsOn: string[];
  blocks: string[];
  dueAt: string | null;
  slaMinutes: number | null;
  slaDeadlineAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  actualMinutes: number | null;
  plannedMinutes: number | null;
  planningAccuracy: number | null;
  completedAt: string | null;
  isArchived: boolean;
  sprintId: string | null;
}

/** A {@link Mission} enriched with an aggregated progress rollup of its tasks. */
export interface MissionWithProgress extends Mission {
  progress: {
    total: number;
    pending: number;
    claimed: number;
    inProgress: number;
    submitted: number;
    approved: number;
    done: number;
    failed: number;
    rejected: number;
    percentage: number;
  };
}

/** One immutable audit entry in a mission's event history. */
export interface MissionEvent {
  id: string;
  missionId: string;
  actorType: ActorType;
  actorId: string;
  action: MissionEventAction;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromStatus: MissionStatus | null;
  toStatus: MissionStatus | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/** Reusable blueprint for spawning new {@link Mission} instances with preset fields and tasks. */
export interface MissionTemplate {
  id: string;
  habitatId: string | null;
  name: string;
  titlePattern: string;
  descriptionPattern: string;
  priority: TaskPriority;
  labels: string[];
  requiredDomain: string | null;
  requiredCapabilities: string[];
  isDefault: boolean;
  usageCount: number;
  createdBy: string;
  createdAt: string;
  tasksTemplate: TaskTemplateEntry[];
  /** Optional workflow DAG definition instantiated alongside tasks by `applyTemplate`. */
  workflowTemplate?: WorkflowTemplateDefinition | null;
}

/** A user's subscription to receive notifications for a specific {@link Mission}. */
export interface MissionWatcher {
  missionId: string;
  userId: string;
  createdAt: string;
}

/** Threaded discussion comment authored by a human, agent, or remote participant on a {@link Mission}. */
export interface MissionComment {
  id: string;
  missionId: string;
  parentId: string | null;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  mentions?: MissionCommentMention[];
}

/** A single @-mention within a {@link MissionComment}. */
export interface MissionCommentMention {
  id: string;
  commentId: string;
  mentionedType: "human" | "agent" | "remote_human" | "remote_orcy";
  mentionedId: string;
  mentionText: string;
  createdAt: string;
  mentionedName?: string;
}

/** Recurrence strategies for a {@link ScheduledTask}: one-shot, interval, or cron. */
export type ScheduleType = "once" | "interval" | "cron";

/** Automation rule that periodically spawns {@link Mission} instances according to a {@link ScheduleType}. */
export interface ScheduledTask {
  id: string;
  habitatId: string;
  templateId: string | null;
  name: string;
  description: string;
  scheduleType: ScheduleType;
  cronExpression: string | null;
  intervalMinutes: number | null;
  scheduledAt: string | null;
  timezone: string;
  missionTitle: string;
  missionDescription: string;
  missionPriority: TaskPriority;
  missionLabels: string[];
  missionDomain: string | null;
  tasksTemplate: TaskTemplateEntry[];
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  runCount: number;
  lastCreatedMissionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
