import type {
  AgentType,
  AgentDomain,
  AgentStatus,
  TaskPriority,
  TaskStatus,
  MissionStatus,
  ActorType,
  EventAction,
  MissionEventAction,
  RetryPolicy,
  AnomalySettings,
  Anomaly,
  AutoAssignStrategy,
  AutoAssignSettings,
  Habitat,
  Column,
  Agent,
  Mission,
  MissionWithProgress,
  MissionEvent,
  Task,
  Artifact,
  TaskEvent,
  TaskComment,
  TaskCommentMention,
  MissionComment,
  MissionCommentMention,
  Subtask,
  TaskWatcher,
  CrossHabitatDependency,
  PresenceType,
  PresenceEntry,
  SSEEvent,
  HabitatStats,
  DashboardStats,
  AgentStats,
  AllAgentStats,
  MissionTemplate,
  HabitatExport,
  BatchTaskOperation,
  BatchTaskResult,
  BatchTaskResponse,
  PullRequest,
  PipelineEventStatus,
  PipelineEvent,
  ApprovalStatus,
  TaskTimeReport,
  BatchTaskRequest,
  CodeReviewSettings,
  CiCdSettings,
  GitWorktreeSettings,
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
  ScheduledTask,
  ScheduleType,
  TaskTemplateEntry,
  TaskReviewer,
  ReviewerStatus,
  ReviewerType,
  Sprint,
  SprintStatus,
  SprintMetrics,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
  SprintCreateInput,
  IntegrationProvider,
  IntegrationAuthMethod,
  IntegrationSyncStatus,
  IntegrationSyncRunStatus,
  IntegrationSyncTrigger,
  ExternalIssueStatus,
  ExternalIssueLinkSyncStatus,
  ExternalIntakeReviewStatus,
  IntegrationConnection,
  IntegrationConnectionView,
  ExternalIssue,
  ExternalIntakeCandidate,
  ExternalIssueLink,
  IntegrationSyncRun,
  CodeEvidenceType,
  CodeEvidenceLinkSource,
  CodeEvidenceVerificationState,
  CodeEvidenceLinkStatus,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceGapStatus,
  CodeEvidenceTargetType,
  CodeEvidenceActorType,
  CodeEvidenceReviewStatus,
  CodeEvidenceChangeType,
  CodeEvidenceProvider,
  KnownProvider,
  NotApplicableReason,
  GapReason,
  CorrectionReason,
  CodeEvidenceLinkInput,
  CodeEvidenceLinkItem,
  CodeEvidenceGapItem,
  EffortSource,
  EffortActorType,
  EffortEntry,
  EffortEntryWithActor,
  EffortReport,
  MissionEffortReport,
} from "@orcy/shared";

export type {
  AgentType,
  AgentDomain,
  AgentStatus,
  TaskPriority,
  TaskStatus,
  MissionStatus,
  ActorType,
  EventAction,
  MissionEventAction,
  RetryPolicy,
  AnomalySettings,
  Anomaly,
  AutoAssignStrategy,
  AutoAssignSettings,
  Habitat,
  Column,
  Agent,
  Mission,
  MissionWithProgress,
  MissionEvent,
  Task,
  Artifact,
  TaskEvent,
  TaskComment,
  TaskCommentMention,
  MissionComment,
  MissionCommentMention,
  Subtask,
  TaskWatcher,
  CrossHabitatDependency,
  PresenceType,
  PresenceEntry,
  SSEEvent,
  HabitatStats,
  DashboardStats,
  AgentStats,
  AllAgentStats,
  MissionTemplate,
  HabitatExport,
  BatchTaskOperation,
  BatchTaskResult,
  BatchTaskResponse,
  PullRequest,
  PipelineEventStatus,
  PipelineEvent,
  ApprovalStatus,
  TaskTimeReport,
  BatchTaskRequest,
  CodeReviewSettings,
  CiCdSettings,
  GitWorktreeSettings,
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
  ScheduledTask,
  ScheduleType,
  TaskTemplateEntry,
  TaskReviewer,
  ReviewerStatus,
  ReviewerType,
  Sprint,
  SprintStatus,
  SprintMetrics,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
  SprintCreateInput,
  IntegrationProvider,
  IntegrationAuthMethod,
  IntegrationSyncStatus,
  IntegrationSyncRunStatus,
  IntegrationSyncTrigger,
  ExternalIssueStatus,
  ExternalIssueLinkSyncStatus,
  ExternalIntakeReviewStatus,
  IntegrationConnection,
  IntegrationConnectionView,
  ExternalIssue,
  ExternalIntakeCandidate,
  ExternalIssueLink,
  IntegrationSyncRun,
  CodeEvidenceType,
  CodeEvidenceLinkSource,
  CodeEvidenceVerificationState,
  CodeEvidenceLinkStatus,
  CodeEvidenceCompletenessStatus,
  CodeEvidenceGapStatus,
  CodeEvidenceTargetType,
  CodeEvidenceActorType,
  CodeEvidenceReviewStatus,
  CodeEvidenceChangeType,
  CodeEvidenceProvider,
  KnownProvider,
  NotApplicableReason,
  GapReason,
  CorrectionReason,
  CodeEvidenceLinkInput,
  CodeEvidenceLinkItem,
  CodeEvidenceGapItem,
  CodeEvidenceCompletenessInfo,
  CodeEvidenceSummary,
  CodeEvidenceResponse,
  CodeEvidenceHistory,
  MissionCodeEvidenceResponse,
  CodeEvidenceBulkResult,
  RepositoryIdentity,
  RepositoryIdentityInput,
  CodeEvidenceCorrectionInput,
  CodeEvidenceNotApplicableInput,
  CodeEvidenceGapInput,
  CodeEvidenceGapResolveInput,
  EffortSource,
  EffortActorType,
  EffortEntry,
  EffortEntryWithActor,
  EffortReport,
  MissionEffortReport,
};

export interface EnrichedHabitatEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  habitatId: string;
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

export interface SiblingTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  result: string | null;
  order: number;
}

export interface TaskContext {
  task: Task;
  mission: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: MissionStatus;
  } | null;
  siblingTasks: SiblingTask[];
  dependencies: Task[];
  crossHabitatDependsOn: CrossHabitatDependency[];
  blockedBy: Task[];
  blocking: Task[];
  habitatContext: {
    name: string;
    columns: { name: string; taskCount: number }[];
  };
}

export interface CreateMissionInput {
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

export interface CreateTaskInMissionInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  estimatedMinutes?: number;
}

export interface MoveMissionInput {
  columnId: string;
}

export interface MoveTaskInput {
  status?: TaskStatus;
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
  status: "pending" | "in_progress" | "passed";
  progress: { total: number; completed: number };
  items: QualityChecklistItem[];
}

export interface TaskQualityReport {
  taskId: string;
  overallStatus: "passed" | "blocked";
  canApprove: boolean;
  checklists: QualityChecklist[];
  missingRequirements: { category: string; missingItems: string[] }[];
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
  parentMission: { id: string; title: string };
}

export type MissionDecompositionResult = DecompositionResult;

export interface NotificationPreferences {
  id: string;
  userId: string;
  habitatId: string | null;
  taskAssigned: boolean;
  taskSubmitted: boolean;
  taskApproved: boolean;
  taskRejected: boolean;
  taskOverdue: boolean;
  taskMentioned: boolean;
  taskWatching: boolean;
  taskReviewAssigned: boolean;
  taskPriorityChanged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegration {
  id: string;
  habitatId: string;
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId: string | null;
  botToken: string | null;
  enabled: number;
  events: string[];
  createdAt: string;
  updatedAt: string;
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
  confidence: "high" | "medium" | "low";
  positionInQueue: number;
  daysUntilDue: number | null;
  daysUntilEstimated: number | null;
}

export interface AtRiskTask {
  taskId: string;
  taskTitle: string;
  reason: "overdue_prediction" | "no_activity" | "blocked_by_dependency" | "past_due";
  severity: "low" | "medium" | "high" | "critical";
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

export type TeamMemberRole = "owner" | "admin" | "member";

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  joinedAt: string;
}

export interface TaskBlockedStatus {
  taskId: string;
  isBlocked: boolean;
  canComplete: boolean;
  reason?: string;
  blockedBy: { taskId: string; taskTitle: string; status: string }[];
  blocking: { taskId: string; taskTitle: string; status: string }[];
}

export interface HabitatTimeMetrics {
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

export type SignalType =
  | "finding"
  | "blocker"
  | "offer"
  | "warning"
  | "question"
  | "answer"
  | "directive"
  | "context"
  | "handoff";

export type PulseScope = "mission" | "habitat";

export interface Pulse {
  id: string;
  missionId: string | null;
  habitatId: string;
  scope: PulseScope;
  fromType: "human" | "agent" | "system";
  fromId: string;
  toType: "human" | "agent" | null;
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

export interface PostPulseInput {
  signalType: SignalType;
  subject: string;
  body?: string;
  toAgentName?: string;
  taskId?: string;
  replyToId?: string;
}

export interface PulseReactionCounts {
  seen: number;
  ack: number;
  question: number;
}

export interface ProjectInsight {
  id: string;
  habitatId: string;
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

export interface SavedFilter {
  id: string;
  habitatId: string;
  userId: string;
  name: string;
  filterConfig: Record<string, unknown>;
  isBuiltin: boolean;
  createdAt: string;
}

export type ReviewRuleStrategy =
  | "domain_expert"
  | "round_robin"
  | "least_loaded"
  | "random"
  | "fixed";

export interface ReviewRule {
  id: string;
  habitatId: string;
  name: string;
  enabled: number;
  priority: number;
  matchDomain: string | null;
  matchLabels: string[];
  matchPriority: string | null;
  assignmentStrategy: ReviewRuleStrategy;
  requiredReviews: number;
  antiSelfReview: number;
  fixedReviewerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DaemonInfo {
  id: string;
  name: string;
  hostname: string;
  status: "online" | "offline";
  agentCount: number;
  activeSessionCount: number;
  lastHeartbeat: string | null;
  createdAt: string;
  maxConcurrent: number;
}

export interface DaemonDetail {
  daemon: {
    id: string;
    name: string;
    hostname: string;
    status: "online" | "offline";
    maxConcurrent: number;
    lastHeartbeat: string | null;
    createdAt: string;
    updatedAt: string;
  };
  agents: Array<{
    id: string;
    cliType: string;
    cliVersion: string | null;
    cliPath: string | null;
    status: string;
  }>;
  activeSessions: Array<{
    id: string;
    taskId: string;
    agentId: string;
    habitatId: string;
    status: string;
    startedAt: string | null;
    workdir: string | null;
    lastProgress: string | null;
  }>;
}

export interface DetectedCli {
  type: string;
  version: string | null;
  path: string;
}

export type SkillCategory =
  | "convention"
  | "pattern"
  | "pitfall"
  | "domain_knowledge"
  | "agent_insight";

export interface HabitatSkill {
  id: string;
  habitatId: string;
  content: string;
  signalCount: number;
  avgStrength: number;
  lastGeneratedAt: string | null;
  generationCount: number;
}

export interface SkillSignal {
  id: string;
  habitatId: string;
  clusterKey: string;
  skillCategory: SkillCategory;
  sourceSignalType: string;
  sourceType: string;
  subject: string;
  summary: string;
  strength: number;
  frequency: number;
  corroboratingAgents: number;
  crossMissionCount: number;
  successfulTasks: number;
  failedTasks: number;
  promotedToSkill: boolean;
  createdAt: string;
}
