/**
 * Scheduled Occurrence Lease Recovery — T9B Phase 2 (DORMANT).
 *
 * The recovery worker that reclaims expired `publishing` occurrence leases +
 * re-drives the publication under the reclaimed lease (same-attempt
 * resumption — NO schedule advance; the schedule already advanced at
 * reservation). This is the deterministic-takeover primitive the plan
 * requires ("Kill workers at every occurrence/attempt checkpoint and prove
 * deterministic takeover").
 *
 * # The recovery loop
 *
 *   1. SCAN `publishing` occurrences with `leaseExpiresAt < now`
 *      ({@link listOccurrencesWithExpiredLeasesWithClient} — the bounded-pass
 *      read; default 100 rows per tick).
 *   2. For each: read the prior reclaim count + compute `newCount = prior + 1`,
 *      then FUSE the reclaim + the counter advancement via
 *      {@link reclaimAndStampOccurrenceWithClient} (T9B-02 — the atomic
 *      lease-transfer + counter-stamp primitive; wraps
 *      `reacquireExpiredOccurrenceLeaseWithClient` +
 *      `stampOccurrenceReclaimAttemptWithClient` in ONE `db.transaction`).
 *      On `not_expired` (a concurrent worker won) / `illegal_source_state`
 *      (terminal) / `not_found` → skip.
 *   3. CIRCUIT-BREAKER: if `newCount > maxReclaims`, terminalize the
 *      occurrence `rejected` with a `recovery_exhausted` result AND
 *      terminalize the coordination attempt + any resumable per-Task
 *      attempts atomically via
 *      {@link terminalRejectOccurrenceWithCoordination} (T9B-03 — recreates
 *      the T9A-05 vetoed-path contract for the recovery-exhausted path).
 *      The no-hot-loop guardrail — a stuck occurrence eventually stops
 *      re-firing.
 *   4. RESUME the publication via {@link resumeScheduledOccurrencePublication}
 *      (the dedicated re-drive entry point that SKIPS the `reserved →
 *      publishing` CAS — the occurrence is already `publishing` under the
 *      reclaimed lease). The resume re-drives STEPS 2-8 (read schedule →
 *      pre-check guard → tokens → prepare → reserve N attempts → publish →
 *      map) under the reclaimed owner. The fenced terminalization (T9A-08)
 *      ensures the reclaimed owner is authoritative — a stale worker's
 *      terminalization returns `not_owner`.
 *   5. MAP the resume's outcome: terminal (`published` / `vetoed` /
 *      `rejected_validation` / `schedule_missing` / `rejected_fingerprint`)
 *      → done (the occurrence reached terminal); resumable
 *      (`schedule_guard_mismatch` / `guard_mismatch` / `governance_denied` /
 *      `schedule_vanished_mid_tx`) → the occurrence stays `publishing` under
 *      this worker's lease → the lease will expire → the next scan tick
 *      reclaims + advances the count → eventually trips the circuit-breaker.
 *
 * # The circuit-breaker (the no-hot-loop guardrail)
 *
 * A `publishing` occurrence whose publication keeps failing + re-expiring
 * would loop forever without the circuit-breaker. The worker tracks the
 * reclaim count on the occurrence's `result` JSON
 * ({@link stampOccurrenceReclaimAttemptWithClient} — durable, fenced to the
 * current lease owner). After `maxReclaims` (default 3) recovery reclaims
 * without reaching terminal, the worker terminalizes the occurrence
 * `rejected` with a `recovery_exhausted` result — the occurrence stops
 * re-firing. The count is stamped BEFORE the resume, so it advances even
 * if the resume crashes (infrastructure failure). A worker restart does
 * NOT reset the count (it's durable on the row, not in-memory).
 *
 * # Recurring-independence (structurally guaranteed)
 *
 * A rejected occurrence does NOT suppress the next tick's reservation. The
 * UNIQUE index `uq_scheduled_occurrences_schedule_due` is per-
 * `(scheduledTaskId, scheduledFor)` — each schedule firing gets its own
 * occurrence row. A rejected occurrence is terminal (`rejected`); the next
 * tick's reservation creates a NEW row for the next `scheduledFor` instant.
 * The recovery worker never touches the next tick's reservation (it only
 * scans `publishing` occurrences). The structural guarantee is verified by
 * test (a rejected occurrence + a subsequent reservation → both rows exist).
 *
 * # Boot-registration (dormant wiring)
 *
 * {@link startOccurrenceLeaseRecoveryWorker} mirrors
 * `scheduledTaskService.startScheduledTaskProcessor` (the established
 * setInterval + try/catch + logger pattern). T11 registers it at boot
 * alongside `registerCreationDispatchAdapters` + the scheduler processor.
 * NO production caller wires it now — the worker + the recovery function
 * are exported + tested but wire NO production boot-registration.
 *
 * See: the T9B ticket (Phase 2 — active scope); the phase-1 primitives
 * (`scheduledOccurrences.ts` — reclaim + stamp); the resume entry point
 * (`scheduledOccurrencePublication.ts` — `resumeScheduledOccurrencePublication`);
 * the worker pattern (`scheduledTaskService.startScheduledTaskProcessor`).
 */
import { hostname } from "node:os";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import {
  getOccurrenceWithClient,
  listOccurrencesWithExpiredLeasesWithClient,
  reclaimAndStampOccurrenceWithClient,
  type OccurrenceResultJson,
  type ScheduledOccurrenceRow,
} from "../repositories/scheduledOccurrences.js";
import { listPendingTaskCreationAttemptsForScopeWithClient } from "../repositories/taskCreationAttempts.js";
import {
  resumeScheduledOccurrencePublication,
  terminalRejectOccurrenceWithCoordination,
  type ResumeScheduledOccurrenceOutcome,
} from "./scheduledOccurrencePublication.js";
import { v4 as uuid } from "uuid";

// ---------------------------------------------------------------------------
// Recovery options + result types
// ---------------------------------------------------------------------------

/**
 * Options for {@link recoverExpiredOccurrenceLeases}. The recovery worker's
 * bounded-pass configuration. All fields have production-reasonable defaults;
 * tests override `now` for deterministic timing + `maxReclaims` for fast
 * circuit-breaker verification.
 */
export interface RecoverExpiredOccurrenceLeasesOptions {
  /**
   * Worker identity claiming reclaimed leases. Stamped on the lease +
   * threaded into the resume's fenced terminalization. Each concurrent
   * recovery worker MUST use a distinct id (so the fenced CAS can
   * distinguish owners — though SQLite's single-writer serialization means
   * two workers never hold the same lease simultaneously, a stale worker
   * whose lease was reclaimed by another instance MUST surface as
   * `not_owner` on terminalization; a shared id would defeat that fence).
   *
   * REQUIRED at this layer (no silent default) —
   * {@link startOccurrenceLeaseRecoveryWorker} mints a unique-per-call id
   * via {@link createRecoveryWorkerId} when its `opts.leaseOwner` override
   * is absent; tests inject explicit ids for deterministic assertions.
   * Callers invoking {@link recoverExpiredOccurrenceLeases} directly MUST
   * supply their own (a silent constant default would re-introduce the
   * T9B-01 multi-instance fencing defect — every process sharing one
   * constant owner string).
   */
  leaseOwner: string;
  /**
   * Lease duration (ms) for reclaimed leases. The recovery worker sets
   * `leaseExpiresAt = now + leaseDurationMs` on each reclaim. Default 30000
   * (30s) — generous for the synchronous resume; the next scan tick
   * (interval 60s) reclaims if the resume returned resumable.
   */
  leaseDurationMs?: number;
  /**
   * Max recovery reclaims before the circuit-breaker terminalizes the
   * occurrence `rejected` with a `recovery_exhausted` result. Default 3 —
   * after 3 recovery reclaims (4 total publication attempts including the
   * initial) without reaching terminal, the occurrence stops re-firing.
   */
  maxReclaims?: number;
  /**
   * Override the current time (ISO timestamp). Production leaves this
   * undefined (`new Date().toISOString()`); tests pass a fixed instant for
   * deterministic lease-expiry assertions.
   */
  now?: string;
  /**
   * Max occurrences to process per pass. Default 100 (bounded scan — the
   * worker polls at an interval, so a bounded pass drains the backlog over
   * multiple ticks).
   */
  limit?: number;
}

/**
 * The recovery worker's per-occurrence detail record (for diagnostics +
 * logging). One entry per scanned occurrence.
 */
export interface OccurrenceLeaseRecoveryDetail {
  /** The scanned occurrence id. */
  occurrenceId: string;
  /** The reclaim primitive's outcome (`reclaimed` = this worker won the CAS). */
  reclaim: "reclaimed" | "not_expired" | "illegal_source_state" | "not_found";
  /**
   * The resume's outcome (when the reclaim succeeded + the resume ran).
   * Absent when the reclaim failed or the circuit-breaker terminalized
   * before the resume.
   */
  resume?: ResumeScheduledOccurrenceOutcome["outcome"] | "infrastructure_error";
  /**
   * The circuit-breaker terminal (when the count exceeded `maxReclaims`).
   * The occurrence was terminalized `rejected` with `recovery_exhausted`.
   */
  circuitBreaker?: "recovery_exhausted";
}

/**
 * The recovery pass result. Summary counts + per-occurrence details. The
 * boot-registration logs the summary; tests assert the counts.
 */
export interface RecoverExpiredOccurrenceLeasesResult {
  /** Number of expired-lease occurrences scanned. */
  scanned: number;
  /** Number of leases reclaimed (this worker won the CAS). */
  reclaimed: number;
  /**
   * Number of occurrences that reached terminal via the resume
   * (`published` / `vetoed` / `rejected_validation` / `schedule_missing` /
   * `rejected_fingerprint`). The occurrence is no longer recoverable.
   */
  terminalized: number;
  /**
   * Number of occurrences that returned a RESUMABLE outcome
   * (`schedule_guard_mismatch` / `guard_mismatch` / `governance_denied` /
   * `schedule_vanished_mid_tx` / `replayed`). The occurrence stays
   * `publishing` under this worker's lease → the lease will expire → the
   * next scan tick reclaims + advances the count.
   */
  resumable: number;
  /**
   * Number terminalized via the circuit-breaker (`recovery_exhausted`).
   * Included in `terminalized` (a circuit-breaker terminal IS a terminal).
   */
  exhausted: number;
  /**
   * Number skipped (reclaim lost to a concurrent worker / not found /
   * illegal state / stamp anomaly / resume infrastructure error). The
   * occurrence may be reclaimable on a future tick (if still `publishing`
   * with an expired lease).
   */
  skipped: number;
  /** Per-occurrence recovery details (for diagnostics/logging). */
  details: OccurrenceLeaseRecoveryDetail[];
}

// ---------------------------------------------------------------------------
// Terminal-outcome classifier (the resume-outcome → recovery-bucket map)
// ---------------------------------------------------------------------------

/**
 * The RESUMABLE resume outcomes — the occurrence STAYS `publishing` under
 * the recovery worker's lease; the lease will expire; the next scan tick
 * reclaims + advances the count. These are the outcomes the circuit-breaker
 * is designed to eventually terminalize.
 *
 * `replayed` is included here (conservative — the occurrence's per-Task
 * attempts are terminal/recovering but the occurrence ROW is still
 * `publishing`; the recovery worker can't fully resolve this partial state,
 * so the circuit-breaker handles it).
 */
const RESUMABLE_RESUME_OUTCOMES: ReadonlySet<ResumeScheduledOccurrenceOutcome["outcome"]> = new Set(
  [
    "schedule_guard_mismatch",
    "guard_mismatch",
    "governance_denied",
    "schedule_vanished_mid_tx",
    "replayed",
  ],
);

/**
 * The TERMINAL resume outcomes — the occurrence reached a terminal state
 * (`published` or `rejected`) via the resume. The occurrence is no longer
 * recoverable; the circuit-breaker is irrelevant.
 */
const TERMINAL_RESUME_OUTCOMES: ReadonlySet<ResumeScheduledOccurrenceOutcome["outcome"]> = new Set([
  "published",
  "vetoed",
  "rejected_validation",
  "schedule_missing",
  "rejected_fingerprint",
]);

// ---------------------------------------------------------------------------
// Recovery function
// ---------------------------------------------------------------------------

/**
 * T9B Phase 2 — scans for expired-lease `publishing` occurrences, reclaims
 * each, + re-drives the publication under the reclaimed lease. The
 * deterministic-takeover primitive. DORMANT (no production caller until T11;
 * the boot-registration {@link startOccurrenceLeaseRecoveryWorker} wires it).
 *
 * See the module header for the full recovery-loop + circuit-breaker
 * description. Never throws for an expected domain decision (every branch is
 * a typed result); infrastructure failures are caught per-occurrence + logged
 * (one bad occurrence doesn't abort the whole pass).
 */
export function recoverExpiredOccurrenceLeases(
  opts: RecoverExpiredOccurrenceLeasesOptions,
): RecoverExpiredOccurrenceLeasesResult {
  const db = getDb();
  const now = opts.now ?? new Date().toISOString();
  const leaseDurationMs = opts.leaseDurationMs ?? 30_000;
  const maxReclaims = opts.maxReclaims ?? 3;
  const limit = opts.limit ?? 100;

  const result: RecoverExpiredOccurrenceLeasesResult = {
    scanned: 0,
    reclaimed: 0,
    terminalized: 0,
    resumable: 0,
    exhausted: 0,
    skipped: 0,
    details: [],
  };

  // --- 1. SCAN --------------------------------------------------------------
  const expired = listOccurrencesWithExpiredLeasesWithClient(db, now, { limit });
  result.scanned = expired.length;

  // --- 2. RECLAIM + CIRCUIT-BREAKER + STAMP + RESUME per occurrence ---------
  for (const row of expired) {
    // 2a. Read the prior reclaim count from the SCANNED row's `result` JSON.
    //     The count is read BEFORE the fused reclaim+stamp so the new count
    //     (priorCount + 1) is computed upfront + stamped atomically with the
    //     lease transfer (T9B-02 — the fused primitive commits BOTH in one
    //     tx, eliminating the crash-window between reclaim + stamp that
    //     previously could leave the lease reclaimed without the count
    //     advancing → hot-loop).
    const priorResult = row.result as {
      reclaimCount?: number;
      lastResumableOutcome?: string;
    } | null;
    const priorCount = priorResult?.reclaimCount ?? 0;
    const newCount = priorCount + 1;

    // 2b. FUSED RECLAIM + STAMP (T9B-02 — atomic lease transfer + counter
    //     advancement). The primitive wraps
    //     `reacquireExpiredOccurrenceLeaseWithClient` +
    //     `stampOccurrenceReclaimAttemptWithClient` in ONE `db.transaction`
    //     so a crash between them rolls back BOTH — the lease is NOT
    //     reclaimed unless the count ALSO advances. Pre-fix, the two were
    //     separate commits + a crash between them defeated the circuit-
    //     breaker (repeated kills kept reacquiring at the same count →
    //     never tripped → hot-loop).
    const newLeaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
    let fused;
    try {
      fused = reclaimAndStampOccurrenceWithClient(db, row.id, {
        leaseOwner: opts.leaseOwner,
        leaseExpiresAt: newLeaseExpiresAt,
        reclaimCount: newCount,
        ...(priorResult?.lastResumableOutcome !== undefined
          ? { lastResumableOutcome: priorResult.lastResumableOutcome }
          : {}),
      });
    } catch (err) {
      // Infrastructure failure during the fused op — the tx rolled back
      // (NEITHER the reclaim NOR the stamp landed). The lease is still
      // expired under the PRIOR owner; a future scan tick retries with
      // the prior count.
      logger.error(
        { err, occurrenceId: row.id },
        "recoverExpiredOccurrenceLeases: infrastructure failure during fused reclaim+stamp",
      );
      result.skipped++;
      result.details.push({
        occurrenceId: row.id,
        reclaim: "not_found",
        resume: "infrastructure_error",
      });
      continue;
    }

    if (fused.outcome !== "reclaimed") {
      // `not_expired` (a concurrent worker won — the lease is still active)
      // / `illegal_source_state` (terminal — a concurrent publication
      // completed) / `not_found` (vanished). Skip — no work for this worker.
      // The stamp was NOT attempted (the fused tx rolled back). The count
      // did NOT advance on this row.
      result.skipped++;
      const reclaimOutcome =
        fused.outcome === "illegal_source_state"
          ? "illegal_source_state"
          : fused.outcome === "not_expired"
            ? "not_expired"
            : "not_found";
      result.details.push({ occurrenceId: row.id, reclaim: reclaimOutcome });
      continue;
    }
    result.reclaimed++;
    const reclaimed = fused.occurrence;

    // 2c. CIRCUIT-BREAKER: the count exceeded the budget → terminalize
    //     `recovery_exhausted` WITH the coordination attempt + any
    //     resumable per-Task attempts (T9B-03 — recreates the T9A-05
    //     vetoed-path contract for the recovery-exhausted path). The
    //     fenced CAS inside the coordination helper (`leaseOwner = expected`)
    //     ensures only this worker (the current lease owner) can
    //     terminalize. The occurrence stops re-firing after this.
    //
    //     The stamp (2b) already advanced the count to `newCount` on the
    //     occurrence's `result` JSON; the terminal rejection OVERWRITES
    //     `result` with the recovery_exhausted detail, preserving `newCount`
    //     so the diagnostic surface records the count that tripped.
    if (newCount > maxReclaims) {
      // Find the resumable per-Task attempts stranded `pending` under
      // `sourceScopeId = occurrence.id` (T9B-03). These are attempts
      // reserved by prior resume passes (step 6 of the publication body)
      // that returned resumable → the publish tx rolled back but the per-
      // Task reservations stayed `pending`. The coordination helper
      // terminalizes them atomically with the occurrence rejection.
      const pendingAttempts = listPendingTaskCreationAttemptsForScopeWithClient(db, reclaimed.id);
      const perTaskAttemptTerminals = pendingAttempts.map((attempt) => ({
        attemptId: attempt.id,
        finalState: "batch_rejected" as const,
        terminalOutcome: "recovery_exhausted",
        terminalResult: {
          outcome: "recovery_exhausted",
          attemptId: attempt.id,
          errors: [
            {
              reason: "occurrence_recovery_exhausted",
              message: `The aggregate occurrence "${reclaimed.id}" exhausted ${priorCount} recovery reclaims without reaching terminal; this Task's publication attempt was terminalized as collateral.`,
            },
          ],
        },
      }));

      let rejectedRow: ScheduledOccurrenceRow;
      try {
        rejectedRow = terminalRejectOccurrenceWithCoordination(db, reclaimed, {
          occurrenceResult: {
            reason: "recovery_exhausted",
            reclaimCount: newCount,
            attempts: newCount,
            ...(priorResult?.lastResumableOutcome !== undefined
              ? { lastResumableOutcome: priorResult.lastResumableOutcome }
              : {}),
            message: `Occurrence "${reclaimed.id}" exhausted ${priorCount} recovery reclaims without reaching terminal (maxReclaims=${maxReclaims}).`,
            exhaustedAt: now,
            perTaskAttemptsTerminalized: perTaskAttemptTerminals.length,
          } satisfies OccurrenceResultJson,
          coordinationFinalState: "batch_rejected",
          coordinationTerminalOutcome: "recovery_exhausted",
          coordinationTerminalResult: {
            outcome: "recovery_exhausted",
            attemptId: reclaimed.attemptId ?? undefined,
            errors: [
              {
                reason: "occurrence_recovery_exhausted",
                message: `The coordination attempt for occurrence "${reclaimed.id}" was terminalized as batch_rejected because the occurrence exhausted its recovery budget (maxReclaims=${maxReclaims}).`,
              },
            ],
          },
          perTaskAttemptTerminals,
        });
      } catch (err) {
        // The coordination helper THROWS on a `rejected_transition` (a
        // data anomaly — an attempt is at an unexpected state) OR on
        // `not_owner` (the lease was reclaimed by another worker mid-tx).
        // Either way the helper's tx rolled back — the occurrence STAYS
        // `publishing` under this worker's lease + the per-Task attempts
        // stay `pending`. Log + count as skipped (the next scan tick
        // retries with the same count — the stamp in 2b is durable).
        logger.error(
          { err, occurrenceId: reclaimed.id },
          "recoverExpiredOccurrenceLeases: coordination helper threw during recovery_exhausted terminalization (tx rolled back)",
        );
        result.skipped++;
        result.details.push({
          occurrenceId: reclaimed.id,
          reclaim: "reclaimed",
          resume: "infrastructure_error",
        });
        continue;
      }
      // The helper succeeded (the occurrence + coordination + per-Task
      // attempts all terminalized atomically). The returned row reflects
      // the rejection.
      void rejectedRow; // the authoritative row is re-read below.
      const rejected = getOccurrenceWithClient(db, reclaimed.id) ?? reclaimed;
      result.exhausted++;
      result.terminalized++;
      result.details.push({
        occurrenceId: reclaimed.id,
        reclaim: "reclaimed",
        circuitBreaker: "recovery_exhausted",
      });
      continue;
    }

    // 2d. RESUME the publication under the reclaimed lease. The resume
    //     SKIPS the `reserved → publishing` CAS (the occurrence is already
    //     `publishing` post-reclaim) + re-drives STEPS 2-8 under this
    //     worker's lease. The fused stamp (2b) already advanced the count;
    //     a successful resume OVERWRITES `result` with the terminal detail
    //     (erasing the counter); a resumable resume leaves the stamped
    //     counter in place for the next scan tick.
    let resume;
    try {
      resume = resumeScheduledOccurrencePublication({
        occurrenceId: reclaimed.id,
        leaseOwner: opts.leaseOwner,
      });
    } catch (err) {
      // Infrastructure failure during the resume — the aggregate rolled
      // back; the occurrence stays `publishing` under this worker's lease.
      // The stamp (2b) already advanced the count → the next scan tick
      // reclaims + retries. Log + count as resumable (the occurrence is
      // still `publishing`).
      logger.error(
        { err, occurrenceId: reclaimed.id },
        "recoverExpiredOccurrenceLeases: infrastructure failure during resume",
      );
      result.resumable++;
      result.details.push({
        occurrenceId: reclaimed.id,
        reclaim: "reclaimed",
        resume: "infrastructure_error",
      });
      continue;
    }

    // 2e. MAP the resume's outcome.
    const outcome = resume.outcome;
    if (TERMINAL_RESUME_OUTCOMES.has(outcome)) {
      result.terminalized++;
    } else if (RESUMABLE_RESUME_OUTCOMES.has(outcome)) {
      result.resumable++;
    } else {
      // `not_found` / `illegal_source_state` / `not_owner` — the occurrence
      // vanished or reached terminal between the reclaim + the resume (a
      // very tight window). Skip.
      result.skipped++;
    }
    result.details.push({ occurrenceId: reclaimed.id, reclaim: "reclaimed", resume: outcome });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Boot-registration (dormant wiring — mirrors scheduledTaskService)
// ---------------------------------------------------------------------------

/**
 * Generates a UNIQUE-per-process recovery-worker identity (T9B-01 — the
 * multi-instance fencing fix). Composed of `${hostname}-${pid}-${uuidSuffix}`
 * so:
 *   - **same process** → same `hostname` + same `pid` (stable across the
 *     worker's interval ticks once minted by
 *     {@link startOccurrenceLeaseRecoveryWorker}).
 *   - **distinct processes** (multi-instance deployment) → distinct `pid`
 *     AND distinct `uuidSuffix` → the fenced terminalization CAS
 *     (`leaseOwner = expected`) can DISTINGUISH them. A stale worker whose
 *     lease was reclaimed by another instance CANNOT terminalize + clear
 *     the new owner's lease (its `leaseOwner` no longer matches the row's).
 *
 * Pre-fix the default was the CONSTANT `"occurrence-recovery-worker"` —
 * every process used the same owner string, so the fencing invariant was
 * defeated: instance A stalls past expiry, instance B (same default owner)
 * reclaims, A's later terminalization STILL MATCHES → A can publish/reject
 * + clear B's lease. The unique-per-call id closes that hole.
 *
 * Exported for testability (the two-process fencing proof generates two ids
 * + asserts they differ + that a stale-id terminalization returns
 * `not_owner`). Production callers should use
 * {@link startOccurrenceLeaseRecoveryWorker} (which mints ONE id per call +
 * threads it across all interval ticks) rather than calling this directly.
 *
 * `opts.leaseOwner` (the override on `startOccurrenceLeaseRecoveryWorker` +
 * `RecoverExpiredOccurrenceLeasesOptions`) ALWAYS takes precedence — tests
 * inject explicit ids for deterministic assertions.
 */
export function createRecoveryWorkerId(): string {
  return `${hostname()}-${process.pid}-${uuid().slice(0, 8)}`;
}

/**
 * T9B Phase 2 — starts a recurring interval that polls for + recovers
 * expired-lease `publishing` occurrences. Returns the handle so the caller
 * can stop it. Mirrors `scheduledTaskService.startScheduledTaskProcessor`
 * (the established setInterval + try/catch + logger pattern).
 *
 * DORMANT: T11 registers this at boot alongside
 * `registerCreationDispatchAdapters` + `startScheduledTaskProcessor`. NO
 * production caller wires it now.
 *
 * # Worker identity (T9B-01 — the unique-per-process fencing fix)
 *
 * Each CALL to this function mints ONE worker id via
 * {@link createRecoveryWorkerId} + closes over it for the lifetime of the
 * returned interval — all ticks share the id (so the fenced CAS can
 * attribute reclaims + terminalizations to this worker). A SUBSEQUENT call
 * (e.g. a second deployment instance) mints a DIFFERENT id (distinct
 * `pid`/`uuid`), so the two workers' lease owners never collide. The
 * override `opts.leaseOwner` still takes precedence for tests + explicit
 * operator-configured ids.
 *
 * @param intervalMs  Polling interval (default 60000 = 60s). Should be >
 *   `leaseDurationMs` (default 30000) so a resumable occurrence's lease
 *   expires before the next scan tick reclaims it.
 * @param opts        Recovery options (leaseOwner override, leaseDurationMs,
 *   maxReclaims, limit). Defaults: a unique-per-call
 *   {@link createRecoveryWorkerId}, 30s lease, 3 max reclaims, 100 per pass.
 */
export function startOccurrenceLeaseRecoveryWorker(
  intervalMs: number = 60_000,
  opts: Partial<Omit<RecoverExpiredOccurrenceLeasesOptions, "now">> = {},
): NodeJS.Timeout {
  // Mint ONE worker id per CALL (T9B-01). Closed over by the interval so
  // every tick reuses it — the worker's reclaims + terminalizations share
  // a stable owner string, + a subsequent call (second instance) mints a
  // distinct id (distinct pid/uuid) so the fenced CAS can distinguish them.
  const workerId = opts.leaseOwner ?? createRecoveryWorkerId();
  return setInterval(() => {
    try {
      const recoveryOpts: RecoverExpiredOccurrenceLeasesOptions = {
        leaseOwner: workerId,
        leaseDurationMs: opts.leaseDurationMs,
        maxReclaims: opts.maxReclaims,
        limit: opts.limit,
      };
      const result = recoverExpiredOccurrenceLeases(recoveryOpts);
      if (result.scanned > 0) {
        logger.info(result, "Occurrence lease recovery worker completed a pass");
      }
    } catch (err) {
      logger.error({ err }, "Error recovering expired occurrence leases");
    }
  }, intervalMs);
}
