import type { TaskPriority } from './task.js';
import type { ActorType } from './events.js';

export { TaskPriority };
export { ActorType };

export type FeatureStatus = 'not_started' | 'in_progress' | 'review' | 'done' | 'failed';

export type FeatureEventAction =
  | 'created' | 'updated' | 'moved' | 'status_changed'
  | 'completed' | 'deleted' | 'dependency_resolved';

export interface Feature {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: TaskPriority;
  labels: string[];
  status: FeatureStatus;
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
}

export interface FeatureWithProgress extends Feature {
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
  };
}

export interface FeatureEvent {
  id: string;
  featureId: string;
  actorType: ActorType;
  actorId: string;
  action: FeatureEventAction;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromStatus: FeatureStatus | null;
  toStatus: FeatureStatus | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface FeatureTemplate {
  id: string;
  boardId: string | null;
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
  tasksTemplate: unknown[];
}

export interface FeatureWatcher {
  featureId: string;
  userId: string;
  createdAt: string;
}
