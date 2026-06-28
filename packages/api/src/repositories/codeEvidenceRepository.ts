import { getDb } from "../db/index.js";
import { habitatCodeRepositories, codeEvidenceLinks, tasks, missions } from "../db/schema/index.js";
import { eq, and, gt, gte, lte, desc, sql } from "drizzle-orm";
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

/**
 * Returns active `code_evidence_links` rows in a habitat with `linked_at > since`, scoped via
 * `code_evidence_links.target_id → tasks.id` (for `target_type='task'`) or
 * `code_evidence_links.target_id → missions.id` (for `target_type='mission'`) and
 * `missions.habitat_id = habitatId`. Backs the `wikiAugmentationService` delta + chunk modes.
 * `limit` defaults to 100; ordered newest-first by `linked_at`. No side effects.
 *
 * The result rows are the raw code-evidence link records (title/description/url/etc.), not the
 * habitat code-repository metadata. The shape is intentionally permissive — augmentation panels
 * group these under `evidence[]` regardless of the underlying target type.
 */
export function listByHabitatSince(
  habitatId: string,
  since: string,
  limit = 100,
): Array<Record<string, unknown>> {
  const db = getDb();

  const taskRows = db
    .select({ row: codeEvidenceLinks })
    .from(codeEvidenceLinks)
    .innerJoin(tasks, eq(tasks.id, codeEvidenceLinks.targetId))
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(
      and(
        eq(codeEvidenceLinks.targetType, "task"),
        eq(missions.habitatId, habitatId),
        gt(codeEvidenceLinks.linkedAt, since),
      ),
    )
    .orderBy(desc(codeEvidenceLinks.linkedAt))
    .limit(limit)
    .all();

  const missionRows = db
    .select({ row: codeEvidenceLinks })
    .from(codeEvidenceLinks)
    .innerJoin(missions, eq(missions.id, codeEvidenceLinks.targetId))
    .where(
      and(
        eq(codeEvidenceLinks.targetType, "mission"),
        eq(missions.habitatId, habitatId),
        gt(codeEvidenceLinks.linkedAt, since),
      ),
    )
    .orderBy(desc(codeEvidenceLinks.linkedAt))
    .limit(limit)
    .all();

  const combined: Array<Record<string, unknown>> = [
    ...taskRows.map((r) => r.row as unknown as Record<string, unknown>),
    ...missionRows.map((r) => r.row as unknown as Record<string, unknown>),
  ];
  combined.sort((a, b) => {
    const aTs = String(a.linkedAt ?? "");
    const bTs = String(b.linkedAt ?? "");
    return aTs < bTs ? 1 : aTs > bTs ? -1 : 0;
  });
  return combined.slice(0, limit);
}

/**
 * Returns code-evidence links in a habitat with `linked_at` in the inclusive window `[from, to]`,
 * scoped via `code_evidence_links → tasks/missions → missions.habitat_id`. Backs the
 * `wikiAugmentationService` chunk mode (SQL-bounded window instead of newest-`limit*4`-since-1970
 * filtered in memory). Result rows are the raw link records (title/description/url/etc.). `limit`
 * is a soft cap on the combined result (per-source caps are `limit` each; combined then trimmed).
 * No side effects.
 */
export function listByHabitatBetween(
  habitatId: string,
  from: string,
  to: string,
  limit = 100,
): Array<Record<string, unknown>> {
  const db = getDb();

  const taskRows = db
    .select({ row: codeEvidenceLinks })
    .from(codeEvidenceLinks)
    .innerJoin(tasks, eq(tasks.id, codeEvidenceLinks.targetId))
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(
      and(
        eq(codeEvidenceLinks.targetType, "task"),
        eq(missions.habitatId, habitatId),
        gte(codeEvidenceLinks.linkedAt, from),
        lte(codeEvidenceLinks.linkedAt, to),
      ),
    )
    .orderBy(desc(codeEvidenceLinks.linkedAt))
    .limit(limit)
    .all();

  const missionRows = db
    .select({ row: codeEvidenceLinks })
    .from(codeEvidenceLinks)
    .innerJoin(missions, eq(missions.id, codeEvidenceLinks.targetId))
    .where(
      and(
        eq(codeEvidenceLinks.targetType, "mission"),
        eq(missions.habitatId, habitatId),
        gte(codeEvidenceLinks.linkedAt, from),
        lte(codeEvidenceLinks.linkedAt, to),
      ),
    )
    .orderBy(desc(codeEvidenceLinks.linkedAt))
    .limit(limit)
    .all();

  const combined: Array<Record<string, unknown>> = [
    ...taskRows.map((r) => r.row as unknown as Record<string, unknown>),
    ...missionRows.map((r) => r.row as unknown as Record<string, unknown>),
  ];
  combined.sort((a, b) => {
    const aTs = String(a.linkedAt ?? "");
    const bTs = String(b.linkedAt ?? "");
    return aTs < bTs ? 1 : aTs > bTs ? -1 : 0;
  });
  return combined.slice(0, limit);
}
