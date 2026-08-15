import { getDb } from "../db/index.js";
import { findingTriage, findingTriageEvidence, pulses } from "../db/schema/index.js";
import { eq, and, desc, notInArray, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  FindingTriageStatus,
  SuggestedBucket,
  TriageActorType,
  ActivationCause,
} from "@orcy/shared";
import { FINDING_TRIAGE_TRANSITIONS, TERMINAL_FINDING_TRIAGE_STATUSES } from "@orcy/shared";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import { conflict } from "../errors.js";
import { normalize } from "../services/habitatSkillService.js";

/** Supplied-client type: same DrizzleDB but injected for transaction participation. */
type SuppliedClient = ReturnType<typeof getDb>;

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
  /** Canonical name for the corrective Mission. Same physical column as triageMissionId. */
  correctiveMissionId: string | null;
  /** @deprecated Use {@link correctiveMissionId}. Preserved as read alias during migration. */
  triageMissionId: string | null;
  corroboratingPulseIds: string[];
  /** Bounded investigation Mission identity. */
  admittedByTriageMissionId: string | null;
  /** Exact Task whose live claim authorizes agent routing. */
  admittedByInvestigationTaskId: string | null;
  /** Nullable predecessor link. */
  recurrenceOfId: string | null;
  /** Blocks automatic recurrence/agent mutation for ambiguous migrated lineage. */
  legacyLineageRepairRequired: boolean;
  /** Normalized immutable route fingerprint. */
  routeFingerprint: string | null;
  /** Activation timestamp. */
  activatedAt: string | null;
  /** Activation actor type. */
  activatedByType: string | null;
  /** Activation actor id. */
  activatedById: string | null;
  /** Activation cause: manual or release. */
  activationCause: ActivationCause | null;
  /** Release identity when activation_cause is 'release'. */
  activationReleaseId: string | null;
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
    // Physical column stays triage_mission_id; expose canonical alias.
    correctiveMissionId: (row.triageMissionId as string | null) ?? null,
    triageMissionId: (row.triageMissionId as string | null) ?? null,
    corroboratingPulseIds,
    admittedByTriageMissionId: (row.admittedByTriageMissionId as string | null) ?? null,
    admittedByInvestigationTaskId: (row.admittedByInvestigationTaskId as string | null) ?? null,
    recurrenceOfId: (row.recurrenceOfId as string | null) ?? null,
    legacyLineageRepairRequired: Boolean(row.legacyLineageRepairRequired ?? 0),
    routeFingerprint: (row.routeFingerprint as string | null) ?? null,
    activatedAt: (row.activatedAt as string | null) ?? null,
    activatedByType: (row.activatedByType as string | null) ?? null,
    activatedById: (row.activatedById as string | null) ?? null,
    activationCause: (row.activationCause as ActivationCause | null) ?? null,
    activationReleaseId: (row.activationReleaseId as string | null) ?? null,
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
      // Uses json_each for existence check + json_insert for append (CS-21
      // pattern). Malformed legacy JSON (a live condition — preflight reports
      // malformed_evidence_json) is treated as no references instead of
      // throwing: json_valid + array json_type guard both the read and the
      // json_insert base.
      const guardedJson = sql`CASE
        WHEN json_valid(COALESCE(${findingTriage.corroboratingPulseIds}, '[]'))
             AND json_type(COALESCE(${findingTriage.corroboratingPulseIds}, '[]')) = 'array'
        THEN COALESCE(${findingTriage.corroboratingPulseIds}, '[]')
        ELSE '[]'
      END`;
      db.update(findingTriage)
        .set({
          corroboratingPulseIds: sql`
            (SELECT CASE WHEN EXISTS(
              SELECT 1 FROM json_each(${guardedJson})
              WHERE value = ${pulse.id}
            ) THEN ${findingTriage.corroboratingPulseIds}
            ELSE json_insert(${guardedJson}, '$[#]', ${pulse.id})
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
    // Deterministic tie-break on id: bulk backfills share createdAt, and the
    // recurrence predecessor must be a stable pick.
    .orderBy(desc(findingTriage.createdAt), desc(findingTriage.id))
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

// ---------------------------------------------------------------------------
// RAW LIFECYCLE WRITER INVENTORY (restored lifecycle T8 writer-closure audit)
// ---------------------------------------------------------------------------
// Literal repository-wide audit (gitnexus impact/context + serena/semble +
// literal grep) of every direct writer of finding-triage status / bucket /
// corrective link / promotion / target-release, with disposition. The
// canonical production mutation path is `services/findingTriageLifecycle.ts`
// (`routeFinding` / `activateCorrectiveMission` / `resolveFinding` /
// `markFindingWontfix`); these setters must NOT gain new production callers.
//
// | Writer                          | Production callers at audit time        | Disposition |
// |---------------------------------|-----------------------------------------|-------------|
// | `transitionStatus`              | `findingTriageService.{confirmBucket,   | Legacy service seam, TEST-ONLY callers |
// |                                 | resolve,promote}` — test-only           | (characterization suites); superseded by |
// |                                 |                                         | the lifecycle kernel. Terminal-guarded. |
// | `setBucket`                     | `findingTriageService.confirmBucket`    | Legacy service seam, TEST-ONLY. |
// | `setTargetRelease`              | NONE                                    | Superseded by Mission release gates;   |
// | `setTargetReleaseType`          | NONE                                    | PATCH rejects the shape with           |
// |                                 |                                         | LEGACY_PATCH_TARGET_RELEASE_SUPERSEDED. |
// | `setTriageMissionId`            | NONE (FU6) — the link shape now writes  | TEST-ONLY (fixtures seed links); the   |
// |                                 | via `applyLegacyLinkWithClient`; the    | unlink shape was REMOVED (400          |
// |                                 |                                         | LEGACY_PATCH_UNLINK_REMOVED, zero     |
// |                                 |                                         | writes).                              |
// | `promote`                       | `findingTriageService.promote` —        | Legacy service seam, TEST-ONLY. The   |
// |                                 | HTTP `/promote` route REMOVED (T8)      | superseded route is gone; manual       |
// |                                 |                                         | activation is `POST .../activate`.    |
// | Supplied-client writers below   | `findingTriageLifecycle.ts` kernel +    | Canonical — the only production write |
// | (`routeWithClient`,             | cluster admission participant +         | authority (plus the Release kernel's  |
// | `terminalizeWithClient`,        | internal Release reconciliation kernel  | `activateCorrectiveMissionForRelease`) |
// | `activateGroupWithClient`,      | + `routes/triage.ts` legacy link        | and the retained legacy link adapter   |
// | `admitWithClient`,              | adapter (FU6 `applyLegacyLinkWithClient`| (`applyLegacyLinkWithClient` is the    |
// | `applyLegacyLinkWithClient`)    | ONLY)                                   | one-write form: link + fingerprint in  |
// |                                 |                                         | a single UPDATE inside BEGIN IMMEDIATE).|
//
// UI cutover (T8): `packages/ui` sends ONLY lifecycle command requests
// (`/route`, `/activate`, `/resolve`, `/wontfix`) — the state-shaped PATCH
// client was deleted. MCP cutover (T8): `insert_deferred_mission` performs
// exactly ONE `POST /triage/findings/:id/route` request; the two-call
// create-Mission-then-PATCH-link flow (and its orphan-Mission window) no
// longer exists, and the PATCH-shaped MCP client was deleted.

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

  // Terminal immutability: terminal states never transition to any other state.
  // Recurrence creates a new row; the old row stays immutable.
  if ((TERMINAL_FINDING_TRIAGE_STATUSES as readonly string[]).includes(current.status)) {
    throw conflict(
      `Cannot transition terminal finding (${current.status}). Recurrence creates a new row.`,
    );
  }

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

// ---------------------------------------------------------------------------
// Supplied-client primitives — used by the lifecycle command module to ensure
// all writes participate in one BEGIN IMMEDIATE transaction. Each primitive
// accepts an injected Drizzle client and NEVER calls getDb() directly.
// ---------------------------------------------------------------------------

/**
 * Reads a finding triage record on the supplied client. Used inside an
 * immediate transaction so the read observes a consistent snapshot under the
 * writer reservation.
 */
export function getByIdWithClient(client: SuppliedClient, id: string): FindingTriage | null {
  const row = client.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  return row ? rowToFindingTriage(row) : null;
}

/** Fields written by the lifecycle route command. */
export interface RouteUpdate {
  status: FindingTriageStatus;
  bucket: SuggestedBucket;
  routeFingerprint: string;
  correctiveMissionId: string | null;
  triagedAt: string | null;
  triagedByType: TriageActorType | null;
  triagedById: string | null;
  activatedAt: string | null;
  activatedByType: string | null;
  activatedById: string | null;
  activationCause: ActivationCause | null;
  activationReleaseId: string | null;
  updatedAt: string;
}

/**
 * Writes route state, attribution, fingerprint, and corrective Mission link
 * on the supplied client. The caller's transaction provides atomicity with
 * Mission creation, dependencies, and the Mission event.
 */
export function routeWithClient(
  client: SuppliedClient,
  id: string,
  update: RouteUpdate,
): FindingTriage {
  try {
    client
      .update(findingTriage)
      .set({
        status: update.status,
        bucket: update.bucket,
        routeFingerprint: update.routeFingerprint,
        triageMissionId: update.correctiveMissionId,
        triagedAt: update.triagedAt,
        triagedByType: update.triagedByType,
        triagedById: update.triagedById,
        activatedAt: update.activatedAt,
        activatedByType: update.activatedByType,
        activatedById: update.activatedById,
        activationCause: update.activationCause,
        activationReleaseId: update.activationReleaseId,
        updatedAt: update.updatedAt,
      })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const row = client.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  if (!row) throw repositoryNotFoundError("findingTriage", id);
  return rowToFindingTriage(row);
}

/**
 * FU6 — retained legacy link adapter's ONE-WRITE apply: sets the corrective
 * Mission link AND the stable legacy-link fingerprint in a SINGLE UPDATE on
 * the supplied client, inside the caller's `BEGIN IMMEDIATE` reservation.
 * Replaces the former two sequential writes (`setTriageMissionId` + a bare
 * fingerprint UPDATE) whose inter-write crash window could commit a link
 * with no fingerprint (breaking lost-response replay) — the single statement
 * makes a partial link impossible by construction.
 */
export function applyLegacyLinkWithClient(
  client: SuppliedClient,
  id: string,
  missionId: string,
  routeFingerprint: string,
): FindingTriage {
  const now = new Date().toISOString();
  try {
    client
      .update(findingTriage)
      .set({ triageMissionId: missionId, routeFingerprint, updatedAt: now })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const row = client.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  if (!row) throw repositoryNotFoundError("findingTriage", id);
  return rowToFindingTriage(row);
}

/** Fields written by the lifecycle terminalize commands (resolve/wontfix). */
export interface TerminalizeUpdate {
  status: "resolved" | "wontfix";
  resolvedAt: string;
  resolvedByType: TriageActorType;
  resolvedById: string;
  resolutionNote: string;
  updatedAt: string;
}

/**
 * Writes terminal Finding state on the supplied client. Commits atomically
 * with the Resolution Record written by the same transaction.
 */
export function terminalizeWithClient(
  client: SuppliedClient,
  id: string,
  update: TerminalizeUpdate,
): FindingTriage {
  try {
    client
      .update(findingTriage)
      .set({
        status: update.status,
        resolvedAt: update.resolvedAt,
        resolvedByType: update.resolvedByType,
        resolvedById: update.resolvedById,
        resolutionNote: update.resolutionNote,
        updatedAt: update.updatedAt,
      })
      .where(eq(findingTriage.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, id);
  }
  const row = client.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  if (!row) throw repositoryNotFoundError("findingTriage", id);
  return rowToFindingTriage(row);
}

// ---------------------------------------------------------------------------
// Activation primitives (restored lifecycle T5). The activation kernel reads
// the homogeneous linked group and writes the group activation on the SAME
// supplied client so the Mission gate-CAS, the Mission audit event, and every
// Finding activation commit (or roll back) together.
// ---------------------------------------------------------------------------

/**
 * Every NON-TERMINAL Finding linked to one corrective Mission, on the
 * supplied client. The activation kernel requires this set to be a
 * homogeneous `triaged` group — mixed states conflict before any write.
 */
export function listNonTerminalByCorrectiveMissionIdWithClient(
  client: SuppliedClient,
  missionId: string,
): FindingTriage[] {
  return client
    .select()
    .from(findingTriage)
    .where(
      and(
        eq(findingTriage.triageMissionId, missionId),
        notInArray(findingTriage.status, ["resolved", "wontfix"]),
      ),
    )
    .all()
    .map(rowToFindingTriage);
}

/** Activation attribution written onto every member of an activated group. */
export interface GroupActivationUpdate {
  activatedAt: string;
  activatedByType: TriageActorType;
  activatedById: string;
  activationCause: ActivationCause;
  /** Release identity; null unless `activationCause` is `release`. */
  activationReleaseId: string | null;
  updatedAt: string;
}

/**
 * `activate-many`: transitions the whole homogeneous group to `in_progress`
 * with activation attribution in ONE atomic statement on the supplied client.
 *
 * The `status = 'triaged'` term is an in-transaction race guard — the kernel
 * verified the group under the writer reservation, so the WHERE term can only
 * go unmatched if the read was inconsistent; a short count is a hard error
 * that rolls back the entire activation (all-or-none, never partial).
 */
export function activateGroupWithClient(
  client: SuppliedClient,
  findingIds: string[],
  activation: GroupActivationUpdate,
): FindingTriage[] {
  if (findingIds.length === 0) return [];
  try {
    client
      .update(findingTriage)
      .set({
        status: "in_progress",
        activatedAt: activation.activatedAt,
        activatedByType: activation.activatedByType,
        activatedById: activation.activatedById,
        activationCause: activation.activationCause,
        activationReleaseId: activation.activationReleaseId,
        updatedAt: activation.updatedAt,
      })
      .where(and(inArray(findingTriage.id, findingIds), eq(findingTriage.status, "triaged")))
      .run();
    const affected = client.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    if (affected !== findingIds.length) {
      throw new Error(
        `activate-many short count: expected ${findingIds.length}, matched ${affected} (group state changed inside the transaction)`,
      );
    }
  } catch (err) {
    throw repositoryUpdateError("findingTriage", err as Error, findingIds.join(","));
  }
  return client
    .select()
    .from(findingTriage)
    .where(inArray(findingTriage.id, findingIds))
    .all()
    .map(rowToFindingTriage);
}

// ---------------------------------------------------------------------------
// Inverse-mutation reference queries (restored lifecycle T5). Read-only
// helpers backing the service-level Pulse/Mission history guards that run
// BEFORE the later FK enforcement migration (T9).
// ---------------------------------------------------------------------------

/** One evidence-membership reference from a Finding to a Pulse. */
export interface PulseEvidenceReference {
  findingTriageId: string;
  role: "source" | "corroborating" | "legacy_observed";
}

/**
 * Every normalized evidence-membership row referencing the Pulse, any role
 * (`finding_triage_evidence` is the authoritative membership store). A Pulse
 * referenced by ANY Finding — terminal or not — cannot be deleted.
 */
export function listEvidenceReferencesForPulse(
  pulseId: string,
  client?: SuppliedClient,
): PulseEvidenceReference[] {
  const db = client ?? getDb();
  return db
    .select()
    .from(findingTriageEvidence)
    .where(eq(findingTriageEvidence.pulseId, pulseId))
    .all()
    .map((row) => ({
      findingTriageId: row.findingTriageId,
      role: row.role,
    }));
}

/**
 * Findings whose source-Pulse pointer (`finding_triage.pulse_id`) is the
 * given Pulse. Covers pre-evidence-table legacy rows where the source Pulse
 * lives only on the row itself.
 */
export function findBySourcePulseId(pulseId: string, client?: SuppliedClient): FindingTriage[] {
  const db = client ?? getDb();
  return db
    .select()
    .from(findingTriage)
    .where(eq(findingTriage.pulseId, pulseId))
    .all()
    .map(rowToFindingTriage);
}

/**
 * Findings that still list the Pulse only on the legacy
 * `corroborating_pulse_ids` JSON projection (no evidence-table row).
 */
export function findByLegacyCorroboratingPulseId(
  pulseId: string,
  client?: SuppliedClient,
): FindingTriage[] {
  const db = client ?? getDb();
  // Malformed legacy JSON (malformed_evidence_json is a live condition the
  // preflight reports) must read as "no reference" — an unguarded json_each
  // throws and turns EVERY pulse delete into a 500, even for unreferenced
  // pulses.
  return db
    .select()
    .from(findingTriage)
    .where(
      sql`EXISTS (
        SELECT 1 FROM json_each(
          CASE
            WHEN json_valid(COALESCE(${findingTriage.corroboratingPulseIds}, '[]'))
                 AND json_type(COALESCE(${findingTriage.corroboratingPulseIds}, '[]')) = 'array'
            THEN COALESCE(${findingTriage.corroboratingPulseIds}, '[]')
            ELSE '[]'
          END
        )
        WHERE value = ${pulseId}
      )`,
    )
    .all()
    .map(rowToFindingTriage);
}

/**
 * Findings admitted by a given Triage Mission (bounded investigation link).
 * Mission deletion rejects while ANY such link exists, terminal or not.
 */
export function findByAdmittedByTriageMissionId(missionId: string): FindingTriage[] {
  const db = getDb();
  return db
    .select()
    .from(findingTriage)
    .where(eq(findingTriage.admittedByTriageMissionId, missionId))
    .all()
    .map(rowToFindingTriage);
}

// ---------------------------------------------------------------------------
// Structured cluster-intake primitives — classification, admission,
// corroboration, and evidence membership on the supplied client. Used by the
// triage occurrence publication participant so Finding admission commits
// atomically with the Mission/Task/workflow/junction aggregate.
// ---------------------------------------------------------------------------

/** One evidence-membership row projected from `finding_triage_evidence`. */
export interface FindingTriageEvidenceRow {
  findingTriageId: string;
  pulseId: string;
  role: "source" | "corroborating" | "legacy_observed";
  admittedByTriageMissionId: string | null;
  admittedByInvestigationTaskId: string | null;
}

/**
 * All lifecycle rows for one structured identity `(habitatId, clusterKey,
 * findingKind)` — every status, oldest first. Classification derives "latest"
 * and active/terminal state from this list.
 */
export function findByIdentityWithClient(
  client: SuppliedClient,
  habitatId: string,
  clusterKey: string,
  findingKind: string,
): FindingTriage[] {
  return client
    .select()
    .from(findingTriage)
    .where(
      and(
        eq(findingTriage.habitatId, habitatId),
        eq(findingTriage.clusterKey, clusterKey),
        eq(findingTriage.findingKind, findingKind),
      ),
    )
    // Deterministic order (createdAt, then id) — same canonical order the
    // classification window uses; ties on createdAt otherwise pick a
    // nondeterministic "latest" predecessor and build the wrong lineage.
    .orderBy(findingTriage.createdAt, findingTriage.id)
    .all()
    .map(rowToFindingTriage);
}

/** Every evidence-membership row for one finding, on the supplied client. */
export function listEvidenceWithClient(
  client: SuppliedClient,
  findingTriageId: string,
): FindingTriageEvidenceRow[] {
  return client
    .select()
    .from(findingTriageEvidence)
    .where(eq(findingTriageEvidence.findingTriageId, findingTriageId))
    .all()
    .map((row) => ({
      findingTriageId: row.findingTriageId,
      pulseId: row.pulseId,
      role: row.role,
      admittedByTriageMissionId: row.admittedByTriageMissionId ?? null,
      admittedByInvestigationTaskId: row.admittedByInvestigationTaskId ?? null,
    }));
}

/**
 * Reads lifecycle rows by ids on the supplied client (lineage traversal —
 * callers pass the `recurrenceOfId` chain one hop at a time and must bound
 * traversal themselves).
 */
export function getByIdsWithClient(client: SuppliedClient, ids: string[]): FindingTriage[] {
  if (ids.length === 0) return [];
  return client
    .select()
    .from(findingTriage)
    .where(inArray(findingTriage.id, ids))
    .all()
    .map(rowToFindingTriage);
}

/** Input for {@link admitWithClient} — one new `open` lifecycle row. */
export interface AdmitInput {
  habitatId: string;
  clusterKey: string;
  findingKind: string;
  /** The source Pulse (earliest novel Pulse — deterministic). */
  pulseId: string;
  /**
   * Compatibility projection (`corroboratingPulseIds`): the admission-evidence
   * Pulse ids EXCLUDING the source Pulse. The evidence table stays the
   * authoritative membership store; this column is a read projection only.
   */
  corroboratingPulseIds: string[];
  /** Bounded investigation Mission identity (the admitting Triage Mission). */
  admittedByTriageMissionId: string;
  /** The exact committed investigation Task (from the templateKey→Task map). */
  admittedByInvestigationTaskId: string;
  /** Terminal predecessor link for a recurrence admission (null for new). */
  recurrenceOfId: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Inserts one new `open` lifecycle row with investigation provenance on the
 * supplied client. The caller writes the evidence rows (any role) and the
 * Pulse pointer in the SAME transaction.
 */
export function admitWithClient(client: SuppliedClient, input: AdmitInput): FindingTriage {
  const id = uuid();
  try {
    client
      .insert(findingTriage)
      .values({
        id,
        habitatId: input.habitatId,
        pulseId: input.pulseId,
        clusterKey: input.clusterKey,
        findingKind: input.findingKind,
        status: "open",
        bucket: null,
        targetRelease: null,
        targetReleaseType: null,
        triageMissionId: null,
        corroboratingPulseIds: JSON.stringify(input.corroboratingPulseIds),
        admittedByTriageMissionId: input.admittedByTriageMissionId,
        admittedByInvestigationTaskId: input.admittedByInvestigationTaskId,
        recurrenceOfId: input.recurrenceOfId,
        metadata: input.metadata ?? {},
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("findingTriage", err as Error, id);
  }
  const row = client.select().from(findingTriage).where(eq(findingTriage.id, id)).get();
  if (!row) throw repositoryNotFoundError("findingTriage", id);
  return rowToFindingTriage(row);
}

/** Input for {@link appendEvidenceWithClient}. */
export interface AppendEvidenceInput {
  findingTriageId: string;
  /** Pulse ids to record. Already-present ids are no-ops (ON CONFLICT DO NOTHING). */
  pulseIds: string[];
  role: "source" | "corroborating" | "legacy_observed";
  /** Optional admitting Mission/Task provenance stamped on the evidence rows. */
  admittedByTriageMissionId?: string | null;
  admittedByInvestigationTaskId?: string | null;
  admittedAt?: string | null;
}

/**
 * Appends evidence-membership rows on the supplied client. Exact membership
 * only: `(findingTriageId, pulseId)` conflicts are silently skipped — the
 * authoritative store never duplicates. When the role is `corroborating`,
 * the compatibility `corroboratingPulseIds` projection is extended with the
 * genuinely-new ids (the caller holds the write reservation; the projection
 * never includes a `source` Pulse).
 */
export function appendEvidenceWithClient(
  client: SuppliedClient,
  input: AppendEvidenceInput,
): { appendedPulseIds: string[] } {
  if (input.pulseIds.length === 0) return { appendedPulseIds: [] };

  const before = new Set(
    client
      .select({ pulseId: findingTriageEvidence.pulseId })
      .from(findingTriageEvidence)
      .where(eq(findingTriageEvidence.findingTriageId, input.findingTriageId))
      .all()
      .map((row) => row.pulseId),
  );

  const now = new Date().toISOString();
  const fresh = input.pulseIds.filter((id) => !before.has(id));
  if (fresh.length === 0) return { appendedPulseIds: [] };

  // habitat_id is the habitat-cascade anchor on evidence rows: always the
  // referenced finding's habitat (derived here, never caller-supplied), so
  // deleting the habitat cascades evidence away alongside its finding.
  const finding = client
    .select({ habitatId: findingTriage.habitatId })
    .from(findingTriage)
    .where(eq(findingTriage.id, input.findingTriageId))
    .get();
  if (!finding) throw repositoryNotFoundError("findingTriage", input.findingTriageId);

  try {
    client
      .insert(findingTriageEvidence)
      .values(
        fresh.map((pulseId) => ({
          findingTriageId: input.findingTriageId,
          pulseId,
          habitatId: finding.habitatId,
          role: input.role,
          admittedByTriageMissionId: input.admittedByTriageMissionId ?? null,
          admittedByInvestigationTaskId: input.admittedByInvestigationTaskId ?? null,
          admittedAt: input.admittedAt ?? now,
        })),
      )
      .onConflictDoNothing()
      .run();
  } catch (err) {
    throw repositoryCreateError("findingTriageEvidence", err as Error, input.findingTriageId);
  }

  if (input.role === "corroborating") {
    // Extend the compatibility projection with the appended ids. Read-modify-
    // write is safe here: the caller's transaction holds the write reservation.
    const row = client
      .select()
      .from(findingTriage)
      .where(eq(findingTriage.id, input.findingTriageId))
      .get();
    if (row) {
      const existing = new Set(rowToFindingTriage(row).corroboratingPulseIds);
      const merged = [...existing, ...fresh.filter((id) => !existing.has(id))];
      try {
        client
          .update(findingTriage)
          .set({
            corroboratingPulseIds: JSON.stringify(merged),
            updatedAt: now,
          })
          .where(eq(findingTriage.id, input.findingTriageId))
          .run();
      } catch (err) {
        throw repositoryUpdateError("findingTriage", err as Error, input.findingTriageId);
      }
    }
  }

  return { appendedPulseIds: fresh };
}

/**
 * Write-once `findingTriageId` pointer into the source Pulse's metadata, on
 * the supplied client (atomic `json_set` on a COALESCE'd base; only the
 * `findingTriageId` key is touched). Mirrors `findingTriageService`'s private
 * pointer write so admission and pointer commit in one transaction. No-op if
 * the pulse is gone or already carries a pointer.
 */
export function writeFindingTriageIdPointerWithClient(
  client: SuppliedClient,
  pulseId: string,
  findingTriageId: string,
): void {
  client
    .update(pulses)
    .set({
      metadata: sql`json_set(COALESCE(${pulses.metadata}, '{}'), '$.findingTriageId', ${findingTriageId})`,
    })
    .where(
      and(
        eq(pulses.id, pulseId),
        sql`json_extract(COALESCE(${pulses.metadata}, '{}'), '$.findingTriageId') IS NULL`,
      ),
    )
    .run();
}
