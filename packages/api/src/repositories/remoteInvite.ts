import { getDb } from "../db/index.js";
import { remoteInvites } from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { RemoteInviteType, RemoteInviteStatus, ParticipantStanding } from "@orcy/shared/types";

export interface CreateRemoteInviteInput {
  habitatId: string;
  inviteType: RemoteInviteType;
  baselineStanding: ParticipantStanding;
  baselineScopes?: string[];
  tokenHash?: string | null;
  providerId?: string | null;
  invitedBy: string;
  expiresAt?: string | null;
}

export interface RemoteInviteRow {
  id: string;
  habitatId: string;
  inviteType: string;
  baselineStanding: string;
  baselineScopes: string[];
  tokenHash: string | null;
  providerId: string | null;
  invitedBy: string;
  status: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const fields = {
  id: remoteInvites.id,
  habitatId: remoteInvites.habitatId,
  inviteType: remoteInvites.inviteType,
  baselineStanding: remoteInvites.baselineStanding,
  baselineScopes: remoteInvites.baselineScopes,
  tokenHash: remoteInvites.tokenHash,
  providerId: remoteInvites.providerId,
  invitedBy: remoteInvites.invitedBy,
  status: remoteInvites.status,
  expiresAt: remoteInvites.expiresAt,
  acceptedAt: remoteInvites.acceptedAt,
  acceptedBy: remoteInvites.acceptedBy,
  revokedAt: remoteInvites.revokedAt,
  revokedBy: remoteInvites.revokedBy,
  revokeReason: remoteInvites.revokeReason,
  createdAt: remoteInvites.createdAt,
  updatedAt: remoteInvites.updatedAt,
} as const;

export function createRemoteInvite(input: CreateRemoteInviteInput): RemoteInviteRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remoteInvites)
      .values({
        id,
        habitatId: input.habitatId,
        inviteType: input.inviteType,
        baselineStanding: input.baselineStanding,
        baselineScopes: input.baselineScopes ?? [],
        tokenHash: input.tokenHash ?? null,
        providerId: input.providerId ?? null,
        invitedBy: input.invitedBy,
        status: "pending",
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteInvite", err as Error, id);
  }

  const row = getRemoteInviteById(id);
  if (!row) throw repositoryNotFoundError("remoteInvite", id);
  return row;
}

export function getRemoteInviteById(id: string): RemoteInviteRow | null {
  const db = getDb();
  const rows = db.select(fields).from(remoteInvites).where(eq(remoteInvites.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemoteInviteByTokenHash(tokenHash: string): RemoteInviteRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteInvites)
    .where(eq(remoteInvites.tokenHash, tokenHash))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemoteInvitesByHabitat(
  habitatId: string,
  status?: RemoteInviteStatus,
): RemoteInviteRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remoteInvites.habitatId, habitatId), eq(remoteInvites.status, status))
    : eq(remoteInvites.habitatId, habitatId);
  return db.select(fields).from(remoteInvites).where(condition).all();
}

export function acceptRemoteInvite(id: string, acceptedBy: string): RemoteInviteRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    // Conditional update: only accept if currently pending — prevents race condition
    const result = db
      .update(remoteInvites)
      .set({ status: "accepted", acceptedAt: now, acceptedBy, updatedAt: now })
      .where(and(eq(remoteInvites.id, id), eq(remoteInvites.status, "pending")))
      .run();
    if (result.changes === 0) return null;
  } catch (err) {
    throw repositoryUpdateError("remoteInvite", err as Error, id);
  }
  return getRemoteInviteById(id);
}

export function revokeRemoteInvite(
  id: string,
  revokedBy: string,
  revokeReason?: string,
): RemoteInviteRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteInvites)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy,
        revokeReason: revokeReason ?? null,
        updatedAt: now,
      })
      .where(eq(remoteInvites.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteInvite", err as Error, id);
  }
  return getRemoteInviteById(id);
}

export function expirePendingInvites(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expiredRows = db
    .select({ id: remoteInvites.id })
    .from(remoteInvites)
    .where(and(eq(remoteInvites.status, "pending"), lt(remoteInvites.expiresAt, now)))
    .all();

  for (const row of expiredRows) {
    db.update(remoteInvites)
      .set({ status: "expired", updatedAt: now })
      .where(eq(remoteInvites.id, row.id))
      .run();
  }

  return expiredRows.length;
}
