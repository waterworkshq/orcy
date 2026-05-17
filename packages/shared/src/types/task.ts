import type { AgentDomain } from './agent.js';
import type { ActorType, EventAction } from './events.js';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export type TaskStatus =
  | 'pending' | 'claimed' | 'in_progress'
  | 'submitted' | 'approved' | 'rejected'
  | 'done' | 'failed';

export interface RetryPolicy {
  maxRetries?: number;
  backoffBase?: number;
  backoffMultiplier?: number;
  maxBackoff?: number;
  escalateToHuman?: boolean;
  retryOnStatuses?: string[];
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assignedAgentId: string | null;
  delegatedToAgentId: string | null;
  requiredDomain: AgentDomain | null;
  requiredCapabilities: string[];
  status: TaskStatus;
  claimedAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  rejectedCount: number;
  rejectionReason: string | null;
  result: string | null;
  artifacts: Artifact[];
  order: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  estimatedMinutes: number | null;
  labels: string[];
  retryPolicy: RetryPolicy | null;
  retryCount: number;
  nextRetryAt: string | null;
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  actorType: ActorType;
  actorId: string;
  action: EventAction;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  parentId: string | null;
  authorType: 'human' | 'agent';
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  mentions?: TaskCommentMention[];
}

export interface TaskCommentMention {
  id: string;
  commentId: string;
  mentionedType: 'human' | 'agent';
  mentionedId: string;
  mentionText: string;
  createdAt: string;
  mentionedName?: string;
}

export interface Artifact {
  type: 'file' | 'pr' | 'commit' | 'log' | 'screenshot';
  url: string;
  description: string;
  createdAt?: string;
}

export interface TaskWatcher {
  taskId: string;
  userId: string;
  createdAt: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  order: number;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrossHabitatDependency {
  taskId: string;
  habitatId: string;
  habitatName: string;
  title: string;
  status: TaskStatus;
}

export interface PullRequest {
  id: string;
  taskId: string;
  provider: 'github' | 'gitlab';
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prUrl: string;
  branchName: string | null;
  state: 'open' | 'merged' | 'closed';
  reviewStatus: 'pending' | 'approved' | 'changes_requested';
  createdAt: string;
  updatedAt: string;
}
