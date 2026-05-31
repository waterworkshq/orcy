import type { TaskPriority } from "./task.js";
import type { ActorType } from "./events.js";

export { TaskPriority };
export { ActorType };

export interface TaskTemplateEntry {
  title: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string;
  requiredCapabilities?: string[];
  estimatedMinutes?: number;
  order?: number;
}

export type MissionStatus = "not_started" | "in_progress" | "review" | "done" | "failed";

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
}

export interface MissionWatcher {
  missionId: string;
  userId: string;
  createdAt: string;
}

export interface MissionComment {
  id: string;
  missionId: string;
  parentId: string | null;
  authorType: "human" | "agent";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  mentions?: MissionCommentMention[];
}

export interface MissionCommentMention {
  id: string;
  commentId: string;
  mentionedType: "human" | "agent";
  mentionedId: string;
  mentionText: string;
  createdAt: string;
  mentionedName?: string;
}

export type ScheduleType = "once" | "interval" | "cron";

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
