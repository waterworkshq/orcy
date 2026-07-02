export type { AgentType, AgentDomain, AgentStatus } from "./agent.js";
export type { Agent, AgentStats, AllAgentStats } from "./agent.js";

export type { Habitat, Column, HabitatStats, HabitatExport } from "./board.js";

export type {
  AuditActorRef,
  AuditCompleteness,
  AuditCompletenessSummary,
  AuditEntityRef,
  AuditEntityType,
  AuditEvent,
  AuditIntegrity,
  AuditProvenance,
  AuditSource,
  AuditWarning,
} from "./audit.js";

export type { MissionStatus, MissionEventAction } from "./feature.js";
export type {
  Mission,
  MissionWithProgress,
  MissionEvent,
  MissionTemplate,
  MissionWatcher,
  MissionComment,
  MissionCommentMention,
  TaskTemplateEntry,
  ScheduledTask,
  ScheduleType,
} from "./feature.js";

export type { TaskPriority, TaskStatus } from "./task.js";
export type {
  Task,
  TaskEvent,
  TaskComment,
  TaskCommentMention,
  Artifact,
  RetryPolicy,
  TaskWatcher,
  Subtask,
  CrossHabitatDependency,
  PullRequest,
} from "./task.js";

export type { ActorType, EventAction, PresenceType } from "./events.js";
export type { PresenceEntry, SSEEvent, PresenceEvent } from "./events.js";

export type { AutoAssignStrategy } from "./settings.js";
export { DEFAULT_TRIAGE_SETTINGS } from "./settings.js";
export type {
  AnomalySettings,
  Anomaly,
  AutoAssignSettings,
  AutomationSettings,
  TriageSettings,
  GitWorktreeSettings,
  CodeReviewSettings,
  CiCdSettings,
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
  WikiSettings,
} from "./settings.js";

export type {
  DashboardStats,
  HabitatMetrics,
  TaskTimeRecord,
  TaskTimeReport,
  EffortSource,
  EffortActorType,
  EffortEntry,
  EffortEntryWithActor,
  LogEffortRequest,
  CorrectEffortRequest,
  EffortTotals,
  EffortReport,
  MissionEffortReport,
} from "./stats.js";

export type {
  QualityChecklistTemplate,
  QualityChecklistItem,
  TaskQualityChecklist,
  TaskQualityChecklistItem,
  TaskQualityReport,
  DependencyValidationResult,
  ApprovalStatus,
} from "./quality.js";

export type {
  BatchTaskOperation,
  BatchTaskPayload,
  BatchTaskResult,
  BatchTaskResponse,
  BatchTaskRequest,
} from "./batch.js";

export type {
  WebhookSubscription,
  WebhookDelivery,
  PipelineEventStatus,
  PipelineEvent,
} from "./webhook.js";

export type { ReviewRuleStrategy, ReviewerStatus, ReviewerType } from "./review.js";
export type {
  ReviewRule,
  TaskReviewer,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
} from "./review.js";

export type {
  NotificationEventType,
  NotificationSourceType,
  NotificationTargetType,
  NotificationRecipientType,
  NotificationSeverity,
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationAttemptStatus,
  NotificationSubscriptionScope,
  NotificationCadence,
  NotificationActorType,
  NotificationEvent,
  NotificationDelivery,
  NotificationDeliveryAttempt,
  NotificationSubscription,
  NotificationDigestItem,
  NotificationRetentionPolicy,
  EnqueueNotificationInput,
  NotificationDashboardView,
} from "./notification.js";

export type { SprintStatus, CarryOverPolicy } from "./sprint.js";
export type { Sprint, SprintMetrics, SprintCreateInput, SprintUpdateInput } from "./sprint.js";

export type {
  IntegrationProvider,
  IntegrationAuthMethod,
  IntegrationSyncStatus,
  IntegrationSyncRunStatus,
  IntegrationSyncTrigger,
  ExternalIssueStatus,
  ExternalIssueLinkSyncStatus,
  ExternalIntakeReviewStatus,
} from "./integration.js";
export type {
  IntegrationConnection,
  IntegrationConnectionView,
  ExternalIssue,
  ExternalIntakeCandidate,
  ExternalIssueLink,
  IntegrationSyncRun,
} from "./integration.js";

export type {
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
} from "./code-evidence.js";

export type {
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
} from "./code-evidence.js";

export {
  CODE_EVIDENCE_TYPES,
  CODE_EVIDENCE_LINK_SOURCES,
  CODE_EVIDENCE_VERIFICATION_STATES,
  CODE_EVIDENCE_LINK_STATUSES,
  CODE_EVIDENCE_COMPLETENESS_STATUSES,
  CODE_EVIDENCE_GAP_STATUSES,
  CODE_EVIDENCE_REVIEW_STATUSES,
  CODE_EVIDENCE_CHANGE_TYPES,
  KNOWN_PROVIDERS,
  NOT_APPLICABLE_REASONS,
  GAP_REASONS,
  CORRECTION_REASONS,
  DEFAULT_CONFIDENCE,
  EXTERNAL_REPO_CONFIDENCE,
  FAILED_VERIFICATION_CONFIDENCE,
  ORCY_TASK_TRAILER,
  ORCY_MISSION_TRAILER,
  GITHUB_PR_URL_PATTERN,
  GITHUB_COMMIT_URL_PATTERN,
  GITHUB_ACTIONS_RUN_URL_PATTERN,
  GITLAB_MR_URL_PATTERN,
  GITLAB_COMMIT_URL_PATTERN,
  GITLAB_PIPELINE_URL_PATTERN,
} from "./code-evidence.js";

export type {
  AutomationEventType,
  AutomationScanType,
  AutomationTriggerType,
  AutomationTrigger,
  AutomationConditionOperator,
  AutomationConditionComparison,
  AutomationCondition,
  AutomationActionType,
  AutomationRecipient,
  AutomationActionNotify,
  AutomationActionCreateSignal,
  AutomationActionCreateTask,
  AutomationActionChangePriority,
  AutomationActionAssign,
  AutomationActionReleaseAssignment,
  AutomationActionRequestReview,
  AutomationActionCallWebhook,
  AutomationActionMarkRisk,
  AutomationAction,
  AutomationRuleStatus,
  AutomationRunStatus,
  AutomationSkipReason,
  AutomationTargetType,
  AutomationRule,
  AutomationRuleRun,
  AutomationConditionResult,
  AutomationActionResult,
  AutomationSimulationResult,
  AutomationTriggerContext,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from "./automation.js";

export { buildFingerprint } from "./automation.js";

export type {
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
  IdentityProviderAuthStateStatus,
  RemoteWebhookEndpointStatus,
  RemoteIdempotencyStatus,
  RemoteEvidenceKind,
  RemoteActionKind,
  RemoteAuditMetadata,
} from "./pod-bridge.js";

export type {
  CliType,
  DetectedCli,
  ClaimResult,
  RegisteredAgent,
  SessionStatus,
  ActiveSession,
  ISessionManager,
  ISessionUpdater,
  ICliDetector,
  IClaimStrategy,
  IHeartbeatStrategy,
  IPollLoop,
} from "./daemon.js";
export { AGENT_TYPES, SESSION_STATUSES } from "./daemon.js";

export type {
  SignalType,
  FindingKind,
  FindingSeverity,
  SuggestedBucket,
  StructuredFindingMetadata,
} from "./signal.js";
export {
  SIGNAL_TYPES,
  FINDING_KINDS,
  FINDING_SEVERITIES,
  SUGGESTED_BUCKETS,
  findingMetadataSchema,
  detectedMetadataSchema,
} from "./signal.js";

export type {
  WikiPageStatus,
  WikiCoverageMarkerType,
  WikiLinkTargetType,
  WikiPage,
  WikiPageVersion,
  WikiPageLink,
  WikiCoverageMarker,
} from "./wiki.js";
export { WIKI_LINK_TARGET_TYPES } from "./wiki.js";

export type { SkillCategory } from "./skill.js";
export { SKILL_CATEGORIES } from "./skill.js";

export type {
  FindingTriageStatus,
  ResolutionKind,
  TriageActorType,
  ClusterPayload,
  AgentQualityPayload,
} from "./triage.js";
export { FINDING_TRIAGE_STATUSES, FINDING_TRIAGE_TRANSITIONS, RESOLUTION_KINDS } from "./triage.js";

export type { ReleaseType, DetectorSource, ReleaseShippedPayload } from "./release.js";
export { RELEASE_TYPES, DETECTOR_SOURCES } from "./release.js";

export type {
  PluginManifest,
  PluginScope,
  Contribution,
  NotificationChannelContribution,
  SignalDetectorContribution,
  LifecycleInterceptorContribution,
  CustomMcpToolContribution,
  CustomHttpRouteContribution,
  WebhookFormatterContribution,
  AutomationConditionContribution,
  AutomationActionContribution,
  PluginEvaluationContext,
  DetectorSourceEvent,
  InterceptorEvent,
  PluginCapabilityName,
  Pulse,
  TaskListFilter,
  PluginHabitatView,
  ScopedComment,
  DetectedSignalInput,
  PulseReader,
  PulseWriter,
  CommentReader,
  TaskReader,
  HabitatReader,
  ChatIntegrationView,
  ChatIntegrationReader,
  PluginTaskCreateInput,
  TaskWriter,
  PluginNotificationInput,
  NotificationSender,
  WebhookCallResult,
  WebhookCaller,
  PluginRunStatus,
  PluginEnrollment,
  PluginEnrollmentInput,
  PluginRun,
} from "./plugin.js";

export type {
  GateType,
  JoinMode,
  SignalMatch,
  AutomationMatch,
  ExperienceCategory,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateGate,
  WorkflowTemplateVariable,
  WorkflowTemplateDefinition,
  TaskEventSnapshot,
  ExperienceSignalSnapshot,
  RetryAttemptSnapshot,
  FailureBundle,
} from "./workflow.js";
