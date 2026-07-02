import { getDb } from "../db/index.js";
import { triageClusterMissions } from "../db/schema/index.js";
import { eq, and, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";

/** Status of a cluster-mission junction record. */
export type TriageClusterMissionStatus = "open" | "resolved";

/** Projected triage cluster mission record. */
export interface TriageClusterMission {
  id: string;
  habitatId: string;
  clusterKey: string;
  missionId: string;
  status: TriageClusterMissionStatus;
  createdAt: string;
  resolvedAt: string | null;
}

function rowToTriageClusterMission(row: Record<string, unknown>): TriageClusterMission {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    clusterKey: row.clusterKey as string,
    missionId: row.missionId as string,
    status: row.status as TriageClusterMissionStatus,
    createdAt: row.createdAt as string,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
  };
}

/**
 * Insert a cluster-mission junction with status `'open'`. Called by
 * `triageService.createTriageMission` to register active triage on a cluster.
 * If a duplicate open junction already exists (partial unique index), re-reads
 * the existing record instead of throwing — idempotent on race.
 */
export function create(
  habitatId: string,
  clusterKey: string,
  missionId: string,
): TriageClusterMission {
  const db = getDb();
  const id = uuid();
  try {
    db.insert(triageClusterMissions)
      .values({
        id,
        habitatId,
        clusterKey,
        missionId,
        status: "open",
      })
      .run();
  } catch (err: any) {
    // Partial unique index (migration 0046) prevents duplicate open junctions.
    // If the insert hits the constraint, re-read the existing record (idempotent).
    const cause = err?.cause ?? err;
    if (
      /UNIQUE constraint failed/i.test(cause?.message ?? "") ||
      cause?.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      const existing = db
        .select()
        .from(triageClusterMissions)
        .where(
          and(
            eq(triageClusterMissions.habitatId, habitatId),
            eq(triageClusterMissions.clusterKey, clusterKey),
            eq(triageClusterMissions.status, "open"),
          ),
        )
        .get();
      if (existing) return rowToTriageClusterMission(existing);
    }
    throw repositoryCreateError("triageClusterMission", err as Error, id);
  }

  const row = db.select().from(triageClusterMissions).where(eq(triageClusterMissions.id, id)).get();
  if (!row) throw repositoryCreateError("triageClusterMission", undefined, id);
  return rowToTriageClusterMission(row);
}

/**
 * Active-triage suppression lookup (AC-REACTIVE-8). Returns the open junction
 * record for `(habitatId, clusterKey)` or null. Any open record suppresses a
 * new triage mission for the same cluster.
 */
export function findActiveByClusterKey(
  habitatId: string,
  clusterKey: string,
): TriageClusterMission | null {
  const db = getDb();
  const row = db
    .select()
    .from(triageClusterMissions)
    .where(
      and(
        eq(triageClusterMissions.habitatId, habitatId),
        eq(triageClusterMissions.clusterKey, clusterKey),
        eq(triageClusterMissions.status, "open"),
      ),
    )
    .get();
  return row ? rowToTriageClusterMission(row) : null;
}

/**
 * Batch active-triage lookup for multiple cluster keys in a single query.
 * Returns a Set of cluster keys that have at least one open junction record.
 * Used by `GET /triage/clusters/top` to avoid N+1 per-cluster queries.
 */
export function findActiveClusterKeys(habitatId: string, clusterKeys: string[]): Set<string> {
  if (clusterKeys.length === 0) return new Set();
  const db = getDb();
  const rows = db
    .select({ clusterKey: triageClusterMissions.clusterKey })
    .from(triageClusterMissions)
    .where(
      and(
        eq(triageClusterMissions.habitatId, habitatId),
        inArray(triageClusterMissions.clusterKey, clusterKeys),
        eq(triageClusterMissions.status, "open"),
      ),
    )
    .all();
  return new Set(rows.map((r) => r.clusterKey as string));
}

/**
 * Resolve an open junction by missionId. Called by
 * `triageService.recordResolution` to mark the cluster triage complete.
 * No-op if no open record exists for the mission.
 */
export function resolveByMissionId(missionId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(triageClusterMissions)
      .set({ status: "resolved", resolvedAt: now })
      .where(
        and(
          eq(triageClusterMissions.missionId, missionId),
          eq(triageClusterMissions.status, "open"),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("triageClusterMission", err as Error, missionId);
  }
}
