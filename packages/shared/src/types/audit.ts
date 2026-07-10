/** Closed set of origin channels through which audit events enter the system. */
export const AUDIT_SOURCES = [
  "rest_api",
  "mcp_tool",
  "webhook",
  "daemon",
  "system",
  "integration_sync",
  "scheduler",
  "migration",
  "automation",
  "notification",
  "workflow",
  "plugin",
  "unknown",
] as const;

/** Origin channel through which an audit event entered the system (REST API, MCP tool, webhook, daemon, scheduler, etc.). */
export type AuditSource = (typeof AUDIT_SOURCES)[number];

/** Closed set of domain object kinds that audit events can reference as their subject entity. */
export const AUDIT_ENTITY_TYPES = [
  "task",
  "mission",
  "effort_entry",
  "time_record",
  "code_evidence_link",
  "code_evidence_gap",
  "branch",
  "commit",
  "changed_file",
  "pull_request",
  "code_review",
  "pipeline_event",
  "integration_sync_run",
  "webhook_delivery",
  "health_snapshot",
  "automation_run",
  "notification_event",
  "notification_delivery",
  "plugin_run",
] as const;

/** Discriminator for an audit event's subject entity kind. Covers both primary and linked entities (including `branch`, which is reference-only and never a primary query entity). */
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * Closed set of audit entity kinds a query can request as a primary selection.
 * Excludes `branch` because branches are reference-only links, never the subject
 * of a queryable audit event. Membership is exactly one per collector catalog
 * entry (enforced by `assertCatalogCoverage`).
 */
export const AUDIT_QUERY_ENTITY_TYPES = [
  "task",
  "mission",
  "effort_entry",
  "time_record",
  "code_evidence_link",
  "code_evidence_gap",
  "commit",
  "changed_file",
  "pull_request",
  "code_review",
  "pipeline_event",
  "integration_sync_run",
  "webhook_delivery",
  "health_snapshot",
  "automation_run",
  "notification_event",
  "notification_delivery",
  "plugin_run",
] as const;

/** Audit entity kinds a query can request as a primary selection. Excludes `branch`. */
export type AuditQueryEntityType = (typeof AUDIT_QUERY_ENTITY_TYPES)[number];

/**
 * Default primary-entity selection for an audit query. Excludes
 * `time_record` (explicit-only per Inferred Presence) and `health_snapshot`
 * (opt-in via `includeHealthSnapshots`). Operational sources (automation,
 * notification, plugin) are default-on.
 */
export const DEFAULT_AUDIT_QUERY_ENTITY_TYPES = [
  "task",
  "mission",
  "effort_entry",
  "code_evidence_link",
  "code_evidence_gap",
  "commit",
  "changed_file",
  "pull_request",
  "code_review",
  "pipeline_event",
  "integration_sync_run",
  "webhook_delivery",
  "automation_run",
  "notification_event",
  "notification_delivery",
  "plugin_run",
] as const;

import type { AutomationRunStatus, AutomationSkipReason } from "./automation.js";
import type {
  NotificationEventType,
  NotificationSourceType,
  NotificationSeverity,
  NotificationRecipientType,
  NotificationChannel,
  NotificationDeliveryStatus,
} from "./notification.js";
import type { Contribution } from "./plugin.js";

/** Operational provenance for an automation rule run. */
export interface AutomationAuditProvenance {
  runId: string;
  ruleId: string;
  ruleName?: string;
  triggerType: string;
  status: AutomationRunStatus;
  skipReason?: AutomationSkipReason;
}

/**
 * Operational provenance for a notification event or delivery. Delivery-only
 * fields (`recipientType`, `channels`, `required`, `status`, `deliveryId`) are
 * populated for `notification_delivery` events; event-only fields
 * (`eventType`, `sourceType`, `severity`, `deliveryCount`) are populated for
 * both event and delivery rows (delivery rows carry parent-event context).
 */
export interface NotificationAuditProvenance {
  eventId: string;
  deliveryId?: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  severity: NotificationSeverity;
  deliveryCount?: number;
  recipientType?: NotificationRecipientType;
  channels?: NotificationChannel[];
  required?: boolean;
  status?: NotificationDeliveryStatus;
}

/** Operational provenance for a plugin run. `contributionKind` is normalized to `"unknown"` when the persisted string does not match any registered `Contribution["kind"]`. */
export interface PluginAuditProvenance {
  runId: string;
  pluginId: string;
  contributionId: string;
  contributionKind: Contribution["kind"] | "unknown";
  triggerType: string;
  status: string;
}

/** Pointer to the primary or linked domain object an audit event describes. */
export interface AuditEntityRef {
  type: AuditEntityType;
  id: string;
  title?: string | null;
}

/** Identifies who performed an audited action, distinguishing humans, local agents, the system, and remote participants. */
export interface AuditActorRef {
  type: "human" | "agent" | "system" | "remote_pod" | "remote_orcy" | "remote_human";
  id: string | null;
  name?: string | null;
}

/** Traceability context recording where, why, and through what mechanism an audit event was produced. */
export interface AuditProvenance {
  requestId?: string;
  route?: string;
  method?: string;
  toolName?: string;
  sessionId?: string;
  provider?: "github" | "gitlab" | "jira" | "linear" | (string & {});
  externalId?: string;
  webhookDeliveryId?: string;
  integrationSyncRunId?: string;
  reason?: string;
  note?: string;
  /** v0.19 Phase E — Remote-participant context when the event was created by a remote actor. */
  remote?: {
    podId: string;
    participantId: string;
    standing: string;
    grantId?: string;
    credentialId?: string;
    actionKind: string;
    providerIdentity?: string | null;
  };
  /** v0.29 Operational Audit — populated for automation rule-run events. */
  automation?: AutomationAuditProvenance;
  /** v0.29 Operational Audit — populated for notification event and delivery events. */
  notification?: NotificationAuditProvenance;
  /** v0.29 Operational Audit — populated for plugin run events. */
  plugin?: PluginAuditProvenance;
}

/** Reserved hash-chain fields for future tamper-evidence support — currently unpopulated by all projection functions. */
export interface AuditIntegrity {
  hash?: string;
  previousHash?: string;
  chainScope?: "habitat" | "global";
  chainId?: string;
  canonicalPayloadVersion?: number;
}

/** Per-event indicator of how much context was captured, distinguishing fully captured from legacy-partial or source-unavailable records. */
export interface AuditCompleteness {
  status: "complete" | "legacy_partial" | "source_unavailable";
  caveats: string[];
}

/** Non-fatal issue surfaced while assembling or querying audit data, such as a degraded source or unresolved reference. */
export interface AuditWarning {
  code: string;
  message: string;
  source?: AuditSource;
  entity?: AuditEntityRef;
}

/** Aggregated counts of audit events grouped by {@link AuditCompleteness} status, plus rolled-up caveats. */
export interface AuditCompletenessSummary {
  totalEvents: number;
  byStatus: Record<AuditCompleteness["status"], number>;
  caveats: string[];
}

/** Immutable record of a single auditable action: what entity was affected, by whom, from where, with provenance and completeness metadata. */
export interface AuditEvent {
  id: string;
  habitatId: string;
  occurredAt: string;
  entity: AuditEntityRef;
  action: string;
  actor: AuditActorRef;
  source: AuditSource;
  provenance: AuditProvenance;
  linkedEntities: AuditEntityRef[];
  summary: string;
  metadata: Record<string, unknown>;
  completeness: AuditCompleteness;
  integrity?: AuditIntegrity;
}
