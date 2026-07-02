import { getDb } from "../db/index.js";
import { releases } from "../db/schema/index.js";
import { eq, and, desc } from "drizzle-orm";
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

/** Most recent prior release for the habitat (semver-diff classification baseline). */
export function findMostRecentPrior(habitatId: string): Release | null {
  const db = getDb();
  const row = db
    .select()
    .from(releases)
    .where(eq(releases.habitatId, habitatId))
    .orderBy(desc(releases.detectedAt))
    .limit(1)
    .get();
  return row ? rowToRelease(row) : null;
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
