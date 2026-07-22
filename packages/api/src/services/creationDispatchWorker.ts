/**
 * Creation Dispatch Worker — T11 Phase 1A (DORMANT).
 *
 * The background polling loop that drives the post-commit observation +
 * assignment gates. Without this worker, Tasks stay
 * `published_pending_observation` forever — the observation gate never
 * opens, Tasks can never be claimed. The worker is THIN: it composes the
 * shipped engines + sweepers; it owns NO state-mutation authority.
 *
 * Composes:
 *   - `processEnvelopeDispatchWithClient`
 *     (services/taskCreationDispatchEngine.ts:285) — per-envelope
 *     processing pipeline (lease → attempt every non-accepted dispatch
 *     target via its registered adapter → evaluate the observation
 *     checkpoint → release the lease).
 *   - `listAttemptsPendingObservationWithClient`
 *     (services/taskCreationDispatchEngine.ts:376) — the bounded scan of
 *     `published_pending_observation` attempts (oldest-first).
 *   - `sweepTargetedAssignments`
 *     (services/taskCreationAssignmentCoordinator.ts:569) — the
 *     assignment-gate sweeper (resolves any
 *     `published_pending_assignment` attempts whose reservation deadline
 *     has expired, OR whose requested claim should commit, via the
 *     coordinator's lease-fenced resolution).
 *
 * Mirrors `services/scheduledOccurrenceRecovery.ts` as the structural
 * precedent (T9B Phase 2):
 *   - `createDispatchWorkerId` mirrors `createRecoveryWorkerId` (line 554).
 *   - `startCreationDispatchWorker` mirrors `startOccurrenceLeaseRecoveryWorker`
 *     (line 586): setInterval + try/catch + logger pattern. Each CALL
 *     mints ONE worker id, closes over it for the lifetime of the
 *     returned interval — all ticks share the id (so the fenced CAS can
 *     attribute dispatches + lease takes to this worker); a subsequent
 *     call (second deployment instance) mints a DIFFERENT id (distinct
 *     `pid`/`uuid`), so multi-instance fencing works (T9B-01 — the
 *     unique-per-process fencing fix; the same defect class applies here).
 *
 * # Dormancy (T11 Phase 1A wiring)
 *
 * NO production caller wires this until cutover (T11). The function is
 * always callable (tests exercise it directly); the boot-registration in
 * `packages/api/src/index.ts` is gated by `isCreationPublicationEnabled()`.
 *
 * # Intervals (T11 Phase 1A — defaulted in `index.ts`)
 *
 * - `startOccurrenceLeaseRecoveryWorker(60_000)` — reclaims expired
 *   `publishing` occurrence leases (T9B). 60s is the T9B precedent default
 *   (a 30s lease + 30s slack → one scan per lease-expiry window).
 * - `startCreationDispatchWorker(5_000)` — drives the observation +
 *   assignment gates. 5s is short because the observation gate is
 *   user-facing (Tasks can't be claimed until it opens); a 5s max wait is
 *   acceptable UX. The dispatch engine is in-process + synchronous for the
 *   registered adapters; a 5s tick is well within the lease budget
 *   (default 30s).
 *
 * See: the T11 ticket (Phase 1A — active scope); the dispatch engine
 * (`services/taskCreationDispatchEngine.ts`); the assignment coordinator
 * (`services/taskCreationAssignmentCoordinator.ts`); the structural
 * precedent (`services/scheduledOccurrenceRecovery.ts`).
 */
import { hostname } from "node:os";
import { getDb } from "../db/index.js";
import { logger } from "../lib/logger.js";
import {
  processEnvelopeDispatchWithClient,
  listAttemptsPendingObservationWithClient,
} from "./taskCreationDispatchEngine.js";
import {
  sweepTargetedAssignments,
  type SweepTargetedAssignmentsResult,
} from "./taskCreationAssignmentCoordinator.js";
import { v4 as uuid } from "uuid";

// ---------------------------------------------------------------------------
// Per-attempt outcome + pass-result types
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link runDispatchWorkerPass} per scanned observation-gate
 * attempt. One entry per attempt surfaced by
 * {@link listAttemptsPendingObservationWithClient} — including the `error`
 * variant so a per-attempt exception is observable in the pass aggregate
 * (and surfaced to the boot-registration logger) without aborting the pass.
 *
 * - `dispatched`        — the attempt was at observation, the engine acquired
 *                         the lease, attempted every non-accepted target,
 *                         advanced the observation checkpoint (to
 *                         `created` or `published_pending_assignment` per
 *                         the active reservation), and released the lease.
 * - `lease_unavailable` — the attempt was at observation BUT another worker
 *                         owns the active lease (the engine's CAS refused).
 *                         The worker defers to the lease owner; the attempt
 *                         will be re-surfaced on a later tick once the lease
 *                         expires.
 * - `lease_lost`        — the engine acquired the lease, processed some
 *                         targets, then lost the lease mid-loop (another
 *                         worker took over). Partial results were committed
 *                         (CAS-protected); the checkpoint was NOT advanced.
 *                         The new owner re-processes remaining targets.
 * - `not_found`         — no attempt row exists for this `attemptId` (the
 *                         attempt vanished between the scan + the dispatch —
 *                         data-integrity anomaly, but a no-op for the pass).
 * - `error`             — an infrastructure throw escaped the engine (e.g. a
 *                         database connection failure). Logged + counted; the
 *                         interval is NOT aborted (the parent try/catch
 *                         guarantees the next tick still polls).
 */
export type DispatchWorkerAttemptOutcome =
  | { attemptId: string; outcome: "dispatched" }
  | { attemptId: string; outcome: "lease_unavailable" }
  | { attemptId: string; outcome: "lease_lost" }
  | { attemptId: string; outcome: "not_found" }
  | { attemptId: string; outcome: "error"; error: string };

/**
 * Closed result of {@link runDispatchWorkerPass}.
 *
 * `observationScanned` counts every attempt surfaced by the bounded scan
 * (default 100) regardless of outcome. `observationOutcomes` carries the
 * per-attempt detail (for diagnostics + boot-logging); `assignmentSweep`
 * carries the sweep aggregate forwarded from
 * {@link sweepTargetedAssignments}.
 */
export interface DispatchWorkerPassResult {
  observationScanned: number;
  observationOutcomes: DispatchWorkerAttemptOutcome[];
  assignmentSweep: SweepTargetedAssignmentsResult;
}

/**
 * Options for {@link runDispatchWorkerPass} + {@link startCreationDispatchWorker}.
 *
 * `workerId` is forwarded to {@link processEnvelopeDispatchWithClient} +
 * {@link sweepTargetedAssignments} for the attempt-lease CAS. Defaults to
 * a fresh `uuid()` PER attempt when omitted (each scan surfaces N attempts,
 * each gets its own lease; sharing one id would make attempt N's lease
 * collide with attempt N+1's acquire). When `startCreationDispatchWorker`
 * is the caller, a SINGLE id is minted at boot + reused across ticks (so
 * all dispatches from this worker share a stable owner string).
 */
export interface RunDispatchWorkerPassOptions {
  /** Worker identity forwarded to the dispatch engine + the sweeper. */
  workerId?: string;
  /** Page size passed to the observation scan + the assignment sweep. Default 100. */
  limit?: number;
  /** Maximum observation attempts processed per pass. Default 1000. */
  maxObservationAttempts?: number;
}

// ---------------------------------------------------------------------------
// Single-pass function (the building block — tests exercise this directly)
// ---------------------------------------------------------------------------

/**
 * Runs ONE pass of the dispatch worker. Scans `published_pending_observation`
 * attempts (oldest-first) and processes each via
 * {@link processEnvelopeDispatchWithClient}, then sweeps
 * `published_pending_assignment` attempts via
 * {@link sweepTargetedAssignments}.
 *
 * The boot-registration in `index.ts` calls this from a `setInterval`; tests
 * call it directly for deterministic pass-level assertions (no timer
 * manipulation).
 *
 * Errors per attempt are caught + logged (one bad attempt does NOT abort the
 * pass). Errors from the sweep are likewise caught + logged (the scan side
 * of the pass already completed). The function itself NEVER throws for an
 * expected domain decision; the interval's outer try/catch is the last-resort
 * guard against an unforeseen throw (logged at `error`, the interval keeps
 * polling on the next tick).
 *
 * Never calls `getDb()` directly — it reads `getDb()` ONCE per pass and
 * threads the client through to the engine + sweep (matches the recovery
 * worker's pattern; preserves the caller's transaction authority when one
 * wraps the pass in a test `tx`).
 */
export async function runDispatchWorkerPass(
  opts: RunDispatchWorkerPassOptions = {},
): Promise<DispatchWorkerPassResult> {
  const db = getDb();
  const limit = opts.limit ?? 100;
  // Default the worker id per-pass so concurrent scans on the same
  // process (or the per-tick default in the interval) get distinct ids.
  // `startCreationDispatchWorker` always overrides this with a stable
  // per-call id.
  const perAttemptWorkerId = opts.workerId ?? uuid();

  const result: DispatchWorkerPassResult = {
    observationScanned: 0,
    observationOutcomes: [],
    assignmentSweep: {
      processed: 0,
      assigned: 0,
      refused: 0,
      deadlineExceeded: 0,
      resumable: 0,
      leaseUnavailable: 0,
    },
  };

  // 1. SCAN + PROCESS observation-gate attempts.
  //
  // `listAttemptsPendingObservationWithClient` is a READ-ONLY scan (no
  // side effects); the dispatch engine's lease acquire is the
  // concurrency-safe entry to per-attempt mutation. We catch per-attempt
  // so a single bad attempt cannot abort the whole pass — the interval
  // keeps polling.
  //
  // Pagination: read offset 0 repeatedly. As long as at least one attempt
  // advances (leaves `published_pending_observation`), newer attempts shift
  // into the result set and are processed. When a full batch yields zero
  // advancements (all stuck in `attention`), break — those targets will be
  // re-attempted on the next tick. This prevents non-progressing attempts
  // from permanently monopolizing the scan page and starving newer ones.
  const maxObservationAttempts = opts.maxObservationAttempts ?? 1_000;
  const seenAttemptIds = new Set<string>();
  let offset = 0;
  for (;;) {
    const batch = listAttemptsPendingObservationWithClient(db, { limit, offset: 0 });
    if (batch.length === 0) break;
    for (const attempt of batch) seenAttemptIds.add(attempt.id);

    let advanced = 0;
    for (const attempt of batch) {
      seenAttemptIds.add(attempt.id);
      try {
        const dispatch = await processEnvelopeDispatchWithClient(db, attempt.id, {
          workerId: perAttemptWorkerId,
        });
        if (dispatch.outcome === "dispatched") advanced++;
        switch (dispatch.outcome) {
          case "dispatched":
            result.observationOutcomes.push({ attemptId: attempt.id, outcome: "dispatched" });
            break;
          case "lease_unavailable":
            result.observationOutcomes.push({
              attemptId: attempt.id,
              outcome: "lease_unavailable",
            });
            break;
          case "lease_lost":
            result.observationOutcomes.push({
              attemptId: attempt.id,
              outcome: "lease_lost",
            });
            break;
          case "not_found":
            result.observationOutcomes.push({ attemptId: attempt.id, outcome: "not_found" });
            break;
        }
      } catch (err) {
        // An infrastructure throw escaped the engine (a missing attempt row is
        // handled internally as `not_found`; a DB-level throw is the only path
        // that reaches here). Log + count as `error` so the pass aggregate
        // records the failure for diagnostics; the interval keeps polling.
        const error = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, attemptId: attempt.id },
          "creationDispatchWorker: error processing observation attempt",
        );
        result.observationOutcomes.push({ attemptId: attempt.id, outcome: "error", error });
      }
      offset++;
      if (offset >= maxObservationAttempts) break;
    }

    // No attempt advanced (all are stuck in attention) — stop to avoid
    // looping on the same non-progressing batch. They'll be re-attempted
    // next tick.
    if (advanced === 0) break;
    if (offset >= maxObservationAttempts) break;
  }
  result.observationScanned = seenAttemptIds.size;

  // 2. SWEEP assignment-gate attempts.
  //
  // The sweep is wrapped separately so a sweep-side throw does NOT mask
  // the observation-side results (the observation aggregate is already
  // complete). The sweep itself catches per-attempt internally; an outer
  // throw would be an unforeseen infrastructure failure.
  try {
    result.assignmentSweep = sweepTargetedAssignments({
      limit,
      // The sweep mints a fresh uuid PER attempt internally; the
      // `workerId` here is a per-tick default so a caller can trace
      // passes by worker when needed.
      workerId: perAttemptWorkerId,
    });
  } catch (err) {
    logger.error({ err }, "creationDispatchWorker: error sweeping assignment attempts");
    // Leave `assignmentSweep` at the zero-initialized default; the
    // observation-side results remain intact.
  }

  return result;
}

// ---------------------------------------------------------------------------
// Boot-registration (dormant wiring — mirrors scheduledOccurrenceRecovery)
// ---------------------------------------------------------------------------

/**
 * Generates a UNIQUE-per-process dispatch-worker identity (T9B-01 — the
 * multi-instance fencing pattern). Composed of `${hostname}-${pid}-${uuidSuffix}`
 * so:
 *   - **same process** → same `hostname` + same `pid` (stable across the
 *     worker's interval ticks once minted by
 *     {@link startCreationDispatchWorker}).
 *   - **distinct processes** (multi-instance deployment) → distinct `pid`
 *     AND distinct `uuidSuffix` → the attempt lease CAS
 *     (`leaseOwner = expected`) can DISTINGUISH them. A stale worker
 *     whose lease was reclaimed by another instance CANNOT terminalize
 *     + clear the new owner's lease (its `workerId` no longer matches the
 *     row's).
 *
 * Exported for testability (the uniqueness + multi-instance fencing proof
 * generates two ids + asserts they differ). Production callers should use
 * {@link startCreationDispatchWorker} (which mints ONE id per call +
 * threads it across all interval ticks) rather than calling this
 * directly.
 *
 * `opts.workerId` (the override on `startCreationDispatchWorker` +
 * `RunDispatchWorkerPassOptions`) ALWAYS takes precedence — tests inject
 * explicit ids for deterministic assertions.
 */
export function createDispatchWorkerId(): string {
  return `${hostname()}-${process.pid}-${uuid().slice(0, 8)}`;
}

/**
 * Handle returned by {@link startCreationDispatchWorker}. The caller calls
 * `stop()` to clear the underlying interval (typically on process shutdown
 * via the existing `onClose` hook in `index.ts`).
 */
export interface CreationDispatchWorkerHandle {
  /** Clears the polling interval. Idempotent. */
  stop: () => void;
}

/**
 * T11 Phase 1A — starts a recurring interval that polls for + processes
 * pending observation-gate + assignment-gate attempts. Returns a handle
 * so the caller can stop it.
 *
 * Mirrors `startOccurrenceLeaseRecoveryWorker` (T9B Phase 2 — the
 * structural precedent) with one intentional shape difference: this
 * function wraps the `NodeJS.Timeout` in a `{ stop }` object so the
 * boot-registration is uniform with the upcoming scheduler-registration
 * surface (T11 Phase 1B). Tests + the `index.ts` boot-registration call
 * `.stop()`; `clearInterval(handle)` is the implementation.
 *
 * DORMANT: `index.ts` registers this inside the
 * `isCreationPublicationEnabled()` gate (T11 cutover concern).
 *
 * # Worker identity (T9B-01 — the unique-per-process fencing pattern)
 *
 * Each CALL to this function mints ONE worker id via
 * {@link createDispatchWorkerId} + closes over it for the lifetime of
 * the returned interval — all ticks share the id (so the fenced CAS can
 * attribute dispatches + lease takes to this worker). A SUBSEQUENT call
 * (e.g. a second deployment instance) mints a DIFFERENT id (distinct
 * `pid`/`uuid`), so the two workers' lease owners never collide. The
 * override `opts.workerId` still takes precedence for tests + explicit
 * operator-configured ids.
 *
 * @param intervalMs  Polling interval in milliseconds (default 5000 = 5s).
 *   The observation gate is user-facing — Tasks can't be claimed until
 *   it opens; 5s is acceptable UX. The default `leaseDurationMs` on the
 *   dispatch engine is 30s, so a tick is well within the lease budget.
 * @param opts        Pass options (`workerId` override, `limit`). Defaults:
 *   a unique-per-call {@link createDispatchWorkerId}, 100 attempts per
 *   scan.
 * @returns           `{ stop }` — call `stop()` to clear the interval.
 */
export function startCreationDispatchWorker(
  intervalMs: number = 5_000,
  opts: RunDispatchWorkerPassOptions = {},
): CreationDispatchWorkerHandle {
  // Mint ONE worker id per CALL (T9B-01). Closed over by the interval so
  // every tick reuses it — all dispatches from this worker share a stable
  // owner string. A subsequent call (second instance) mints a DISTINCT id
  // (distinct pid/uuid) so the fenced CAS can distinguish them.
  const workerId = opts.workerId ?? createDispatchWorkerId();
  const limit = opts.limit;
  let inFlight = false;
  const handle = setInterval(() => {
    // Single-flight: skip if the previous pass is still running (async
    // adapters can exceed the tick interval; overlapping passes with the
    // same workerId would re-attempt the same pending targets).
    if (inFlight) return;
    inFlight = true;
    // Build the per-tick opts explicitly (omit `limit` when undefined so
    // the default in `runDispatchWorkerPass` applies — passing
    // `undefined` for `limit` would still hit the default, but the
    // explicit-omit pattern is clearer for readers).
    const passOpts: RunDispatchWorkerPassOptions =
      limit !== undefined ? { workerId, limit } : { workerId };
    void runDispatchWorkerPass(passOpts)
      .then((passResult) => {
        if (passResult.observationScanned > 0 || passResult.assignmentSweep.processed > 0) {
          logger.info(passResult, "Creation dispatch worker completed a pass");
        }
      })
      .catch((err: unknown) => {
        // Last-resort guard against an unforeseen rejection — the per-attempt
        // + per-sweep try/catch already handle the expected domain failures.
        // Log + keep the interval alive; the next tick polls.
        logger.error({ err }, "Error running creation dispatch worker pass");
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  return {
    stop: () => clearInterval(handle),
  };
}
