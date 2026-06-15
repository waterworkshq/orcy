/** Closed set of domain object kinds that audit events can reference as their subject entity. */
export type AuditEntityType =
  | "task"
  | "mission"
  | "effort_entry"
  | "time_record"
  | "code_evidence_link"
  | "code_evidence_gap"
  | "branch"
  | "commit"
  | "changed_file"
  | "pull_request"
  | "code_review"
  | "pipeline_event"
  | "integration_sync_run"
  | "webhook_delivery"
  | "health_snapshot";

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

/** Origin channel through which an audit event entered the system (REST API, MCP tool, webhook, daemon, scheduler, etc.). */
export type AuditSource =
  | "rest_api"
  | "mcp_tool"
  | "webhook"
  | "daemon"
  | "system"
  | "integration_sync"
  | "scheduler"
  | "migration"
  | "automation"
  | "notification"
  | "unknown";

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
