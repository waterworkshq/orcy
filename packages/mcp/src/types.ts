export interface Task {
  id: string;
  featureId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignedAgentId: string | null;
  requiredDomain: string | null;
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
}

export type FeatureStatus = 'not_started' | 'in_progress' | 'review' | 'done' | 'failed';

export interface Feature {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
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

export interface FeatureContext {
  feature: Feature;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    result: string | null;
    artifacts: Artifact[];
    assignedAgentId: string | null;
  }>;
  dependencies: Feature[];
  blocking: Feature[];
}

export type TaskStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'done'
  | 'failed';

export interface Artifact {
  type: 'file' | 'pr' | 'commit' | 'log' | 'screenshot';
  url: string;
  description: string;
  createdAt?: string;
}

export interface Agent {
  id: string;
  name: string;
  type: 'claude-code' | 'codex' | 'opencode';
  domain: string;
  capabilities: string[];
  status: 'idle' | 'working' | 'offline';
  currentTaskId: string | null;
  createdAt: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown>;
}

export interface Board {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  createdAt: string;
  updatedAt: string;
}

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

export interface BoardContext {
  name: string;
  columns: { name: string; taskCount: number }[];
}

export interface TaskContext {
  task: Task;
  feature: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: string;
    priority: string;
  };
  siblingTasks: Array<{
    id: string;
    title: string;
    status: string;
    result: string | null;
  }>;
  dependencies: Task[];
  blockedBy: Task[];
  blocking: Task[];
  boardContext: BoardContext;
}

export interface ClaimTaskResponse {
  success: true;
  task: Task;
}

export interface ClaimTaskFailureResponse {
  success: false;
  reason: 'already_claimed' | 'not_found' | 'domain_mismatch' | 'dependencies_unmet' | 'capability_mismatch';
  message: string;
  missingCapabilities?: string[];
}

export interface SubmitTaskResponse {
  success: true;
  task: {
    id: string;
    status: TaskStatus;
    submittedAt: string;
  };
  message: string;
}

export interface CompleteTaskResponse {
  success: true;
  task: {
    id: string;
    status: TaskStatus;
    completedAt: string | null;
    result: string | null;
    artifacts: Task['artifacts'];
  };
  message: string;
}

export interface ReleaseTaskResponse {
  success: true;
  task: {
    id: string;
    status: TaskStatus;
    assignedAgentId: string | null;
  };
}

export interface HeartbeatResponse {
  success: true;
  agentStatus: 'idle' | 'working' | 'offline';
  nextCheckIn: number;
  taskStatus: TaskStatus | null;
}

export interface AgentStatusResponse {
  status: 'idle' | 'working' | 'offline';
  nextCheckIn: number;
  taskStatus: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  action: string;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
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

export interface ListSubtasksResponse {
  subtasks: Subtask[];
  total: number;
  completedCount: number;
}

export interface AgentMessage {
  id: string;
  boardId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string | null;
  subject: string;
  body: string;
  messageType: 'info' | 'request' | 'response' | 'alert';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  readAt: string | null;
  createdAt: string;
}

export interface SendMessageResponse {
  message: AgentMessage;
}

export interface ListMessagesResponse {
  messages: AgentMessage[];
  total: number;
  unreadCount: number;
}

export interface Webhook {
  id: string;
  boardId: string;
  name: string;
  url: string;
  events: string[];
  format: 'standard' | 'slack' | 'discord';
  createdAt: string;
  updatedAt: string;
}

export interface ListWebhooksResponse {
  webhooks: Webhook[];
}

export interface CreateWebhookResponse {
  webhook: Webhook;
}

export interface FeatureTemplate {
  id: string;
  boardId: string;
  name: string;
  titlePattern: string;
  descriptionPattern: string;
  priority: 'low' | 'medium' | 'high' | 'critical' | null;
  labels: string[];
  domain: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListTemplatesResponse {
  templates: FeatureTemplate[];
}

export interface CreateTemplateResponse {
  template: FeatureTemplate;
}

export interface BoardSettings {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentStats {
  completed: number;
  failed: number;
  avgCycleTime: number;
  rejectionRate: number;
  throughput: number;
  streak: number;
}

export interface TaskNarrative {
  taskTitle: string;
  taskId: string;
  priority: string;
  currentStatus: string;
  assignedAgent: string | null;
  timeline: {
    action: string;
    actor: string;
    timestamp: string;
    detail?: string;
  }[];
  cycleTimeMinutes?: number;
  rejections: number;
  result?: string;
}

export interface ActivityPeriod {
  period: string;
  from: string;
  to: string;
  taskNarratives: TaskNarrative[];
  metrics: {
    tasksCompleted: number;
    tasksCreated: number;
    tasksStarted: number;
    tasksRejected: number;
    avgCycleTimeMinutes: number;
  };
}

export interface ListFeaturesResponse {
  features: FeatureWithProgress[];
  total: number;
}

export interface ListTasksInFeatureResponse {
  tasks: Task[];
  total: number;
}

export interface FeatureProgressResponse {
  completed: number;
  total: number;
  percentage: number;
  byStatus: Record<string, number>;
}

export interface FeatureDetailsResponse {
  feature: FeatureWithProgress;
  tasks: Task[];
  events: FeatureEvent[];
  progress: { completed: number; total: number; percentage: number; byStatus: Record<string, number> };
  dependencies: { dependsOn: string[]; blocks: string[] };
}

export interface FeatureEvent {
  id: string;
  featureId: string;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  action: string;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface BoardSummary {
  board: {
    name: string;
    description: string;
    columns: { name: string; featureCount: number; isTerminal: boolean }[];
    totalFeatures: number;
  };
  snapshot: {
    byStatus: Record<string, number>;
    byPriority: Record<string, number>;
    activeAgents: { name: string; currentTask: string | null }[];
    blockedFeatures: { title: string; blockedBy: string[] }[];
    overdueFeatures: { title: string; dueAt: string }[];
  };
  recentActivity: ActivityPeriod[];
  digest: string;
  generatedAt: string;
}