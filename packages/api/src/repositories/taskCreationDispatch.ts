/**
 * Dispatch-Target State Primitives — transaction-aware, DORMANT.
 *
 * Phase 1 of T4A. These `*WithClient` functions read and transition
 * `task_creation_dispatch_targets` rows on a caller-supplied drizzle client
 * (the default `getDb()` OR a `tx` from `db.transaction(cb)`). They mirror the
 * T1/T3A precedent (`TaskPublicationDbClient` in `repositories/taskPublication.ts`,
 * `acquireAttemptLeaseWithClient` in `repositories/taskCreationAttempts.ts`).
 *
 * Load-bearing invariant — NONE of these primitives:
 *   - call `getDb()` (they would escape the caller's transaction),
 *   - open their own transaction (no nested transactions),
 *   - emit external effects (SSE / hooks / webhooks / adapter dispatch).
 *
 * The dispatch engine's observation checkpoint opens only after every required
 * target reaches `accepted`. These primitives are the mechanism: CAS transitions
 * `pending → accepted | attention` (with retry for `attention`), and the
 * all-accepted predicate that the Phase 2 worker and Phase 3 claim gate compose.
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover, so no
 * dispatch targets exist in production. See the T4A ticket § "Phase 1 grounding".
 */
import { taskCreationDispatchTargets } from "../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import { repositoryNotFoundError, repositoryUpdateError } from "../errors/repository.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Row type (re-derived from the schema so callers don't depend on the schema
// module's internals — mirrors TaskCreationAttemptRow)
// ---------------------------------------------------------------------------

/** A `task_creation_dispatch_targets` row. */
export type DispatchTargetRow = typeof taskCreationDispatchTargets.$inferSelect;

// ---------------------------------------------------------------------------
// Result + input types
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link advanceDispatchTargetWithClient} — the compare-and-set
 * transition matrix for dispatch targets.
 *
 * - `transitioned` — the CAS UPDATE matched exactly one row: the target moved
 *                     `pending → accepted | attention` (or `attention → pending
 *                     → accepted | attention` on retry), with `attemptCount`
 *                     incremented and `lastAttemptAt` stamped.
 * - `no_op`         — the target was ALREADY `accepted` (idempotent re-accept;
 *                     the row is returned UNCHANGED — `acceptedAt` is NOT
 *                     re-stamped), OR a concurrent writer advanced it between
 *                     the in-tx read and the conditional UPDATE so the WHERE
 *                     predicate matched zero rows.
 *
 * Never throws for a transition decision; only infrastructure failures
 * (`repositoryUpdateError`) or a missing row (`repositoryNotFoundError`) throw.
 */
export type DispatchTargetTransitionResult =
  | { outcome: "transitioned"; target: DispatchTargetRow }
  | { outcome: "no_op"; target: DispatchTargetRow };

/** Advance directive for {@link advanceDispatchTargetWithClient}. */
export interface DispatchTargetAdvance {
  targetId: string;
  outcome: "accepted" | "attention";
  /** Diagnostic context for `attention`; cleared on `accepted`. */
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * List every dispatch target for an envelope on the passed client. Returns an
 * empty array for an envelope with no targets (the dormant zero-target common
 * case) or an unknown envelope.
 *
 * Used by the Phase 2 worker (to scan targets that need attempting) and as the
 * basis for the all-accepted predicate.
 */
export function listDispatchTargetsForEnvelopeWithClient(
  db: TaskPublicationDbClient,
  eventId: string,
): DispatchTargetRow[] {
  return db
    .select()
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.eventId, eventId))
    .all();
}

/**
 * Advance a dispatch target via compare-and-set: `pending → accepted | attention`
 * (with retry for an `attention` target: reset to `pending` first, then advance).
 *
 * **CAS classification** uses `SELECT changes()` — portable across both the
 * sql.js test backend and the better-sqlite3 production backend. The drizzle
 * `run().changes` return is `undefined` on sql.js and MUST NOT be used. The
 * affected-row count of the conditional UPDATE is the SOLE classification
 * signal: a re-read would lie under a concurrent writer that reached the
 * target state (the T3B-R pattern at `checkpointAttemptWithClient` /
 * `acquireAttemptLeaseWithClient`).
 *
 * **Idempotency**: re-accepting an already-`accepted` target returns `no_op`
 * with the row UNCHANGED (accepted is sticky; `acceptedAt` is NOT re-stamped).
 *
 * **Retry**: advancing an `attention` target first resets it to `pending`
 * (CAS `WHERE state = 'attention'`), then advances from `pending`. The reset
 * is an internal step — the single classification point is the advance CAS
 * (`WHERE state = 'pending'`). `attemptCount` increments once per successful
 * advance (not on the reset).
 *
 * Never throws for a transition decision; only infrastructure failures
 * (`repositoryUpdateError`) or a missing row (`repositoryNotFoundError`) throw.
 */
export function advanceDispatchTargetWithClient(
  db: TaskPublicationDbClient,
  advance: DispatchTargetAdvance,
): DispatchTargetTransitionResult {
  const { targetId, outcome, lastError } = advance;

  // 1. In-tx read of the current row (supports the idempotency + CAS decision).
  const current = db
    .select()
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.id, targetId))
    .all()[0];
  if (!current) throw repositoryNotFoundError("taskCreationDispatchTarget", targetId);

  // 2. Idempotent re-accept: an already-accepted target is sticky. Return it
  //    UNCHANGED (do NOT re-stamp acceptedAt). This is the same-state short-
  //    circuit from checkpointAttemptWithClient.
  if (current.state === "accepted") {
    return { outcome: "no_op", target: current };
  }

  const now = new Date().toISOString();

  // 3. Retry reset: an attention target must return to pending before the
  //    advance CAS (`WHERE state = 'pending'`) can match. This is the
  //    "resets to pending-then-advances" contract. The reset is NOT classified
  //    separately — if it loses to a concurrent writer, the advance CAS below
  //    will no_op (the row is no longer pending).
  if (current.state === "attention") {
    try {
      db.update(taskCreationDispatchTargets)
        .set({ state: "pending", updatedAt: now })
        .where(
          and(
            eq(taskCreationDispatchTargets.id, targetId),
            eq(taskCreationDispatchTargets.state, "attention"),
          ),
        )
        .run();
    } catch (err) {
      throw repositoryUpdateError("taskCreationDispatchTarget", err as Error, targetId);
    }
  }

  // 4. Compare-and-set advance: the conditional UPDATE whose WHERE includes the
  //    expected pending state. A concurrent advance between the in-tx read (or
  //    the reset) and this UPDATE no-ops rather than corrupting.
  //    `attemptCount` increments and `lastAttemptAt` stamps on EVERY successful
  //    advance (accepted OR attention — "either way"). `accepted` stamps
  //    `acceptedAt` + clears `lastError`; `attention` sets `lastError`.
  let affected: number;
  try {
    db.update(taskCreationDispatchTargets)
      .set(
        outcome === "accepted"
          ? {
              state: "accepted",
              attemptCount: sql`${taskCreationDispatchTargets.attemptCount} + 1`,
              lastAttemptAt: now,
              updatedAt: now,
              acceptedAt: now,
              lastError: null,
            }
          : {
              state: "attention",
              attemptCount: sql`${taskCreationDispatchTargets.attemptCount} + 1`,
              lastAttemptAt: now,
              updatedAt: now,
              lastError: lastError ?? null,
            },
      )
      .where(
        and(
          eq(taskCreationDispatchTargets.id, targetId),
          eq(taskCreationDispatchTargets.state, "pending"),
        ),
      )
      .run();
    // Classify from the UPDATE's affected-row count (portable CAS — see
    // checkpointAttemptWithClient / acquireAttemptLeaseWithClient).
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationDispatchTarget", err as Error, targetId);
  }

  // 5. Re-read the authoritative row (the return value for both outcomes).
  //    When affected === 1 it is the row we just advanced; when affected === 0
  //    a concurrent writer moved state, and this is the winner's row.
  const row = db
    .select()
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.id, targetId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationDispatchTarget", targetId);

  return affected === 1
    ? { outcome: "transitioned", target: row }
    : { outcome: "no_op", target: row };
}

/**
 * Whether every dispatch target for an envelope has reached `accepted`.
 *
 * Vacuously `true` for an envelope with zero targets — the dormant common case
 * (the dispatch plan is caller-supplied, default empty; no targets = observation
 * checkpoint satisfied). This is the predicate the Phase 3 claim gate will use
 * to replace the current placeholder (`creationIntegrity > 0 → blocked`).
 */
export function allDispatchTargetsAcceptedWithClient(
  db: TaskPublicationDbClient,
  eventId: string,
): boolean {
  const targets = db
    .select({ state: taskCreationDispatchTargets.state })
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.eventId, eventId))
    .all();
  // every() on an empty array is vacuously true — the zero-target dormant case.
  return targets.every((t) => t.state === "accepted");
}
