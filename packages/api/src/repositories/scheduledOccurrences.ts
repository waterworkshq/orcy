/**
 * Scheduled Occurrence Repository — T9A Phase 1 (DORMANT additive primitives).
 *
 * Builds the transaction-aware repository layer for the existing
 * `scheduled_occurrences` table (T1 — `db/schema/taskPublication.ts:436-466`)
 * and the legal-transition state machine that drives it. The table, indexes,
 * `scheduled_occurrence` `AttemptPublicationKind` (`taskCreationAttempts.ts:94`),
 * and migration ALREADY shipped in Story-1 / T1 as forward-compatible dormant
 * storage — this module ADDS primitives, it does NOT modify the schema.
 *
 * State machine (4 states, forward-only):
 *
 *   reserved → publishing → published
 *                       └──→ rejected
 *   reserved ──────────────→ rejected  (reservation-time validation failure
 *                                        detected before publication begins)
 *
 * Terminal states (`published`, `rejected`) are one-way doors — every further
 * transition is refused. `publishing → publishing` is a no-op (NOT a re-mark),
 * mirroring the attempt matrix's same-state discipline
 * (`taskPublication.ts:319-324` `isLegalCheckpointForward`).
 *
 * The `*WithClient` contract mirrors the T1 / T3A precedent
 * (`PulseDbClient`, `createPulseWithClient`, `reserveAttemptWithClient`,
 * `checkpointAttemptWithClient`, `acquireAttemptLeaseWithClient`):
 *   - ACCEPT a caller-supplied drizzle client (default `getDb()` OR a `tx` from
 *     `db.transaction(cb)`). The coordinator (Phase 3 — `publishScheduledOccurrence`)
 *     composes these inside one `db.transaction((tx) => …)` so the occurrence
 *     state mutation is atomic with the Mission/Tasks/envelope writes.
 *   - NEVER call `getDb()` themselves (they would escape the caller's tx).
 *   - NEVER open their own transaction (no nested transactions).
 *   - NEVER emit external effects (SSE / hooks / webhooks).
 *   - THROW only on infrastructure failure (retryable transport). Every
 *     expected domain decision is a closed discriminated-union branch — never
 *     a thrown exception.
 *
 * Compare-and-set discipline (portable across sql.js + better-sqlite3 — see
 * MEMORY.md § Database Portability): every state-transition primitive runs a
 * conditional UPDATE whose WHERE encodes the expected source state, then
 * classifies from `SELECT changes() AS n` (NOT from drizzle's `run().changes`
 * — that returns `undefined` on the sql.js test driver). Re-reading alone is
 * INSUFFICIENT — a losing CAS whose target state a concurrent writer happened
 * to reach would falsely report `transitioned`. The affected-row count IS the
 * entire signal: 1 row → `transitioned`; 0 rows → `no_op` (concurrent writer
 * won; the authoritative row is returned UNCHANGED — the loser never
 * overwrites the winner).
 *
 * Lease semantics: a worker lease is `(leaseOwner, leaseExpiresAt)`. The lease
 * is INSTALLED atomically with the `reserved → publishing` transition — the
 * CAS predicate is `state='reserved' AND (leaseOwner IS NULL OR
 * leaseExpiresAt < now)`, so the FIRST worker to CAS into `publishing` owns
 * the lease. Renew is conditioned on the current owner matching (no steal);
 * a different worker's renew is refused without mutation. Release clears the
 * columns; only the current owner may release. The lease is RETIRED
 * automatically by the terminal transitions (`publishing → published|rejected`
 * clear `leaseOwner`/`leaseExpiresAt`) — AND T9A-08 (T9B Phase 1 fencing)
 * makes the terminal CAS LEASE-OWNER-CONDITIONED: the terminal directives
 * carry the expected `leaseOwner`, the terminal CAS predicate adds
 * `leaseOwner = expected`, and a mismatch (a stale worker whose lease was
 * reclaimed by {@link reacquireExpiredOccurrenceLeaseWithClient}) returns a
 * typed `not_owner` outcome so the caller can distinguish "lost the lease"
 * from "the occurrence is already terminal". T9B's expired-lease RECLAIM
 * primitive (below) is the EXPLICIT takeover path for the phase-2 recovery
 * worker — a `publishing` occurrence whose `leaseExpiresAt < now` can be
 * re-claimed, transferring the lease to the recovery owner.
 *
 * DORMANT: no production origin routes through this module yet. The
 * reservation transaction (Phase 2 — `reserveScheduledOccurrence`) and the
 * occurrence publisher (Phase 3 — `publishScheduledOccurrence`) compose these
 * primitives. The scheduler wiring that actually drives occurrence creation
 * is T11 (the cutover ticket).
 */
import { getDb } from "../db/index.js";
import { scheduledOccurrences } from "../db/schema/index.js";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { isSqliteError } from "../errors/sqlite.js";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Shared row / state types (re-derived from the schema so callers don't depend
// on the schema module's internals — mirrors `taskCreationAttempts.ts`)
// ---------------------------------------------------------------------------

/** A full `scheduled_occurrences` row, as selected by drizzle. */
export type ScheduledOccurrenceRow = typeof scheduledOccurrences.$inferSelect;

/** The 4-state occurrence enum persisted in `scheduled_occurrences.state`. */
export type ScheduledOccurrenceState = "reserved" | "publishing" | "published" | "rejected";

/**
 * Frozen schedule/template revision snapshot persisted at reservation time.
 * Re-derived here (the schema's `ScheduleRevisionJson` is not exported) —
 * mirrors how `taskCreationAttempts.ts` re-derives `AttemptTerminalResult`.
 */
export type ScheduleRevisionJson = Record<string, unknown>;

/**
 * Compact occurrence terminal result (success or failure detail). Re-derived
 * here (the schema's `OccurrenceResultJson` is not exported). The Phase 3
 * publisher stamps the canonical shape (created Mission id, failure errors,
 * etc.); Phase 1 treats it as an opaque payload.
 */
export type OccurrenceResultJson = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Terminal-state set (shared domain invariant — mirrors
// `TERMINAL_ATTEMPT_STATES` in `taskPublication.ts:284-290`)
// ---------------------------------------------------------------------------

/**
 * Terminal occurrence states — once reached, every further transition is
 * refused (one-way terminal door). The terminal-lock is a domain invariant
 * shared across the occurrence state machine, NOT per-function logic:
 *   - `published` — success; the Mission + Tasks were committed.
 *   - `rejected`  — publication failed (Task invalid/vetoed, or a
 *                    reservation-time validation failure detected before
 *                    publication began).
 *
 * Kept alongside {@link isLegalOccurrenceForward} so the legality predicate is
 * data-driven + auditable, not an inline literal.
 */
export const TERMINAL_OCCURRENCE_STATES: ReadonlySet<ScheduledOccurrenceState> = new Set([
  "published",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Legal-transition matrix — pure function (mirrors
// `taskPublication.ts:319-324 isLegalCheckpointForward`)
// ---------------------------------------------------------------------------

/**
 * Legal forward occurrence transitions ONLY. The state machine is
 * forward-only:
 *
 *   reserved → publishing         (begin publication; lease acquired)
 *   reserved → rejected           (pre-publication validation failure)
 *   publishing → published        (success)
 *   publishing → rejected         (publication failure)
 *
 * Same-state (e.g. `publishing → publishing` re-mark) and every other pair
 * (backward, terminal-exit, skip) are illegal — handled by the caller as
 * `no_op` (same state) or `illegal_source_state` (otherwise). Terminal states
 * refuse every further transition (the one-way door).
 *
 * The `reserved → rejected` edge (vs. the attempt matrix's
 * `pending → rejected_validation` direct-from-reservation terminal) is the
 * reservation-time validation failure exit: the Phase 2 reservation tx may
 * detect an invalid schedule state (disabled mid-tx, template missing,
 * ordinal overflow) AFTER the occurrence row exists but BEFORE any
 * publication begins. Without this edge, the only escape from `reserved`
 * would be `publishing`, forcing a bogus publish attempt on an occurrence
 * already known to be invalid.
 */
export function isLegalOccurrenceForward(
  from: ScheduledOccurrenceState,
  to: ScheduledOccurrenceState,
): boolean {
  if (from === "reserved") return to === "publishing" || to === "rejected";
  if (from === "publishing") return to === "published" || to === "rejected";
  return false; // terminal states refuse every further transition
}

// ---------------------------------------------------------------------------
// Reservation input + result
// ---------------------------------------------------------------------------

/**
 * Reservation directive for {@link reserveOccurrenceWithClient}. The
 * occurrence's identity is the unique pair `(scheduledTaskId, scheduledFor)`
 * (the `uq_scheduled_occurrences_schedule_due` partial unique index); `id` is
 * the caller-allocated row primary key.
 *
 * The caller — Phase 2's `reserveScheduledOccurrence` — allocates `id`
 * OUTSIDE the primitive so the reservation tx can stage other writes keyed by
 * the same id before calling this (mirrors how the aggregate publisher takes
 * `attemptIds` from outside — `templateAggregatePublication.ts` Phase 2
 * signature correction). When omitted, the primitive mints a fresh `uuid()`.
 *
 * NO `habitatId` field: the table has no such column (T1 ships without it —
 * `scheduled_task_id` and `created_mission_id` are plain text / non-cascading
 * and the occurrence is operational history that outlives habitat replacement;
 * `habitatId` is recoverable via the schedule at read time). Adding a column
 * would require a new migration + drizzle schema update +
 * `test:production-migration` — out of Phase 1 scope.
 */
export interface ReserveOccurrenceInput {
  /** Caller-allocated occurrence id; minted when omitted. */
  id?: string;
  /** The schedule this occurrence belongs to (plain text, non-cascading). */
  scheduledTaskId: string;
  /** ISO timestamp this occurrence is due (uniqueness coordinate #2). */
  scheduledFor: string;
  /** Zero-based ordinal — Nth firing of this schedule. */
  ordinal: number;
  /** Optional frozen schedule/template revision snapshot at reservation time. */
  scheduleRevision?: ScheduleRevisionJson;
}

/**
 * Outcome of {@link reserveOccurrenceWithClient}. Closed discriminated union
 * — never throws for an expected reservation decision; only infrastructure
 * failures (retryable transport) throw.
 *
 * - `created`        — fresh `(scheduledTaskId, scheduledFor)` pair; a new
 *                      `reserved` occurrence row was inserted.
 * - `already_exists` — the partial unique index
 *                      `uq_scheduled_occurrences_schedule_due` guarantees
 *                      idempotency: a concurrent reservation (or a same-key
 *                      retry) already committed a row for this pair. The
 *                      stored row is returned UNCHANGED in its CURRENT state
 *                      (reserved / publishing / published / rejected) — the
 *                      caller decides whether to no-op the surrounding
 *                      schedule-advance (Phase 2) based on this state.
 *
 * Mirrors the idempotent re-read pattern in `triageClusterMissions.create`
 * (UNIQUE-violation catch → re-read existing row) and the
 * `reserveAttemptWithClient` `created` / `replayed` distinction — but simpler
 * because the occurrence reservation has no fingerprint-mismatch dimension
 * (the pair `(scheduledTaskId, scheduledFor)` is itself the canonical
 * request; a same-key reserve IS the same request by construction).
 */
export type OccurrenceReservationResult =
  | { outcome: "created"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "already_exists"; occurrence: ScheduledOccurrenceRow };

// ---------------------------------------------------------------------------
// Lease + transition inputs / results
// ---------------------------------------------------------------------------

/** Worker-lease directive shared by acquire / renew. */
export interface OccurrenceLeaseDirective {
  /** Worker claiming ownership of this occurrence's publication. */
  leaseOwner: string;
  /** ISO timestamp at which the lease expires (the recovery worker's signal). */
  leaseExpiresAt: string;
}

/**
 * Directive for {@link markOccurrencePublishingWithClient}. Combines the
 * state transition with lease installation (the fused acquire: the FIRST
 * worker to CAS into `publishing` owns the lease — there is no separate
 * lease primitive for the `reserved` state because no work happens there).
 *
 * `attemptId` is the OPTIONAL coordination handle stamped on the row (the
 * table's singular `attempt_id` column). Per T9A design question #1, this
 * column's role is being refined in Phase 3 — it may store a coordination/
 * tracking attempt id (NOT the per-Task attempts, which the Phase 3 publisher
 * reserves with `sourceScopeId = occurrence.id`, mirroring the triage
 * adapter's N-attempt reservation). Phase 1 stamps the value when supplied
 * and leaves it NULL otherwise.
 */
export interface OccurrencePublishingDirective extends OccurrenceLeaseDirective {
  /** Optional coordination handle (design question #1 — Phase 3 resolves). */
  attemptId?: string;
}

/**
 * Directive for {@link markOccurrencePublishedWithClient}. Stamps the created
 * Mission id + optional compact result + optional coordination attempt id.
 * The lease is RETIRED atomically with the transition (terminal occurrences
 * have no meaningful lease).
 *
 * T9A-08 (T9B Phase 1 fencing): `leaseOwner` is the EXPECTED owner — the
 * terminal CAS predicate checks `leaseOwner = expected` so a STALE worker
 * (whose lease was reclaimed by T9B's recovery worker) CANNOT terminalize
 * + clear the new owner's lease. The production path (the Phase-3
 * participant) always carries the publisher's non-null `leaseOwner`. The
 * type is `string | null`: `null` is the expected owner for the
 * `reserved → rejected` edge (a `reserved` occurrence carries no lease —
 * there is nothing to fence; `null` matches the row's NULL `leaseOwner`
 * via the CAS's `isNull` predicate).
 */
export interface OccurrencePublishedDirective {
  /**
   * The expected lease owner (T9A-08 fencing). The terminal CAS checks
   * `leaseOwner = expected`; a mismatch (the caller is no longer the
   * owner — a T9B takeover happened) returns `not_owner`. The production
   * path (the publisher) always passes its non-null worker id; `null` is
   * the expected owner for source states that carry no lease.
   */
  leaseOwner: string | null;
  /** The Mission this occurrence created (plain text, non-cascading). */
  createdMissionId: string;
  /** Optional coordination handle (design question #1 — Phase 3 resolves). */
  attemptId?: string;
  /** Optional compact success result (Mission id, timing, etc.). */
  result?: OccurrenceResultJson;
}

/**
 * Directive for {@link markOccurrenceRejectedWithClient}. Stamps the failure
 * result + optional coordination attempt id. The lease is RETIRED atomically.
 *
 * T9A-08 (T9B Phase 1 fencing): `leaseOwner` is the EXPECTED owner — see
 * {@link OccurrencePublishedDirective.leaseOwner} for the full rationale.
 */
export interface OccurrenceRejectedDirective {
  /** The expected lease owner (T9A-08 fencing) — see {@link OccurrencePublishedDirective}. */
  leaseOwner: string | null;
  /** Optional coordination handle (design question #1 — Phase 3 resolves). */
  attemptId?: string;
  /** Compact failure result (Task errors, veto reasons, validation diagnostics). */
  result: OccurrenceResultJson;
}

/**
 * Closed result of {@link markOccurrencePublishingWithClient} — the fused
 * state-transition + lease-acquire CAS. Never throws for an expected decision;
 * only infrastructure failures (retryable transport) throw.
 *
 * - `transitioned`        — this call's CAS UPDATE matched exactly one row:
 *                           the occurrence moved `reserved → publishing` AND
 *                           the lease was installed for `leaseOwner`. The
 *                           caller holds the lease and may proceed with
 *                           publication.
 * - `already_publishing`  — a CONCURRENT worker already transitioned this
 *                           occurrence to `publishing` and holds an ACTIVE
 *                           lease; this call's CAS predicate `state='reserved'`
 *                           matched zero rows. The caller did NOT acquire the
 *                           lease and must NOT proceed with publication (a
 *                           different worker owns the work). The current row
 *                           is returned for diagnostics. Distinct from
 *                           `illegal_source_state` (a terminal row) so the
 *                           publisher can distinguish "lost the race" from
 *                           "the occurrence is closed".
 * - `illegal_source_state`— the occurrence is in a TERMINAL state
 *                           (`published` or `rejected`); the transition is
 *                           refused, the row is returned UNCHANGED.
 *                           `fromState` carries the terminal state for
 *                           diagnostics.
 * - `not_found`           — no occurrence row exists for `id` (typed
 *                           not-found, no throw).
 *
 * Note: T9B's expired-lease reclaim path (out of scope here) does NOT route
 * through this primitive — it will use a separate
 * `reacquireExpiredOccurrenceLease` conditioned on `state='publishing' AND
 * leaseExpiresAt < now`, layered additively. `markOccurrencePublishingWithClient`
 * ONLY accepts `reserved` source state because that is the only point at
 * which a fresh worker can BEGIN publication.
 */
export type OccurrencePublishingResult =
  | { outcome: "transitioned"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "already_publishing"; occurrence: ScheduledOccurrenceRow }
  | {
      outcome: "illegal_source_state";
      occurrence: ScheduledOccurrenceRow;
      fromState: ScheduledOccurrenceState;
    }
  | { outcome: "not_found" };

/**
 * Closed result of {@link markOccurrencePublishedWithClient} /
 * {@link markOccurrenceRejectedWithClient} — terminalization through the
 * compare-and-set transition matrix (mirrors
 * `completeAttemptWithClient`'s `completed` / `no_op` / `rejected_transition`).
 * Never throws for an expected completion decision; only infrastructure
 * failures (retryable transport) throw.
 *
 * - `transitioned`        — the legal `fromState → targetTerminal` CAS UPDATE
 *                           matched exactly one row (this call installed the
 *                           terminal state, result, created-Mission id, and
 *                           retired the lease).
 * - `no_op`               — the occurrence was ALREADY in the requested
 *                           terminal state (idempotent replay): the CAS
 *                           `state = fromState` predicate matched zero rows
 *                           because a concurrent terminalization won, OR a
 *                           replay reached this layer. The authoritative
 *                           terminal row is returned UNCHANGED — the loser
 *                           never overwrites the winner's result.
 * - `not_owner`           — T9A-08 (T9B Phase 1 fencing): the row is still in
 *                           the expected `fromState` BUT the `leaseOwner` no
 *                           longer matches the directive's expected owner.
 *                           A T9B lease-reclaim transferred the lease to a
 *                           new worker; the caller is the STALE owner and
 *                           MUST NOT proceed (the new owner's lease is
 *                           preserved UNCHANGED). Distinct from `no_op` (the
 *                           occurrence is NOT terminal — it is still in the
 *                           source state) and from `illegal_source_state`
 *                           (the source state IS legal — the caller just lost
 *                           the lease) so the caller can distinguish "lost
 *                           the lease" from "the occurrence is already
 *                           terminal" / "illegal transition".
 * - `illegal_source_state`— the current state does not have a legal forward
 *                           edge to the requested terminal (e.g.
 *                           `published → rejected` cross-terminal, or a
 *                           transition out of a terminal state). The row is
 *                           returned UNCHANGED; `fromState` carries the
 *                           current state for diagnostics.
 * - `not_found`           — no occurrence row exists for `id` (typed
 *                           not-found, no throw).
 */
export type OccurrenceTerminalResult =
  | { outcome: "transitioned"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "no_op"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_owner"; occurrence: ScheduledOccurrenceRow }
  | {
      outcome: "illegal_source_state";
      occurrence: ScheduledOccurrenceRow;
      fromState: ScheduledOccurrenceState;
    }
  | { outcome: "not_found" };

/**
 * Closed result of {@link renewOccurrenceLeaseWithClient}. Only the current
 * owner can extend the lease; a non-owner (including a worker that took over
 * an expired lease via the future T9B reclaim path) is refused without
 * mutation.
 *
 * - `renewed`   — caller IS the current owner; `leaseExpiresAt` extended.
 * - `not_owner` — caller is NOT the owner (or the lease was cleared); no
 *                 mutation.
 * - `not_found` — no occurrence row exists for `id`.
 */
export type OccurrenceLeaseRenewResult =
  | { outcome: "renewed"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_owner"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_found" };

/**
 * Closed result of {@link releaseOccurrenceLeaseWithClient}. Only the current
 * owner can clear the lease; a non-owner release is refused without mutation.
 *
 * - `released`  — caller IS the current owner; `leaseOwner`/`leaseExpiresAt`
 *                 cleared.
 * - `not_owner` — caller is NOT the owner (or the lease was already clear);
 *                 no mutation.
 * - `not_found` — no occurrence row exists for `id`.
 */
export type OccurrenceLeaseReleaseResult =
  | { outcome: "released"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_owner"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// Reservation primitive
// ---------------------------------------------------------------------------

/**
 * Reserves a scheduled occurrence on the caller-supplied client. The caller
 * owns the transaction: inside `db.transaction((tx) =>
 * reserveOccurrenceWithClient(tx, input))` the reservation is atomic with the
 * surrounding writes (the Phase 2 reservation tx composes this with the
 * schedule-advance CAS + one-shot disablement). Never calls `getDb()`, never
 * opens its own transaction, never emits external effects.
 *
 * Concurrency model (load-bearing — mirrors `triageClusterMissions.create`
 * + `reserveAttemptWithClient`): the partial unique index
 * `uq_scheduled_occurrences_schedule_due` enforces "concurrent
 * same-`(scheduledTaskId, scheduledFor)` → one occurrence". The primitive
 * pre-check SELECTs for the fast idempotent-replay path (the common
 * concurrent-reservation / status-poll case resolves without throwing
 * through the UNIQUE violation), then INSERTs; on UNIQUE hit (a concurrent
 * same-key insert won the race between the SELECT and INSERT — SQLite
 * serializes writers, so by the time we catch, the winning row is durable on
 * the passed client), the primitive RE-READS the now-committed row and
 * returns `{ outcome: "already_exists" }`. The caller decides whether to
 * no-op the surrounding schedule-advance (Phase 2) based on the returned
 * occurrence's CURRENT state.
 *
 * Throws {@link repositoryCreateError} only on infrastructure failure
 * (retryable transport). Every expected reservation decision is a closed
 * discriminated-union branch — never a thrown exception.
 */
export function reserveOccurrenceWithClient(
  db: TaskPublicationDbClient,
  input: ReserveOccurrenceInput,
): OccurrenceReservationResult {
  // --- 1. Fast path: pre-check SELECT (the common duplicate / status-poll
  // case resolves here without throwing through the UNIQUE violation). The
  // unique index is STILL the race defender — step 3's catch handles the
  // window between this SELECT and the INSERT.
  const existing = db
    .select()
    .from(scheduledOccurrences)
    .where(
      and(
        eq(scheduledOccurrences.scheduledTaskId, input.scheduledTaskId),
        eq(scheduledOccurrences.scheduledFor, input.scheduledFor),
      ),
    )
    .get();
  if (existing) return { outcome: "already_exists", occurrence: existing };

  // --- 2. Fresh pair: INSERT a new reserved occurrence.
  const id = input.id ?? uuid();
  try {
    db.insert(scheduledOccurrences)
      .values({
        id,
        scheduledTaskId: input.scheduledTaskId,
        scheduledFor: input.scheduledFor,
        ordinal: input.ordinal,
        scheduleRevision: input.scheduleRevision ?? null,
        state: "reserved",
      })
      .run();
  } catch (err) {
    // --- 3. Race: a concurrent same-pair insert won between the pre-check
    // SELECT and this INSERT → the unique index fired. Re-read the
    // now-committed row and return it as `already_exists`. SQLite serializes
    // writers, so by the time we catch, the winning row is durable on the
    // passed client.
    if (isUniqueConstraintViolation(err)) {
      const raced = db
        .select()
        .from(scheduledOccurrences)
        .where(
          and(
            eq(scheduledOccurrences.scheduledTaskId, input.scheduledTaskId),
            eq(scheduledOccurrences.scheduledFor, input.scheduledFor),
          ),
        )
        .get();
      if (raced) return { outcome: "already_exists", occurrence: raced };
      // Truly unreachable: the UNIQUE constraint fired, so a matching row MUST
      // exist on this client. Re-throw the original so the caller sees the
      // infrastructure anomaly rather than masking it.
    }
    throw repositoryCreateError("scheduledOccurrence", err as Error, id);
  }

  // Re-read through the SAME client so the returned row reflects anything the
  // caller's transaction has already staged, and so a RETURNING-empty quirk
  // (unreachable-in-production SQLite edge) still resolves correctly.
  const created = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("scheduledOccurrence", undefined, id);
  return { outcome: "created", occurrence: created };
}

/**
 * Convenience wrapper for {@link reserveOccurrenceWithClient} that owns its
 * own short transaction. Use when the reservation is the only write; compose
 * `reserveOccurrenceWithClient` inside a caller-owned `db.transaction` when
 * the reservation must be atomic with other writes (Phase 2's reservation tx
 * — occurrence insert + schedule advance + one-shot disablement).
 */
export function reserveOccurrence(input: ReserveOccurrenceInput): OccurrenceReservationResult {
  return getDb().transaction((tx) => reserveOccurrenceWithClient(tx, input));
}

// ---------------------------------------------------------------------------
// Occurrence-level coordination attempt link (T9A-03 — additive primitive)
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link setOccurrenceAttemptIdWithClient}.
 *
 * - `stamped`          — this call's conditional UPDATE matched exactly one
 *                        row: the occurrence's `attemptId` column was NULL +
 *                        is now the passed coordination-attempt id.
 * - `already_stamped`  — the occurrence already carries a NON-NULL
 *                        `attemptId` (a prior stamp won); this call's
 *                        `attemptId IS NULL` CAS predicate matched zero rows.
 *                        The authoritative row is returned UNCHANGED — a
 *                        loser never overwrites the winner's attempt link.
 *                        Reported instead of a false `stamped` so the caller
 *                        can detect a re-stamp attempt (a programming error
 *                        — the link is one-shot, established at reservation).
 * - `not_found`        — no occurrence row exists for `id` (typed not-found,
 *                        no throw).
 */
export type OccurrenceAttemptLinkResult =
  | { outcome: "stamped"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "already_stamped"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_found" };

/**
 * Stamps the occurrence-level coordination `attemptId` on an existing
 * occurrence row. Used by Phase 2's reservation tx (T9A-03) AFTER reserving
 * the occurrence-level attempt via `reserveAttemptWithClient` to link the
 * attempt to the occurrence row. The link is one-shot: a conditional UPDATE
 * whose WHERE encodes `id AND attemptId IS NULL` — once stamped, later
 * stamps are refused without mutation (`already_stamped`).
 *
 * # Why a dedicated primitive (T9A-03 design choice)
 *
 * `reserveOccurrenceWithClient` is a Phase-1 primitive whose input shape is
 * fixed (id / scheduledTaskId / scheduledFor / ordinal / scheduleRevision).
 * Adding an `attemptId` field to its input would MODIFY the existing
 * primitive — the ticket's constraint is ADDITIVE only. This dedicated
 * sibling composes additively inside Phase 2's reservation tx:
 *
 *   1. `reserveOccurrenceWithClient(db, …)` — INSERT the occurrence row
 *      (attemptId NULL).
 *   2. `reserveAttemptWithClient(db, …)` — reserve the occurrence-level
 *      coordination attempt (`attemptKey:"occurrence"`).
 *   3. `setOccurrenceAttemptIdWithClient(db, occurrence.id, attempt.id)` —
 *      stamp the link (this primitive).
 *
 * All three run inside the caller's transaction — the link commits atomically
 * with the occurrence + attempt (or rolls back together).
 *
 * # Why a CAS (not an unconditional UPDATE)
 *
 * The conditional UPDATE catches a re-stamp programming error as a typed
 * `already_stamped` outcome (defensive — the reservation tx is the only
 * writer, so a re-stamp indicates a bug somewhere in the call chain). It is
 * NOT a race defender: SQLite serializes writers, so a concurrent stamper's
 * UPDATE commits before this call's; the loser sees the winner's row.
 *
 * Never calls `getDb()`, never opens its own tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function setOccurrenceAttemptIdWithClient(
  db: TaskPublicationDbClient,
  id: string,
  attemptId: string,
): OccurrenceAttemptLinkResult {
  let affected: number;
  try {
    db.update(scheduledOccurrences)
      .set({ attemptId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(scheduledOccurrences.id, id),
          // One-shot link: refuse re-stamp once a coordination attempt is
          // already linked.
          isNull(scheduledOccurrences.attemptId),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  // Re-read the authoritative row (return value for both outcomes).
  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  return affected === 1
    ? { outcome: "stamped", occurrence: row }
    : { outcome: "already_stamped", occurrence: row };
}

// ---------------------------------------------------------------------------
// State-transition primitives (CAS-classified — compare-and-set + `SELECT
// changes() AS n`)
// ---------------------------------------------------------------------------

/**
 * Fused state-transition + lease-acquire: advances a `reserved` occurrence to
 * `publishing` AND installs the worker lease in ONE compare-and-set UPDATE
 * whose WHERE encodes BOTH preconditions:
 *   1. the occurrence is in `state='reserved'` (no publication in flight), AND
 *   2. the lease is FREE — `leaseOwner IS NULL OR leaseExpiresAt < now` (an
 *      expired lease is takeable = safe takeover — defense in depth; in
 *      practice a `reserved` row carries no lease by construction, but the
 *      predicate is robust to a future reclaim flow that may stage a
 *      pre-lease on a reserved row).
 *
 * The WHERE predicate IS the entire defense — there is no read-then-decide
 * race window. A concurrent publisher's CAS is serialized by SQLite
 * (single-writer): the first UPDATE matches and commits; the second
 * publisher's UPDATE no-ops (the first's transition moved state out of
 * `reserved`). Outcome is classified from the UPDATE's affected-row count
 * via `SELECT changes() AS n` (portable across both backends — MEMORY.md):
 * exactly one changed row → `transitioned`; zero rows → the re-read
 * distinguishes `already_publishing` (a concurrent publisher now owns an
 * active lease on a `publishing` row) / `illegal_source_state` (a terminal
 * row refuses the transition) / `not_found` (no row).
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function markOccurrencePublishingWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: OccurrencePublishingDirective,
): OccurrencePublishingResult {
  const now = new Date().toISOString();

  let affected: number;
  try {
    db.update(scheduledOccurrences)
      .set({
        state: "publishing",
        leaseOwner: directive.leaseOwner,
        leaseExpiresAt: directive.leaseExpiresAt,
        ...(directive.attemptId !== undefined ? { attemptId: directive.attemptId } : {}),
      })
      .where(
        and(
          eq(scheduledOccurrences.id, id),
          eq(scheduledOccurrences.state, "reserved"),
          // Free lease: no owner, OR an expired (takeable) lease. Defense in
          // depth — `reserved` rows carry no lease by construction, but this
          // predicate is robust to any future flow that pre-stages a lease.
          or(isNull(scheduledOccurrences.leaseOwner), lt(scheduledOccurrences.leaseExpiresAt, now)),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  // Re-read to classify the zero-row case (and to return the current row).
  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  // This call installed the transition + lease (the reserved/free-lease CAS
  // matched) → publishing with the lease owned by directive.leaseOwner.
  if (affected === 1) return { outcome: "transitioned", occurrence: row };

  // affected === 0: classify why from the actual row state.
  const fromState = row.state as ScheduledOccurrenceState;
  if (TERMINAL_OCCURRENCE_STATES.has(fromState)) {
    return { outcome: "illegal_source_state", occurrence: row, fromState };
  }
  // The row is `publishing` (the only non-terminal state past `reserved`) — a
  // concurrent publisher won the race and owns an active lease.
  return { outcome: "already_publishing", occurrence: row };
}

/**
 * Terminalizes a `publishing` occurrence to `published` AND stamps the
 * created Mission id + optional compact result + optional coordination
 * `attemptId`, AND RETIRES the lease (`leaseOwner`/`leaseExpiresAt` cleared)
 * in ONE compare-and-set UPDATE. The terminal-lock CAS predicate is
 * `state='publishing' AND leaseOwner = directive.leaseOwner` (T9A-08 fencing
 * — see {@link terminalizeWithClient}); a concurrent terminalization's UPDATE
 * no-ops (the first commit wins; the loser never overwrites the winner's
 * result), and a STALE worker whose lease was reclaimed by T9B's recovery
 * worker surfaces as `not_owner` (the new owner's lease is preserved).
 *
 * Decision order (all on the passed client):
 *   1. Read the current row (in-tx decision support).
 *   2. Terminal fast-path: already `published` → `no_op` returning the
 *      authoritative terminal row UNCHANGED (idempotent replay).
 *   3. Legal-pair check via {@link isLegalOccurrenceForward}: any non-`publishing`
 *      source (incl. `rejected` cross-terminal, `reserved` skip) →
 *      `illegal_source_state`.
 *   4. CAS UPDATE `WHERE id AND state='publishing' AND leaseOwner=expected`;
 *      classify from `SELECT changes() AS n`. One row → `transitioned`; zero
 *      rows → `not_owner` (row still `publishing` but owner changed — a T9B
 *      takeover) OR `no_op` (row moved — a concurrent terminalization won).
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure.
 */
export function markOccurrencePublishedWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: OccurrencePublishedDirective,
): OccurrenceTerminalResult {
  return terminalizeWithClient(db, id, "published", directive);
}

/**
 * Terminalizes a `publishing` OR `reserved` occurrence to `rejected` AND
 * stamps the failure result + optional coordination `attemptId`, AND RETIRES
 * the lease. The legal source states for `rejected` are BOTH `publishing`
 * (publication failure — Task invalid/vetoed) AND `reserved` (pre-publication
 * validation failure detected before publication began — see
 * {@link isLegalOccurrenceForward}). The CAS predicate is
 * `state IN (legal-source-states) AND leaseOwner = directive.leaseOwner`
 * (T9A-08 fencing — see {@link terminalizeWithClient}); for the `publishing`
 * source the directive passes the publisher's worker id, and for the
 * `reserved` source it passes `null` (a `reserved` occurrence carries no
 * lease — the CAS's `isNull(leaseOwner)` predicate matches the row's NULL).
 *
 * Decision order mirrors {@link markOccurrencePublishedWithClient}: terminal
 * fast-path on already-`rejected` → `no_op`; legal-pair check →
 * `illegal_source_state` for `published` cross-terminal; CAS classify from
 * `SELECT changes()` → `transitioned` / `not_owner` (T9B takeover) / `no_op`.
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure.
 */
export function markOccurrenceRejectedWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: OccurrenceRejectedDirective,
): OccurrenceTerminalResult {
  return terminalizeWithClient(db, id, "rejected", directive);
}

// ---------------------------------------------------------------------------
// Worker-lease primitives (renew / release — acquire is FUSED into
// `markOccurrencePublishingWithClient`; the renew/release mirror the attempt
// repo's `renewAttemptLeaseWithClient` / `releaseAttemptLeaseWithClient`)
// ---------------------------------------------------------------------------

/**
 * Extends `leaseExpiresAt` ONLY IF the caller is the current `leaseOwner`.
 * Compare-and-set UPDATE (`WHERE id AND leaseOwner = caller`); re-read
 * classifies. A non-owner renew is refused without mutation (no steal —
 * mirrors `renewAttemptLeaseWithClient`).
 *
 * Renew does NOT check terminal state: extending a lease you already own on a
 * since-terminalized occurrence is harmless (the terminal transitions already
 * retired the lease, so a terminal row's `leaseOwner` is NULL — this call's
 * CAS predicate naturally no-ops as `not_owner`). The publisher decides
 * whether to renew dead work; T9B's recovery worker handles reclaim.
 *
 * Never calls `getDb()`.
 */
export function renewOccurrenceLeaseWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: OccurrenceLeaseDirective,
): OccurrenceLeaseRenewResult {
  try {
    db.update(scheduledOccurrences)
      .set({ leaseExpiresAt: directive.leaseExpiresAt })
      .where(
        and(
          eq(scheduledOccurrences.id, id),
          eq(scheduledOccurrences.leaseOwner, directive.leaseOwner),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" };
  // The conditional UPDATE matched (we still own it) → renewed.
  if (row.leaseOwner === directive.leaseOwner) {
    return { outcome: "renewed", occurrence: row };
  }
  // We did not own it (or a concurrent takeover cleared/reassigned it).
  return { outcome: "not_owner", occurrence: row };
}

/**
 * Clears `leaseOwner`/`leaseExpiresAt` ONLY IF the caller is the current
 * `leaseOwner`. Pre-reads to disambiguate "we just cleared it" (`released`)
 * from "it was already clear / owned by another" (`not_owner`); the
 * subsequent compare-and-set UPDATE (`WHERE id AND leaseOwner = caller`)
 * makes a concurrent takeover between read and write surface as `not_owner`
 * on re-read (mirrors `releaseAttemptLeaseWithClient`).
 *
 * Never calls `getDb()`.
 */
export function releaseOccurrenceLeaseWithClient(
  db: TaskPublicationDbClient,
  id: string,
  leaseOwner: string,
): OccurrenceLeaseReleaseResult {
  const current = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .get();
  if (!current) return { outcome: "not_found" };
  // Fast refusal: not our lease → no mutation attempt.
  if (current.leaseOwner !== leaseOwner) {
    return { outcome: "not_owner", occurrence: current };
  }

  try {
    db.update(scheduledOccurrences)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(scheduledOccurrences.id, id), eq(scheduledOccurrences.leaseOwner, leaseOwner)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" }; // vanished mid-call (data anomaly)
  // Cleared (by us) → released. A concurrent re-acquire would set a new owner.
  if (row.leaseOwner === null) {
    return { outcome: "released", occurrence: row };
  }
  // Concurrent takeover re-acquired the lease between our UPDATE and re-read.
  return { outcome: "not_owner", occurrence: row };
}

// ---------------------------------------------------------------------------
// Expired-lease RECLAIM (T9B Phase 1 — the recovery worker's takeover path)
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link reacquireExpiredOccurrenceLeaseWithClient}.
 *
 * - `reclaimed`           — the CAS matched: the occurrence was
 *                           `state='publishing'` AND `leaseExpiresAt < now`.
 *                           The lease is now owned by the directive's
 *                           `leaseOwner` with the supplied `leaseExpiresAt`.
 *                           The new owner MAY proceed with publication (the
 *                           fenced terminalization ensures the new owner is
 *                           authoritative — a stale worker's terminalization
 *                           returns `not_owner`).
 * - `not_expired`         — the occurrence IS `publishing` BUT the lease has
 *                           NOT observably expired (`leaseExpiresAt >= now`,
 *                           or `leaseExpiresAt IS NULL` — a data anomaly
 *                           treated defensively as "not reclaimable"). No
 *                           mutation; the current owner's lease is preserved.
 * - `illegal_source_state`— the occurrence is NOT `publishing` (`reserved`,
 *                           `published`, or `rejected`). A terminal occurrence
 *                           is never reclaimable (the lease was retired by the
 *                           terminal transition); a `reserved` occurrence
 *                           carries no lease to reclaim. No mutation;
 *                           `fromState` carries the current state.
 * - `not_found`           — no occurrence row exists for `id`.
 */
export type OccurrenceLeaseReclaimResult =
  | { outcome: "reclaimed"; occurrence: ScheduledOccurrenceRow }
  | { outcome: "not_expired"; occurrence: ScheduledOccurrenceRow }
  | {
      outcome: "illegal_source_state";
      occurrence: ScheduledOccurrenceRow;
      fromState: ScheduledOccurrenceState;
    }
  | { outcome: "not_found" };

/**
 * Reclaims an EXPIRED worker lease on a `publishing` occurrence for a new
 * owner (T9B Phase 1 — the recovery worker's takeover path). A CAS UPDATE
 * conditioned on `id AND state='publishing' AND leaseExpiresAt < now`
 * atomically transfers the lease to the directive's `leaseOwner` +
 * `leaseExpiresAt`. The fenced terminalization ({@link terminalizeWithClient}
 * — T9A-08) ensures the new owner is AUTHORITATIVE: a stale worker's
 * subsequent `markOccurrencePublishedWithClient` / `markOccurrenceRejectedWithClient`
 * returns `not_owner` (the CAS predicate checks `leaseOwner = expected`).
 *
 * # The two-primitive contract (reclaim + fenced terminalize)
 *
 * The recovery flow is TWO primitives composed by the phase-2 worker:
 *   1. `reacquireExpiredOccurrenceLeaseWithClient(db, id, {leaseOwner, leaseExpiresAt})`
 *      → `{outcome:"reclaimed"}` (the recovery owner now holds the lease).
 *   2. Re-drive `publishScheduledOccurrence` under the reclaimed lease. The
 *      publisher's `markOccurrencePublishingWithClient` call refuses a
 *      `publishing` occurrence with an ACTIVE lease — the worker must reclaim
 *      FIRST (this primitive), then the re-drive's terminalization uses the
 *      reclaimed owner. A stale worker who runs terminalization concurrently
 *      with the recovery's re-drive surfaces as `not_owner` (the fenced CAS
 *      catches the owner mismatch).
 *
 * # NULL `leaseExpiresAt` handling
 *
 * A `publishing` occurrence always carries a non-null `leaseExpiresAt` (set
 * by `markOccurrencePublishingWithClient`). A NULL `leaseExpiresAt` on a
 * `publishing` occurrence is a data anomaly; the CAS predicate
 * `lt(leaseExpiresAt, now)` does NOT match NULL (SQL NULL comparison), so the
 * reclaim returns `not_expired` (defensive — the lease is not observably
 * expired, so it is not reclaimable). The recovery worker skips it.
 *
 * # Concurrency
 *
 * SQLite serializes writers; two concurrent recovery workers on the same
 * expired lease: the first CAS matches + commits (transferring the lease +
 * setting a future `leaseExpiresAt`); the second worker's CAS predicate
 * `leaseExpiresAt < now` no longer matches (the first commit set a future
 * expiry) → `not_expired`. The second worker sees the lease as "not expired"
 * — accurate from its perspective (the first worker reclaimed it).
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function reacquireExpiredOccurrenceLeaseWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: OccurrenceLeaseDirective,
): OccurrenceLeaseReclaimResult {
  const now = new Date().toISOString();
  let affected: number;
  try {
    db.update(scheduledOccurrences)
      .set({
        leaseOwner: directive.leaseOwner,
        leaseExpiresAt: directive.leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledOccurrences.id, id),
          eq(scheduledOccurrences.state, "publishing"),
          // Expired-lease predicate: `leaseExpiresAt < now`. NULL
          // `leaseExpiresAt` (a data anomaly on a `publishing` row) does NOT
          // match — `lt(NULL, now)` is SQL NULL, not TRUE → the reclaim
          // returns `not_expired` (defensive — not observably expired).
          lt(scheduledOccurrences.leaseExpiresAt, now),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  // Re-read the authoritative row (return value for all outcomes + the
  // classification signal for the zero-row case).
  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "reclaimed", occurrence: row };

  // affected === 0: classify from the live row. The CAS predicate
  // `state='publishing' AND leaseExpiresAt < now` failed — distinguish
  // "wrong state" (terminal/reserved) from "lease not expired".
  const fromState = row.state as ScheduledOccurrenceState;
  if (fromState !== "publishing") {
    return { outcome: "illegal_source_state", occurrence: row, fromState };
  }
  // `state='publishing'` but the lease is NOT reclaimable: either
  // `leaseExpiresAt >= now` (still active) or `leaseExpiresAt IS NULL`
  // (data anomaly). Both surface as `not_expired`.
  return { outcome: "not_expired", occurrence: row };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Reads a single occurrence by id on the caller-supplied client. Pure read —
 * `undefined` when missing (typed not-found at the read layer; the
 * transition primitives surface a typed `{ outcome: "not_found" }` instead).
 */
export function getOccurrenceWithClient(
  db: TaskPublicationDbClient,
  id: string,
): ScheduledOccurrenceRow | undefined {
  return db.select().from(scheduledOccurrences).where(eq(scheduledOccurrences.id, id)).get();
}

/**
 * Reads a single occurrence by its uniqueness pair `(scheduledTaskId,
 * scheduledFor)`. Pure read — `undefined` when missing. Used by Phase 2's
 * reservation tx to pre-flight an idempotent re-read + by the Phase 3
 * publisher's status-poll path.
 */
export function getOccurrenceByScheduleAndDueWithClient(
  db: TaskPublicationDbClient,
  scheduledTaskId: string,
  scheduledFor: string,
): ScheduledOccurrenceRow | undefined {
  return db
    .select()
    .from(scheduledOccurrences)
    .where(
      and(
        eq(scheduledOccurrences.scheduledTaskId, scheduledTaskId),
        eq(scheduledOccurrences.scheduledFor, scheduledFor),
      ),
    )
    .get();
}

/** Pagination options for the list reads (default limit 100, mirrors
 * `listByHabitatBetween` per MEMORY.md § Triage & automation specifics). */
export interface OccurrenceListOptions {
  /** Max rows to return. Defaults to 100 (matches `listByHabitatBetween`). */
  limit?: number;
  /** Zero-based offset for paginated reads. */
  offset?: number;
}

/**
 * Lists occurrences in a given state, ordered by `createdAt` ascending (the
 * recovery worker's natural scan order — oldest first). Pure read.
 *
 * Default `limit = 100` (MEMORY.md: `listByHabitatBetween`'s default — pass an
 * explicit limit for scan queries).
 */
export function listOccurrencesInStateWithClient(
  db: TaskPublicationDbClient,
  state: ScheduledOccurrenceState,
  opts: OccurrenceListOptions = {},
): ScheduledOccurrenceRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.state, state))
    .orderBy(scheduledOccurrences.createdAt)
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * Lists occurrences for a given schedule, ordered by `scheduledFor` ascending
 * (chronological firing order — the schedule-history scan). Pure read.
 *
 * Default `limit = 100` (MEMORY.md).
 */
export function listOccurrencesForScheduleWithClient(
  db: TaskPublicationDbClient,
  scheduledTaskId: string,
  opts: OccurrenceListOptions = {},
): ScheduledOccurrenceRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.scheduledTaskId, scheduledTaskId))
    .orderBy(scheduledOccurrences.scheduledFor)
    .limit(limit)
    .offset(offset)
    .all();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Shared terminalization CAS for {@link markOccurrencePublishedWithClient} /
 * {@link markOccurrenceRejectedWithClient}. Computes the legal source-state
 * set from the matrix, runs the terminal fast-path, the legal-pair check, and
 * the CAS-classified UPDATE. Private to this module.
 *
 * The CAS predicate encodes THREE preconditions: (1) the row id, (2) the
 * legal-source-set membership (`state = fromState` — the one-way door + the
 * forward invariant), AND (3) T9A-08 fencing — the row's `leaseOwner` equals
 * the directive's expected owner. The owner predicate is `eq(leaseOwner,
 * expected)` when the expected owner is a string (the production path — a
 * `publishing` occurrence with a live lease), or `isNull(leaseOwner)` when
 * the expected owner is `null` (the `reserved → rejected` edge — a
 * `reserved` occurrence carries no lease, so `null` matches the row's NULL
 * `leaseOwner`). This makes the affected-row count the entire signal for
 * `transitioned` vs `no_op` / `not_owner`:
 *   - 1 row  → `transitioned` (this call installed the terminal).
 *   - 0 rows → the re-read distinguishes `not_owner` (the row is still in
 *              `fromState` but `leaseOwner` changed — a T9B takeover) from
 *              `no_op` (the row moved to any other state — a concurrent
 *              terminalization won).
 */
function terminalizeWithClient(
  db: TaskPublicationDbClient,
  id: string,
  target: "published" | "rejected",
  directive: OccurrencePublishedDirective | OccurrenceRejectedDirective,
): OccurrenceTerminalResult {
  // 1. In-tx read of the current state (supports the legal-pair + CAS decision).
  const current = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!current) return { outcome: "not_found" };

  const fromState = current.state as ScheduledOccurrenceState;

  // 2. Terminal fast-path: already in the requested terminal → idempotent
  //    `no_op` returning the authoritative terminal row UNCHANGED. A prior
  //    terminalization wins; a loser never overwrites the winner's result.
  //    (The lease was retired by the prior terminalization, so the owner
  //    check is irrelevant here — the fast-path returns BEFORE the CAS.)
  if (fromState === target) {
    return { outcome: "no_op", occurrence: current };
  }

  // 3. Legal-pair check on the matrix. Rejects cross-terminal (e.g.
  //    `published → rejected`), backward, and out-of-terminal transitions.
  if (!isLegalOccurrenceForward(fromState, target)) {
    return { outcome: "illegal_source_state", occurrence: current, fromState };
  }

  // 4. Compare-and-set terminalization: the legal-source-set CAS predicate
  //    is the one-way door. `state = fromState` guards against state drift
  //    between the read and the UPDATE; the legal-source set is encoded by
  //    the matrix check above (we already know `fromState` is legal). The
  //    T9A-08 owner predicate fences the terminalization against a stale
  //    worker whose lease was reclaimed by T9B's recovery worker.
  //    NULL-safe: the directive's `leaseOwner` may be `null` (the
  //    `reserved → rejected` edge — no lease to fence); drizzle's `eq`
  //    cannot compare NULL (SQL `NULL = NULL` is NULL, not TRUE), so the
  //    predicate switches to `isNull(leaseOwner)` when the expected owner
  //    is null.
  const ownerPredicate =
    directive.leaseOwner === null
      ? isNull(scheduledOccurrences.leaseOwner)
      : eq(scheduledOccurrences.leaseOwner, directive.leaseOwner);
  const now = new Date().toISOString();
  let affected: number;
  try {
    db.update(scheduledOccurrences)
      .set({
        state: target,
        // Lease RETIRED atomically with the terminal transition — terminal
        // occurrences have no meaningful lease.
        leaseOwner: null,
        leaseExpiresAt: null,
        // Result + Mission id stamped per directive (rejected has no
        // createdMissionId; published always does).
        ...(target === "published"
          ? {
              createdMissionId: (directive as OccurrencePublishedDirective).createdMissionId,
              result: (directive as OccurrencePublishedDirective).result ?? null,
            }
          : { result: (directive as OccurrenceRejectedDirective).result }),
        ...(directive.attemptId !== undefined ? { attemptId: directive.attemptId } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledOccurrences.id, id),
          eq(scheduledOccurrences.state, fromState),
          ownerPredicate,
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("scheduledOccurrence", err as Error, id);
  }

  // 5. Re-read the authoritative row (return value for all outcomes). When
  //    affected === 1 it is the row we just terminalized; when affected === 0
  //    a concurrent terminalization OR a T9B takeover won, and this is the
  //    winner's row returned UNCHANGED.
  const row = db
    .select()
    .from(scheduledOccurrences)
    .where(eq(scheduledOccurrences.id, id))
    .all()[0];
  if (!row) return { outcome: "not_found" }; // vanished mid-call (data anomaly)

  if (affected === 1) return { outcome: "transitioned", occurrence: row };

  // affected === 0: classify WHY the CAS lost. The row's current state +
  //    leaseOwner vs the directive's expected owner disambiguates the three
  //    losing shapes. The classification order matters: `not_owner` MUST be
  //    tested BEFORE `no_op` because a `not_owner` row is still in
  //    `fromState` (it has NOT moved) — only its `leaseOwner` changed.
  if (row.state === fromState && row.leaseOwner !== directive.leaseOwner) {
    // T9A-08 fencing: the row is still in the expected source state BUT a
    // T9B lease-reclaim transferred the lease to a new owner. The caller is
    // the STALE owner and MUST NOT proceed — the new owner's lease is
    // preserved UNCHANGED.
    return { outcome: "not_owner", occurrence: row };
  }
  // The row moved (to `target` via a concurrent terminalization, or to any
  // other state). The loser never overwrites the winner's result.
  return { outcome: "no_op", occurrence: row };
}

/**
 * Cross-backend UNIQUE-constraint detector — mirrors the composite pattern in
 * `taskCreationAttempts.ts:isUniqueConstraintViolation` (better-sqlite3 throws
 * a `SqliteError` with `code === "SQLITE_CONSTRAINT_UNIQUE"`, drizzle-orm may
 * wrap it on `.cause`, sql.js throws a plain `Error` whose `message` contains
 * "UNIQUE constraint failed"). Composite match per the established project
 * pattern (`wikiService.ts`, `releaseTriggerService.ts`).
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (err instanceof Error && UNIQUE_CONSTRAINT_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (UNIQUE_CONSTRAINT_RE.test(cause.message)) return true;
  }
  return false;
}

const UNIQUE_CONSTRAINT_RE = /UNIQUE constraint failed/i;
