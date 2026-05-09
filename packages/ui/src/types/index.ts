/**
 * Shared type definitions for the Kanban UI.
 * Covers board, task, agent, SSE events, stats, and export schemas.
 */

/** Agent runtime product: Claude Code, Codex, or OpenCode. */
export type AgentType = 'claude-code' | 'codex' | 'opencode';
export type AgentDomain = 'frontend' | 'backend' | 'devops' | 'testing' | string;
export type AgentStatus = 'idle' | 'working' | 'offline';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type TaskStatus =
  | 'pending' | 'claimed' | 'in_progress'
  | 'submitted' | 'approved' | 'rejected'
  | 'done' | 'failed';
export type FeatureStatus = 'not_started' | 'in_progress' | 'review' | 'done' | 'failed';
export type ActorType = 'human' | 'agent' | 'system';
export type EventAction =
  | 'created' | 'claimed' | 'started' | 'submitted'
  | 'approved' | 'rejected' | 'completed' | 'failed'
  | 'moved' | 'released' | 'dependency_resolved' | 'updated' | 'delegated';
export type FeatureEventAction =
  | 'created' | 'updated' | 'moved' | 'status_changed'
  | 'completed' | 'deleted' | 'dependency_resolved';

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

/** Workflow execution engine driving the board's columns and transitions. */
export interface Board {
  id: string;
  name: string;
  description: string;
  columns?: Column[];
  teamId: string | null;
  retrySettings: RetryPolicy | null;
  anomalySettings: AnomalySettings | null;
  autoAssignSettings: AutoAssignSettings | null;
  createdAt: string;
  updatedAt: string;
}

/** Single column on a board; controls WIP limits, auto-advance, and claim requirements. */
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

/** AI agent registered on the board; sends heartbeats to indicate current task. */
export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  domain: AgentDomain;
  capabilities: string[];
  status: AgentStatus;
  currentTaskId: string | null;
  createdAt: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown>;
}

/** Board-level kanban card representing a product initiative with auto-derived status. */
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
  isArchived: boolean;
  dueDateStatus?: 'overdue' | 'approaching' | 'ok' | 'none';
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

/** Single work item within a feature; lifecycle: pending → claimed → in_progress → submitted → approved/rejected → done/failed. */
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
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
  retryPolicy: RetryPolicy | null;
  retryCount: number;
  nextRetryAt: string | null;
}

export interface Artifact {
  type: 'file' | 'pr' | 'commit' | 'log' | 'screenshot';
  url: string;
  description: string;
  createdAt?: string;
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

export interface EnrichedBoardEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  boardId: string;
  actorType: ActorType;
  actorId: string;
  actorName: string | null;
  action: EventAction;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromColumnName: string | null;
  toColumnName: string | null;
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

export interface TaskWatcher {
  taskId: string;
  userId: string;
  createdAt: string;
}

export interface SiblingTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  result: string | null;
  order: number;
}

export interface CrossBoardDependency {
  taskId: string;
  boardId: string;
  boardName: string;
  title: string;
  status: TaskStatus;
}

export type PresenceType = 'human' | 'agent';

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

/** All possible server-sent events pushed to the board stream. Discriminated union by `type`. */
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
  | { type: 'subtask.created'; data: { taskId: string; subtask: Subtask } }
  | { type: 'subtask.updated'; data: { taskId: string; subtask: Subtask } }
  | { type: 'subtask.deleted'; data: { taskId: string; subtaskId: string } }
  | { type: 'presence.joined'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.left'; data: { boardId: string; sessionId: string } }
  | { type: 'presence.refresh'; data: { boardId: string; presence: PresenceEntry } }
  | { type: 'presence.summary'; data: { boardId: string; viewers: PresenceEntry[] } }
  | { type: 'task.watcher_notify'; data: { taskId: string; taskTitle: string; eventType: string; watcherUserIds: string[]; boardId: string } }
  | { type: 'task.mentioned'; data: { taskId: string; commentId: string; mentionedType: 'human' | 'agent'; mentionedId: string; mentionedName: string; boardId: string } }
  | { type: 'task.deleted'; data: { taskId: string } }
  | { type: 'task.overdue'; data: { taskId: string; boardId: string; detectedAt: string } }
  | { type: 'anomaly.detected'; data: Anomaly & { boardId: string; detectedAt: string } }
  | { type: 'feature.created'; data: Feature }
  | { type: 'feature.updated'; data: Feature }
  | { type: 'feature.moved'; data: { featureId: string; fromColumnId: string; toColumnId: string } }
  | { type: 'feature.status_changed'; data: { featureId: string; fromStatus: FeatureStatus; toStatus: FeatureStatus } }
  | { type: 'feature.deleted'; data: { featureId: string } }
  | { type: 'feature.progress'; data: { featureId: string; completed: number; total: number } };

export interface CreateFeatureInput {
  columnId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string;
  slaMinutes?: number;
}

export interface CreateTaskInFeatureInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  estimatedMinutes?: number;
}

export interface MoveFeatureInput {
  columnId: string;
}

export interface MoveTaskInput {
  status?: TaskStatus;
}

export interface TaskContext {
  task: Task;
  feature: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: FeatureStatus;
  } | null;
  siblingTasks: SiblingTask[];
  dependencies: Task[];
  crossBoardDependsOn: CrossBoardDependency[];
  blockedBy: Task[];
  blocking: Task[];
  boardContext: {
    name: string;
    columns: { name: string; taskCount: number }[];
  };
}

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

export interface SubtaskProposal {
  id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  order: number;
  editedTitle?: string;
  editedDescription?: string;
  deleted?: boolean;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  createdAt: string;
}

export interface DecompositionResult {
  proposals: SubtaskProposal[];
  parentTask: { id: string; title: string };
}

export interface FeatureDecompositionResult {
  tasks: Array<{
    title: string;
    description: string;
    priority: TaskPriority;
    order: number;
  }>;
  feature: { id: string; title: string };
}

export type BatchTaskOperation = 'priority' | 'assign' | 'delete';

export type BatchTaskRequest =
  | { taskIds: string[]; operation: 'priority'; payload: { priority: TaskPriority } }
  | { taskIds: string[]; operation: 'assign'; payload: { assignedAgentId: string } }
  | { taskIds: string[]; operation: 'delete'; payload: {} };

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

export interface NotificationPreferences {
  id: string;
  userId: string;
  boardId: string | null;
  taskAssigned: boolean;
  taskSubmitted: boolean;
  taskApproved: boolean;
  taskRejected: boolean;
  taskOverdue: boolean;
  taskMentioned: boolean;
  taskWatching: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegration {
  id: string;
  boardId: string;
  provider: 'slack' | 'discord';
  webhookUrl: string;
  channelId: string | null;
  botToken: string | null;
  enabled: number;
  events: string[];
  createdAt: string;
  updatedAt: string;
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

export interface AgentCapacity {
  agentId: string;
  agentName: string;
  domain: string;
  status: string;
  activeTasks: number;
  completedLast7d: number;
  avgCycleMinutes: number;
  maxTasks: number;
  availableCapacity: number;
  utilization: number;
  overCapacity: boolean;
}

export interface CapacityReport {
  agents: AgentCapacity[];
  summary: {
    totalCapacity: number;
    totalAllocated: number;
    totalAvailable: number;
    averageUtilization: number;
    overCapacityCount: number;
  };
  suggestions: string[];
}

export interface VelocityMetrics {
  days7: number;
  days14: number;
  days30: number;
  perAgent: Record<string, { days7: number; days14: number; days30: number; agentName: string }>;
}

export interface TaskEstimate {
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  dueAt: string | null;
  estimatedCompletionAt: string | null;
  confidence: 'high' | 'medium' | 'low';
  positionInQueue: number;
  daysUntilDue: number | null;
  daysUntilEstimated: number | null;
}

export interface AtRiskTask {
  taskId: string;
  taskTitle: string;
  reason: 'overdue_prediction' | 'no_activity' | 'blocked_by_dependency' | 'past_due';
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string;
  assignedAgentId: string | null;
  dueAt: string | null;
  lastActivityAt: string | null;
}

export interface PredictionResponse {
  velocity: VelocityMetrics;
  estimates: TaskEstimate[];
  atRiskTasks: AtRiskTask[];
}

export interface BurndownDataPoint {
  date: string;
  completed: number;
  remaining: number;
  idealRemaining: number;
  totalTasks: number;
}

export interface BurndownResponse {
  data: BurndownDataPoint[];
  startDate: string;
  endDate: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  averageDailyVelocity: number;
  estimatedCompletionDate: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Team {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
}

export type TeamMemberRole = 'owner' | 'admin' | 'member';

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  joinedAt: string;
}

export interface QualityChecklistItem {
  id: string;
  title: string;
  required: boolean;
  isCompleted: boolean;
  completedBy: string | null;
  completedAt: string | null;
  evidenceUrl: string | null;
  notes: string;
}

export interface QualityChecklist {
  id: string;
  templateId: string;
  templateName: string;
  category: string;
  required: boolean;
  status: 'pending' | 'in_progress' | 'passed';
  progress: { total: number; completed: number };
  items: QualityChecklistItem[];
}

export interface TaskQualityReport {
  taskId: string;
  overallStatus: 'passed' | 'blocked';
  canApprove: boolean;
  checklists: QualityChecklist[];
  missingRequirements: { category: string; missingItems: string[] }[];
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

export interface TaskTimeReport {
  taskId: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
  heartbeatHistory: {
    id: string;
    taskId: string;
    agentId: string | null;
    minutesSpent: number;
    recordedAt: string;
    statusDuringWork: string;
  }[];
}

export interface BoardTimeMetrics {
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

export interface TaskBlockedStatus {
  taskId: string;
  isBlocked: boolean;
  canComplete: boolean;
  reason?: string;
  blockedBy: { taskId: string; taskTitle: string; status: string }[];
  blocking: { taskId: string; taskTitle: string; status: string }[];
}

export interface Notification {
  id: string;
  type: string;
  taskId: string;
  taskTitle: string;
  agentName?: string;
  message: string;
  timestamp: string;
  read: boolean;
}
