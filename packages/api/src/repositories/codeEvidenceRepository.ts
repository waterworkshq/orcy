import { getDb } from "../db/index.js";
import { habitatCodeRepositories } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceVerificationState } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryUpsertError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export function getByHabitatId(habitatId: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(habitatCodeRepositories)
    .where(eq(habitatCodeRepositories.habitatId, habitatId))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getById(id: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(habitatCodeRepositories)
    .where(eq(habitatCodeRepositories.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function create(input: {
  habitatId: string;
  provider: string;
  providerBaseUrl?: string;
  externalId?: string;
  repoSlug?: string;
  displayName?: string;
  localPath?: string;
  verificationState?: CodeEvidenceVerificationState;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(habitatCodeRepositories)
      .values({
        id,
        habitatId: input.habitatId,
        provider: input.provider,
        providerBaseUrl: input.providerBaseUrl ?? null,
        externalId: input.externalId ?? null,
        repoSlug: input.repoSlug ?? null,
        displayName: input.displayName ?? null,
        localPath: input.localPath ?? null,
        verificationState: input.verificationState ?? "unverified",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("codeRepository", err as Error, id);
  }

  return getById(id);
}

export function upsertByHabitatId(input: {
  habitatId: string;
  provider: string;
  providerBaseUrl?: string;
  externalId?: string;
  repoSlug?: string;
  displayName?: string;
  localPath?: string;
  verificationState?: CodeEvidenceVerificationState;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(habitatCodeRepositories)
      .values({
        id,
        habitatId: input.habitatId,
        provider: input.provider,
        providerBaseUrl: input.providerBaseUrl ?? null,
        externalId: input.externalId ?? null,
        repoSlug: input.repoSlug ?? null,
        displayName: input.displayName ?? null,
        localPath: input.localPath ?? null,
        verificationState: input.verificationState ?? "unverified",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: habitatCodeRepositories.habitatId,
        set: {
          provider: input.provider,
          providerBaseUrl: input.providerBaseUrl ?? null,
          externalId: input.externalId ?? null,
          repoSlug: input.repoSlug ?? null,
          displayName: input.displayName ?? null,
          localPath: input.localPath ?? null,
          verificationState: input.verificationState ?? "unverified",
          updatedAt: now,
        },
      })
      .run();
  } catch (err) {
    throw repositoryUpsertError("codeRepository", err as Error, input.habitatId);
  }

  return getByHabitatId(input.habitatId);
}

export function updateByHabitatId(
  habitatId: string,
  updates: {
    provider?: string;
    providerBaseUrl?: string;
    externalId?: string;
    repoSlug?: string;
    displayName?: string;
    localPath?: string;
    verificationState?: CodeEvidenceVerificationState;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof habitatCodeRepositories.$inferInsert> = { updatedAt: now };

  if (updates.provider !== undefined) setValues.provider = updates.provider;
  if (updates.providerBaseUrl !== undefined) setValues.providerBaseUrl = updates.providerBaseUrl;
  if (updates.externalId !== undefined) setValues.externalId = updates.externalId;
  if (updates.repoSlug !== undefined) setValues.repoSlug = updates.repoSlug;
  if (updates.displayName !== undefined) setValues.displayName = updates.displayName;
  if (updates.localPath !== undefined) setValues.localPath = updates.localPath;
  if (updates.verificationState !== undefined)
    setValues.verificationState = updates.verificationState;

  try {
    db.update(habitatCodeRepositories)
      .set(setValues)
      .where(eq(habitatCodeRepositories.habitatId, habitatId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("codeRepository", err as Error, habitatId);
  }

  return getByHabitatId(habitatId);
}

export function deleteById(id: string): boolean {
  const db = getDb();
  const existing = getById(id);
  if (!existing) return false;
  try {
    db.delete(habitatCodeRepositories).where(eq(habitatCodeRepositories.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("codeRepository", err as Error, id);
  }
  return true;
}
