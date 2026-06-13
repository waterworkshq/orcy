import { getDb } from "../db/index.js";
import { remotePods } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { RemotePodStatus, ParticipantStanding } from "@orcy/shared/types";

export interface CreateRemotePodInput {
  habitatId: string;
  name: string;
  description?: string;
  trustMetadata?: Record<string, unknown>;
  defaultStanding?: ParticipantStanding;
  inviteId?: string | null;
  providerPodIdentity?: string | null;
  createdBy?: string | null;
}

export interface RemotePodRow {
  id: string;
  habitatId: string;
  name: string;
  description: string;
  trustMetadata: Record<string, unknown>;
  status: string;
  defaultStanding: string;
  inviteId: string | null;
  providerPodIdentity: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

const fields = {
  id: remotePods.id,
  habitatId: remotePods.habitatId,
  name: remotePods.name,
  description: remotePods.description,
  trustMetadata: remotePods.trustMetadata,
  status: remotePods.status,
  defaultStanding: remotePods.defaultStanding,
  inviteId: remotePods.inviteId,
  providerPodIdentity: remotePods.providerPodIdentity,
  createdBy: remotePods.createdBy,
  createdAt: remotePods.createdAt,
  updatedAt: remotePods.updatedAt,
  revokedAt: remotePods.revokedAt,
  revokedBy: remotePods.revokedBy,
  revokeReason: remotePods.revokeReason,
} as const;

export function createRemotePod(input: CreateRemotePodInput): RemotePodRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remotePods)
      .values({
        id,
        habitatId: input.habitatId,
        name: input.name,
        description: input.description ?? "",
        trustMetadata: input.trustMetadata ?? {},
        status: "pending",
        defaultStanding: input.defaultStanding ?? "remote_observer",
        inviteId: input.inviteId ?? null,
        providerPodIdentity: input.providerPodIdentity ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remotePod", err as Error, id);
  }

  const row = getRemotePodById(id);
  if (!row) throw repositoryNotFoundError("remotePod", id);
  return row;
}

export function getRemotePodById(id: string): RemotePodRow | null {
  const db = getDb();
  const rows = db.select(fields).from(remotePods).where(eq(remotePods.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemotePodsByHabitat(
  habitatId: string,
  status?: RemotePodStatus,
): RemotePodRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remotePods.habitatId, habitatId), eq(remotePods.status, status))
    : eq(remotePods.habitatId, habitatId);
  return db.select(fields).from(remotePods).where(condition).all();
}

export function activateRemotePod(id: string): RemotePodRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remotePods)
      .set({ status: "active", updatedAt: now })
      .where(eq(remotePods.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remotePod", err as Error, id);
  }
  return getRemotePodById(id);
}

export function suspendRemotePod(id: string): RemotePodRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remotePods)
      .set({ status: "suspended", updatedAt: now })
      .where(eq(remotePods.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remotePod", err as Error, id);
  }
  return getRemotePodById(id);
}

export function revokeRemotePod(
  id: string,
  revokedBy: string,
  revokeReason?: string,
): RemotePodRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remotePods)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy,
        revokeReason: revokeReason ?? null,
        updatedAt: now,
      })
      .where(eq(remotePods.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remotePod", err as Error, id);
  }
  return getRemotePodById(id);
}

export function updateRemotePod(
  id: string,
  patch: Partial<Pick<RemotePodRow, "name" | "description" | "trustMetadata" | "defaultStanding">>,
): RemotePodRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remotePods)
      .set({ ...patch, updatedAt: now })
      .where(eq(remotePods.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remotePod", err as Error, id);
  }
  return getRemotePodById(id);
}
