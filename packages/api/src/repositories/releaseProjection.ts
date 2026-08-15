/**
 * Release projection + activation epoch repository (restored lifecycle T7).
 *
 * Supplied-client primitives for the durable per-Release projection
 * deliveries and the immutable activation epoch + frozen Mission groups.
 * All writes participate in the caller's transaction (the reconciliation
 * seam's `BEGIN IMMEDIATE`); none of these functions open transactions.
 */
import { eq, and, asc, ne, desc, sql, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import {
  releases,
  releaseProjectionDeliveries,
  releaseActivationEpochs,
  releaseActivationEpochGroups,
  type ReleaseProjectionKind,
  type EpochGroupDisposition,
} from "../db/schema/index.js";
import type { Release } from "./release.js";
import { rowToRelease } from "./release.js";
import type { DetectorSource, ReleaseType } from "@orcy/shared";

export type { ReleaseProjectionKind, EpochGroupDisposition } from "../db/schema/index.js";

/** Supplied-client type for transaction participation. */
export type ReleaseProjectionDbClient = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface ReleaseProjectionDelivery {
  id: string;
  releaseId: string;
  habitatId: string;
  projectionKind: ReleaseProjectionKind;
  state: "pending" | "completed";
  idempotencyKey: string;
  attemptCount: number;
  lastError: string | null;
  outputIdentity: Record<string, unknown> | null;
  completedAt: string | null;
}

interface ProjectionRow {
  id: string;
  releaseId: string;
  habitatId: string;
  projectionKind: ReleaseProjectionKind;
  state: string;
  idempotencyKey: string;
  attemptCount: number;
  lastError: string | null;
  outputIdentity: Record<string, unknown> | null;
  completedAt: string | null;
}

function rowToProjection(row: ProjectionRow): ReleaseProjectionDelivery {
  return {
    id: row.id,
    releaseId: row.releaseId,
    habitatId: row.habitatId,
    projectionKind: row.projectionKind,
    state: row.state as "pending" | "completed",
    idempotencyKey: row.idempotencyKey,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    outputIdentity: row.outputIdentity ?? null,
    completedAt: row.completedAt,
  };
}

/** Stable per-(release, kind) idempotency key (deterministic identity). */
export function projectionIdempotencyKey(releaseId: string, kind: ReleaseProjectionKind): string {
  return `release-projection:${releaseId}:${kind}`;
}

/**
 * Idempotently ensures the five pending projection rows exist for a Release
 * (insert-or-skip on the unique `(releaseId, projectionKind)` identity).
 * Runs on the caller's transaction client.
 */
export function ensureProjectionsWithClient(
  client: ReleaseProjectionDbClient,
  release: Release,
): void {
  const kinds: ReleaseProjectionKind[] = [
    "activation_reconciliation",
    "deadline_notification",
    "activation_notification",
    "retrospective_pulse",
    "release_shipped",
  ];
  for (const kind of kinds) {
    client
      .insert(releaseProjectionDeliveries)
      .values({
        id: uuid(),
        releaseId: release.id,
        habitatId: release.habitatId,
        projectionKind: kind,
        state: "pending",
        idempotencyKey: projectionIdempotencyKey(release.id, kind),
      })
      .onConflictDoNothing()
      .run();
  }
}

export function listProjectionsWithClient(
  client: ReleaseProjectionDbClient,
  releaseId: string,
): ReleaseProjectionDelivery[] {
  const rows = client
    .select()
    .from(releaseProjectionDeliveries)
    .where(eq(releaseProjectionDeliveries.releaseId, releaseId))
    .all();
  return rows.map((row) => rowToProjection(row as unknown as ProjectionRow));
}

export function getProjectionWithClient(
  client: ReleaseProjectionDbClient,
  releaseId: string,
  kind: ReleaseProjectionKind,
): ReleaseProjectionDelivery | null {
  const row = client
    .select()
    .from(releaseProjectionDeliveries)
    .where(
      and(
        eq(releaseProjectionDeliveries.releaseId, releaseId),
        eq(releaseProjectionDeliveries.projectionKind, kind),
      ),
    )
    .get();
  return row ? rowToProjection(row as unknown as ProjectionRow) : null;
}

/** Marks a projection completed with its output identity (idempotent re-run safe). */
export function completeProjectionWithClient(
  client: ReleaseProjectionDbClient,
  projectionId: string,
  outputIdentity: Record<string, unknown>,
  now: string,
): void {
  client
    .update(releaseProjectionDeliveries)
    .set({
      state: "completed",
      outputIdentity,
      completedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(releaseProjectionDeliveries.id, projectionId))
    .run();
}

/** Records a failed attempt on a still-pending projection (retryable). */
export function recordProjectionAttemptError(
  releaseId: string,
  kind: ReleaseProjectionKind,
  error: string,
): void {
  const db = getDb();
  db.run(sql`UPDATE release_projection_deliveries
    SET attempt_count = attempt_count + 1, last_error = ${error}, updated_at = ${new Date().toISOString()}
    WHERE release_id = ${releaseId} AND projection_kind = ${kind} AND state = 'pending'`);
}

// ---------------------------------------------------------------------------
// Epoch
// ---------------------------------------------------------------------------

export interface ReleaseActivationEpoch {
  id: string;
  releaseId: string;
  habitatId: string;
  frozenCap: number | null;
  autoPromoteEnabled: boolean;
  eligibilityDigest: string;
  completedAt: string | null;
}

export interface EpochGroupRow {
  id: string;
  epochId: string;
  releaseId: string;
  habitatId: string;
  missionId: string;
  missionCreatedAt: string;
  position: number;
  findingIds: string[];
  gateType: "patch" | "minor" | "major" | null;
  gateVersion: string | null;
  membershipDigest: string;
  disposition: EpochGroupDisposition;
  dispositionAt: string | null;
  dispositionDetail: string | null;
  activatedFindingCount: number | null;
}

function rowToEpoch(row: {
  id: string;
  releaseId: string;
  habitatId: string;
  frozenCap: number | null;
  autoPromoteEnabled: number;
  eligibilityDigest: string;
  completedAt: string | null;
}): ReleaseActivationEpoch {
  return {
    id: row.id,
    releaseId: row.releaseId,
    habitatId: row.habitatId,
    frozenCap: row.frozenCap,
    autoPromoteEnabled: row.autoPromoteEnabled === 1,
    eligibilityDigest: row.eligibilityDigest,
    completedAt: row.completedAt,
  };
}

function rowToGroup(row: {
  id: string;
  epochId: string;
  releaseId: string;
  habitatId: string;
  missionId: string;
  missionCreatedAt: string;
  position: number;
  findingIds: string[] | string | null;
  gateType: "patch" | "minor" | "major" | null;
  gateVersion: string | null;
  membershipDigest: string;
  disposition: string;
  dispositionAt: string | null;
  dispositionDetail: string | null;
  activatedFindingCount: number | null;
}): EpochGroupRow {
  const ids = row.findingIds;
  return {
    id: row.id,
    epochId: row.epochId,
    releaseId: row.releaseId,
    habitatId: row.habitatId,
    missionId: row.missionId,
    missionCreatedAt: row.missionCreatedAt,
    position: row.position,
    findingIds: Array.isArray(ids) ? ids : JSON.parse(ids as string),
    gateType: row.gateType,
    gateVersion: row.gateVersion,
    membershipDigest: row.membershipDigest,
    disposition: row.disposition as EpochGroupDisposition,
    dispositionAt: row.dispositionAt,
    dispositionDetail: row.dispositionDetail,
    activatedFindingCount: row.activatedFindingCount,
  };
}

export function getEpochByReleaseIdWithClient(
  client: ReleaseProjectionDbClient,
  releaseId: string,
): ReleaseActivationEpoch | null {
  const row = client
    .select()
    .from(releaseActivationEpochs)
    .where(eq(releaseActivationEpochs.releaseId, releaseId))
    .get();
  return row ? rowToEpoch(row as never) : null;
}

export interface CreateEpochInput {
  releaseId: string;
  habitatId: string;
  frozenCap: number | null;
  autoPromoteEnabled: boolean;
  eligibilityDigest: string;
}

export function createEpochWithClient(
  client: ReleaseProjectionDbClient,
  input: CreateEpochInput,
): ReleaseActivationEpoch {
  const id = uuid();
  client
    .insert(releaseActivationEpochs)
    .values({
      id,
      releaseId: input.releaseId,
      habitatId: input.habitatId,
      frozenCap: input.frozenCap,
      autoPromoteEnabled: input.autoPromoteEnabled ? 1 : 0,
      eligibilityDigest: input.eligibilityDigest,
    })
    .run();
  const created = client
    .select()
    .from(releaseActivationEpochs)
    .where(eq(releaseActivationEpochs.id, id))
    .get();
  if (!created) throw new Error(`release_activation_epochs row ${id} missing after insert`);
  return rowToEpoch(created as never);
}

export interface CreateEpochGroupInput {
  epochId: string;
  releaseId: string;
  habitatId: string;
  missionId: string;
  missionCreatedAt: string;
  position: number;
  findingIds: string[];
  gateType: string | null;
  gateVersion: string | null;
  membershipDigest: string;
}

export function createEpochGroupWithClient(
  client: ReleaseProjectionDbClient,
  input: CreateEpochGroupInput,
): void {
  client
    .insert(releaseActivationEpochGroups)
    .values({
      id: uuid(),
      epochId: input.epochId,
      releaseId: input.releaseId,
      habitatId: input.habitatId,
      missionId: input.missionId,
      missionCreatedAt: input.missionCreatedAt,
      position: input.position,
      findingIds: input.findingIds,
      gateType: input.gateType,
      gateVersion: input.gateVersion,
      membershipDigest: input.membershipDigest,
      disposition: "pending",
    })
    .run();
}

/** Frozen groups in deterministic eligible order (position). */
export function listEpochGroupsOrderedWithClient(
  client: ReleaseProjectionDbClient,
  epochId: string,
): EpochGroupRow[] {
  const rows = client
    .select()
    .from(releaseActivationEpochGroups)
    .where(eq(releaseActivationEpochGroups.epochId, epochId))
    .orderBy(asc(releaseActivationEpochGroups.position))
    .all();
  return rows.map((row) => rowToGroup(row as never));
}

export function getEpochGroupByIdWithClient(
  client: ReleaseProjectionDbClient,
  groupId: string,
): EpochGroupRow | null {
  const row = client
    .select()
    .from(releaseActivationEpochGroups)
    .where(eq(releaseActivationEpochGroups.id, groupId))
    .get();
  return row ? rowToGroup(row as never) : null;
}

/**
 * Writes a group's terminal disposition. Guarded `pending -> disposition` so
 * an already-classified group (a concurrent reconciler committed first) is
 * never overwritten — the caller rereads and adopts the committed value.
 * Returns true when this call classified the group.
 */
export function setGroupDispositionWithClient(
  client: ReleaseProjectionDbClient,
  groupId: string,
  disposition: Exclude<EpochGroupDisposition, "pending">,
  now: string,
  detail?: string,
  activatedFindingCount?: number,
): boolean {
  const runResult = client
    .update(releaseActivationEpochGroups)
    .set({
      disposition,
      dispositionAt: now,
      dispositionDetail: detail ?? null,
      activatedFindingCount: activatedFindingCount ?? null,
    })
    .where(
      and(
        eq(releaseActivationEpochGroups.id, groupId),
        eq(releaseActivationEpochGroups.disposition, "pending"),
      ),
    )
    .run();
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  return changes === undefined ? true : changes > 0;
}

/** Epoch completion is final — guarded on `completed_at IS NULL`. */
export function completeEpochWithClient(
  client: ReleaseProjectionDbClient,
  epochId: string,
  now: string,
): boolean {
  const runResult = client
    .update(releaseActivationEpochs)
    .set({ completedAt: now })
    .where(and(eq(releaseActivationEpochs.id, epochId), sql`completed_at IS NULL`))
    .run();
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  return changes === undefined ? true : changes > 0;
}

/**
 * LIVE count of Findings already carrying `activation_release_id = releaseId`
 * (the used frozen-budget capacity). Runs on the caller's transaction client
 * so the per-group reservation reads it under the writer lock.
 */
export function countReleaseAttributedFindingsWithClient(
  client: ReleaseProjectionDbClient,
  releaseId: string,
): number {
  const row = client
    .select({ count: sql<number>`count(*)` })
    .from(sql`finding_triage`)
    .where(sql`activation_release_id = ${releaseId}`)
    .get();
  return Number((row as { count?: number } | undefined)?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Release creation on a client (bootstrap seam)
// ---------------------------------------------------------------------------

/** Release row by id on the caller's client (worker processes have no global getDb). */
export function findReleaseByIdWithClient(
  client: ReleaseProjectionDbClient,
  releaseId: string,
): Release | null {
  const row = client
    .select()
    .from(releases)
    .where(eq(releases.id, releaseId))
    .get();
  return row ? rowToRelease(row) : null;
}

/** Most recent prior release on the caller's client (classification baseline). */
export function findMostRecentPriorWithClient(
  client: ReleaseProjectionDbClient,
  habitatId: string,
  excludeVersion: string,
): Release | null {
  const row = client
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.habitatId, habitatId),
        ne(releases.version, excludeVersion),
      ),
    )
    .orderBy(desc(releases.detectedAt), desc(releases.id))
    .limit(1)
    .get();
  return row ? rowToRelease(row) : null;
}

/** `(habitatId, version)` lookup on the caller's client. */
export function findReleaseByHabitatAndVersionWithClient(
  client: ReleaseProjectionDbClient,
  habitatId: string,
  version: string,
): Release | null {
  const row = client
    .select()
    .from(releases)
    .where(and(eq(releases.habitatId, habitatId), eq(releases.version, version)))
    .get();
  return row ? rowToRelease(row) : null;
}

export interface CreateReleaseOnClientInput {
  habitatId: string;
  version: string;
  releaseType: ReleaseType;
  detectedBy: DetectorSource;
  releaseNotes?: string;
  metadata?: Record<string, unknown>;
}

/** Creates the Release row on the caller's transaction client. */
export function createReleaseWithClient(
  client: ReleaseProjectionDbClient,
  input: CreateReleaseOnClientInput,
): Release {
  const id = uuid();
  client
    .insert(releases)
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
  const created = client.select().from(releases).where(eq(releases.id, id)).get();
  if (!created) throw new Error(`releases row ${id} missing after insert`);
  return rowToRelease(created);
}

/** Batch load of epoch groups by mission ids (worker-race convenience). */
export function listEpochGroupsForMissionsWithClient(
  client: ReleaseProjectionDbClient,
  epochId: string,
  missionIds: string[],
): EpochGroupRow[] {
  if (missionIds.length === 0) return [];
  const rows = client
    .select()
    .from(releaseActivationEpochGroups)
    .where(
      and(
        eq(releaseActivationEpochGroups.epochId, epochId),
        inArray(releaseActivationEpochGroups.missionId, missionIds),
      ),
    )
    .all();
  return rows.map((row) => rowToGroup(row as never)).sort((a, b) => a.position - b.position);
}
