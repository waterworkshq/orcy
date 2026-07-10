import type {
  AuditEvent,
  AuditQueryEntityType,
  AuditSource,
  AuditWarning,
} from "@orcy/shared/types";

export interface AuditEntityReferenceFilter {
  type: "task" | "mission";
  id: string;
}

export type AuditCollectorKey =
  | "lifecycle"
  | "effort"
  | "code_evidence"
  | "integration_sync"
  | "webhook_delivery"
  | "health_snapshot"
  | "automation_run"
  | "notification"
  | "plugin_run";

export type AuditCollectorFailurePolicy = "fatal" | "warning";

export interface AuditCollectorRequest {
  habitatId: string;
  selectedEntityTypes: ReadonlySet<AuditQueryEntityType>;
}

export interface AuditCollectorResult {
  events: AuditEvent[];
  warnings: AuditWarning[];
  caveats: string[];
}

export interface AuditProjectionCollector {
  key: AuditCollectorKey;
  entityTypes: readonly AuditQueryEntityType[];
  failurePolicy: AuditCollectorFailurePolicy;
  warningSource?: AuditSource;
  collect(request: AuditCollectorRequest): AuditCollectorResult;
}

export interface AuditProjectionSet {
  events: AuditEvent[];
  warnings: AuditWarning[];
  caveats: string[];
}