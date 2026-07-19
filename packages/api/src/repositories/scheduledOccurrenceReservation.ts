/**
 * Scheduled Occurrence Reservation — T9A Phase 2 (DORMANT additive composer).
 *
 * Composes Phase 1's `reserveOccurrenceWithClient` (`scheduledOccurrences.ts`)
 * with new tx-aware schedule primitives (`advanceScheduleOnceWithClient`,
 * `disableScheduleWithClient` — `scheduledTask.ts`) + the T9A-03 occurrence-
 * level coordination attempt (`reserveAttemptWithClient` —
 * `taskCreationAttempts.ts`) inside ONE caller-owned transaction to atomically:
 *
 *   1. INSERT the occurrence row (state = `reserved`) — the durable record
 *      uniquely keyed by `(scheduledTaskId, scheduledFor)`.
 *   2. T9A-03: RESERVE ONE occurrence-level coordination attempt
 *      (`publicationKind:"scheduled_occurrence"`, `sourceScopeId:occurrence.id`,
 *      `attemptKey:"occurrence"`) + STAMP its id onto the occurrence's
 *      `attemptId` column (via `setOccurrenceAttemptIdWithClient`). The
 *      attempt is the aggregate-coordination / audit handle the Phase-3
 *      publisher advances/terminalizes in lockstep with the occurrence ROW.
 *      The N per-Task attempts (reserved by the Phase-3 publisher) STAY
 *      scoped by `occurrence.id` under distinct keys (`"${templateId}-${i}"`);
 *      this coordination attempt is NOT a substitute for them.
 *   3. ADVANCE the recurring schedule exactly once (`runCount + 1`,
 *      `nextRunAt` forward) — the CAS that moves the schedule's due pointer
 *      (mirrors the legacy `claimExecution` predicate, conditioned on
 *      `enabled = true AND nextRunAt <= now`).
 *   4. DISABLE a one-shot schedule from normal firing AT RESERVATION (not on
 *      publication success) — the fix for the `scheduledTaskService.ts:244-246`
 *      bug where a failed one-shot refires because the disable happens only
 *      on success.
 *
 * Atomicity model: all four operations run inside ONE `db.transaction`. A
 * failure at any step rolls back the whole reservation — no orphan occurrence,
 * no coordination attempt without an occurrence, no schedule advance without
 * an occurrence, no disable without an advance. The occurrence UNIQUE index
 * (`uq_scheduled_occurrences_schedule_due`) is the idempotency gate: a
 * concurrent same-`(scheduleId, scheduledFor)` reservation surfaces as
 * `{ outcome: "already_exists", advanced: false }` — the winner already
 * advanced the schedule; the loser no-ops the advance (re-advancing would
 * double-count).
 *
 * # T9A-02 — lost-race atomicity (no dangling `reserved` occurrence)
 *
 * A FRESH occurrence insert whose schedule-advance CAS LOST (`advanced:false`)
 * — i.e. a concurrent different-`scheduledFor` reservation already advanced
 * the schedule between this call's pre-read and its CAS UPDATE — used to
 * surface as `{ outcome:"created", advanced:false }`, persisting a durable
 * `reserved` occurrence this reservation didn't claim. T9A-02 changes that:
 * the primitive throws a {@link ScheduledOccurrenceAdvanceLostRace} sentinel
 * inside the tx → the whole tx rolls back (occurrence + coordination attempt
 * + link + one-shot disable) → NO durable `reserved` occurrence survives a
 * lost advance. The convenience wrapper maps the sentinel to the typed
 * `{outcome:"lost_race"}` branch.
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
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { AuditSource, CausalContext } from "@orcy/shared";
import type { TaskPublicationDbClient } from "./taskPublication.js";
import {
  reserveOccurrenceWithClient,
  setOccurrenceAttemptIdWithClient,
  getOccurrenceByScheduleAndDueWithClient,
  type ScheduledOccurrenceRow,
  type ScheduleRevisionJson,
} from "./scheduledOccurrences.js";
import { advanceScheduleOnceWithClient, disableScheduleWithClient } from "./scheduledTask.js";
import { reserveAttemptWithClient } from "./taskCreationAttempts.js";

// ---------------------------------------------------------------------------
// Provenance constants (occurrence-level coordination attempt — T9A-03)
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a scheduled-occurrence reservation. Mirrors
 * the Phase-3 publisher's `SCHEDULE_ACTOR_ID` (`scheduledOccurrencePublication.ts:271`)
 * — both phases of the same scheduler-driven origin attribute the work to
 * the same actor. Stamped on the occurrence-level attempt's `actorId`.
 */
const SCHEDULE_ACTOR_ID = "scheduler";

/**
 * The origin channel for a scheduled-occurrence reservation. `"scheduler"` is
 * the valid `AuditSource` enum value matching the Phase-3 publisher's
 * `SCHEDULE_AUDIT_SOURCE`. Stamped on the occurrence-level attempt's `source`.
 */
const SCHEDULE_AUDIT_SOURCE: AuditSource = "scheduler";

/**
 * The causal-root type for a scheduled-occurrence publication. The root id is
 * the occurrence id (the durable record for this specific firing). Matches the
 * Phase-3 publisher's `OCCURRENCE_CAUSAL_ROOT_TYPE`. Stamped on the
 * occurrence-level attempt's `causalContext.root`.
 */
const OCCURRENCE_CAUSAL_ROOT_TYPE = "scheduled_occurrence";

/**
 * The attempt-reservation scope kind. Paired with `sourceScopeId = occurrence.id`,
 * this forms the per-occurrence reservation scope. Matches the Phase-3
 * publisher's `OCCURRENCE_SCOPE_KIND` — the N per-Task attempts AND the
 * occurrence-level coordination attempt both live in this scope, distinguished
 * by `attemptKey` (`"occurrence"` vs `"${templateId}-${i}"`).
 */
const OCCURRENCE_SCOPE_KIND = "scheduled_occurrence";

// ---------------------------------------------------------------------------
// Canonical stable-JSON serializer (for the occurrence-level attempt fingerprint)
// ---------------------------------------------------------------------------

/** Stable-keyed JSON serialization (sorted keys, stable array order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical stable-string serialization. */
function stableHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Computes the canonical request fingerprint for the occurrence-level
 * coordination attempt (T9A-03). Covers the occurrence's identity basis —
 * `(scheduleId, scheduledFor, ordinal)` — so a re-reservation of the SAME
 * occurrence (which the UNIQUE index already prevents at the occurrence-row
 * level) would deterministically replay; a DIFFERENT occurrence (different
 * scheduledFor / ordinal) produces a distinct fingerprint.
 *
 * The fingerprint deliberately EXCLUDES:
 *   - the rendered mission title / description / labels — those drive the
 *     per-Task attempts' fingerprint (the Phase-3 publisher's
 *     `computeOccurrenceFingerprint`), NOT the occurrence-level coordination
 *     handle. The coordination attempt's job is to track the occurrence's
 *     lifecycle (reserved → published | rejected), not its rendered payload.
 *   - the full scheduleRevision snapshot — the identity basis above is
 *     sufficient for the coordination-attempt dedup (which is itself
 *     defended by the occurrence-row UNIQUE index).
 *   - provenance (actor / source / causal-context) — server-stamped + stable
 *     across retries.
 */
function computeOccurrenceCoordinationFingerprint(input: {
  scheduleId: string;
  scheduledFor: string;
  ordinal: number;
}): string {
  const payload = {
    scheduleId: input.scheduleId,
    scheduledFor: input.scheduledFor,
    ordinal: input.ordinal,
  };
  return "scheduled_occurrence_coord:" + stableHash(stableStringify(payload));
}

// ---------------------------------------------------------------------------
// In-tx abort sentinel — the T9A-02 lost-race signal
// ---------------------------------------------------------------------------

/**
 * Thrown INSIDE the reservation transaction by
 * {@link reserveScheduledOccurrenceWithClient} when the occurrence was freshly
 * inserted BUT the schedule-advance CAS lost (a concurrent different-
 * `scheduledFor` reservation already advanced the schedule between this call's
 * schedule read and its advance UPDATE). The throw rolls back the whole
 * reservation tx — the occurrence INSERT, the occurrence-level attempt
 * reservation, the attempt-link stamp, and the one-shot disable (if any) all
 * roll back together. NO durable `reserved` occurrence persists for a
 * schedule advance this reservation didn't claim.
 *
 * The convenience wrapper {@link reserveScheduledOccurrence} catches this
 * sentinel + returns the typed `{outcome:"lost_race"}` branch. Callers
 * composing the `WithClient` variant inside their own tx MUST let the throw
 * propagate (their tx rolls back — the correct atomicity behavior); they can
 * catch + classify via `instanceof ScheduledOccurrenceAdvanceLostRace` if they
 * want the typed outcome.
 *
 * NOT an infrastructure error — it is the in-tx signal that a concurrent
 * different-due-time reservation won the schedule advance. The scheduling
 * layer (T11) treats `lost_race` as "this `scheduledFor` is no longer the
 * schedule's current due pointer; drop it — the next tick will compute a
 * fresh `scheduledFor` from the new `schedule.nextRunAt`."
 */
export class ScheduledOccurrenceAdvanceLostRace extends Error {
  constructor() {
    super(
      "ScheduledOccurrenceAdvanceLostRace: the occurrence was freshly inserted BUT the schedule-advance CAS lost (a concurrent different-scheduledFor reservation already advanced the schedule). The reservation tx will roll back — no dangling reserved occurrence persists.",
    );
    this.name = "ScheduledOccurrenceAdvanceLostRace";
  }
}

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
 *                      `reserved` occurrence row was inserted + the schedule
 *                      advanced exactly once (CAS matched). The occurrence-
 *                      level coordination attempt is reserved + linked via
 *                      `attemptId`. `advanced` is always `true` on this
 *                      branch — the previous `{advanced:false}` edge was
 *                      removed in T9A-02 (it persisted a dangling `reserved`
 *                      occurrence that this reservation didn't claim); the
 *                      lost-race case now surfaces as the typed `lost_race`
 *                      branch (the tx rolls back, no occurrence persists).
 * - `already_exists` — a concurrent reservation already committed a row for
 *                      this `(scheduleId, scheduledFor)`. The winner advanced
 *                      the schedule; this call no-ops the advance
 *                      (`advanced: false`). The stored occurrence is returned
 *                      UNCHANGED in its current state (reserved / publishing /
 *                      published / rejected) — Phase 3 reads this state to
 *                      decide whether to resume, replay, or no-op.
 * - `lost_race`      — T9A-02: a FRESH occurrence insert lost the schedule-
 *                      advance CAS to a concurrent different-`scheduledFor`
 *                      reservation. The reservation tx ROLLED BACK — no
 *                      `reserved` occurrence persists, no schedule mutation
 *                      committed, no occurrence-level attempt was reserved
 *                      (or if it was reserved inside the tx, it rolled back
 *                      too). The caller (T11 scheduler) drops this
 *                      `scheduledFor`; the next scheduler tick computes a
 *                      fresh `scheduledFor` from the schedule's current
 *                      `nextRunAt` (which the winner moved forward).
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
  | { outcome: "already_exists"; occurrence: ScheduledOccurrenceRow; advanced: false }
  | { outcome: "lost_race" }
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
 *   7. T9A-03: reserve ONE occurrence-level coordination attempt via
 *      `reserveAttemptWithClient` (`publicationKind:"scheduled_occurrence"`,
 *      `sourceScopeKind:"scheduled_occurrence"`, `sourceScopeId:occurrence.id`,
 *      `attemptKey:"occurrence"`). Stamp its id onto the occurrence row via
 *      `setOccurrenceAttemptIdWithClient`. The attempt + link commit IN THIS
 *      TX — atomic with the occurrence insert.
 *   8. `advanceScheduleOnceWithClient` — CAS the schedule forward exactly
 *      once (conditioned on `enabled = true AND nextRunAt <= now`).
 *   9. T9A-02: if the advance CAS LOST (`advanced:false`) on a fresh insert,
 *      THROW {@link ScheduledOccurrenceAdvanceLostRace} → the whole tx rolls
 *      back (occurrence + attempt + link + one-shot disable). No dangling
 *      `reserved` occurrence persists. The wrapper maps the sentinel to
 *      `{outcome:"lost_race"}`.
 *   10. If one-shot: `disableScheduleWithClient` — disable AT RESERVATION.
 *
 * Throws {@link ScheduledOccurrenceAdvanceLostRace} on the T9A-02 lost-race
 * (the wrapper maps to the closed `lost_race` outcome). Throws
 * {@link repositoryUpdateError} / {@link repositoryCreateError} only on
 * infrastructure failure (retryable transport). Every other expected
 * reservation decision is a closed discriminated-union branch — never a
 * thrown exception.
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

  // 5. T9A-03: reserve ONE occurrence-level coordination attempt + stamp its
  //    id onto the occurrence row. The attempt is the coordination / audit
  //    handle for this occurrence — it tracks the aggregate's lifecycle
  //    (reserved → published | rejected), NOT the per-Task publication
  //    progress (the N per-Task attempts reserved by Phase-3's publisher
  //    track that, scoped by the SAME `sourceScopeId = occurrence.id` but
  //    distinct `attemptKey = "${templateId}-${i}"`). Stable per occurrence
  //    via `attemptKey:"occurrence"`. Commits IN THIS TX — atomic with the
  //    occurrence insert + (upcoming) schedule advance.
  //
  //    The occurrence row's `attemptId` column (nullable per the T1 schema)
  //    is the link the Phase-3 publisher reads to know which attempt to
  //    advance/terminalize alongside the occurrence's own state machine.
  const coordinationFingerprint = computeOccurrenceCoordinationFingerprint({
    scheduleId: input.scheduleId,
    scheduledFor,
    ordinal,
  });
  const causalContext: CausalContext = {
    root: { type: OCCURRENCE_CAUSAL_ROOT_TYPE, id: occurrenceId },
  };
  const coordinationReservation = reserveAttemptWithClient(db, {
    source: SCHEDULE_AUDIT_SOURCE,
    sourceScopeKind: OCCURRENCE_SCOPE_KIND,
    sourceScopeId: occurrenceId,
    attemptKey: "occurrence",
    requestFingerprint: coordinationFingerprint,
    publicationKind: "scheduled_occurrence",
    habitatId: schedule.habitatId,
    actorType: "system",
    actorId: SCHEDULE_ACTOR_ID,
    causalContext,
  });
  // `rejected_fingerprint` is unreachable here: a fingerprint mismatch would
  // require a prior coordination attempt under the SAME `(source, scope,
  // "occurrence")` key with a DIFFERENT fingerprint. But the key is unique
  // per occurrence (`sourceScopeId = occurrence.id`), the occurrence is
  // fresh (just inserted in this tx — step 4 returned `created`), and the
  // fingerprint is deterministic in the occurrence's identity basis. A
  // mismatch indicates a programming error — throw to roll back + surface.
  if (coordinationReservation.outcome === "rejected_fingerprint") {
    throw new Error(
      `reserveScheduledOccurrenceWithClient: unreachable coordination-attempt fingerprint mismatch for occurrence "${occurrenceId}" (reserved fingerprint "${coordinationReservation.reservedFingerprint}" ≠ request "${coordinationFingerprint}") — the occurrence-level coordination attempt is unique per occurrence; a mismatch indicates a programming error.`,
    );
  }
  // `replayed` is also unreachable on a fresh occurrence (no prior attempt
  // row could exist under a key scoped to a just-minted occurrence id). If
  // it ever fires, use the replayed attempt's id (defensive — preserves the
  // link) and continue.
  const coordinationAttemptId = coordinationReservation.attempt.id;
  const linkResult = setOccurrenceAttemptIdWithClient(db, occurrenceId, coordinationAttemptId);
  // `not_found` is unreachable (we just inserted the occurrence in this tx).
  // `already_stamped` is unreachable (the occurrence's `attemptId` column was
  // NULL at INSERT — step 4 — and this is the first stamp). Either surfaces
  // a programming error — throw to roll back + surface.
  if (linkResult.outcome !== "stamped") {
    throw new Error(
      `reserveScheduledOccurrenceWithClient: unreachable occurrence-attempt link outcome "${linkResult.outcome}" for occurrence "${occurrenceId}" — the row was just inserted in this tx with attemptId NULL.`,
    );
  }

  // 6. `created` → advance the schedule exactly once (CAS). The CAS predicate
  //    `enabled = true AND nextRunAt <= now` is the race-safe authority: a
  //    concurrent different-`scheduledFor` reservation that already advanced
  //    surfaces as `advanced: false` here (the schedule's nextRunAt moved
  //    past `now`).
  const advanceResult = advanceScheduleOnceWithClient(db, input.scheduleId, input.nextRunAt, now);

  // 7. T9A-02: lost-race handling. If the occurrence was freshly inserted
  //    (step 4 `created`) + the coordination attempt was reserved (step 5)
  //    BUT the schedule-advance CAS lost (`advanced:false`), a CONCURRENT
  //    different-`scheduledFor` reservation already advanced the schedule.
  //    Persisting THIS `reserved` occurrence would create a durable record
  //    for a schedule advance this reservation didn't claim — ambiguous +
  //    contradicts the "insert + advance exactly once" atomicity. THROW the
  //    sentinel → the whole tx rolls back (occurrence INSERT, coordination
  //    attempt reservation, attempt-link stamp, one-shot disable if any).
  //    NO durable `reserved` occurrence survives a lost advance. The wrapper
  //    catches the sentinel + returns `{outcome:"lost_race"}`.
  if (!advanceResult.advanced) {
    throw new ScheduledOccurrenceAdvanceLostRace();
  }

  // 8. One-shot → disable AT RESERVATION (not on publication success). The
  //    fix for `scheduledTaskService.ts:244-246`: even if Phase 3's
  //    publication later fails (governance veto, infrastructure error), the
  //    one-shot cannot refire — `enabled = false` is durable from this tx.
  //    A recurring schedule stays enabled (future occurrences are
  //    independent — each gets its own reservation). Reached only when
  //    `advanceResult.advanced` is `true` (the lost-race threw above).
  if (schedule.scheduleType === "once") {
    disableScheduleWithClient(db, input.scheduleId);
  }

  return {
    outcome: "created",
    occurrence: linkResult.occurrence,
    advanced: true,
  };
}

/**
 * Convenience wrapper for {@link reserveScheduledOccurrenceWithClient} that
 * owns its own short transaction. The tx is the atomicity boundary:
 * occurrence insert + coordination-attempt reservation + attempt-link stamp +
 * schedule advance + one-shot disable commit together or roll back together.
 * Use the `WithClient` variant to compose inside a larger caller-owned tx.
 *
 * # T9A-02 lost-race mapping
 *
 * If the `WithClient` primitive throws {@link ScheduledOccurrenceAdvanceLostRace}
 * (a fresh insert that lost the schedule-advance CAS), this wrapper catches
 * it + returns the typed `{outcome:"lost_race"}` branch — the tx rolled
 * back, no durable state persists. The optional `db` parameter (defaults to
 * `getDb()`) supports test injection; production callers omit it.
 */
export function reserveScheduledOccurrence(
  input: ReserveScheduledOccurrenceInput,
  db: TaskPublicationDbClient = getDb(),
): ReserveScheduledOccurrenceResult {
  try {
    return db.transaction((tx) => reserveScheduledOccurrenceWithClient(tx, input));
  } catch (err) {
    if (err instanceof ScheduledOccurrenceAdvanceLostRace) {
      return { outcome: "lost_race" };
    }
    throw err;
  }
}
