import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AuditSource,
  AuditActorRef,
  RemoteAuditMetadata,
  RemoteActionKind,
  ParticipantStanding,
} from "@orcy/shared/types";
import type { ActorType } from "../models/index.js";

export interface AuditProvenanceContext {
  source: AuditSource;
  requestId?: string;
  route?: string;
  method?: string;
  toolName?: string;
  mcpAction?: string;
  actorType?: ActorType | AuditActorRef["type"];
  actorId?: string;
  /**
   * v0.19 Phase E — Remote-participant context. When set, the audit
   * metadata block will include `audit.remote` with pod/participant
   * attribution, standing, grant reference, and the action kind.
   */
  remote?: {
    podId: string;
    participantId: string;
    standing: ParticipantStanding;
    grantId?: string;
    credentialId?: string;
    actionKind: RemoteActionKind;
    providerIdentity?: string | null;
  };
}

const storage = new AsyncLocalStorage<AuditProvenanceContext>();

export function runWithAuditProvenance<T>(context: AuditProvenanceContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function updateAuditProvenance(patch: Partial<AuditProvenanceContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

export function setAuditActor(actorType: ActorType | AuditActorRef["type"], actorId: string): void {
  updateAuditProvenance({ actorType, actorId });
}

/**
 * Phase E — Set the full remote-participant context in one call. This is
 * what `remoteParticipantAuth` uses after it has loaded the pod,
 * participant, credential, and the relevant grant.
 */
export function setRemoteAuditContext(remote: NonNullable<AuditProvenanceContext["remote"]>): void {
  updateAuditProvenance({ remote });
}

export function getAuditProvenanceMetadata(): Record<string, unknown> | undefined {
  const current = storage.getStore();
  if (!current) return undefined;

  return {
    source: current.source,
    ...(current.requestId ? { requestId: current.requestId } : {}),
    ...(current.route ? { route: current.route } : {}),
    ...(current.method ? { method: current.method } : {}),
    ...(current.toolName ? { toolName: current.toolName } : {}),
    ...(current.mcpAction ? { mcpAction: current.mcpAction } : {}),
    ...(current.actorType ? { actorType: current.actorType } : {}),
    ...(current.actorId ? { actorId: current.actorId } : {}),
    ...(current.remote ? { remote: current.remote as unknown as Record<string, unknown> } : {}),
  };
}

export function withAuditProvenanceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const audit = getAuditProvenanceMetadata();
  if (!audit) return metadata ?? {};

  const existing = metadata?.audit;
  const existingAudit =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return {
    ...metadata,
    audit: {
      ...audit,
      ...existingAudit,
    },
  };
}

// Suppress unused import warning — RemoteAuditMetadata is re-exported
// for downstream consumers who want to construct context.remote.
export type { RemoteAuditMetadata };
