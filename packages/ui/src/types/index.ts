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
  AutomationSettings,
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
  CodeEvidenceCorrectionInput,
  CodeEvidenceNotApplicableInput,
  CodeEvidenceGapInput,
  CodeEvidenceGapResolveInput,
  RepositoryIdentity,
  RepositoryIdentityInput,
  EffortSource,
  EffortActorType,
  EffortEntry,
  EffortEntryWithActor,
  EffortReport,
  MissionEffortReport,
  // Pod Bridge types
  PodAffiliation,
  ParticipantStanding,
  RemotePrincipalType,
  RemoteParticipantType,
  RemoteActorRef,
  RemoteGrantType,
  RemoteGrantStatus,
  RemoteRevocationMode,
  RemoteGrantEligibilityMode,
  RemoteGrantTargetType,
  RemoteActionScope,
  RemoteCredentialType,
  RemoteCredentialStatus,
  RemoteInviteType,
  RemoteInviteStatus,
  RemotePodStatus,
  RemoteParticipantStatus,
  IdentityProviderKind,
  RemoteWebhookEndpointStatus,
  RemoteIdempotencyStatus,
  RemoteEvidenceKind,
  RemoteActionKind,
  RemoteAuditMetadata,
  SignalType,
  SkillCategory,
  // Wiki types
  WikiPageStatus,
  WikiLinkTargetType,
  WikiPage,
  WikiPageVersion,
  WikiPageLink,
  // Workflow types
  GateType,
  JoinMode,
  SignalMatch,
  AutomationMatch,
  ExperienceCategory,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateGate,
  WorkflowTemplateVariable,
  WorkflowTemplateDefinition,
  AutomationCondition,
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
  AutomationSettings,
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
  PodAffiliation,
  ParticipantStanding,
  RemotePrincipalType,
  RemoteParticipantType,
  RemoteActorRef,
  RemoteGrantType,
  RemoteGrantStatus,
  RemoteRevocationMode,
  RemoteGrantEligibilityMode,
  RemoteGrantTargetType,
  RemoteActionScope,
  RemoteCredentialType,
  RemoteCredentialStatus,
  RemoteInviteType,
  RemoteInviteStatus,
  RemotePodStatus,
  RemoteParticipantStatus,
  IdentityProviderKind,
  RemoteWebhookEndpointStatus,
  RemoteIdempotencyStatus,
  RemoteEvidenceKind,
  RemoteActionKind,
  RemoteAuditMetadata,
  SignalType,
  SkillCategory,
  WikiPageStatus,
  WikiLinkTargetType,
  WikiPage,
  WikiPageVersion,
  WikiPageLink,
  GateType,
  JoinMode,
  SignalMatch,
  AutomationMatch,
  ExperienceCategory,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateGate,
  WorkflowTemplateVariable,
  WorkflowTemplateDefinition,
  AutomationCondition,
};

// ---------------------------------------------------------------------------
// Admin metrics view-model interfaces (mirrors backend metrics services)
// ---------------------------------------------------------------------------

/** Per-agent experience signal metrics row for the admin dashboard. */
export interface AgentExperienceMetrics {
  agentId: string;
  agentName: string;
  agentType: string;
  agentDomain: string;
  signalCount: number;
  tasksWorked: number;
  signalsTaskRatio: number;
  categoryDistribution: Partial<Record<ExperienceCategory, number>>;
  midTaskCount: number;
  completionCount: number;
  midTaskCompletionRatio: number;
  outlierFlag: "high_reporter" | "low_reporter" | null;
}

/** Full experience metrics response from the admin route. */
export interface ExperienceMetricsResult {
  agents: AgentExperienceMetrics[];
  medianSignalsTaskRatio: number;
  generatedAt: string;
}

/** Recovery attempt count grouped by recovery depth. */
export interface RecoveryAttemptByDepth {
  recoveryDepth: number;
  total: number;
}

/** Workflow health metrics response from the admin route. */
export interface WorkflowMetricsResult {
  activeWorkflowsCount: number;
  failureRate: number;
  recoverySuccessRate: number;
  recoveryAttemptsByDepth: RecoveryAttemptByDepth[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Pod Bridge view-model interfaces (mirrors backend remoteAccessAdminService)
// ---------------------------------------------------------------------------

export interface RemotePodView {
  id: string;
  habitatId: string;
  name: string;
  description: string;
  status: string;
  defaultStanding: string;
  inviteId: string | null;
  providerPodIdentity: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  participantCount: number;
  activeGrantCount: number;
}

export interface RemoteParticipantView {
  id: string;
  remotePodId: string;
  habitatId: string;
  participantType: string;
  displayName: string;
  standing: string;
  proposedCapabilities: string[];
  proposedDomains: string[];
  approvedCapabilities: string[];
  approvedDomains: string[];
  status: string;
  externalIdentityId: string | null;
  registeredBy: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
  hasActiveCredential: boolean;
  activeGrantCount: number;
}

export interface RemoteGrantView {
  id: string;
  habitatId: string;
  remotePodId: string;
  remoteParticipantId: string | null;
  grantType: string;
  standing: string;
  actionScopes: string[];
  eligibilityMode: string;
  includeFutureMatches: boolean;
  graceWindowHours: number;
  status: string;
  expiresAt: string | null;
  expiredAt: string | null;
  revocationMode: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  targets: { targetType: string; targetId: string }[];
  rule: { domains?: string[]; labels?: string[]; capabilities?: string[] } | null;
  taskSnapshotCount: number;
  isPodWide: boolean;
  isPermanent: boolean;
}

export interface RemoteAccessManagementView {
  pods: RemotePodView[];
  participants: RemoteParticipantView[];
  grants: RemoteGrantView[];
  summary: {
    totalPods: number;
    activePods: number;
    totalParticipants: number;
    activeParticipants: number;
    totalGrants: number;
    activeGrants: number;
  };
}

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

export type ForecastConfidence = "high" | "medium" | "low" | "insufficient_data";

export interface ForecastReason {
  code:
    | "small_sample"
    | "no_recent_velocity"
    | "blocked_dependencies"
    | "unstable_rejection_rate"
    | "missing_estimates"
    | "effort_overlap"
    | "overdue"
    | "stable_history";
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface ForecastEstimate {
  targetType: "task" | "mission" | "sprint";
  targetId: string;
  estimatedCompletionAt: string | null;
  earliestCompletionAt: string | null;
  latestCompletionAt: string | null;
  confidence: ForecastConfidence;
  confidenceScore: number;
  reasons: ForecastReason[];
  sampleSize: number;
  basis: "throughput" | "logged_effort" | "inferred_presence" | "hybrid";
}

export interface TaskEstimate {
  targetType: "task";
  targetId: string;
  taskId: string;
  missionId: string;
  taskTitle: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  dueAt: string | null;
  estimatedCompletionAt: string | null;
  earliestCompletionAt: string | null;
  latestCompletionAt: string | null;
  confidence: ForecastConfidence;
  confidenceScore: number;
  confidenceReasons: string[];
  reasons: ForecastReason[];
  sampleSize: number;
  basis: ForecastEstimate["basis"];
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
  forecasts: ForecastEstimate[];
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

export type AnalyticsConfidence = "high" | "medium" | "low" | "insufficient_data";

export interface AnalyticsWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface CumulativeFlowPoint {
  date: string;
  countsByColumn: Record<string, number>;
  countsByStatus: Record<string, number>;
  source?: string;
  completeness?: string;
  warnings?: AnalyticsWarning[];
}

export interface CumulativeFlowResponse {
  habitatId: string;
  days: number;
  generatedAt: string;
  columns: Array<{ columnId: string; name: string; order: number }>;
  data: CumulativeFlowPoint[];
  warnings: AnalyticsWarning[];
}

export interface BottleneckFinding {
  columnId?: string;
  columnName?: string;
  missionId?: string;
  severity: "low" | "medium" | "high" | "critical";
  signal:
    | "accumulation"
    | "dwell_time"
    | "wip_exceeded"
    | "blocked_dependencies"
    | "backlog_growth";
  confidence: AnalyticsConfidence;
  summary: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}

export interface BottleneckResponse {
  habitatId: string;
  days: number;
  generatedAt: string;
  findings: BottleneckFinding[];
  warnings: AnalyticsWarning[];
}

export interface SprintMetricsV2 {
  sprintId: string;
  totalMissions: number;
  completedMissions: number;
  completionPercentage: number;
  totalTasks: number;
  completedTasks: number;
  velocity: number;
  remainingDays: number;
  isOnTrack: boolean;
  plannedMinutes: number | null;
  loggedEffortMinutes: number;
  inferredPresenceMinutes: number;
  carryOverCount: number;
  forecast: ForecastEstimate | null;
  warnings: AnalyticsWarning[];
}

export interface SprintCarryOverReason {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface SprintCarryOverReport {
  sprintId: string;
  generatedAt: string;
  policy: "backlog" | "next_sprint" | "none";
  carriedOverMissions: Array<{
    missionId: string;
    title: string;
    status: string;
    reasons: SprintCarryOverReason[];
  }>;
  warnings: AnalyticsWarning[];
}

export interface AgentQualitySignal {
  agentId: string;
  agentName: string;
  score: number | null;
  confidence: AnalyticsConfidence;
  sampleSize: number;
  dimensions: {
    approval: number | null;
    nonRejectionRate: number | null;
    consistency: number | null;
    cycleDataCompleteness: number | null;
    estimateAccuracy: number | null;
    evidenceCompleteness: number | null;
  };
  warnings: string[];
}

export interface AgentQualityResponse {
  habitatId: string;
  generatedAt: string;
  signals: AgentQualitySignal[];
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

export type PulseScope = "mission" | "habitat";

export interface Pulse {
  id: string;
  missionId: string | null;
  habitatId: string;
  scope: PulseScope;
  fromType: "human" | "agent" | "system" | "remote_human" | "remote_orcy";
  fromId: string;
  toType: "human" | "agent" | "remote_human" | "remote_orcy" | null;
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

// ---------------------------------------------------------------------------
// Wiki view-model interfaces (reader-facing surfaces — seed 10 + seed 14)
// ---------------------------------------------------------------------------

/** Search hit row returned by the wiki FTS5/LIKE search route. */
export interface WikiSearchHit {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  rank: number;
}

/** Wiki page link with read-time dangling flag (ADR-0007 polymorphic citation). */
export interface WikiPageLinkWithDangling extends WikiPageLink {
  dangling?: boolean;
}

/** Wiki page enriched with resolved citations for the page viewer. */
export interface WikiPageWithLinks extends WikiPage {
  links: WikiPageLinkWithDangling[];
}

/**
 * Aggregated experience cluster projected for reader-facing surfaces.
 * Individual pulse / task / comment / agent IDs are NOT exposed (privacy
 * boundary, ARCHITECTURE.md §11.7).
 */
export interface WikiExperienceAggregate {
  id: string;
  subject: string;
  summary: string | null;
  skillCategory: string;
  sourceSignalType: string;
  strength: number;
  frequency: number;
  corroboratingAgents: number;
  successfulTasks: number;
  failedTasks: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Parallel-array signal surface returned by the signal-surface route. */
export interface WikiSignalSurface {
  experiencePatterns?: WikiExperienceAggregate[];
  findings?: Record<string, unknown>[];
  unstructuredFindings?: Record<string, unknown>[];
  /** Plugin-detector output rows (ADR-0013); only populated when signalClass === "detected". */
  detectedSignals?: Record<string, unknown>[];
}

/** Coverage watermark + marker-type payload from the cadence status route. */
export interface WikiCadence {
  enabled: boolean;
  scheduleType?: string;
  intervalMinutes?: number | null;
  cronExpression?: string | null;
  timezone?: string;
  scheduledTaskId?: string | null;
  updatedAt?: string;
  watermark?: string | null;
  coverageGap?: { from: string | null; to: string };
}
