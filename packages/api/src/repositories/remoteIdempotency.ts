import { getDb } from "../db/index.js";
import { remoteIdempotencyKeys } from "../db/schema/index.js";
import { eq, and, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";
import type { RemoteIdempotencyStatus } from "@orcy/shared/types";

export interface CreateIdempotencyKeyInput {
  habitatId: string;
  remoteParticipantId: string;
  remoteCredentialId?: string | null;
  action: string;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: string;
}

export interface RemoteIdempotencyKeyRow {
  id: string;
  habitatId: string;
  remoteParticipantId: string;
  remoteCredentialId: string | null;
  action: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
}

const fields = {
  id: remoteIdempotencyKeys.id,
  habitatId: remoteIdempotencyKeys.habitatId,
  remoteParticipantId: remoteIdempotencyKeys.remoteParticipantId,
  remoteCredentialId: remoteIdempotencyKeys.remoteCredentialId,
  action: remoteIdempotencyKeys.action,
  idempotencyKey: remoteIdempotencyKeys.idempotencyKey,
  requestHash: remoteIdempotencyKeys.requestHash,
  status: remoteIdempotencyKeys.status,
  responseStatus: remoteIdempotencyKeys.responseStatus,
  responseBody: remoteIdempotencyKeys.responseBody,
  errorMessage: remoteIdempotencyKeys.errorMessage,
  expiresAt: remoteIdempotencyKeys.expiresAt,
  createdAt: remoteIdempotencyKeys.createdAt,
  completedAt: remoteIdempotencyKeys.completedAt,
} as const;

export function getOrCreateIdempotencyKey(input: CreateIdempotencyKeyInput): {
  row: RemoteIdempotencyKeyRow;
  created: boolean;
} {
  const db = getDb();

  const existing = db
    .select(fields)
    .from(remoteIdempotencyKeys)
    .where(
      and(
        eq(remoteIdempotencyKeys.remoteParticipantId, input.remoteParticipantId),
        eq(remoteIdempotencyKeys.action, input.action),
        eq(remoteIdempotencyKeys.idempotencyKey, input.idempotencyKey),
      ),
    )
    .all();

  if (existing.length > 0) {
    return { row: existing[0], created: false };
  }

  const id = uuid();
  try {
    db.insert(remoteIdempotencyKeys)
      .values({
        id,
        habitatId: input.habitatId,
        remoteParticipantId: input.remoteParticipantId,
        remoteCredentialId: input.remoteCredentialId ?? null,
        action: input.action,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        status: "pending",
        expiresAt: input.expiresAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("remoteIdempotencyKey", err as Error, id);
  }

  const row = db
    .select(fields)
    .from(remoteIdempotencyKeys)
    .where(eq(remoteIdempotencyKeys.id, id))
    .all()[0];
  return { row, created: true };
}

export function getIdempotencyKey(
  remoteParticipantId: string,
  action: string,
  idempotencyKey: string,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(remoteIdempotencyKeys)
    .where(
      and(
        eq(remoteIdempotencyKeys.remoteParticipantId, remoteParticipantId),
        eq(remoteIdempotencyKeys.action, action),
        eq(remoteIdempotencyKeys.idempotencyKey, idempotencyKey),
      ),
    )
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function completeIdempotencyKey(
  id: string,
  responseStatus: number,
  responseBody?: Record<string, unknown>,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteIdempotencyKeys)
      .set({
        status: "completed",
        responseStatus,
        responseBody: responseBody ?? null,
        completedAt: now,
      })
      .where(eq(remoteIdempotencyKeys.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteIdempotencyKey", err as Error, id);
  }
  return (
    db
      .select(fields)
      .from(remoteIdempotencyKeys)
      .where(eq(remoteIdempotencyKeys.id, id))
      .all()[0] ?? null
  );
}

export function failIdempotencyKey(
  id: string,
  errorMessage: string,
  responseStatus?: number,
): RemoteIdempotencyKeyRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(remoteIdempotencyKeys)
      .set({
        status: "failed",
        errorMessage,
        responseStatus: responseStatus ?? null,
        completedAt: now,
      })
      .where(eq(remoteIdempotencyKeys.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("remoteIdempotencyKey", err as Error, id);
  }
  return (
    db
      .select(fields)
      .from(remoteIdempotencyKeys)
      .where(eq(remoteIdempotencyKeys.id, id))
      .all()[0] ?? null
  );
}

export function deleteExpiredIdempotencyKeys(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db
    .select({ id: remoteIdempotencyKeys.id })
    .from(remoteIdempotencyKeys)
    .where(lt(remoteIdempotencyKeys.expiresAt, now))
    .all();
  for (const row of expired) {
    db.delete(remoteIdempotencyKeys).where(eq(remoteIdempotencyKeys.id, row.id)).run();
  }
  return expired.length;
}
