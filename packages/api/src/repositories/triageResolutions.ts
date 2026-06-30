import { getDb } from "../db/index.js";
import { triageResolutions } from "../db/schema/index.js";
import { eq, and, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { ResolutionKind } from "@orcy/shared";
import { repositoryCreateError, repositoryNotFoundError } from "../errors/repository.js";

/** Actor type union reused across all attribution columns. */
export type TriageActorType =
  | "human"
  | "agent"
  | "system"
  | "remote_human"
  | "remote_orcy"
  | "remote_pod";

/** Source of a triage resolution record. */
export type TriageResolutionSource = "cluster_triage" | "finding_triage";

/** Projected triage resolution record. */
export interface TriageResolution {
  id: string;
  habitatId: string;
  clusterKey: string;
  skillCategory: string;
  source: TriageResolutionSource;
  sourceId: string;
  rootCause: string | null;
  resolution: string | null;
  resolutionKind: ResolutionKind | null;
  resolvedByType: TriageActorType | null;
  resolvedById: string | null;
  resolvedAt: string;
  metadata: Record<string, unknown>;
}

/** Input accepted by {@link create}. */
export interface CreateTriageResolutionInput {
  habitatId: string;
  clusterKey: string;
  skillCategory: string;
  source: TriageResolutionSource;
  sourceId: string;
  rootCause?: string;
  resolution?: string;
  resolutionKind?: ResolutionKind;
  resolvedByType?: TriageActorType;
  resolvedById?: string;
  metadata?: Record<string, unknown>;
}

function rowToTriageResolution(row: Record<string, unknown>): TriageResolution {
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    clusterKey: row.clusterKey as string,
    skillCategory: row.skillCategory as string,
    source: row.source as TriageResolutionSource,
    sourceId: row.sourceId as string,
    rootCause: (row.rootCause as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    resolutionKind: (row.resolutionKind as ResolutionKind | null) ?? null,
    resolvedByType: (row.resolvedByType as TriageActorType | null) ?? null,
    resolvedById: (row.resolvedById as string | null) ?? null,
    resolvedAt: row.resolvedAt as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
  };
}

export function getById(id: string): TriageResolution | null {
  const db = getDb();
  const row = db.select().from(triageResolutions).where(eq(triageResolutions.id, id)).get();
  return row ? rowToTriageResolution(row) : null;
}

/**
 * Insert a resolution record. Used by triage services when a cluster or finding
 * triage is resolved; the `clusterKey` enables proactive matching for future
 * recurrences (PRD AC-PROACTIVE).
 */
export function create(input: CreateTriageResolutionInput): TriageResolution {
  const db = getDb();
  const id = uuid();
  try {
    db.insert(triageResolutions)
      .values({
        id,
        habitatId: input.habitatId,
        clusterKey: input.clusterKey,
        skillCategory: input.skillCategory,
        source: input.source,
        sourceId: input.sourceId,
        rootCause: input.rootCause ?? null,
        resolution: input.resolution ?? null,
        resolutionKind: input.resolutionKind ?? null,
        resolvedByType: input.resolvedByType ?? null,
        resolvedById: input.resolvedById ?? null,
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("triageResolution", err as Error, id);
  }

  const created = getById(id);
  if (!created) throw repositoryNotFoundError("triageResolution", id);
  return created;
}

/**
 * Proactive-match lookup (PRD AC-PROACTIVE). Returns all historical resolutions
 * for `(habitatId, clusterKey)` ordered newest-first. Multiple resolutions are
 * possible over time (a cluster may re-emerge after an earlier fix).
 */
export function findByClusterKey(habitatId: string, clusterKey: string): TriageResolution[] {
  const db = getDb();
  return db
    .select()
    .from(triageResolutions)
    .where(
      and(eq(triageResolutions.habitatId, habitatId), eq(triageResolutions.clusterKey, clusterKey)),
    )
    .orderBy(desc(triageResolutions.resolvedAt))
    .all()
    .map(rowToTriageResolution);
}
