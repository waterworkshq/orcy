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
 *   2. For each: RECLAIM the expired lease via
 *      {@link reacquireExpiredOccurrenceLeaseWithClient} (the phase-1 CAS —
 *      `state='publishing' AND leaseExpiresAt < now` → transfers the lease
 *      to the recovery worker). On `not_expired` (a concurrent worker won)
 *      / `illegal_source_state` (terminal) / `not_found` → skip.
 *   3. Read the prior reclaim count from the reclaimed row's `result` JSON.
 *      CIRCUIT-BREAKER: if the count exceeds `maxReclaims`, terminalize the
 *      occurrence `rejected` with a `recovery_exhausted` result (the
 *      no-hot-loop guardrail — a stuck occurrence eventually stops re-firing).
 *   4. STAMP the new count on the `result` JSON via
 *      {@link stampOccurrenceReclaimAttemptWithClient} (durable counter —
 *      survives worker restart; fenced to the current lease owner). The
 *      stamp happens BEFORE the resume so the count advances even if the
 *      resume crashes (infrastructure failure) — the next scan tick reads
 *      the advanced count + eventually trips the circuit-breaker.
 *   5. RESUME the publication via {@link resumeScheduledOccurrencePublication}
 *      (the dedicated re-drive entry point that SKIPS the `reserved →
 *      publishing` CAS — the occurrence is already `publishing` under the
 *      reclaimed lease). The resume re-drives STEPS 2-8 (read schedule →
 *      pre-check guard → tokens → prepare → reserve N attempts → publish →
 *      map) under the reclaimed owner. The fenced terminalization (T9A-08)
 *      ensures the reclaimed owner is authoritative — a stale worker's
 *      terminalization returns `not_owner`.
 *   6. MAP the resume's outcome: terminal (`published` / `vetoed` /
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
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import {
  listOccurrencesWithExpiredLeasesWithClient,
  markOccurrenceRejectedWithClient,
  reacquireExpiredOccurrenceLeaseWithClient,
  stampOccurrenceReclaimAttemptWithClient,
  type OccurrenceResultJson,
  type ScheduledOccurrenceRow,
} from "../repositories/scheduledOccurrences.js";
import {
  resumeScheduledOccurrencePublication,
  type ResumeScheduledOccurrenceOutcome,
} from "./scheduledOccurrencePublication.js";

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
   * recovery worker should use a distinct id (so the fenced CAS can
   * distinguish owners — though SQLite's single-writer serialization means
   * two workers never hold the same lease simultaneously).
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
    // 2a. RECLAIM the expired lease (phase-1 CAS — the concurrency defender).
    const newLeaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
    let reclaim;
    try {
      reclaim = reacquireExpiredOccurrenceLeaseWithClient(db, row.id, {
        leaseOwner: opts.leaseOwner,
        leaseExpiresAt: newLeaseExpiresAt,
      });
    } catch (err) {
      // Infrastructure failure during reclaim — log + skip. The lease is
      // still expired; a future scan tick retries.
      logger.error(
        { err, occurrenceId: row.id },
        "recoverExpiredOccurrenceLeases: infrastructure failure during reclaim",
      );
      result.skipped++;
      result.details.push({
        occurrenceId: row.id,
        reclaim: "not_found",
        resume: "infrastructure_error",
      });
      continue;
    }

    if (reclaim.outcome !== "reclaimed") {
      // `not_expired` (a concurrent worker won) / `illegal_source_state`
      // (terminal — a concurrent publication completed) / `not_found`
      // (vanished). Skip — no work for this worker.
      result.skipped++;
      result.details.push({ occurrenceId: row.id, reclaim: reclaim.outcome });
      continue;
    }
    result.reclaimed++;

    const reclaimed = reclaim.occurrence;
    const priorResult = reclaimed.result as {
      reclaimCount?: number;
      lastResumableOutcome?: string;
    } | null;
    const priorCount = priorResult?.reclaimCount ?? 0;
    const newCount = priorCount + 1;

    // 2b. CIRCUIT-BREAKER: the count exceeded the budget → terminalize
    //     `recovery_exhausted`. The fenced CAS (`leaseOwner = expected`)
    //     ensures only this worker (the current lease owner) can terminalize.
    //     The occurrence stops re-firing after this.
    if (newCount > maxReclaims) {
      let rejected;
      try {
        rejected = markOccurrenceRejectedWithClient(db, reclaimed.id, {
          leaseOwner: opts.leaseOwner,
          result: {
            reason: "recovery_exhausted",
            reclaimCount: priorCount,
            attempts: priorCount + 1,
            ...(priorResult?.lastResumableOutcome !== undefined
              ? { lastResumableOutcome: priorResult.lastResumableOutcome }
              : {}),
            message: `Occurrence "${reclaimed.id}" exhausted ${priorCount} recovery reclaims without reaching terminal (maxReclaims=${maxReclaims}).`,
            exhaustedAt: now,
          } satisfies OccurrenceResultJson,
        });
      } catch (err) {
        logger.error(
          { err, occurrenceId: reclaimed.id },
          "recoverExpiredOccurrenceLeases: infrastructure failure during recovery_exhausted terminalization",
        );
        result.skipped++;
        result.details.push({
          occurrenceId: reclaimed.id,
          reclaim: "reclaimed",
          resume: "infrastructure_error",
        });
        continue;
      }
      if (rejected.outcome === "transitioned" || rejected.outcome === "no_op") {
        // `transitioned` — this worker terminalized. `no_op` — a concurrent
        // worker already terminalized (idempotent). Either way, the
        // occurrence is terminal.
        result.exhausted++;
        result.terminalized++;
        result.details.push({
          occurrenceId: reclaimed.id,
          reclaim: "reclaimed",
          circuitBreaker: "recovery_exhausted",
        });
      } else {
        // `not_owner` / `illegal_source_state` — the lease changed or the
        // occurrence reached terminal via a different path. Skip (the
        // occurrence is no longer this worker's concern).
        result.skipped++;
        result.details.push({ occurrenceId: reclaimed.id, reclaim: "reclaimed" });
      }
      continue;
    }

    // 2c. STAMP the new reclaim count (durable counter — survives worker
    //     restart; fenced to this worker's lease). Stamped BEFORE the resume
    //     so the count advances even if the resume crashes (infrastructure
    //     failure). The terminal transitions OVERWRITE the `result` JSON, so
    //     a successful resume erases the counter; a resumable resume leaves
    //     it for the next scan tick.
    let stamp;
    try {
      stamp = stampOccurrenceReclaimAttemptWithClient(db, reclaimed.id, {
        leaseOwner: opts.leaseOwner,
        reclaimCount: newCount,
      });
    } catch (err) {
      logger.error(
        { err, occurrenceId: reclaimed.id },
        "recoverExpiredOccurrenceLeases: infrastructure failure during reclaim-count stamp",
      );
      result.skipped++;
      result.details.push({
        occurrenceId: reclaimed.id,
        reclaim: "reclaimed",
        resume: "infrastructure_error",
      });
      continue;
    }
    if (stamp.outcome !== "stamped") {
      // `not_owner` / `illegal_source_state` — the lease changed or the
      // occurrence reached terminal between the reclaim + the stamp (a data
      // anomaly — the reclaim just set a future expiry). Skip the resume
      // (the stamp didn't land, so the count didn't advance; the next scan
      // tick retries with the prior count).
      result.skipped++;
      result.details.push({ occurrenceId: reclaimed.id, reclaim: "reclaimed" });
      continue;
    }

    // 2d. RESUME the publication under the reclaimed lease. The resume
    //     SKIPS the `reserved → publishing` CAS (the occurrence is already
    //     `publishing` post-reclaim) + re-drives STEPS 2-8 under this
    //     worker's lease.
    let resume;
    try {
      resume = resumeScheduledOccurrencePublication({
        occurrenceId: reclaimed.id,
        leaseOwner: opts.leaseOwner,
      });
    } catch (err) {
      // Infrastructure failure during the resume — the aggregate rolled
      // back; the occurrence stays `publishing` under this worker's lease.
      // The stamp (2c) already advanced the count → the next scan tick
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
 * The default recovery-worker identity. Each concurrent worker SHOULD use a
 * distinct id (so the fenced CAS can distinguish owners). The default is
 * fine for a single-worker deployment (the typical case pre-T11).
 */
const DEFAULT_RECOVERY_WORKER_ID = "occurrence-recovery-worker";

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
 * @param intervalMs  Polling interval (default 60000 = 60s). Should be >
 *   `leaseDurationMs` (default 30000) so a resumable occurrence's lease
 *   expires before the next scan tick reclaims it.
 * @param opts        Recovery options (leaseOwner, leaseDurationMs,
 *   maxReclaims, limit). Defaults: the {@link DEFAULT_RECOVERY_WORKER_ID},
 *   30s lease, 3 max reclaims, 100 per pass.
 */
export function startOccurrenceLeaseRecoveryWorker(
  intervalMs: number = 60_000,
  opts: Partial<Omit<RecoverExpiredOccurrenceLeasesOptions, "now">> = {},
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const recoveryOpts: RecoverExpiredOccurrenceLeasesOptions = {
        leaseOwner: opts.leaseOwner ?? DEFAULT_RECOVERY_WORKER_ID,
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
