import type {
  Task,
  TaskStatus,
  Artifact,
  Agent,
  Board,
  Column,
  Feature,
  FeatureStatus,
  FeatureWithProgress,
  FeatureEvent,
  FeatureTemplate,
  TaskEvent,
  TaskComment,
  Subtask,
  ActorType,
  FeatureEventAction,
} from '@orcy/shared';

export type {
  Task,
  TaskStatus,
  Artifact,
  Agent,
  Board,
  Column,
  Feature,
  FeatureStatus,
  FeatureWithProgress,
  FeatureEvent,
  FeatureTemplate,
  TaskEvent,
  TaskComment,
  Subtask,
  ActorType,
  FeatureEventAction,
};

export interface ListSubtasksResponse {
  subtasks: Subtask[];
  total: number;
  completedCount: number;
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
  pulse?: PulseDigest;
  projectInsights?: ProjectInsight[];
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

export interface BoardContext {
  name: string;
  columns: { name: string; taskCount: number }[];
}

export type SignalType =
  | 'finding' | 'blocker' | 'offer' | 'warning'
  | 'question' | 'answer' | 'directive' | 'context' | 'handoff';

export type PulseScope = 'mission' | 'habitat';

export interface Pulse {
  id: string;
  missionId: string | null;
  boardId: string;
  scope: PulseScope;
  fromType: 'human' | 'agent' | 'system';
  fromId: string;
  toType: 'human' | 'agent' | null;
  toId: string | null;
  signalType: SignalType;
  subject: string;
  body: string;
  taskId: string | null;
  replyToId: string | null;
  linkedTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  pinned: number;
  isAuto: boolean;
}

export interface PulseDigest {
  summary: string;
  newSinceLastCheck: number;
  counts: Record<SignalType, number>;
  highlights: Array<{
    id: string;
    signalType: SignalType;
    from: { type: string; name: string };
    subject: string;
    linkedTaskId?: string;
    createdAt: string;
  }>;
}

export interface ProjectInsight {
  id: string;
  boardId: string;
  sourcePulseId: string | null;
  sourceMission: string | null;
  signalType: SignalType;
  subject: string;
  body: string;
  relevanceTags: string[];
  promotedBy: string;
  promotedAt: string;
  isActive: boolean;
  createdAt: string;
}

export interface PostPulseResponse {
  pulse: Pulse;
  linkedTask?: Task;
  blockerTaskCreated?: boolean;
}

export interface ListPulsesResponse {
  items: Pulse[];
  total: number;
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
