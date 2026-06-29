import type { AuditActorRef, AuditProvenance, AuditSource } from "@orcy/shared/types";
import type { ActorType } from "../models/index.js";

const AUDIT_SOURCES = new Set<AuditSource>([
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
]);

const SYSTEM_ACTOR_MAP: Record<string, { id: string; source: AuditSource }> = {
  "status-engine": { id: "system:status-engine", source: "system" },
  scheduler: { id: "system:scheduler", source: "scheduler" },
  "scheduled-task": { id: "system:scheduled-task", source: "scheduler" },
  "github-ci": { id: "system:github-ci", source: "webhook" },
  "gitlab-ci": { id: "system:gitlab-ci", source: "webhook" },
  "integration-sync": { id: "system:integration-sync", source: "integration_sync" },
};

/** Raw actor and metadata fields lifted from a source row, used to derive the canonical audit actor, source, and provenance. */
export interface AuditProjectionActorSourceInput {
  actorType: ActorType;
  actorId: string | null;
  actorName?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Normalized actor reference, {@link AuditSource}, and {@link AuditProvenance} produced by {@link normalizeAuditActorAndSource}. */
export interface AuditProjectionActorSource {
  actor: AuditActorRef;
  source: AuditSource;
  provenance: AuditProvenance;
}

function getAuditMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const audit = metadata?.audit;
  return audit && typeof audit === "object" && !Array.isArray(audit)
    ? (audit as Record<string, unknown>)
    : {};
}

function readSource(value: unknown): AuditSource | null {
  return typeof value === "string" && AUDIT_SOURCES.has(value as AuditSource)
    ? (value as AuditSource)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Derives the canonical {@link AuditActorRef}, {@link AuditSource}, and {@link AuditProvenance} from a source row's actor fields and audit metadata, applying system-actor mapping where applicable. */
export function normalizeAuditActorAndSource(
  input: AuditProjectionActorSourceInput,
): AuditProjectionActorSource {
  const audit = getAuditMetadata(input.metadata);
  const metadataSource = readSource(audit.source);
  const mappedSystemActor =
    input.actorType === "system" && input.actorId ? SYSTEM_ACTOR_MAP[input.actorId] : undefined;
  const actorId = mappedSystemActor?.id ?? input.actorId;

  return {
    actor: {
      type: input.actorType,
      id: actorId,
      ...(input.actorName ? { name: input.actorName } : {}),
    },
    source: metadataSource ?? mappedSystemActor?.source ?? "unknown",
    provenance: {
      ...(readString(audit.requestId) ? { requestId: readString(audit.requestId) } : {}),
      ...(readString(audit.route) ? { route: readString(audit.route) } : {}),
      ...(readString(audit.method) ? { method: readString(audit.method) } : {}),
      ...(readString(audit.toolName) ? { toolName: readString(audit.toolName) } : {}),
      ...(readString(audit.integrationSyncRunId)
        ? { integrationSyncRunId: readString(audit.integrationSyncRunId) }
        : {}),
      ...(readString(audit.webhookDeliveryId)
        ? { webhookDeliveryId: readString(audit.webhookDeliveryId) }
        : {}),
      ...(readString(audit.provider) ? { provider: readString(audit.provider) } : {}),
      ...(readString(audit.externalId) ? { externalId: readString(audit.externalId) } : {}),
      ...(readString(audit.reason) ? { reason: readString(audit.reason) } : {}),
      ...(readString(audit.note) ? { note: readString(audit.note) } : {}),
      // Phase E — pass through remote context when present
      ...(audit.remote && typeof audit.remote === "object" && !Array.isArray(audit.remote)
        ? { remote: audit.remote as AuditProvenance["remote"] }
        : {}),
    },
  };
}
