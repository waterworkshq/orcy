/**
 * Dispatch Engine — observation advancement + lease-based dispatcher (DORMANT).
 *
 * Phase 2 of T4A. Composes the Phase 1 dispatch-target primitives
 * (`repositories/taskCreationDispatch.ts`) + the adapter registry (this
 * `services/` dir) + the T3A attempt lease / transition matrix
 * (`repositories/taskCreationAttempts.ts`, `repositories/taskPublication.ts`)
 * to SATISFY the observation checkpoint: advance a post-cutover attempt past
 * `published_pending_observation` once every required dispatch target is
 * `accepted`. Phase 3 wires the claim gate to that real state (replacing the
 * current placeholder `creationIntegrity > 0 → blocked`).
 *
 * Load-bearing invariant — NONE of these functions:
 *   - call `getDb()` (they would escape the caller's transaction),
 *   - open their own transaction (no nested transactions),
 *   - emit external effects BEYOND the registered adapter seam (the adapter's
 *     `attempt()` is the single side-effect point; it is synchronous + MUST be
 *     idempotent because the worker is at-least-once).
 *
 * They compose the transaction-aware `*WithClient` primitives on the
 * caller-supplied client. When that client is the default `getDb()` connection
 * (the worker case), each primitive's compare-and-set UPDATE autocommits, so a
 * crash mid-process leaves the work already done durable and the resume
 * idempotently skips it (CAS). When a test wraps them in a `tx`, every step
 * shares that transaction.
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover, so
 * no dispatch targets exist in production and no worker drives this engine.
 * See the T4A ticket § "Phase 2 grounding".
 */
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { taskCreationAttempts, taskCreationEnvelopes } from "../db/schema/index.js";
import { repositoryNotFoundError } from "../errors/repository.js";
import type {
  TaskPublicationDbClient,
  AttemptTransitionResult,
  AttemptCompletionResult,
} from "../repositories/taskPublication.js";
import {
  hasActiveReservationForAttemptWithClient,
  checkpointAttemptWithClient,
  completeAttemptWithClient,
} from "../repositories/taskPublication.js";
import {
  listDispatchTargetsForEnvelopeWithClient,
  advanceDispatchTargetWithClient,
  allDispatchTargetsAcceptedWithClient,
} from "../repositories/taskCreationDispatch.js";
import type { DispatchTargetTransitionResult } from "../repositories/taskCreationDispatch.js";
import type {
  AttemptLeaseAcquireResult,
  TaskCreationAttemptRow,
} from "../repositories/taskCreationAttempts.js";
import {
  acquireAttemptLeaseWithClient,
  renewAttemptLeaseWithClient,
  releaseAttemptLeaseWithClient,
} from "../repositories/taskCreationAttempts.js";
import { resolveDispatchAdapter } from "./taskCreationDispatchRegistry.js";

/**
 * Default worker-lease duration for a single dispatch pass. Generous for the
 * synchronous Phase 1/2 adapters (no real adapters are registered until T4B);
 * real async adapters (T4B) renew per-target via {@link renewAttemptLeaseWithClient}.
 */
const DEFAULT_DISPATCH_LEASE_MS = 30_000;

// ---------------------------------------------------------------------------
// satisfyObservationCheckpointWithClient
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link satisfyObservationCheckpointWithClient}.
 *
 * - `advanced`           — the attempt WAS at `published_pending_observation`,
 *                          targets all accepted, and this call's CAS installed
 *                          the advance (checkpoint to
 *                          `published_pending_assignment` if an active
 *                          reservation exists; terminalization to `created`
 *                          otherwise). `transition` carries the underlying
 *                          {@link AttemptTransitionResult} /
 *                          {@link AttemptCompletionResult} (with the row).
 * - `no_op`              — the read said at-observation but the CAS lost to a
 *                          concurrent writer (the underlying primitive returned
 *                          `no_op`); the attempt is now past observation due to
 *                          the winner. No state change by this call.
 * - `not_satisfiable`    — at least one dispatch target is still `pending` or
 *                          `attention` (the observation checkpoint stays
 *                          closed; the Task stays unavailable).
 * - `not_at_observation` — the read-state is NOT `published_pending_observation`
 *                          (pending / already advanced / terminal). No advance
 *                          attempted.
 *
 * Never throws for a decision; only a missing attempt row (data integrity)
 * throws {@link repositoryNotFoundError}, matching {@link checkpointAttemptWithClient}.
 */
export type ObservationCheckpointResult =
  | { outcome: "advanced"; transition: AttemptTransitionResult | AttemptCompletionResult }
  | { outcome: "no_op" }
  | { outcome: "not_satisfiable" }
  | { outcome: "not_at_observation" };

/**
 * Advance the observation checkpoint for an attempt when its dispatch targets
 * are all accepted (the T4A Phase 2 observation-satisfaction step).
 *
 * Decision order (all on the passed client — never `getDb()`, never a nested tx):
 *   1. Read the attempt (state decision). Missing → throws (data integrity).
 *   2. Resolve the attempt's envelope (by `attemptId`) → `eventId`. The
 *      attempt's `committedTaskId` is NOT set at observation (T3C stamps neither
 *      it nor `envelopeEventId` on the attempt here) — the envelope is the link.
 *   3. All targets accepted? (vacuously `true` for zero targets / a missing
 *      envelope — the dormant common case). No → `not_satisfiable`.
 *   4. State is `published_pending_observation`? No → `not_at_observation`.
 *   5. Active reservation for the attempt?
 *        - yes → {@link checkpointAttemptWithClient} → `published_pending_assignment`
 *          (the assignment gate still owes the requested claim).
 *        - no  → {@link completeAttemptWithClient} `{finalState:"created",
 *          terminalOutcome:"published"}` (now legal via the T4A Phase 2
 *          `isLegalTerminalForward` widening — the no-reservation observation-
 *          success terminal).
 *   6. Map: `transitioned` / `completed` → `advanced`; `no_op` → `no_op`
 *      (concurrent writer won); `rejected_transition` → `no_op` (defensive —
 *      cannot occur for a legal pair post-widening, but a concurrent
 *      terminalization could surface it).
 *
 * Never throws for a transition decision.
 */
export function satisfyObservationCheckpointWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
): ObservationCheckpointResult {
  // 1. Read the attempt (state decision + existence).
  const attempt = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!attempt) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  // 2. Resolve the envelope by attemptId → eventId. The envelope carries the
  //    (eventId, attemptId, taskId) linkage; the attempt's committedTaskId is
  //    NOT set at observation (T3C), so the envelope is the authoritative link.
  const envelope = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.attemptId, attemptId))
    .all()[0];
  const eventId = envelope?.eventId ?? null;

  // 3. All targets accepted? A missing envelope is treated as the zero-target
  //    case (vacuously true) — the dormant common case, and a missing envelope
  //    must not deadlock the attempt at observation forever.
  const allAccepted = eventId !== null ? allDispatchTargetsAcceptedWithClient(db, eventId) : true;
  if (!allAccepted) return { outcome: "not_satisfiable" };

  // 4. At observation? (Checked AFTER the all-accepted gate per the ticket: an
  //    already-advanced attempt whose targets are all accepted surfaces here.)
  if (attempt.state !== "published_pending_observation") {
    return { outcome: "not_at_observation" };
  }

  // 5. Advance: active reservation → assignment checkpoint; else → terminalize.
  const transition = hasActiveReservationForAttemptWithClient(db, attemptId)
    ? checkpointAttemptWithClient(db, attemptId, { stage: "published_pending_assignment" })
    : completeAttemptWithClient(db, attemptId, {
        finalState: "created",
        terminalOutcome: "published",
      });

  // 6. Map the underlying CAS outcome.
  if (transition.outcome === "transitioned" || transition.outcome === "completed") {
    return { outcome: "advanced", transition };
  }
  return { outcome: "no_op" };
}

// ---------------------------------------------------------------------------
// processEnvelopeDispatchWithClient
// ---------------------------------------------------------------------------

/** Options for {@link processEnvelopeDispatchWithClient}. */
export interface ProcessEnvelopeDispatchOptions {
  /**
   * Worker identity for the attempt lease. Defaults to a fresh `uuid()`.
   * Injectable so tests can drive the `held_by_other` / safe-takeover cases.
   */
  workerId?: string;
  /** Lease duration in ms. Defaults to {@link DEFAULT_DISPATCH_LEASE_MS}. */
  leaseDurationMs?: number;
}

/**
 * Closed result of {@link processEnvelopeDispatchWithClient}.
 *
 * - `dispatched`        — the lease was acquired (or already held) and the
 *                         envelope processed: each non-accepted target was
 *                         attempted via its registered adapter (or recorded to
 *                         `attention` if unregistered), then the observation
 *                         checkpoint was evaluated. `targets` carries every
 *                         per-target CAS result; `observation` carries the
 *                         advancement decision.
 * - `lease_unavailable`  — the lease could NOT be acquired (`held_by_other` or
 *                         `terminal_locked`). NO adapter is called and NO
 *                         target is touched (no redundant work). `acquire`
 *                         carries the T3A acquire result for diagnostics.
 * - `not_found`          — no attempt row exists for `attemptId`.
 */
export type EnvelopeDispatchResult =
  | {
      outcome: "dispatched";
      workerId: string;
      targets: DispatchTargetTransitionResult[];
      observation: ObservationCheckpointResult;
    }
  | { outcome: "lease_unavailable"; acquire: AttemptLeaseAcquireResult }
  | { outcome: "not_found" };

/**
 * Process one envelope's dispatch on the passed client: acquire the attempt
 * lease, attempt every non-accepted dispatch target via its registered adapter
 * (recording `accepted` / `attention`), then evaluate the observation
 * checkpoint. The resumable dispatcher worker (T4A Phase 2) drives this per
 * attempt surfaced by {@link listAttemptsPendingObservationWithClient}.
 *
 * Flow (all on the passed client — never `getDb()`, never a nested tx):
 *   1. Acquire the T3A attempt lease. `held_by_other` / `terminal_locked` →
 *      `lease_unavailable` (return WITHOUT any adapter call — no redundant
 *      work). `not_found` → `not_found`.
 *   2. Resolve the envelope by `attemptId` (eventId + the row passed to adapters).
 *   3. List the envelope's targets; filter to NON-accepted (accepted is sticky;
 *      a target accepted before a crash is NOT re-attempted — crash-resumable).
 *   4. For each: renew the lease defensively (a lost lease mid-loop → stop);
 *      resolve the adapter. UNREGISTERED `targetKind` → record `attention`
 *      with `lastError: "no adapter registered for targetKind ..."` — the
 *      target stays non-accepted so `all-accepted` is false and the Task stays
 *      UNAVAILABLE (NO silent claimability). Registered → `adapter.attempt()`
 *      → record the outcome (CAS-protected, idempotent).
 *   5. {@link satisfyObservationCheckpointWithClient} — advance if all accepted.
 *   6. Release the lease (best-effort; if lost mid-loop this is a no-op).
 *
 * Idempotent (CAS-protected at every step): re-processing an all-accepted
 * envelope / already-advanced attempt is a no-op (no adapter call, no
 * re-transition). At-least-once with dedup via the target CAS.
 */
export function processEnvelopeDispatchWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  opts: ProcessEnvelopeDispatchOptions = {},
): EnvelopeDispatchResult {
  const workerId = opts.workerId ?? uuid();
  const leaseMs = opts.leaseDurationMs ?? DEFAULT_DISPATCH_LEASE_MS;

  // 1. Acquire the attempt lease. Refused → surface WITHOUT adapter calls.
  const acquire = acquireAttemptLeaseWithClient(db, attemptId, workerId, leaseMs);
  if (acquire.outcome === "not_found") return { outcome: "not_found" };
  if (acquire.outcome !== "acquired" && acquire.outcome !== "already_owned") {
    // held_by_other | terminal_locked: another worker owns it or it is settled.
    return { outcome: "lease_unavailable", acquire };
  }

  // 2-4. Resolve the envelope; list + attempt its non-accepted targets.
  const envelope = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.attemptId, attemptId))
    .all()[0];

  const targetResults: DispatchTargetTransitionResult[] = [];
  if (envelope) {
    const targets = listDispatchTargetsForEnvelopeWithClient(db, envelope.eventId);
    // Accepted is sticky — skip it (crash-resumable: a target accepted before a
    // crash is NOT re-attempted). Pending + attention are (re)attempted.
    const outstanding = targets.filter((t) => t.state !== "accepted");

    for (const target of outstanding) {
      // Renew defensively before each target (a real async adapter in T4B could
      // exceed the lease duration; losing the lease mid-process → stop).
      const renew = renewAttemptLeaseWithClient(db, attemptId, workerId, leaseMs);
      if (renew.outcome === "not_owner") break; // lost the lease; stop.

      const adapter = resolveDispatchAdapter(target.targetKind);
      if (!adapter) {
        // Unregistered targetKind → attention. The target stays non-accepted, so
        // all-accepted is false and the Task stays UNAVAILABLE (NO silent
        // claimability).
        targetResults.push(
          advanceDispatchTargetWithClient(db, {
            targetId: target.id,
            outcome: "attention",
            lastError: `no adapter registered for targetKind "${target.targetKind}"`,
          }),
        );
        continue;
      }

      const attemptOutcome = adapter.attempt(envelope, target);
      targetResults.push(
        attemptOutcome.outcome === "accepted"
          ? advanceDispatchTargetWithClient(db, { targetId: target.id, outcome: "accepted" })
          : advanceDispatchTargetWithClient(db, {
              targetId: target.id,
              outcome: "attention",
              lastError: attemptOutcome.error,
            }),
      );
    }
  }

  // 5. Evaluate + advance the observation checkpoint.
  const observation = satisfyObservationCheckpointWithClient(db, attemptId);

  // 6. Release the lease (best-effort; a lost-lease mid-loop makes this a no-op).
  releaseAttemptLeaseWithClient(db, attemptId, workerId);

  return { outcome: "dispatched", workerId, targets: targetResults, observation };
}

// ---------------------------------------------------------------------------
// listAttemptsPendingObservationWithClient
// ---------------------------------------------------------------------------

/** Options for {@link listAttemptsPendingObservationWithClient}. */
export interface ListAttemptsPendingObservationOptions {
  /** Page size. Defaults to 100. */
  limit?: number;
  /** Page offset. Defaults to 0. */
  offset?: number;
}

/**
 * Bounded recovery scan of attempts currently at `published_pending_observation`
 * — the surface an operational scheduler polls to drive
 * {@link processEnvelopeDispatchWithClient} (the "resumes after process failure"
 * path). Oldest-first (`reservedAt` ASC) so prolonged-pending attempts are
 * revisited first.
 *
 * This is the SCAN ONLY — Phase 2 does NOT build the scheduler/queue/cron that
 * polls it (operational, later). Never calls `getDb()`, never opens a tx.
 */
export function listAttemptsPendingObservationWithClient(
  db: TaskPublicationDbClient,
  opts: ListAttemptsPendingObservationOptions = {},
): TaskCreationAttemptRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.state, "published_pending_observation"))
    .orderBy(taskCreationAttempts.reservedAt)
    .limit(limit)
    .offset(offset)
    .all();
}
