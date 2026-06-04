import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditSource } from "@orcy/shared/types";
import type { ActorType } from "../models/index.js";

export interface AuditProvenanceContext {
  source: AuditSource;
  requestId?: string;
  route?: string;
  method?: string;
  toolName?: string;
  mcpAction?: string;
  actorType?: ActorType;
  actorId?: string;
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

export function setAuditActor(actorType: ActorType, actorId: string): void {
  updateAuditProvenance({ actorType, actorId });
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
