import { getDb } from "../db/index.js";
import { externalIdentities } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export interface CreateExternalIdentityInput {
  providerId: string;
  habitatId: string;
  externalSubject: string;
  accountLogin?: string | null;
  accountName?: string | null;
  email?: string | null;
  profileData?: Record<string, unknown>;
  localUserId?: string | null;
  remoteParticipantId?: string | null;
}

export interface ExternalIdentityRow {
  id: string;
  providerId: string;
  habitatId: string;
  externalSubject: string;
  accountLogin: string | null;
  accountName: string | null;
  email: string | null;
  profileData: Record<string, unknown>;
  localUserId: string | null;
  remoteParticipantId: string | null;
  createdAt: string;
  updatedAt: string;
}

const fields = {
  id: externalIdentities.id,
  providerId: externalIdentities.providerId,
  habitatId: externalIdentities.habitatId,
  externalSubject: externalIdentities.externalSubject,
  accountLogin: externalIdentities.accountLogin,
  accountName: externalIdentities.accountName,
  email: externalIdentities.email,
  profileData: externalIdentities.profileData,
  localUserId: externalIdentities.localUserId,
  remoteParticipantId: externalIdentities.remoteParticipantId,
  createdAt: externalIdentities.createdAt,
  updatedAt: externalIdentities.updatedAt,
} as const;

export function createExternalIdentity(input: CreateExternalIdentityInput): ExternalIdentityRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(externalIdentities)
      .values({
        id,
        providerId: input.providerId,
        habitatId: input.habitatId,
        externalSubject: input.externalSubject,
        accountLogin: input.accountLogin ?? null,
        accountName: input.accountName ?? null,
        email: input.email ?? null,
        profileData: input.profileData ?? {},
        localUserId: input.localUserId ?? null,
        remoteParticipantId: input.remoteParticipantId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("externalIdentity", err as Error, id);
  }

  const row = getExternalIdentityById(id);
  if (!row) throw repositoryNotFoundError("externalIdentity", id);
  return row;
}

export function getExternalIdentityById(id: string): ExternalIdentityRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(externalIdentities)
    .where(eq(externalIdentities.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getExternalIdentityByProviderSubject(
  providerId: string,
  externalSubject: string,
): ExternalIdentityRow | null {
  const db = getDb();
  const rows = db
    .select(fields)
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.providerId, providerId),
        eq(externalIdentities.externalSubject, externalSubject),
      ),
    )
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getExternalIdentitiesByLocalUser(localUserId: string): ExternalIdentityRow[] {
  const db = getDb();
  return db
    .select(fields)
    .from(externalIdentities)
    .where(eq(externalIdentities.localUserId, localUserId))
    .all();
}

export function getExternalIdentitiesByHabitat(habitatId: string): ExternalIdentityRow[] {
  const db = getDb();
  return db
    .select(fields)
    .from(externalIdentities)
    .where(eq(externalIdentities.habitatId, habitatId))
    .all();
}

export function linkExternalIdentityToLocalUser(
  id: string,
  localUserId: string,
): ExternalIdentityRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(externalIdentities)
      .set({ localUserId, updatedAt: now })
      .where(eq(externalIdentities.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("externalIdentity", err as Error, id);
  }
  return getExternalIdentityById(id);
}

export function linkExternalIdentityToRemoteParticipant(
  id: string,
  remoteParticipantId: string,
): ExternalIdentityRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(externalIdentities)
      .set({ remoteParticipantId, updatedAt: now })
      .where(eq(externalIdentities.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("externalIdentity", err as Error, id);
  }
  return getExternalIdentityById(id);
}

export function deleteExternalIdentity(id: string): void {
  const db = getDb();
  db.delete(externalIdentities).where(eq(externalIdentities.id, id)).run();
}
