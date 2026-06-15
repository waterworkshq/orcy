import type { AgentDomain } from "./agent.js";
import type { ActorType, EventAction } from "./events.js";

/** The four priority levels used to rank a {@link Task}. */
export type TaskPriority = "low" | "medium" | "high" | "critical";

/** Lifecycle states a {@link Task} can occupy, from pending through claimed, review, and terminal done/failed. */
export type TaskStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "submitted"
  | "approved"
  | "rejected"
  | "done"
  | "failed";

/** Configuration describing how a failed {@link Task} is retried: max attempts, backoff, and escalation. */
export interface RetryPolicy {
  maxRetries?: number;
  backoffBase?: number;
  backoffMultiplier?: number;
  maxBackoff?: number;
  escalateToHuman?: boolean;
  retryOnStatuses?: string[];
}

/** The central task entity — a unit of work in a mission carrying assignment, lifecycle, results, and metrics. */
export interface Task {
  id: string;
  missionId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assignedAgentId: string | null;
  remoteAssignedParticipantId?: string | null;
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

/** An immutable audit entry recording one transition on a {@link Task}. */
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

/** A threaded comment on a {@link Task} authored by a human, agent, or remote participant. */
export interface TaskComment {
  id: string;
  taskId: string;
  parentId: string | null;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  mentions?: TaskCommentMention[];
}

/** A single mention of a participant embedded in a {@link TaskComment}. */
export interface TaskCommentMention {
  id: string;
  commentId: string;
  mentionedType: "human" | "agent" | "remote_human" | "remote_orcy";
  mentionedId: string;
  mentionText: string;
  createdAt: string;
  mentionedName?: string;
}

/** A deliverable produced for a {@link Task} — a file, PR, commit, log, or screenshot. */
export interface Artifact {
  type: "file" | "pr" | "commit" | "log" | "screenshot";
  url: string;
  description: string;
  createdAt?: string;
}

/** A subscription record indicating a user is watching a {@link Task} for updates. */
export interface TaskWatcher {
  taskId: string;
  userId: string;
  createdAt: string;
}

/** An ordered, checkable child item of a {@link Task} used to break work into smaller steps. */
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

/** A reference to a {@link Task} in another habitat that the local task depends on. */
export interface CrossHabitatDependency {
  taskId: string;
  habitatId: string;
  habitatName: string;
  title: string;
  status: TaskStatus;
}

/** A synchronized record of an external GitHub/GitLab pull request linked to a {@link Task}. */
export interface PullRequest {
  id: string;
  taskId: string;
  provider: "github" | "gitlab";
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prUrl: string;
  branchName: string | null;
  state: "open" | "merged" | "closed";
  reviewStatus: "pending" | "approved" | "changes_requested";
  createdAt: string;
  updatedAt: string;
}
