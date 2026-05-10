/** Agent runtime type identifier. */
export type AgentType = 'claude-code' | 'codex' | 'opencode';
/** Agent domain/specialty area. */
export type AgentDomain = 'frontend' | 'backend' | 'devops' | 'testing' | string;
/** Agent availability state. */
export type AgentStatus = 'idle' | 'working' | 'offline';
/** Distinguishes human visitors from autonomous agents. */
export type PresenceType = 'human' | 'agent';

/** Tracks a single session's presence on a board. */
export interface PresenceEntry {
  sessionId: string;
  type: PresenceType;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
  boardId: string;
  viewingTaskId?: string | null;
  lastSeen: number;
}
/** Task urgency level. */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type BatchTaskOperation = 'priority' | 'assign' | 'delete';

export type BatchTaskPayload =
  | { priority: TaskPriority }
  | { assignedAgentId: string }
  | Record<string, never>;

export interface BatchTaskResult {
  taskId: string;
  success: boolean;
  error?: string;
  task?: Task;
}

export interface BatchTaskResponse {
  successCount: number;
  failureCount: number;
  results: BatchTaskResult[];
}

export interface BatchTaskRequest {
  taskIds: string[];
  operation: BatchTaskOperation;
  payload: BatchTaskPayload;
}
/** Kanban lifecycle state machine for a task. */
export type TaskStatus =
  | 'pending' | 'claimed' | 'in_progress'
  | 'submitted' | 'approved' | 'rejected'
  | 'done' | 'failed';
/** Actor category for audit events. */
export type ActorType = 'human' | 'agent' | 'system';
/** Action type tags recorded in task event history. */
export type EventAction =
  | 'created' | 'claimed' | 'started' | 'submitted'
  | 'approved' | 'rejected' | 'completed' | 'failed'
  | 'moved' | 'released' | 'dependency_resolved' | 'updated' | 'delegated' | 'cloned'
  | 'retry_scheduled' | 'retry_executed' | 'escalated';

export interface RetryPolicy {
  maxRetries?: number;
  backoffBase?: number;
  backoffMultiplier?: number;
  maxBackoff?: number;
  escalateToHuman?: boolean;
  retryOnStatuses?: string[];
}

export interface AnomalySettings {
  enabled: boolean;
  scanIntervalMinutes: number;
  thresholds: {
    staleInProgressMinutes: number;
    rejectionRatePercent: number;
    rejectionWindowTasks: number;
    cycleTimeIncreasePercent: number;
    backlogToAgentRatio: number;
    agentOfflineMinutes: number;
  };
  notifications: {
    email: boolean;
    sse: boolean;
    chat: boolean;
  };
}

export interface Anomaly {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  data: Record<string, unknown>;
}

export type AutoAssignStrategy = 'round_robin' | 'least_loaded' | 'best_match';

export interface AutoAssignSettings {
  enabled: boolean;
  strategy: AutoAssignStrategy;
  maxTasksPerAgent: number;
  requireDomainMatch: boolean;
  requireCapabilityMatch: boolean;
  excludeOfflineAgents: boolean;
}

export interface GitWorktreeSettings {
  repoPath: string;
  branchPrefix: string;
  autoCleanup: boolean;
}

/** A Kanban board and its metadata. */
export interface Board {
  id: string;
  name: string;
  description: string;
  columns?: Column[];
  teamId: string | null;
  retrySettings: RetryPolicy | null;
  anomalySettings: AnomalySettings | null;
  autoAssignSettings: AutoAssignSettings | null;
  codeReviewSettings: CodeReviewSettings | null;
  ciCdSettings: CiCdSettings | null;
  gitWorktreeSettings: GitWorktreeSettings | null;
  eventRetentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A single column within a board. */
export interface Column {
  id: string;
  boardId: string;
  name: string;
  order: number;
  wipLimit: number | null;
  autoAdvance: boolean;
  requiresClaim: boolean;
  nextColumnId: string | null;
  isTerminal: boolean;
}

/** A registered autonomous agent. */
export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  domain: AgentDomain;
  capabilities: string[];
  status: AgentStatus;
  currentTaskId: string | null;
  apiKeyHash: string;
  rateLimitPerMinute: number | null;
  createdAt: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown>;
}

/** A single work item within a feature. */
export interface Task {
  id: string;
  featureId: string;
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

/** Auto-derived status of a feature based on child task states. */
export type FeatureStatus = 'not_started' | 'in_progress' | 'review' | 'done' | 'failed';

/** Feature action type for audit events. */
export type FeatureEventAction =
  | 'created' | 'updated' | 'moved' | 'status_changed'
  | 'completed' | 'deleted' | 'dependency_resolved';

/** A board-level kanban card representing a product initiative. */
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

/** Feature with aggregated task progress metrics. */
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

/** A user watching a feature for updates. */
export interface FeatureWatcher {
  featureId: string;
  userId: string;
  createdAt: string;
}

/** A history entry recording a state change on a feature. */
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

/** A task from another board that this board's task depends on. */
export interface CrossBoardDependency {
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  status: TaskStatus;
}

/** A deliverable attached to a task after execution. */
export interface Artifact {
  type: 'file' | 'pr' | 'commit' | 'log' | 'screenshot';
  url: string;
  description: string;
  createdAt?: string;
}

/** A history entry recording a state change or action on a task. */
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

/** A comment on a task, optionally nested under a parent comment. */
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

/** A mention of a user or agent within a task comment. */
export interface TaskCommentMention {
  id: string;
  commentId: string;
  mentionedType: 'human' | 'agent';
  mentionedId: string;
  mentionText: string;
  createdAt: string;
  mentionedName?: string;
}

/**
 * Union of all Server-Sent Events emitted by the API.
 * discriminated by the `type` field.
 */
export type SSEEvent =
  | { type: 'task.created'; data: Task }
  | { type: 'task.updated'; data: Task }
  | { type: 'task.moved'; data: { taskId: string; fromColumn: string; toColumn: string } }
  | { type: 'task.claimed'; data: { taskId: string; agentId: string } }
  | { type: 'task.submitted'; data: { taskId: string; agentId: string } }
  | { type: 'task.approved'; data: { taskId: string; reviewerId: string } }
  | { type: 'task.rejected'; data: { taskId: string; reason: string } }
  | { type: 'task.completed'; data: { taskId: string } }
  | { type: 'task.failed'; data: { taskId: string; reason: string } }
  | { type: 'task.released'; data: { taskId: string; reason: string } }
  | { type: 'task.delegated'; data: { taskId: string; fromAgentId: string; toAgentId: string } }
  | { type: 'task.cloned'; data: { sourceTaskId: string; clonedTask: Task } }
  | { type: 'task.deleted'; data: { taskId: string } }
  | { type: 'task.overdue'; data: { taskId: string; boardId: string; detectedAt: string } }
  | { type: 'task.watcher_notify'; data: { taskId: string; taskTitle: string; eventType: string; watcherUserIds: string[]; boardId: string } }
  | { type: 'task.mentioned'; data: { taskId: string; commentId: string; mentionedType: 'human' | 'agent'; mentionedId: string; mentionedName: string; boardId: string } }
  | { type: 'task.commented'; data: { taskId: string; comment: TaskComment } }
  | { type: 'task.comment_deleted'; data: { taskId: string; commentId: string } }
  | { type: 'agent.status_changed'; data: { agentId: string; status: AgentStatus } }
  | { type: 'agent.heartbeat'; data: { agentId: string; taskId: string | null } }
  | { type: 'column.created'; data: Column }
  | { type: 'column.updated'; data: Column }
  | { type: 'column.deleted'; data: { columnId: string; boardId: string } }
  | { type: 'column.wip_limit_reached'; data: { columnId: string; limit: number } }
  | { type: 'board.created'; data: { id: string; name: string; description: string; createdAt: string; updatedAt: string } }
  | { type: 'board.updated'; data: { id: string; name: string; description: string; createdAt: string; updatedAt: string } }
  | { type: 'board.deleted'; data: { boardId: string } }
  | { type: 'subtask.created'; data: { taskId: string; subtask: import('../repositories/subtask.js').Subtask } }
  | { type: 'subtask.updated'; data: { taskId: string; subtask: import('../repositories/subtask.js').Subtask } }
  | { type: 'subtask.deleted'; data: { taskId: string; subtaskId: string } }
  | { type: 'presence.joined'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.left'; data: { boardId: string; sessionId: string } }
  | { type: 'presence.refresh'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.summary'; data: { boardId: string; viewers: PresenceEntry[] } }
  | { type: 'agent.message_received'; data: { messageId: string; fromAgentId: string; fromAgentName: string; toAgentId: string; subject: string; messageType: string; priority: string; taskId: string | null; boardId: string } }
  | { type: 'pulse.signal_posted'; data: { pulseId: string; missionId: string; signalType: string; fromType: string; fromId: string; subject: string } }
  | { type: 'task.retry_scheduled'; data: { taskId: string; nextRetryAt: string; retryCount: number } }
  | { type: 'task.retry_executed'; data: { taskId: string; retryCount: number } }
  | { type: 'task.escalated'; data: { taskId: string; retryCount: number; reason: string } }
  | { type: 'anomaly.detected'; data: Anomaly & { boardId: string; detectedAt: string } }
  | { type: 'feature.created'; data: Feature }
  | { type: 'feature.updated'; data: Feature }
  | { type: 'feature.moved'; data: { featureId: string; fromColumnId: string; toColumnId: string } }
  | { type: 'feature.status_changed'; data: { featureId: string; fromStatus: FeatureStatus; toStatus: FeatureStatus } }
  | { type: 'feature.deleted'; data: { featureId: string } }
  | { type: 'feature.progress'; data: { featureId: string; completed: number; total: number } };

/** Aggregated board-level statistics for the dashboard. */
export interface BoardStats {
  cycleTime: {
    averageMinutes: number;
    medianMinutes: number;
    count: number;
  };
  throughput: {
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
  wipHealth: {
    columnId: string;
    columnName: string;
    current: number;
    limit: number | null;
    health: 'ok' | 'warning' | 'exceeded';
  }[];
}

/** Per-agent statistics and performance metrics. */
export interface AgentStats {
  agentId: string;
  agentName: string;
  tasks: {
    completed: number;
    failed: number;
    inProgress: number;
    rejected: number;
    totalAssigned: number;
  };
  cycleTime: {
    averageMinutes: number;
    medianMinutes: number;
    count: number;
  };
  throughput: {
    today: number;
    last7d: number;
    last30d: number;
  };
  quality: {
    rejectionRate: number;
    approvalRate: number;
    currentStreak: number;
    totalRejections: number;
  };
  artifacts: {
    total: number;
    byType: Record<string, number>;
  };
}

/** Summary statistics across all agents. */
export interface AllAgentStats {
  agents: Array<{
    agentId: string;
    agentName: string;
    domain: string;
    status: AgentStatus;
    completed: number;
    failed: number;
    inProgress: number;
    avgCycleMinutes: number;
    approvalRate: number;
    currentStreak: number;
  }>;
  summary: {
    totalTasksCompleted: number;
    totalTasksFailed: number;
    totalAgentsActive: number;
  };
}

/** A reusable template for creating features on a board. */
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


/** Configuration for an outbound webhook subscription. */
export interface WebhookSubscription {
  id: string;
  boardId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: 'standard' | 'slack' | 'discord';
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

/** A single delivery attempt for a webhook event. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: 'pending' | 'success' | 'failed';
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

/** A pull/merge request linked to a task via branch/title convention. */
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

/** Board-level code review integration settings. */
export interface CodeReviewSettings {
  autoApproveOnMerge: boolean;
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}

export type PipelineEventStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled';

export interface PipelineEvent {
  id: string;
  taskId: string;
  provider: 'github' | 'gitlab';
  repo: string;
  runId: string;
  status: PipelineEventStatus;
  branch: string;
  commitSha: string | null;
  createdAt: string;
}

export interface CiCdSettings {
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}

/** A user who is watching a task for updates. */
export interface TaskWatcher {
  taskId: string;
  userId: string;
  createdAt: string;
}

/** Presence-specific event types (subset of SSEEvent). */
export type PresenceEvent =
  | { type: 'presence.joined'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.left'; data: { boardId: string; sessionId: string } }
  | { type: 'presence.refresh'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.summary'; data: { boardId: string; viewers: PresenceEntry[] } };

/** Aggregated metrics shown on the dashboard home view. */
export interface DashboardStats {
  throughput: Array<{ date: string; count: number }>;
  cycleTime: Array<{ date: string; avgMinutes: number; medianMinutes: number }>;
  rejectionRate: Array<{ date: string; rejections: number; total: number }>;
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    completed: number;
    failed: number;
    avgCycleMinutes: number;
    approvalRate: number;
  }>;
  taskByPriority: { critical: number; high: number; medium: number; low: number };
  taskByStatus: { pending: number; claimed: number; in_progress: number; submitted: number; done: number };
  wipHealth: Array<{
    columnId: string;
    columnName: string;
    boardId: string;
    boardName: string;
    current: number;
    limit: number | null;
    health: 'ok' | 'warning' | 'exceeded';
  }>;
  webhookStats: { total: number; success: number; failed: number; pending: number; successRate: number };
  summary: {
    totalTasksCompleted: number;
    totalTasksInProgress: number;
    averageCycleTimeMinutes: number;
    overallRejectionRate: number;
    activeAgents: number;
  };
}

/** Serialised board export payload with version header. */
export interface BoardExport {
  version: number;
  exportedAt: string;
  board: {
    name: string;
    description: string;
    columns: Array<{
      name: string;
      order: number;
      wipLimit: number | null;
      autoAdvance: boolean;
      requiresClaim: boolean;
      nextColumnName: string | null;
      isTerminal: boolean;
    }>;
    features: Array<{
      title: string;
      description: string;
      acceptanceCriteria: string;
      priority: TaskPriority;
      labels: string[];
      columnName: string;
      status: FeatureStatus;
      dependsOn: string[];
      blocks: string[];
      dueAt: string | null;
      tasks: Array<{
        title: string;
        description: string;
        priority: TaskPriority;
        status: TaskStatus;
        requiredDomain: string | null;
        requiredCapabilities: string[];
        result: string | null;
        artifacts: Artifact[];
        createdBy: string;
      }>;
    }>;
    comments: Array<{
      taskTitle: string;
      parentTaskTitle: string | null;
      content: string;
      authorType: 'human' | 'agent';
      authorId: string;
    }>;
    templates: Array<{
      name: string;
      titlePattern: string;
      descriptionPattern: string;
      priority: TaskPriority;
      labels: string[];
      requiredDomain: string | null;
      requiredCapabilities: string[];
      isDefault: boolean;
    }>;
    webhooks: Array<{
      name: string;
      url: string;
      events: string[];
      headers: Record<string, string>;
      format: 'standard' | 'slack' | 'discord';
      enabled: boolean;
    }>;
  };
}

export interface TaskTimeRecord {
  id: string;
  taskId: string;
  agentId: string | null;
  minutesSpent: number;
  recordedAt: string;
  statusDuringWork: string;
}

export interface TaskTimeReport {
  taskId: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
  heartbeatHistory: TaskTimeRecord[];
}

export interface BoardMetrics {
  averageCycleTime: number;
  averageLeadTime: number;
  averageEstimationAccuracy: number;
  totalPlannedMinutes: number;
  totalActualMinutes: number;
  overdueTasks: number;
  onTimeCompletionRate: number;
  agentMetrics: {
    agentId: string;
    agentName: string;
    tasksCompleted: number;
    averageCycleTime: number;
    averageEstimationAccuracy: number;
    totalTimeTracked: number;
  }[];
}

export interface QualityChecklistTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  isRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QualityChecklistItem {
  id: string;
  templateId: string;
  title: string;
  description: string;
  required: boolean;
  orderIndex: number;
  createdAt: string;
}

export interface TaskQualityChecklist {
  id: string;
  taskId: string;
  templateId: string | null;
  status: string;
  completedAt: string | null;
  completedBy: string | null;
  notes: string;
  createdAt: string;
}

export interface TaskQualityChecklistItem {
  id: string;
  checklistId: string;
  itemId: string;
  isCompleted: boolean;
  completedBy: string | null;
  completedAt: string | null;
  evidenceUrl: string | null;
  notes: string;
}

export interface TaskQualityReport {
  taskId: string;
  overallStatus: string;
  canApprove: boolean;
  checklists: {
    id: string;
    templateId: string;
    templateName: string;
    category: string;
    required: boolean;
    status: string;
    progress: { total: number; completed: number };
    items: {
      id: string;
      title: string;
      required: boolean;
      isCompleted: boolean;
      completedBy: string | null;
      completedAt: string | null;
      evidenceUrl: string | null;
      notes: string;
    }[];
  }[];
  missingRequirements: {
    category: string;
    missingItems: string[];
  }[];
}

export interface DependencyValidationResult {
  canComplete: boolean;
  reason?: string;
  blockedBy?: {
    taskId: string;
    title: string;
    status: string;
  }[];
  incompleteTasks?: {
    taskId: string;
    title: string;
    status: string;
  }[];
}

export interface ApprovalStatus {
  canBeApproved: boolean;
  reasons: string[];
  requirements: {
    qualityChecklist: { status: string; completed: number; total: number };
    dependencies: { status: string };
    timeTracking: { status: string };
  };
}
