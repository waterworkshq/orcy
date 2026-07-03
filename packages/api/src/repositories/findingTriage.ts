import { getDb } from "../db/index.js";
import { findingTriage } from "../db/schema/index.js";
import { eq, and, desc, notInArray, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { FindingTriageStatus, SuggestedBucket, TriageActorType } from "@orcy/shared";
import { FINDING_TRIAGE_TRANSITIONS } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import { conflict } from "../errors.js";
import { normalize } from "../services/habitatSkillService.js";

/** Projected finding triage record (corroboratingPulseIds parsed to string[]). */
export interface FindingTriage {
  id: string;
  habitatId: string;
  pulseId: string;
  clusterKey: string;
  findingKind: string;
  status: FindingTriageStatus;
  bucket: SuggestedBucket | null;
  targetRelease: string | null;
  targetReleaseType: string | null;
  triageMissionId: string | null;
  corroboratingPulseIds: string[];
  triagedByType: TriageActorType | null;
  triagedById: string | null;
  triagedAt: string | null;
  resolvedByType: TriageActorType | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Pulse payload accepted by {@link createForPulse}. */
export interface FindingTriagePulseInput {
  id: string;
  habitatId: string;
  subject: string;
  metadata: { findingKind?: string } & Record<string, unknown>;
}

/** Optional filters for {@link findByHabitat}. */
export interface FindingTriageFilters {
  status?: FindingTriageStatus;
  bucket?: SuggestedBucket;
}

const DEFAULT_LIST_LIMIT = 100;

function rowToFindingTriage(row: Record<string, unknown>): FindingTriage {
  const rawCorroborating = row.corroboratingPulseIds as string | null;
  let corroboratingPulseIds: string[] = [];
  if (rawCorroborating) {
    try {
      const parsed = JSON.parse(rawCorroborating);
      corroboratingPulseIds = Array.isArray(parsed) ? parsed : [];
    } catch {
      corroboratingPulseIds = [];
    }
  }
  return {
    id: row.id as string,
    habitatId: row.habitatId as string,
    pulseId: row.pulseId as string,
    clusterKey: row.clusterKey as string,
    findingKind: row.findingKind as string,
    status: row.status as FindingTriageStatus,
    bucket: (row.bucket as SuggestedBucket | null) ?? null,
    targetRelease: (row.targetRelease as string | null) ?? null,
    targetReleaseType: (row.targetReleaseType as string | null) ?? null,
    triageMissionId: (row.triageMissionId as string | null) ?? null,
    corroboratingPulseIds,
    triagedByType: (row.triagedByType as TriageActorType | null) ?? null,
    triagedById: (row.triagedById as string | null) ?? null,
    triagedAt: (row.triagedAt as string | null) ?? null,
    resolvedByType: (row.resolvedByType as TriageActorType | null) ?? null,
    resolvedById: (row.resolvedById as string | null) ?? null,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
    resolutionNote: (row.resolutionNote as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

export function getById(id: string): FindingTriage | null {
  const db = getDb();
  const row = db.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  return row ? rowToFindingTriage(row) : null;
}

/**
 * Dedup-aware creation (ADR-0027). Computes `clusterKey = normalize(pulse.subject)`,
 * queries for a non-terminal match on `(habitatId, clusterKey, findingKind)`, and
 * either corroborates the existing record (appends pulseId) or inserts a new one.
 * Terminal-state matches seed `metadata.recurrenceOf` on the new record.
 */
export function createForPulse(pulse: FindingTriagePulseInput): FindingTriage {
  const db = getDb();
  const clusterKey = normalize(pulse.subject);
  const findingKind = pulse.metadata.findingKind;
  if (!findingKind) {
    throw repositoryCreateError(
      "findingTriage",
      new Error("pulse.metadata.findingKind is required for finding triage creation"),
      pulse.id,
    );
  }

  const existing = db
    .select()
    .from(findingTriage)
    .where(
      and(
        eq(findingTriage.habitatId, pulse.habitatId),
        eq(findingTriage.clusterKey, clusterKey),
        eq(findingTriage.findingKind, findingKind),
        notInArray(findingTriage.status, ["resolved", "wontfix"]),
      ),
    )
    .all();

  if (existing.length > 0) {
    const match = existing[0];
    const now = new Date().toISOString();
    try {
      // Atomic append via SQL: only inserts if pulse ID not already in the array.
      // Uses json_each for existence check + json_insert for append (CS-21 pattern).
      db.update(findingTriage)
        .set({
          corroboratingPulseIds: sql`
            (SELECT CASE WHEN EXISTS(
              SELECT 1 FROM json_each(COALESCE(${findingTriage.corroboratingPulseIds}, '[]'))
              WHERE value = ${pulse.id}
            ) THEN ${findingTriage.corroboratingPulseIds}
            ELSE json_insert(COALESCE(${findingTriage.corroboratingPulseIds}, '[]'), '$[#]', ${pulse.id})
            END)
          `,
          updatedAt: now,
        })
        .where(eq(findingTriage.id, match.id as string))
        .run();
    } catch (err) {
      throw repositoryUpdateError("findingTriage", err as Error, match.id as string);
    }
    const refreshed = getById(match.id as string);
    if (!refreshed) throw repositoryNotFoundError("findingTriage", match.id as string);
    return refreshed;
  }

  // No non-terminal match. Check for a terminal match to record recurrence.
  const terminalMatch = db
    .select({ id: findingTriage.id })
    .from(findingTriage)
    .where(
      and(
        eq(findingTriage.habitatId, pulse.habitatId),
        eq(findingTriage.clusterKey, clusterKey),
        eq(findingTriage.findingKind, findingKind),
      ),
    )
    .orderBy(desc(findingTriage.createdAt))
    .all();

  const id = uuid();
  const now = new Date().toISOString();
  const metadata: Record<string, unknown> = { ...pulse.metadata };
  if (terminalMatch.length > 0) {
    metadata.recurrenceOf = terminalMatch[0].id;
  }

  try {
    db.insert(findingTriage)
      .values({
        id,
        habitatId: pulse.habitatId,
        pulseId: pulse.id,
        clusterKey,
        findingKind,
        status: "open",
        bucket: null,
        targetRelease: null,
        targetReleaseType: null,
        triageMissionId: null,
        corroboratingPulseIds: JSON.stringify([pulse.id]),
        triagedByType: null,
        triagedById: null,
        triagedAt: null,
        resolvedByType: null,
        resolvedById: null,
        resolvedAt: null,
        resolutionNote: null,
        metadata,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("findingTriage", err as Error, id);
  }

  const created = getById(id);
  if (!created) throw repositoryNotFoundError("findingTriage", id);
  return created;
}

export function findByHabitat(habitatId: string, filters?: FindingTriageFilters): FindingTriage[] {
  const db = getDb();
  const conditions = [eq(findingTriage.habitatId, habitatId)];
  if (filters?.status) conditions.push(eq(findingTriage.status, filters.status));
  if (filters?.bucket) conditions.push(eq(findingTriage.bucket, filters.bucket));
  return db
    .select()
    .from(findingTriage)
    .where(and(...conditions))
    .orderBy(desc(findingTriage.createdAt))
    .limit(DEFAULT_LIST_LIMIT)
    .all()
    .map(rowToFindingTriage);
}

/**
 * Returns all findings for a habitat matching ANY of the given statuses, with no
 * truncation limit. Used by `/triage/clusters/top` aggregation which needs ALL
 * open/triaged findings — not just the 100 most recent.
 */
export function findByHabitatInStatus(
  habitatId: string,
  statuses: FindingTriageStatus[],
): FindingTriage[] {
  if (statuses.length === 0) return [];
  const db = getDb();
  return db
    .select()
    .from(findingTriage)
    .where(and(eq(findingTriage.habitatId, habitatId), inArray(findingTriage.status, statuses)))
    .orderBy(desc(findingTriage.createdAt))
    .all()
    .map(rowToFindingTriage);
}

/**
 * All findings linked to a triage mission via `triageMissionId`. The schema
 * permits N:1 (no UNIQUE constraint), so every linked `triaged` finding is
 * promoted on gate resolution — returning all rows here is the N:1 safety fix
 * (RM-8). Callers that need a single finding should filter the result.
 */
export function findByTriageMissionId(missionId: string): FindingTriage[] {
  const db = getDb();
  return db
    .select()
    .from(findingTriage)
    .where(eq(findingTriage.triageMissionId, missionId))
    .all()
    .map(rowToFindingTriage);
}

export function findByBucket(habitatId: string, bucket: SuggestedBucket): FindingTriage[] {
  const db = getDb();
  return db
    .select()
    .from(findingTriage)
    .where(and(eq(findingTriage.habitatId, habitatId), eq(findingTriage.bucket, bucket)))
    .orderBy(desc(findingTriage.createdAt))
    .limit(DEFAULT_LIST_LIMIT)
    .all()
    .map(rowToFindingTriage);
}

/**
 * Enforces {@link FINDING_TRIAGE_TRANSITIONS}. Throws `conflict(...)` on invalid
 * transitions. Sets triage/resolution attribution columns when entering the
 * corresponding states.
 */
export function transitionStatus(
  id: string,
  newStatus: FindingTriageStatus,
  actor: { type: TriageActorType; id: string },
): FindingTriage {
  const current = getById(id);
  if (!current) throw repositoryNotFoundError("findingTriage", id);

  const allowed = FINDING_TRIAGE_TRANSITIONS[current.status];
  if (!allowed.includes(newStatus)) {
    throw conflict(`Invalid status transition: ${current.status} → ${newStatus}`);
  }

  const now = new Date().toISOString();
  type TriageUpdate = Partial<typeof findingTriage.$inferInsert>;
  const set: TriageUpdate = { status: newStatus, updatedAt: now };
  if (newStatus === "resolved" || newStatus === "wontfix") {
    set.resolvedAt = now;
    set.resolvedByType = actor.type;
    set.resolvedById = actor.id;
  } else if (newStatus === "triaged") {
    set.triagedAt = now;
    set.triagedByType = actor.type;
    set.triagedById = actor.id;
  }

  const db = getDb();
  try {
    db.update(findingTriage).set(set).where(eq(findingTriage.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }

  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}

export function setBucket(id: string, bucket: SuggestedBucket): FindingTriage {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(findingTriage).set({ bucket, updatedAt: now }).where(eq(findingTriage.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}

/** Sets the target release version for deferred findings (e.g. "v0.24", "v0.24.0"). Pass `null` to clear. */
export function setTargetRelease(id: string, targetRelease: string | null): FindingTriage {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(findingTriage)
      .set({ targetRelease, updatedAt: now })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}

/** Sets the target release type for type-based deferrals (patch/minor/major). Pass `null` to clear. */
export function setTargetReleaseType(id: string, targetReleaseType: string | null): FindingTriage {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(findingTriage)
      .set({ targetReleaseType, updatedAt: now })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}

export function setTriageMissionId(id: string, missionId: string | null): FindingTriage {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(findingTriage)
      .set({ triageMissionId: missionId, updatedAt: now })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}

/**
 * Marks a triaged finding as promoted: transitions `triaged → in_progress` via
 * the central state machine, then atomically sets `promotedAt` in metadata via
 * `json_set` (CS-21 pattern — no full-object overwrite). Only callable from
 * `triaged` status — promotes from other statuses are rejected even if the
 * state machine would allow the transition.
 */
export function promote(id: string, actor: { type: TriageActorType; id: string }): FindingTriage {
  const current = getById(id);
  if (!current) throw repositoryNotFoundError("findingTriage", id);
  if (current.status !== "triaged") {
    throw conflict(`Cannot promote finding in status: ${current.status}`);
  }
  transitionStatus(id, "in_progress", actor);

  const now = new Date().toISOString();
  const db = getDb();
  try {
    db.update(findingTriage)
      .set({
        metadata: sql`json_set(COALESCE(${findingTriage.metadata}, '{}'), '$.promotedAt', ${now})`,
        updatedAt: now,
      })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const refreshed = getById(id);
  if (!refreshed) throw repositoryNotFoundError("findingTriage", id);
  return refreshed;
}
