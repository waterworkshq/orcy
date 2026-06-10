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
export type {
  AnomalySettings,
  Anomaly,
  AutoAssignSettings,
  GitWorktreeSettings,
  CodeReviewSettings,
  CiCdSettings,
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
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
