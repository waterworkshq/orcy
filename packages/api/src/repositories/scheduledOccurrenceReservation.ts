/**
 * Scheduled Occurrence Reservation — T9A Phase 2 (DORMANT additive composer).
 *
 * Composes Phase 1's `reserveOccurrenceWithClient` (`scheduledOccurrences.ts`)
 * with new tx-aware schedule primitives (`advanceScheduleOnceWithClient`,
 * `disableScheduleWithClient` — `scheduledTask.ts`) inside ONE caller-owned
 * transaction to atomically:
 *
 *   1. INSERT the occurrence row (state = `reserved`) — the durable record
 *      uniquely keyed by `(scheduledTaskId, scheduledFor)`.
 *   2. ADVANCE the recurring schedule exactly once (`runCount + 1`,
 *      `nextRunAt` forward) — the CAS that moves the schedule's due pointer
 *      (mirrors the legacy `claimExecution` predicate, conditioned on
 *      `enabled = true AND nextRunAt <= now`).
 *   3. DISABLE a one-shot schedule from normal firing AT RESERVATION (not on
 *      publication success) — the fix for the `scheduledTaskService.ts:244-246`
 *      bug where a failed one-shot refires because the disable happens only
 *      on success.
 *
 * Atomicity model: all three operations run inside ONE `db.transaction`. A
 * failure at any step rolls back the whole reservation — no orphan occurrence,
 * no schedule advance without an occurrence, no disable without an advance.
 * The occurrence UNIQUE index (`uq_scheduled_occurrences_schedule_due`) is
 * the idempotency gate: a concurrent same-`(scheduleId, scheduledFor)`
 * reservation surfaces as `{ outcome: "already_exists", advanced: false }` —
 * the winner already advanced the schedule; the loser no-ops the advance
 * (re-advancing would double-count).
 *
 * `nextRunAt` (the advance target) is a REQUIRED input: the caller (T11
 * scheduler / test) computes it via `calculateNextRun`
 * (`services/scheduledTaskService.ts:74-97`, called at `executeScheduledTask:
 * 151-156`). Keeping this a caller responsibility avoids a repository →
 * service layering inversion (this composer stays a pure repo-level tx —
 * no service imports, no module-load side effects from
 * `scheduledTaskService`'s handler registry).
 *
 * DORMANT: no production origin routes through this module yet. The scheduler
 * wiring (T11) is the cutover gate. The occurrence publisher (Phase 3 —
 * `publishScheduledOccurrence`) consumes the reserved occurrence this module
 * produces and is the next phase.
 */
import { getDb } from "../db/index.js";
import { scheduledTasks } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskPublicationDbClient } from "./taskPublication.js";
import {
  reserveOccurrenceWithClient,
  getOccurrenceByScheduleAndDueWithClient,
  type ScheduledOccurrenceRow,
  type ScheduleRevisionJson,
} from "./scheduledOccurrences.js";
import { advanceScheduleOnceWithClient, disableScheduleWithClient } from "./scheduledTask.js";

// ---------------------------------------------------------------------------
// Input + result
// ---------------------------------------------------------------------------

/**
 * Directive for {@link reserveScheduledOccurrenceWithClient}.
 *
 * `nextRunAt` is REQUIRED (see module docstring). `scheduledFor`, `now`, and
 * `id` default to values derived from the schedule / current time / a fresh
 * `uuid()` — override for backfill or deterministic testing.
 */
export interface ReserveScheduledOccurrenceInput {
  /** The schedule to reserve an occurrence for. */
  scheduleId: string;
  /**
   * The schedule's next `nextRunAt` AFTER this firing (the advance target).
   * The caller computes this via `calculateNextRun`
   * (`services/scheduledTaskService.ts:74-97`). For a one-shot this is the
   * `9999-12-31T23:59:59Z` sentinel (`calculateNextRun` line 93); for
   * interval / cron it is the next calculated tick.
   */
  nextRunAt: string;
  /**
   * The due timestamp for this occurrence (uniqueness coordinate #2).
   * Defaults to the schedule's current `nextRunAt` (read inside the tx) —
   * the natural "this occurrence is for when the schedule is currently due."
   * Override for backfill or deterministic testing.
   */
  scheduledFor?: string;
  /**
   * Reference time for the advance CAS due-check (`nextRunAt <= now`).
   * Defaults to `new Date().toISOString()`. Override for deterministic
   * testing of the due-check.
   */
  now?: string;
  /**
   * Caller-allocated occurrence primary key. Defaults to `uuid()`. The
   * Phase-1 carry-over: `reserveOccurrenceWithClient` takes a caller-supplied
   * `id` so the reservation tx can stage other writes keyed by the same id
   * before calling it.
   */
  id?: string;
}

/**
 * Closed result of {@link reserveScheduledOccurrenceWithClient} /
 * {@link reserveScheduledOccurrence}. Never throws for an expected
 * reservation decision; only infrastructure failures (retryable transport)
 * throw.
 *
 * - `created`        — fresh `(scheduleId, scheduledFor)` pair; a new
 *                      `reserved` occurrence row was inserted. `advanced`
 *                      reports whether THIS call's CAS moved the schedule
 *                      forward:
 *                       - `true` (common) — the CAS predicate matched; the
 *                         schedule advanced exactly once.
 *                       - `false` (edge) — the CAS lost: a concurrent
 *                         different-`scheduledFor` reservation advanced the
 *                         schedule between this call's pre-read and its CAS
 *                         UPDATE. The occurrence is reserved but the
 *                         schedule's due pointer did not move for it. Rare;
 *                         the recovery worker (T9B) reconciles.
 * - `already_exists` — a concurrent reservation already committed a row for
 *                      this `(scheduleId, scheduledFor)`. The winner advanced
 *                      the schedule; this call no-ops the advance
 *                      (`advanced: false`). The stored occurrence is returned
 *                      UNCHANGED in its current state (reserved / publishing /
 *                      published / rejected) — Phase 3 reads this state to
 *                      decide whether to resume, replay, or no-op.
 * - `rejected`       — reservation-time validation failure detected BEFORE
 *                      any write: the schedule is missing, disabled, or not
 *                      currently due (`nextRunAt > now`). No occurrence row,
 *                      no schedule mutation. The caller's pre-check may also
 *                      surface these; the in-tx read is the race-safe
 *                      authority (the `reserved → rejected` edge in the
 *                      Phase-1 state machine exists for the post-write case;
 *                      this branch avoids creating an occurrence at all when
 *                      the schedule is observably unreservable).
 */
export type ReserveScheduledOccurrenceResult =
  | { outcome: "created"; occurrence: ScheduledOccurrenceRow; advanced: true }
  | { outcome: "created"; occurrence: ScheduledOccurrenceRow; advanced: false }
  | { outcome: "already_exists"; occurrence: ScheduledOccurrenceRow; advanced: false }
  | {
      outcome: "rejected";
      reason: "schedule_not_found" | "schedule_disabled" | "schedule_not_due";
    };

// ---------------------------------------------------------------------------
// Reservation primitive (caller-owned tx — compose inside db.transaction)
// ---------------------------------------------------------------------------

/**
 * Reserves a scheduled occurrence on the caller-supplied client. The caller
 * owns the transaction: inside `db.transaction((tx) =>
 * reserveScheduledOccurrenceWithClient(tx, input))` the reservation is atomic
 * with any surrounding writes (the convenience wrapper
 * {@link reserveScheduledOccurrence} owns its own short tx for the common
 * case). Never calls `getDb()`, never opens its own transaction, never emits
 * external effects.
 *
 * Flow (all on the passed client):
 *   1. Read the schedule (decision support). Reject if missing.
 *   2. Compute `scheduledFor` (default `schedule.nextRunAt`).
 *   3. Idempotent replay pre-check: if an occurrence already exists for
 *      `(scheduleId, scheduledFor)`, return `already_exists` (the winner
 *      advanced; no-op). This check PRECEDES the schedule due-check so a
 *      same-key retry against a schedule whose `nextRunAt` has already
 *      advanced (the winner moved it forward) still resolves as
 *      `already_exists`, not as `rejected: schedule_not_due`.
 *   4. For a FRESH pair: reject if the schedule is disabled or not currently
 *      due (`nextRunAt > now`).
 *   5. Compute `ordinal` (= `schedule.runCount`, zero-based: the Nth firing
 *      where N is the count BEFORE this firing), `scheduleRevision`
 *      (full-row snapshot), and allocate the occurrence `id`.
 *   6. `reserveOccurrenceWithClient` — INSERT the occurrence (state =
 *      `reserved`), idempotent via the UNIQUE index (the race defender for
 *      the window between step 3 and step 6). `already_exists` → no-op the
 *      advance and return.
 *   7. `advanceScheduleOnceWithClient` — CAS the schedule forward exactly
 *      once (conditioned on `enabled = true AND nextRunAt <= now`).
 *   8. If `advanced && scheduleType === "once"`: `disableScheduleWithClient`
 *      — disable the one-shot AT RESERVATION (the fix).
 *
 * Throws {@link repositoryUpdateError} / {@link repositoryCreateError} only
 * on infrastructure failure (retryable transport). Every expected reservation
 * decision is a closed discriminated-union branch — never a thrown exception.
 */
export function reserveScheduledOccurrenceWithClient(
  db: TaskPublicationDbClient,
  input: ReserveScheduledOccurrenceInput,
): ReserveScheduledOccurrenceResult {
  const now = input.now ?? new Date().toISOString();

  // 1. Read the schedule (decision support: scheduleType, runCount, nextRunAt,
  //    scheduleRevision snapshot). Read on the caller's client so the snapshot
  //    reflects in-tx state.
  const schedule = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, input.scheduleId))
    .get();

  if (!schedule) return { outcome: "rejected", reason: "schedule_not_found" };

  const scheduledFor = input.scheduledFor ?? schedule.nextRunAt;

  // 2. Idempotent replay pre-check: if an occurrence already exists for this
  //    (scheduleId, scheduledFor), return `already_exists` WITHOUT checking
  //    the schedule's due state. This MUST precede the schedule_not_due
  //    check: a same-key retry arrives after the winning reservation
  //    advanced the schedule (so nextRunAt > now), but the occurrence exists
  //    and the caller needs `already_exists` (not a bogus `rejected`). The
  //    UNIQUE index in step 4 is still the race defender for the window
  //    between this read and the INSERT.
  const existing = getOccurrenceByScheduleAndDueWithClient(db, input.scheduleId, scheduledFor);
  if (existing) {
    return { outcome: "already_exists", occurrence: existing, advanced: false };
  }

  // 3. For a FRESH pair: reservation-time validation. The schedule must be
  //    enabled and currently due.
  if (!schedule.enabled) return { outcome: "rejected", reason: "schedule_disabled" };
  // schedule_not_due: the schedule's current nextRunAt is in the future
  // relative to this reservation's reference time. A stale scheduler tick
  // (queued before the schedule was advanced by a concurrent reservation)
  // surfaces here without creating an occurrence.
  if (schedule.nextRunAt > now) {
    return { outcome: "rejected", reason: "schedule_not_due" };
  }

  // ordinal = schedule.runCount (zero-based: the first firing has runCount=0
  // → ordinal=0; the second has runCount=1 → ordinal=1). This is the Nth
  // firing where N is the count BEFORE this firing advances it.
  const ordinal = schedule.runCount;

  // scheduleRevision: full schedule-row snapshot at reservation time. Phase
  // 3's publisher uses this as the optimistic publication guard (a schedule
  // edit between reservation and publication is detected by diffing the
  // snapshot to the live row — the technical plan's "schedule/template
  // revision" field). The JSON column stores the full row; Phase 3 may
  // subset if the guard only needs specific fields.
  const scheduleRevision: ScheduleRevisionJson = { ...schedule };

  const occurrenceId = input.id ?? uuid();

  // 4. Reserve the occurrence (UNIQUE on scheduledTaskId + scheduledFor).
  //    Phase-1 primitive — `created` / `already_exists`.
  const occurrenceResult = reserveOccurrenceWithClient(db, {
    id: occurrenceId,
    scheduledTaskId: input.scheduleId,
    scheduledFor,
    ordinal,
    scheduleRevision,
  });

  if (occurrenceResult.outcome === "already_exists") {
    // Concurrent reservation won the race between the step-2 pre-check and
    // the INSERT (UNIQUE collision). Its INSERT already committed on this
    // client (SQLite serializes writers). The winner advanced the schedule;
    // re-advancing would double-count. No-op.
    return {
      outcome: "already_exists",
      occurrence: occurrenceResult.occurrence,
      advanced: false,
    };
  }

  // 5. `created` → advance the schedule exactly once (CAS). The CAS predicate
  //    `enabled = true AND nextRunAt <= now` is the race-safe authority: a
  //    concurrent different-`scheduledFor` reservation that already advanced
  //    surfaces as `advanced: false` here (the schedule's nextRunAt moved
  //    past `now`).
  const advanceResult = advanceScheduleOnceWithClient(db, input.scheduleId, input.nextRunAt, now);

  // 6. One-shot → disable AT RESERVATION (not on publication success). The
  //    fix for `scheduledTaskService.ts:244-246`: even if Phase 3's
  //    publication later fails (governance veto, infrastructure error), the
  //    one-shot cannot refire — `enabled = false` is durable from this tx.
  //    A recurring schedule stays enabled (future occurrences are
  //    independent — each gets its own reservation). Conditioned on
  //    `advanceResult.advanced` so we only disable when THIS call actually
  //    moved the schedule (a no-op advance means a concurrent reservation
  //    owns the disable).
  if (advanceResult.advanced && schedule.scheduleType === "once") {
    disableScheduleWithClient(db, input.scheduleId);
  }

  return {
    outcome: "created",
    occurrence: occurrenceResult.occurrence,
    advanced: advanceResult.advanced,
  };
}

/**
 * Convenience wrapper for {@link reserveScheduledOccurrenceWithClient} that
 * owns its own short transaction. The tx is the atomicity boundary:
 * occurrence insert + schedule advance + one-shot disable commit together or
 * roll back together. Use the `WithClient` variant to compose inside a
 * larger caller-owned tx.
 */
export function reserveScheduledOccurrence(
  input: ReserveScheduledOccurrenceInput,
): ReserveScheduledOccurrenceResult {
  return getDb().transaction((tx) => reserveScheduledOccurrenceWithClient(tx, input));
}
