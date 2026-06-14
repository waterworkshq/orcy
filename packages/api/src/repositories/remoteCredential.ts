import { getDb } from "../db/index.js";
import { remoteCredentials } from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type { RemoteCredentialType, RemoteCredentialStatus } from "@orcy/shared/types";

export interface CreateRemoteCredentialInput {
  remoteParticipantId: string;
  habitatId: string;
  credentialType: RemoteCredentialType;
  secretHash: string;
  label?: string;
  expiresAt?: string | null;
  createdBy?: string | null;
}

export interface RemoteCredentialRow {
  id: string;
  remoteParticipantId: string;
  habitatId: string;
  credentialType: string;
  secretHash: string;
  label: string;
  status: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rotatedFromId: string | null;
  rotatedAt: string | null;
  rotatedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const fields = {
  id: remoteCredentials.id,
  remoteParticipantId: remoteCredentials.remoteParticipantId,
  habitatId: remoteCredentials.habitatId,
  credentialType: remoteCredentials.credentialType,
  secretHash: remoteCredentials.secretHash,
  label: remoteCredentials.label,
  status: remoteCredentials.status,
  lastUsedAt: remoteCredentials.lastUsedAt,
  expiresAt: remoteCredentials.expiresAt,
  rotatedFromId: remoteCredentials.rotatedFromId,
  rotatedAt: remoteCredentials.rotatedAt,
  rotatedBy: remoteCredentials.rotatedBy,
  revokedAt: remoteCredentials.revokedAt,
  revokedBy: remoteCredentials.revokedBy,
  revokeReason: remoteCredentials.revokeReason,
  createdBy: remoteCredentials.createdBy,
  createdAt: remoteCredentials.createdAt,
  updatedAt: remoteCredentials.updatedAt,
} as const;

export function createRemoteCredential(input: CreateRemoteCredentialInput): RemoteCredentialRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(remoteCredentials)
      .values({
        id,
        remoteParticipantId: input.remoteParticipantId,
        habitatId: input.habitatId,
        credentialType: input.credentialType,
        secretHash: input.secretHash,
        label: input.label ?? "",
        status: "active",
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteCredential", err as Error, id);
  }

  const row = getRemoteCredentialById(id);
  if (!row) throw repositoryNotFoundError("remoteCredential", id);
  return row;
}

export function getRemoteCredentialById(id: string): RemoteCredentialRow | null {
  const db = getDb();
  const rows = db.select(fields).from(remoteCredentials).where(eq(remoteCredentials.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getRemoteCredentialByHash(secretHash: string): RemoteCredentialRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteCredentials)
    .where(eq(remoteCredentials.secretHash, secretHash))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getActiveCredentialsByParticipant(
  remoteParticipantId: string,
): RemoteCredentialRow[] {
  const db = getDb();
  return db
    .select(fields)
    .from(remoteCredentials)
    .where(
      and(
        eq(remoteCredentials.remoteParticipantId, remoteParticipantId),
        eq(remoteCredentials.status, "active"),
      ),
    )
    .all();
}

export function getCredentialsByHabitat(
  habitatId: string,
  status?: RemoteCredentialStatus,
): RemoteCredentialRow[] {
  const db = getDb();
  const condition = status
    ? and(eq(remoteCredentials.habitatId, habitatId), eq(remoteCredentials.status, status))
    : eq(remoteCredentials.habitatId, habitatId);
  return db.select(fields).from(remoteCredentials).where(condition).all();
}

export function touchCredentialLastUsed(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.update(remoteCredentials)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(remoteCredentials.id, id))
    .run();
}

export function rotateRemoteCredential(
  id: string,
  newSecretHash: string,
  rotatedBy?: string | null,
): { oldCredential: RemoteCredentialRow | null; newCredential: RemoteCredentialRow | null } {
  const db = getDb();
  const now = new Date().toISOString();

  const old = getRemoteCredentialById(id);
  if (!old) throw repositoryNotFoundError("remoteCredential", id);

  const newId = uuid();
  try {
    db.transaction((tx) => {
      tx.insert(remoteCredentials)
        .values({
          id: newId,
          remoteParticipantId: old.remoteParticipantId,
          habitatId: old.habitatId,
          credentialType: old.credentialType,
          secretHash: newSecretHash,
          label: old.label,
          status: "active",
          expiresAt: old.expiresAt,
          rotatedFromId: id,
          rotatedAt: now,
          rotatedBy: rotatedBy ?? null,
          createdBy: old.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      tx.update(remoteCredentials)
        .set({ status: "rotated", updatedAt: now })
        .where(eq(remoteCredentials.id, id))
        .run();
    });
  } catch (err) {
    throw repositoryCreateError("remoteCredential", err as Error, newId);
  }

  return {
    oldCredential: getRemoteCredentialById(id),
    newCredential: getRemoteCredentialById(newId),
  };
}

export function revokeRemoteCredential(
  id: string,
  revokedBy?: string | null,
  revokeReason?: string | null,
): RemoteCredentialRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteCredentials)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy: revokedBy ?? null,
        revokeReason: revokeReason ?? null,
        updatedAt: now,
      })
      .where(eq(remoteCredentials.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteCredential", err as Error, id);
  }
  return getRemoteCredentialById(id);
}

export function expireCredentials(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expiredRows = db
    .select({ id: remoteCredentials.id })
    .from(remoteCredentials)
    .where(and(eq(remoteCredentials.status, "active"), lt(remoteCredentials.expiresAt, now)))
    .all();

  for (const row of expiredRows) {
    db.update(remoteCredentials)
      .set({ status: "expired", updatedAt: now })
      .where(eq(remoteCredentials.id, row.id))
      .run();
  }

  return expiredRows.length;
}
