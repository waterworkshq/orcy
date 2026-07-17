/**
 * Task Creation Attempt Protocol — reservation, dedup, replay (T3A Phase 1),
 * worker leases / safe takeover (T3A Phase 3), and compact-vs-detailed
 * retention (T3A Phase 4).
 *
 * DORMANT additive production code: no production origin routes through this
 * module yet. It is tested in isolation against the T1 storage layer
 * (`db/schema/taskPublication.ts` → `task_creation_attempts`). Phase 2 added
 * the compare-and-set transition matrix (forward-only, terminal-locked) in
 * `taskPublication.ts`. Phase 3 adds the worker-lease primitives — acquire /
 * renew / release with safe expired-lease takeover — operating on the
 * existing `leaseOwner`/`leaseExpiresAt` columns (no migration). Phase 4
 * (this module) adds the compact primitive — {@link compactAttemptDetails} /
 * {@link compactAttemptDetailsWithClient} — and the authorized
 * `GET /task-creation-attempts/:id` route (in `routes/taskCreationAttempts.ts`)
 * consumes {@link getAttemptStatus}.
 *
 * Reservation contract (load-bearing):
 *   - Fresh `(source, source-scope, attempt-key)` → INSERT at `state="pending"`,
 *     `reserved_at=now` → `{ outcome: "created" }`.
 *   - Existing key + SAME `requestFingerprint` → REPLAY: return the stored row
 *     verbatim in its CURRENT state (pending / in-flight / terminal) with its
 *     committed IDs and terminal result. No new row, no side effect, no
 *     re-transition. `{ outcome: "replayed" }`.
 *   - Existing key + DIFFERENT `requestFingerprint` → REJECT deterministically
 *     (typed, never thrown): `{ outcome: "rejected_fingerprint" }` carrying the
 *     reserved fingerprint so the caller can surface the mismatch.
 *
 * Concurrency model (load-bearing): the unique index
 * `uq_task_creation_attempts_scope_key` enforces "concurrent same-key → one
 * attempt". `reserveAttemptWithClient` does a pre-check SELECT (the fast replay
 * path for the common duplicate-click / status-poll case) and then INSERTs; on
 * `SQLITE_CONSTRAINT_UNIQUE` (a concurrent same-key insert won the race between
 * the SELECT and INSERT) it re-reads the now-committed row and replays or
 * rejects on fingerprint. SQLite serializes writers, so this is deterministic.
 *
 * The `*WithClient` variant mirrors the Pulse / T1 precedent (`PulseDbClient`,
 * `createPulseWithClient`, the `*WithClient` primitives in `taskPublication.ts`):
 * it accepts a caller-supplied drizzle client (default `getDb()` OR a `tx` from
 * `db.transaction(cb)`) and NEVER calls `getDb()` itself, NEVER opens its own
 * transaction, and NEVER emits external effects (SSE / hooks / webhooks). The
 * publication coordinator (later tickets) composes it inside one
 * `db.transaction((tx) => …)`.
 *
 * See: Task Creation and Clone Technical Plan § "Durable Task Creation Attempts"
 * + § "Reservation and replay".
 */
import { getDb } from "../db/index.js";
import { taskCreationAttempts } from "../db/schema/index.js";
import { and, eq, or, isNull, lt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { isSqliteError } from "../errors/sqlite.js";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";
import type {
  TaskPublicationDbClient,
  CausalContext,
  AttemptTerminalResult,
} from "./taskPublication.js";
import { TERMINAL_ATTEMPT_STATES } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Shared row / state types (re-derived from the schema so callers don't depend
// on the schema module's internals)
// ---------------------------------------------------------------------------

/** A full `task_creation_attempts` row, as selected by drizzle. */
export type TaskCreationAttemptRow = typeof taskCreationAttempts.$inferSelect;

/** The 8-state attempt enum persisted in `task_creation_attempts.state`. */
export type TaskCreationAttemptState =
  | "pending"
  | "rejected_validation"
  | "vetoed"
  | "batch_rejected"
  | "published_pending_observation"
  | "published_pending_assignment"
  | "created"
  | "created_unassigned";

// ---------------------------------------------------------------------------
// Reservation input
// ---------------------------------------------------------------------------

/** Actor provenance union shared across the publication tables. */
export type AttemptActorType =
  | "human"
  | "agent"
  | "system"
  | "remote_human"
  | "remote_orcy"
  | "remote_pod";

/** Publication-kind enum persisted on the attempt row. */
export type AttemptPublicationKind = "create" | "clone" | "scheduled_occurrence" | "habitat_import";

/**
 * Reservation directive for {@link reserveAttempt} /
 * {@link reserveAttemptWithClient}. Uniquely identifies the attempt via the
 * `(source, sourceScopeKind, sourceScopeId, attemptKey)` reservation key and
 * carries the canonical request fingerprint used for same-key dedup / mismatch
 * rejection.
 */
export interface ReserveAttemptInput {
  /** Audit source of the publication (e.g. `"ui"`, `"automation"`, `"schedule"`). */
  source: string;
  /** Scope kind of the reservation key (e.g. `"mission"`, `"schedule"`, `"import"`). */
  sourceScopeKind: string;
  /** Scope id of the reservation key (e.g. mission id, schedule id, import session id). */
  sourceScopeId: string;
  /**
   * Caller-allocated attempt key, unique within `(source, sourceScopeKind,
   * sourceScopeId)`. Interactive clients generate it on first Publish press and
   * retain it across timeouts / repeated clicks / status checks; Automation
   * derives it from Rule Run + action index.
   */
  attemptKey: string;
  /**
   * Canonical fingerprint of the publication request. A same-key reserve with
   * the SAME fingerprint REPLAYS the stored state; a DIFFERENT fingerprint is
   * deterministically rejected. Stabilizes duplicate clicks while rejecting
   * accidental reuse of a key for different work.
   */
  requestFingerprint: string;
  /** Publication kind for this attempt. */
  publicationKind: AttemptPublicationKind;
  /**
   * Authorization scope: the Habitat this attempt belongs to. Persisted at
   * reservation time so the authorized `GET /task-creation-attempts/:attemptId`
   * route can resolve the caller's habitat membership against it (R4). Plain
   * text / non-cascading — survives habitat replacement; the route refuses
   * access when the caller lacks this habitat's membership.
   */
  habitatId: string;
  /** Actor provenance — server-constructed; never trusted from an untrusted caller. */
  actorType: AttemptActorType;
  /** Actor id (user / agent / system identifier). */
  actorId: string;
  /** Optional compact causal context connecting this publication to its origin chain. */
  causalContext?: CausalContext;
}

// ---------------------------------------------------------------------------
// Reservation result — closed discriminated union (NEVER thrown for expected
// outcomes: created / replayed / rejected_fingerprint)
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link reserveAttempt} / {@link reserveAttemptWithClient}. The
 * three branches cover every expected reservation decision; infrastructure
 * failures still throw (they are retryable transport, not domain outcomes — see
 * Technical Plan § "Outcome envelope").
 *
 * - `created`              — fresh key; a new pending attempt was inserted.
 * - `replayed`             — same key + same fingerprint; the stored attempt is
 *                            returned verbatim in its CURRENT state (pending,
 *                            in-flight, or terminal). No side effect, no
 *                            re-transition.
 * - `rejected_fingerprint` — same key + DIFFERENT fingerprint; the reservation
 *                            is refused deterministically. `reservedFingerprint`
 *                            is the stored fingerprint so the caller can surface
 *                            the mismatch. The stored attempt is returned
 *                            read-only for context (it is NOT mutated).
 */
export type AttemptReservationResult =
  | { outcome: "created"; attempt: TaskCreationAttemptRow }
  | { outcome: "replayed"; attempt: TaskCreationAttemptRow }
  | {
      outcome: "rejected_fingerprint";
      attempt: TaskCreationAttemptRow;
      /** Fingerprint already reserved against this key. */
      reservedFingerprint: string;
    };

// ---------------------------------------------------------------------------
// Status-read result (the recovery surface for the later GET route)
// ---------------------------------------------------------------------------

/**
 * Authorized status-read surface returned by {@link getAttemptStatus}. Mirrors
 * the fields the later `GET /task-creation-attempts/:id` route will expose:
 * current state, committed identifiers, terminal result, and recovery metadata
 * (lease + checkpoint timestamps).
 */
export interface AttemptStatus {
  attemptId: string;
  state: TaskCreationAttemptState;
  /** Authorization scope persisted at reservation; the GET route membership-checks against it. */
  habitatId: string | null;
  reservedAt: string;
  publishedAt: string | null;
  completedAt: string | null;
  committedTaskId: string | null;
  committedMissionId: string | null;
  envelopeEventId: string | null;
  reservationId: string | null;
  terminalOutcome: string | null;
  terminalResult: AttemptTerminalResult | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

/** Result of {@link getAttemptStatus}: a typed not-found rather than a throw. */
export type AttemptStatusResult = { found: true; status: AttemptStatus } | { found: false };

// ---------------------------------------------------------------------------
// Reservation primitives
// ---------------------------------------------------------------------------

/**
 * Reserves a task-creation attempt on the caller-supplied client. The caller
 * owns the transaction: inside `db.transaction((tx) =>
 * reserveAttemptWithClient(tx, input))` the reservation is atomic with the
 * surrounding writes. Never calls `getDb()`, never opens its own transaction,
 * never emits external effects.
 *
 * See the module header for the full reservation contract (created / replayed /
 * rejected_fingerprint) and the concurrency model (pre-check SELECT + INSERT +
 * UNIQUE-violation catch-and-replay).
 */
export function reserveAttemptWithClient(
  db: TaskPublicationDbClient,
  input: ReserveAttemptInput,
): AttemptReservationResult {
  // --- 1. Fast path: pre-check SELECT (the common duplicate-click / status
  // poll case resolves here without throwing through the UNIQUE violation).
  // The unique index is STILL the race defender — step 2's catch handles the
  // window between this SELECT and the INSERT.
  const existing = selectByScopeKey(db, input);
  if (existing) return resolveExisting(existing, input.requestFingerprint);

  // --- 2. Fresh key: INSERT a new pending attempt.
  const id = uuid();
  try {
    db.insert(taskCreationAttempts)
      .values({
        id,
        source: input.source,
        sourceScopeKind: input.sourceScopeKind,
        sourceScopeId: input.sourceScopeId,
        attemptKey: input.attemptKey,
        requestFingerprint: input.requestFingerprint,
        publicationKind: input.publicationKind,
        habitatId: input.habitatId,
        actorType: input.actorType,
        actorId: input.actorId,
        causalContext: input.causalContext ?? null,
        state: "pending",
      })
      .run();
  } catch (err) {
    // --- 3. Race: a concurrent same-key insert won between the pre-check
    // SELECT and this INSERT → the unique index fired. Re-read the now-committed
    // row and replay or reject on fingerprint. SQLite serializes writers, so by
    // the time we catch, the winning row is durable on the passed client.
    if (isUniqueConstraintViolation(err)) {
      const raced = selectByScopeKey(db, input);
      if (raced) return resolveExisting(raced, input.requestFingerprint);
      // Truly unreachable: the UNIQUE constraint fired, so a matching row MUST
      // exist on this client. Re-throw the original so the caller sees the
      // infrastructure anomaly rather than masking it.
    }
    throw repositoryCreateError("taskCreationAttempt", err as Error, id);
  }

  // Re-read through the SAME client so the returned row reflects anything the
  // caller's transaction has already staged, and so a RETURNING-empty quirk
  // (unreachable-in-production SQLite edge) still resolves correctly.
  const created = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("taskCreationAttempt", undefined, id);
  return { outcome: "created", attempt: created };
}

/**
 * Convenience wrapper for {@link reserveAttemptWithClient} that owns its own
 * short transaction. Use when the reservation is the only write; compose
 * `reserveAttemptWithClient` inside a caller-owned `db.transaction` when the
 * reservation must be atomic with other writes (e.g. a publication
 * coordinator's guarded commit).
 */
export function reserveAttempt(input: ReserveAttemptInput): AttemptReservationResult {
  return getDb().transaction((tx) => reserveAttemptWithClient(tx, input));
}

// ---------------------------------------------------------------------------
// Status read (recovery surface for the later GET route)
// ---------------------------------------------------------------------------

/**
 * Reads the current recovery state of an attempt for the authorized
 * `GET /task-creation-attempts/:id` route: state, committed identifiers,
 * terminal result, and lease/checkpoint metadata. Pure read — never mutates,
 * never throws for a missing attempt (returns `{ found: false }`).
 */
export function getAttemptStatus(attemptId: string): AttemptStatusResult {
  const row = getDb()
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .get();
  if (!row) return { found: false };
  return { found: true, status: rowToStatus(row) };
}

// ---------------------------------------------------------------------------
// Worker leases (T3A Phase 3) — safe takeover via compare-and-set
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link acquireAttemptLeaseWithClient}. Closed discriminated
 * union — never throws for an expected acquire decision; only infrastructure
 * failures (retryable transport) throw.
 *
 * - `acquired`         — the lease was free (no owner OR expired) AND the
 *                        attempt is non-terminal; this call's CAS UPDATE matched
 *                        exactly one row, so `leaseOwner`/`leaseExpiresAt` are
 *                        now this worker's at the requested `durationMs`.
 * - `already_owned`    — the caller ALREADY holds an ACTIVE lease on a
 *                        non-terminal attempt; the free-lease CAS predicate did
 *                        NOT match (the lease is not free), so the lease columns
 *                        are UNCHANGED (`leaseExpiresAt` is NOT extended — the
 *                        caller must use {@link renewAttemptLeaseWithClient} for
 *                        that). Reported instead of a false `acquired` so a
 *                        resumed worker knows it did NOT install a fresh lease.
 * - `held_by_other`    — another worker holds an ACTIVE (unexpired) lease;
 *                        the lease columns are UNCHANGED. (Safe-takeover guard:
 *                        an EXPIRED lease is `acquired`, not `held_by_other`.)
 * - `terminal_locked`  — the attempt is in a terminal state (or has
 *                        `completedAt` set); acquire is refused, the lease
 *                        columns and terminal state are UNCHANGED. This is the
 *                        "lease expiry transfers work without changing terminal
 *                        state" guardrail — defense in depth alongside the
 *                        Phase-2 transition matrix terminal-lock.
 * - `not_found`        — no attempt row exists for `attemptId`.
 */
export type AttemptLeaseAcquireResult =
  | { outcome: "acquired"; attempt: TaskCreationAttemptRow }
  | { outcome: "already_owned"; attempt: TaskCreationAttemptRow }
  | { outcome: "held_by_other"; attempt: TaskCreationAttemptRow }
  | { outcome: "terminal_locked"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_found" };

/**
 * Outcome of {@link renewAttemptLeaseWithClient}. Only the current owner can
 * extend the lease; a non-owner (including a worker that took over an expired
 * lease) is refused without mutation.
 *
 * - `renewed`   — caller IS the owner; `leaseExpiresAt` extended.
 * - `not_owner` — caller is NOT the owner (or the lease was cleared); no
 *                 mutation.
 * - `not_found` — no attempt row exists for `attemptId`.
 */
export type AttemptLeaseRenewResult =
  | { outcome: "renewed"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_owner"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_found" };

/**
 * Outcome of {@link releaseAttemptLeaseWithClient}. Only the current owner can
 * clear the lease; a non-owner release is refused without mutation.
 *
 * - `released`  — caller IS the owner; `leaseOwner`/`leaseExpiresAt` cleared.
 * - `not_owner` — caller is NOT the owner; no mutation.
 * - `not_found` — no attempt row exists for `attemptId`.
 */
export type AttemptLeaseReleaseResult =
  | { outcome: "released"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_owner"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_found" };

/**
 * Acquires (or takes over) the worker lease on a task-creation attempt via a
 * single **compare-and-set** UPDATE whose WHERE encodes BOTH preconditions:
 *   1. the lease is FREE — `leaseOwner IS NULL OR leaseExpiresAt < now` (an
 *      expired lease is takeable = safe takeover), AND
 *   2. the attempt is NON-TERMINAL — `state NOT IN (terminal set) AND
 *      completedAt IS NULL` (the guardrail: a terminal attempt refuses acquire
 *      so lease handoff can never change terminal state).
 *
 * The WHERE predicate IS the entire defense — there is no read-then-decide
 * race window. A concurrent acquire by a second worker is serialized by SQLite
 * (single-writer): the first UPDATE matches and commits; the second worker's
 * UPDATE no-ops (the first's lease now violates the free-lease predicate).
 * Outcome is classified from the UPDATE's **affected-row count** via
 * `SELECT changes() AS n` (portable across both backends, unlike drizzle's
 * `run().changes` which is undefined in the test driver): exactly one changed
 * row → `acquired`; zero rows → the re-read distinguishes `already_owned`
 * (same worker holds an active lease) / `held_by_other` / `terminal_locked`.
 * Classifying by re-read state alone would falsely report `acquired` when the
 * same worker already owns an active lease (the free-lease WHERE rejects the
 * UPDATE but `leaseOwner === workerId` on re-read) while `leaseExpiresAt`
 * stays unchanged despite a longer `durationMs`.
 *
 * The terminal-set is the SAME canonical {@link TERMINAL_ATTEMPT_STATES}
 * shared with the Phase-2 transition matrix — the terminal-lock is a domain
 * invariant, not per-module logic. Never calls `getDb()`, never opens a nested
 * tx, never emits external effects. Throws only on infrastructure failure.
 */
export function acquireAttemptLeaseWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  workerId: string,
  durationMs: number,
): AttemptLeaseAcquireResult {
  const now = new Date().toISOString();
  const newExpiry = new Date(Date.now() + durationMs).toISOString();

  // Compare-and-set: the WHERE predicate encodes BOTH the free-lease and
  // non-terminal preconditions. A row that fails EITHER predicate is untouched.
  let affected: number;
  try {
    db.update(taskCreationAttempts)
      .set({ leaseOwner: workerId, leaseExpiresAt: newExpiry })
      .where(
        and(
          eq(taskCreationAttempts.id, attemptId),
          // Non-terminal (defense in depth: state set + completedAt signal).
          isNull(taskCreationAttempts.completedAt),
          sql`${taskCreationAttempts.state} NOT IN (${sql.join(
            [...TERMINAL_ATTEMPT_STATES].map((s) => sql`${s}`),
            sql`, `,
          )})`,
          // Free lease: no owner, OR an expired (takeable) lease.
          or(isNull(taskCreationAttempts.leaseOwner), lt(taskCreationAttempts.leaseExpiresAt, now)),
        ),
      )
      .run();
    // Classify from the affected-row count (portable across both backends).
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  // Re-read to classify the zero-row case (and to return the current row).
  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) return { outcome: "not_found" };

  // This call installed the lease (the free/non-terminal CAS matched) →
  // acquired at the requested duration. No further checks needed: the WHERE
  // excluded terminal rows, so a one-row change is necessarily a fresh lease.
  if (affected === 1) return { outcome: "acquired", attempt: row };

  // affected === 0: the WHERE predicate did not match. Classify why from the
  // actual row state.
  if (row.completedAt !== null || TERMINAL_ATTEMPT_STATES.has(row.state)) {
    return { outcome: "terminal_locked", attempt: row };
  }
  // Same worker already holds an ACTIVE lease — the free-lease predicate
  // rejected the UPDATE, so the lease is UNCHANGED (NOT extended; use renew).
  if (row.leaseOwner === workerId) {
    return { outcome: "already_owned", attempt: row };
  }
  // Another worker holds an active lease our WHERE predicate could not match.
  return { outcome: "held_by_other", attempt: row };
}

/**
 * Extends `leaseExpiresAt` by `durationMs` ONLY if the caller is the current
 * `leaseOwner`. Compare-and-set UPDATE (`WHERE id AND leaseOwner = workerId`);
 * re-read classifies. A non-owner renew is refused without mutation. Never
 * calls `getDb()`.
 *
 * Renew does NOT check terminal state: extending a lease you already own on a
 * since-terminalized attempt is harmless (the terminal-lock is enforced at
 * transition + acquire, not at renew). The coordinator decides whether to
 * renew dead work.
 */
export function renewAttemptLeaseWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  workerId: string,
  durationMs: number,
): AttemptLeaseRenewResult {
  const newExpiry = new Date(Date.now() + durationMs).toISOString();

  try {
    db.update(taskCreationAttempts)
      .set({ leaseExpiresAt: newExpiry })
      .where(
        and(eq(taskCreationAttempts.id, attemptId), eq(taskCreationAttempts.leaseOwner, workerId)),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) return { outcome: "not_found" };
  // The conditional UPDATE matched (we still own it) → renewed.
  if (row.leaseOwner === workerId) {
    return { outcome: "renewed", attempt: row };
  }
  // We did not own it (or a concurrent takeover cleared/reassigned it).
  return { outcome: "not_owner", attempt: row };
}

/**
 * Clears `leaseOwner`/`leaseExpiresAt` ONLY if the caller is the current
 * `leaseOwner`. Pre-reads to disambiguate "we just cleared it" (`released`)
 * from "it was already clear / owned by another" (`not_owner`); the subsequent
 * compare-and-set UPDATE (`WHERE id AND leaseOwner = workerId`) makes a
 * concurrent takeover between read and write surface as `not_owner` on re-read.
 * Never calls `getDb()`.
 */
export function releaseAttemptLeaseWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  workerId: string,
): AttemptLeaseReleaseResult {
  const current = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .get();
  if (!current) return { outcome: "not_found" };
  // Fast refusal: not our lease → no mutation attempt.
  if (current.leaseOwner !== workerId) {
    return { outcome: "not_owner", attempt: current };
  }

  try {
    db.update(taskCreationAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(eq(taskCreationAttempts.id, attemptId), eq(taskCreationAttempts.leaseOwner, workerId)),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) return { outcome: "not_found" }; // vanished mid-call (data anomaly)
  // Cleared (by us) → released. A concurrent re-acquire would set a new owner.
  if (row.leaseOwner === null) {
    return { outcome: "released", attempt: row };
  }
  // Concurrent takeover re-acquired the lease between our UPDATE and re-read.
  return { outcome: "not_owner", attempt: row };
}

/**
 * Convenience wrapper for {@link acquireAttemptLeaseWithClient} that owns its
 * own short transaction. Use when the acquire is the only write; compose the
 * `*WithClient` variant inside a caller-owned `db.transaction` when the lease
 * must be atomic with other writes (e.g. the later coordinator composing
 * lease-acquire + transition).
 */
export function acquireAttemptLease(
  attemptId: string,
  workerId: string,
  durationMs: number,
): AttemptLeaseAcquireResult {
  return getDb().transaction((tx) =>
    acquireAttemptLeaseWithClient(tx, attemptId, workerId, durationMs),
  );
}

/** Convenience wrapper for {@link renewAttemptLeaseWithClient} (own tx). */
export function renewAttemptLease(
  attemptId: string,
  workerId: string,
  durationMs: number,
): AttemptLeaseRenewResult {
  return getDb().transaction((tx) =>
    renewAttemptLeaseWithClient(tx, attemptId, workerId, durationMs),
  );
}

/** Convenience wrapper for {@link releaseAttemptLeaseWithClient} (own tx). */
export function releaseAttemptLease(
  attemptId: string,
  workerId: string,
): AttemptLeaseReleaseResult {
  return getDb().transaction((tx) => releaseAttemptLeaseWithClient(tx, attemptId, workerId));
}

// ---------------------------------------------------------------------------
// Retention (T3A Phase 4) — compact-vs-detailed
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link compactAttemptDetailsWithClient}. Closed discriminated
 * union — never throws for an expected compaction decision; only infrastructure
 * failures (retryable transport) throw.
 *
 * - `compacted` — the attempt row exists; the **detailed** JSON columns
 *                 (`details`, `terminalResult`, `causalContext`) were set to
 *                 NULL (or were already NULL — idempotent). The **compact**
 *                 dedup/recovery identity is preserved verbatim: reservation
 *                 key (`source`/`sourceScopeKind`/`sourceScopeId`/`attemptKey`),
 *                 `requestFingerprint`, `state`, `terminalOutcome`, committed
 *                 IDs, `envelopeEventId`/`reservationId`,
 *                 `leaseOwner`/`leaseExpiresAt`, and timestamps. The
 *                 post-compaction row is returned so the caller can verify
 *                 dedup evidence.
 * - `not_found` — no attempt row exists for `attemptId` (typed not-found, no
 *                 throw).
 *
 * The compact primitive is the T3A guardrail "habitat deletion/replacement
 * cannot erase attempt identity" partner for retention: it lets the operator
 * prune bounded detailed fragments while KEEPING the dedup evidence
 * (fingerprint + state + outcome) that lets a same-key `reserveAttempt`
 * continue to REPLAY correctly.
 */
export type AttemptCompactResult =
  | { outcome: "compacted"; attempt: TaskCreationAttemptRow }
  | { outcome: "not_found" };

/**
 * Nulls the **detailed** JSON columns of a `task_creation_attempts` row while
 * KEEPING the compact dedup/recovery identity intact.
 *
 * Columns NULL'd (the bounded detailed fragments eligible for earlier pruning):
 *   - `details`        (proposal / validation detail JSON)
 *   - `terminalResult` (full terminal envelope JSON)
 *   - `causalContext`  (origin-chain hop history)
 *
 * Columns KEPT (the compact dedup/recovery identity — required for guardrails):
 *   - reservation key: `source`, `sourceScopeKind`, `sourceScopeId`, `attemptKey`
 *   - canonical request: `requestFingerprint` (drives REPLAY vs REJECT)
 *   - state machine: `state`, `terminalOutcome`
 *   - committed identifiers: `committedTaskId`, `committedMissionId`,
 *     `prospectiveTaskId`, `envelopeEventId`, `reservationId`
 *   - recovery metadata: `leaseOwner`, `leaseExpiresAt` (an expired lease is
 *     the takeover signal — must survive compaction)
 *   - timestamps: `reservedAt`, `publishedAt`, `completedAt`
 *
 * Idempotent: re-compacting a row that already has all three detailed columns
 * NULL is a no-op (the SET writes NULL over NULL, the conditional UPDATE
 * matches every row, and the re-read returns the same compact row). Never
 * calls `getDb()`, never opens a nested tx, never emits external effects.
 * Throws only on infrastructure failure.
 */
export function compactAttemptDetailsWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
): AttemptCompactResult {
  // Single UPDATE: the row is matched by id alone — there is no read-then-
  // decide race window for retention (compaction is idempotent; a concurrent
  // second compact is safe and produces the same final state).
  try {
    db.update(taskCreationAttempts)
      .set({ details: null, terminalResult: null, causalContext: null })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  // Re-read (sql.js-safe) to classify the outcome: a missing id surfaces as
  // not_found rather than a silent success, and a successful compact surfaces
  // with the post-compaction row so the caller can verify dedup evidence
  // (state/fingerprint/outcome intact, detailed columns nulled).
  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) return { outcome: "not_found" };
  return { outcome: "compacted", attempt: row };
}

/**
 * Convenience wrapper for {@link compactAttemptDetailsWithClient} that owns its
 * own short transaction. Use when the compact is the only write; compose the
 * `*WithClient` variant inside a caller-owned `db.transaction` when retention
 * must be atomic with other writes (e.g. the later retention automation that
 * combines compact with audit-log emission).
 */
export function compactAttemptDetails(attemptId: string): AttemptCompactResult {
  return getDb().transaction((tx) => compactAttemptDetailsWithClient(tx, attemptId));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** SELECT a single attempt row by its full reservation key. */
function selectByScopeKey(
  db: TaskPublicationDbClient,
  input: ReserveAttemptInput,
): TaskCreationAttemptRow | undefined {
  return db
    .select()
    .from(taskCreationAttempts)
    .where(
      and(
        eq(taskCreationAttempts.source, input.source),
        eq(taskCreationAttempts.sourceScopeKind, input.sourceScopeKind),
        eq(taskCreationAttempts.sourceScopeId, input.sourceScopeId),
        eq(taskCreationAttempts.attemptKey, input.attemptKey),
      ),
    )
    .get();
}

/**
 * Resolves a same-key reserve against an existing (or race-winning) row:
 * REPLAY if the fingerprint matches (returns the stored state verbatim, no
 * re-transition), or REJECT deterministically on fingerprint mismatch. Never
 * mutates the row.
 */
function resolveExisting(
  existing: TaskCreationAttemptRow,
  requestFingerprint: string,
): AttemptReservationResult {
  if (existing.requestFingerprint === requestFingerprint) {
    return { outcome: "replayed", attempt: existing };
  }
  return {
    outcome: "rejected_fingerprint",
    attempt: existing,
    reservedFingerprint: existing.requestFingerprint,
  };
}

/** Maps a full attempt row to the {@link AttemptStatus} recovery surface. */
function rowToStatus(row: TaskCreationAttemptRow): AttemptStatus {
  return {
    attemptId: row.id,
    state: row.state as TaskCreationAttemptState,
    habitatId: row.habitatId,
    reservedAt: row.reservedAt,
    publishedAt: row.publishedAt,
    completedAt: row.completedAt,
    committedTaskId: row.committedTaskId,
    committedMissionId: row.committedMissionId,
    envelopeEventId: row.envelopeEventId,
    reservationId: row.reservationId,
    terminalOutcome: row.terminalOutcome,
    terminalResult: row.terminalResult,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

/**
 * Cross-backend UNIQUE-constraint detector. better-sqlite3 (production) throws
 * a `SqliteError` with `code === "SQLITE_CONSTRAINT_UNIQUE"` (drizzle-orm may
 * wrap it, putting the real error on `.cause`); sql.js (tests) throws a plain
 * `Error` whose `message` contains "UNIQUE constraint failed". This composite
 * matches both, plus the RepositoryError-wrapped variant, per the project's
 * established pattern (`wikiService.ts`, `releaseTriggerService.ts`).
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
