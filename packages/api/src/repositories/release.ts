import { getDb } from "../db/index.js";
import { releases } from "../db/schema/index.js";
import { eq, and, ne, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { ReleaseType, DetectorSource } from "@orcy/shared";
import { repositoryCreateError, repositoryNotFoundError } from "../errors/repository.js";

/** Projected release record (metadata parsed to a plain object). */
export interface Release {
  id: string;
  habitatId: string;
  version: string;
  releaseType: ReleaseType;
  detectedBy: DetectorSource;
  releaseNotes: string | null;
  detectedAt: string;
  metadata: Record<string, unknown>;
}

/** Payload accepted by {@link create}. */
export interface CreateReleaseInput {
  habitatId: string;
  version: string;
  releaseType: ReleaseType;
  detectedBy: DetectorSource;
  releaseNotes?: string;
  metadata?: Record<string, unknown>;
}

function rowToRelease(row: Record<string, unknown>): Release {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    version: row.version as string,
    releaseType: row.releaseType as ReleaseType,
    detectedBy: row.detectedBy as DetectorSource,
    releaseNotes: (row.releaseNotes as string | null) ?? null,
    detectedAt: row.detectedAt as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export function getById(id: string): Release | null {
  const db = getDb();
  const row = db.select().from(releases).where(eq(releases.id, id)).get();
  return row ? rowToRelease(row) : null;
}

/** Idempotency lookup — the `(habitatId, version)` unique index guarantees at most one row. */
export function findByHabitatAndVersion(habitatId: string, version: string): Release | null {
  const db = getDb();
  const row = db
    .select()
    .from(releases)
    .where(and(eq(releases.habitatId, habitatId), eq(releases.version, version)))
    .get();
  return row ? rowToRelease(row) : null;
}

/**
 * Most recent prior release for the habitat (semver-diff classification
 * baseline). Excludes `excludeVersion` so the incoming release is never
 * diffed against itself; ties on `detectedAt` (same-second releases) break
 * deterministically on `id`.
 */
export function findMostRecentPrior(habitatId: string, excludeVersion?: string): Release | null {
  const db = getDb();
  const row = db
    .select()
    .from(releases)
    .where(
      excludeVersion
        ? and(eq(releases.habitatId, habitatId), ne(releases.version, excludeVersion))
        : eq(releases.habitatId, habitatId),
    )
    .orderBy(desc(releases.detectedAt), desc(releases.id))
    .limit(1)
    .get();
  return row ? rowToRelease(row) : null;
}

/**
 * Recent releases for a habitat, newest first. Feeds the roadmap-context
 * endpoint's `recentReleases` surface so the triage agent can see what has
 * shipped and infer which gated missions may now be actionable.
 */
export function findRecentByHabitat(habitatId: string, limit = 10): Release[] {
  const db = getDb();
  const rows = db
    .select()
    .from(releases)
    .where(eq(releases.habitatId, habitatId))
    .orderBy(desc(releases.detectedAt), desc(releases.id))
    .limit(limit)
    .all();
  return rows.map(rowToRelease);
}

export function create(input: CreateReleaseInput): Release {
  const db = getDb();
  const id = uuid();
  try {
    db.insert(releases)
      .values({
        id,
        habitatId: input.habitatId,
        version: input.version,
        releaseType: input.releaseType,
        detectedBy: input.detectedBy,
        releaseNotes: input.releaseNotes ?? null,
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("releases", err as Error, id);
  }
  const created = getById(id);
  if (!created) throw repositoryNotFoundError("releases", id);
  return created;
}
