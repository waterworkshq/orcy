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

export interface AuditEntityRef {
  type: AuditEntityType;
  id: string;
  title?: string | null;
}

export interface AuditActorRef {
  type: "human" | "agent" | "system" | "remote_pod" | "remote_orcy" | "remote_human";
  id: string | null;
  name?: string | null;
}

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

export interface AuditIntegrity {
  hash?: string;
  previousHash?: string;
  chainScope?: "habitat" | "global";
  chainId?: string;
  canonicalPayloadVersion?: number;
}

export interface AuditCompleteness {
  status: "complete" | "legacy_partial" | "source_unavailable";
  caveats: string[];
}

export interface AuditWarning {
  code: string;
  message: string;
  source?: AuditSource;
  entity?: AuditEntityRef;
}

export interface AuditCompletenessSummary {
  totalEvents: number;
  byStatus: Record<AuditCompleteness["status"], number>;
  caveats: string[];
}

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
