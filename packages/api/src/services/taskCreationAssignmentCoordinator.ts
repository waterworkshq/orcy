/**
 * Targeted Assignment Coordinator — resolves one `published_pending_assignment`
 * attempt to a terminal outcome (DORMANT).
 *
 * Phase 1 of T5. Composes the shipped primitives — the T2 claim authority
 * (`claimWithAuthorityClient`), the T3A attempt lease + terminalization matrix
 * (`taskCreationAttempts.ts` / `taskPublication.ts`), and the T5 reservation
 * state-transition primitives (`consumeAssignmentReservationWithClient` /
 * `releaseAssignmentReservationWithClient`) — into ONE atomic resolution that a
 * worker calls per attempt surfaced by the P2 recovery scan.
 *
 * WHAT THIS COORDINATOR OWNS (the assignment-resolution state machine):
 *
 *   acquire lease ─▶ load attempt + active reservation ─▶ guard state
 *        │                                                    │
 *        │           ┌────────────────────────────────────────┘
 *        │           ▼
 *        │     ONE transaction {
 *        │       claimWithAuthorityClient(tx, taskId, {kind:"local", id: requestedAgentId})
 *        │       ── success    ─▶ consume reservation + complete attempt → created
 *        │       ── definitive ─▶ release reservation + complete attempt → created_unassigned
 *        │       ── transient  ─▶ no writes (empty tx) ─▶ release lease, resumable
 *        │     } catch (infra throw) ─▶ tx rolls back ─▶ release lease, resumable
 *        │
 *        └─▶ release lease (best-effort hygiene on every acquired path)
 *
 * THE ATOMICITY INVARIANT (the load-bearing guarantee): the claim mutation, the
 * reservation transition, and the attempt terminalization commit TOGETHER in
 * ONE transaction or not at all. A throw inside the tx rolls back all three —
 * the attempt stays `published_pending_assignment`, the reservation stays
 * `active`, and the coordinator returns `{outcome:"resumable"}` so the P2
 * recovery scan can retry. This is what makes a kill-worker crash deterministic:
 * pre-claim crash → nothing committed, resume; post-claim crash → terminal
 * replay via `completeAttemptWithClient`'s `no_op` path (the loser never
 * overwrites the winner).
 *
 * ADDITIVE — does NOT modify:
 *   - `claimWithAuthorityClient` / `claimWithAuthority` / the claim gates (the
 *     hub-risk rule, MEMORY.md § "Lifecycle mutation guards"). The coordinator
 *     is a NEW CALLER of the authority, not an edit to it.
 *   - `sseBroadcaster.publish` / `runPreInterceptors` (the additive seams stay
 *     byte-identical behind legacy short-circuits).
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover, so no
 `published_pending_assignment` attempt exists in production and no worker drives
 * this coordinator. The P2 scheduler/scan + the boot cron (T11) will poll it.
 */
import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import {
  tasks,
  taskCreationAttempts,
  taskCreationAssignmentReservations,
} from "../db/schema/index.js";
import { getDb } from "../db/index.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  consumeAssignmentReservationWithClient,
  releaseAssignmentReservationWithClient,
  expireAssignmentReservationWithClient,
  completeAttemptWithClient,
} from "../repositories/taskPublication.js";
import {
  acquireAttemptLeaseWithClient,
  releaseAttemptLeaseWithClient,
} from "../repositories/taskCreationAttempts.js";
import type {
  AttemptLeaseAcquireResult,
  TaskCreationAttemptRow,
} from "../repositories/taskCreationAttempts.js";
import {
  claimWithAuthorityClient,
  mapInfraErrorToFailure,
} from "../repositories/claimAuthority.js";
import type { ClaimFailureCategory } from "../repositories/claimAuthority.js";

/**
 * Default worker-lease duration for a single assignment-resolution pass. The
 * resolution is one claim + ≤2 writes inside one tx (sub-millisecond on
 * SQLite); 30s is generous and matches the dispatch-engine precedent.
 */
const DEFAULT_ASSIGNMENT_LEASE_MS = 30_000;

/**
 * Definitive refusal categories — the requested claim LOST permanently (the
 * identity is ineligible, governance vetoed, someone else already holds the
 * task, the task is no longer pending, or the reservation targets another).
 * These terminalize the attempt to `created_unassigned` and release the
 * reservation so the claim gate opens for ordinary claimants.
 *
 * Everything else is TRANSIENT (resumable):
 *   - `infrastructure_failure` (thrown by the primitive, caught + mapped)
 *   - `version_conflict` (CAS no-op returned OR UNIQUE thrown — both resumable)
 *   - `observation_pending` / `not_found` (defensive — should not occur for a
 *     `published_pending_assignment` attempt, but routed transient rather than
 *     crashing on an impossible state)
 */
const DEFINITIVE_REFUSAL_CATEGORIES: ReadonlySet<ClaimFailureCategory> = new Set([
  "ineligible",
  "governance_veto",
  "already_claimed",
  "not_pending",
  "reserved_for_other",
]);

/** Options for {@link resolveTargetedAssignment}. */
export interface ResolveTargetedAssignmentOptions {
  /**
   * Worker identity for the attempt lease. Defaults to a fresh `uuid()`.
   * Injectable so tests can drive the `held_by_other` / safe-takeover cases and
   * so a resuming worker can reuse the same id across crash-recovery.
   */
  workerId?: string;
  /** Lease duration in ms. Defaults to {@link DEFAULT_ASSIGNMENT_LEASE_MS}. */
  leaseDurationMs?: number;
  /**
   * Test injection: the drizzle client to run against. Defaults to `getDb()`.
   * Production callers omit this; tests pass the test DB (or a failing-client
   * wrapper) so the coordinator never reaches outside the injected client.
   */
  db?: TaskPublicationDbClient;
}

/**
 * Closed result of {@link resolveTargetedAssignment}.
 *
 * - `assigned`         — the requested claim SUCCEEDED; the Task is claimed by
 *                        the requested agent, the reservation is `consumed`,
 *                        and the attempt terminalized to `created` — all
 *                        committed atomically.
 * - `refused`          — the requested claim was DEFINITIVELY refused; the
 *                        reservation is `released` (with the reason stamped),
 *                        the attempt terminalized to `created_unassigned`, and
 *                        the Task is pending + ordinarily claimable (the gate
 *                        opened). `category`/`reason` carry the typed refusal.
 *                        `currentAssignee` is present for `already_claimed` /
 *                        `not_pending` so the P3 retry surface can report who
 *                        won (null = the task flipped status without an
 *                        assignee).
 * - `deadline_exceeded` — the bounded reservation deadline elapsed WITHOUT the
 *                        requested claim committing (the requested identity
 *                        LOST the race against the clock). The reservation is
 *                        `expired` (with `"deadline_exceeded"` stamped), the
 *                        attempt terminalized to `created_unassigned`, and the
 *                        Task is pending + ordinarily claimable (the gate
 *                        opened for ALL claimants). `deadline` carries the ISO
 *                        timestamp that elapsed.
 * - `resumable`        — the resolution could NOT complete (transient infra
 *                        failure, CAS conflict, or a defensive
 *                        observation_pending / not_found). NOTHING committed:
 *                        the attempt stays `published_pending_assignment`, the
 *                        reservation stays `active`, and the lease was released
 *                        so the recovery scan can retry. `category` carries the
 *                        transient category for retry telemetry.
 * - `terminal_replay`  — the attempt is ALREADY terminal (a prior resolution or
 *                        the observation path settled it). Idempotent return;
 *                        the coordinator does NOT rerun assignment (the
 *                        `completeAttemptWithClient` `no_op` invariant).
 * - `lease_unavailable`— another worker owns the active lease
 *                        (`already_owned` / `held_by_other`). NO resolution work
 *                        was done; the caller defers to the lease owner.
 * - `not_found`        — no attempt row exists for `attemptId`.
 * - `no_op`            — the attempt is `published_pending_assignment` but has
 *                        no active reservation / a null `requestedAgentId`, OR
 *                        the attempt state is unexpected. The lease was
 *                        released; no terminalization forced. `reason` carries
 *                        a short diagnostic for operational triage.
 */
export type TargetedAssignmentResolution =
  | { outcome: "assigned"; taskId: string; assigneeId: string }
  | {
      outcome: "refused";
      taskId: string;
      category: ClaimFailureCategory;
      reason: string;
      /** Present for already_claimed/not_pending (null = status flipped, no assignee). */
      currentAssignee?: { kind: "local" | "remote"; id: string } | null;
    }
  | { outcome: "deadline_exceeded"; taskId: string; deadline: string }
  | { outcome: "resumable"; category: ClaimFailureCategory }
  | { outcome: "terminal_replay"; attemptId: string; terminalState: string }
  | { outcome: "lease_unavailable"; acquire: AttemptLeaseAcquireResult }
  | { outcome: "not_found" }
  | { outcome: "no_op"; reason: string };

/**
 * Resolves ONE `published_pending_assignment` attempt to a terminal outcome.
 *
 * A worker (driven by the P2 recovery scan) calls this per attempt. The
 * coordinator is idempotent: re-calling on a terminalized attempt returns
 * `terminal_replay` WITHOUT rerunning assignment (the lease acquire refuses
 * terminal rows, and `completeAttemptWithClient`'s CAS would return `no_op`
 * even if a second resolution raced through).
 *
 * Decision order (all on the injected client — never a nested tx, never an
 * external effect):
 *   1. Acquire the T3A attempt lease. `not_found` → `not_found`;
 *      `terminal_locked` → `terminal_replay`; `already_owned` / `held_by_other`
 *      → `lease_unavailable` (NO resolution work — avoid redundant claims).
 *   2. Load the attempt + its active reservation. Guard: the attempt MUST be
 *      `published_pending_assignment` AND carry an active reservation with a
 *      non-null `requestedAgentId`. Otherwise release the lease + `no_op`
 *      (do NOT force a transition — the guardrail from the ticket).
 *   3. Run the resolution in ONE transaction:
 *        - `claimWithAuthorityClient(tx, taskId, {kind:"local", id})`.
 *        - success    → consume reservation + complete attempt → `created`.
 *        - definitive → release reservation + complete attempt →
 *          `created_unassigned` (typed reason; surface current assignee for
 *          `already_claimed`/`not_pending`).
 *        - transient  → no writes (empty tx); release lease; `resumable`.
 *      A throw inside the tx rolls back ALL writes (atomicity invariant) and is
 *      caught → mapped to `resumable` via the authority's infra mapper.
 *   4. Release the lease (best-effort hygiene; a release error is swallowed so
 *      it cannot mask the resolution result — an un-released lease expires
 *      naturally and the recovery scan retakes it).
 *
 * `claimWithAuthorityClient`'s internal `checkClaimability` reads via `getDb()`
 * not `tx` — a known, preserved limitation (ADR-0038); the claim mutation's own
 * CAS (`WHERE status = 'pending'`) is the TOCTOU guard. The coordinator does
 * not work around this.
 */
export function resolveTargetedAssignment(
  attemptId: string,
  opts: ResolveTargetedAssignmentOptions = {},
): TargetedAssignmentResolution {
  const db = opts.db ?? getDb();
  const workerId = opts.workerId ?? uuid();
  const leaseMs = opts.leaseDurationMs ?? DEFAULT_ASSIGNMENT_LEASE_MS;

  // 1. Acquire the attempt lease.
  const acquire = acquireAttemptLeaseWithClient(db, attemptId, workerId, leaseMs);
  if (acquire.outcome === "not_found") return { outcome: "not_found" };
  if (acquire.outcome === "terminal_locked") {
    return {
      outcome: "terminal_replay",
      attemptId,
      terminalState: acquire.attempt.state,
    };
  }
  if (acquire.outcome !== "acquired") {
    // already_owned | held_by_other — another call/worker owns the active lease.
    return { outcome: "lease_unavailable", acquire };
  }

  // acquired → every subsequent return path must release the lease.
  try {
    return resolveAcquired(db, attemptId);
  } finally {
    try {
      releaseAttemptLeaseWithClient(db, attemptId, workerId);
    } catch {
      // Best-effort hygiene — an un-released lease expires naturally and the
      // recovery scan retakes it. Swallow so the resolution result is not masked.
    }
  }
}

/**
 * The resolution body, run after the lease was freshly acquired. Loads the
 * attempt + reservation, guards state, and runs the atomic resolution tx.
 * Separated so the {@link resolveTargetedAssignment} finally can release the
 * lease on every acquired return path.
 */
function resolveAcquired(
  db: TaskPublicationDbClient,
  attemptId: string,
): TargetedAssignmentResolution {
  // 2. Load the attempt (exists — we just acquired its lease) + active reservation.
  const attempt = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0]!;
  if (attempt.state !== "published_pending_assignment") {
    // Unexpected state (e.g. a concurrent observation-satisfaction advanced it,
    // or a concurrent resolution terminalized it between acquire and read).
    // Do NOT force a transition — surface no_op for operational triage.
    return { outcome: "no_op", reason: `attempt_state_${attempt.state}` };
  }
  const reservation = getActiveReservationForAttempt(db, attemptId);
  if (!reservation) {
    return { outcome: "no_op", reason: "no_active_reservation" };
  }
  if (reservation.requestedAgentId === null) {
    // An active NULL reservation is an INVALID state the creation seam never
    // mints (PreparedReservationInput.requestedAgentId is required). Do NOT
    // force a transition — surface no_op.
    return { outcome: "no_op", reason: "null_requested_agent" };
  }
  const requestedAgentId = reservation.requestedAgentId;
  const taskId = reservation.taskId;

  // 3. Run the resolution in ONE transaction (atomicity invariant).
  try {
    return db.transaction((tx) => {
      // Phase 2 — matching-agent reconcile (additive branch BEFORE the deadline
      // check + the claim). If the requested agent already WON the Task via an
      // ordinary claim path before the coordinator ran (the reservation is FOR
      // the requested agent, so the agent is NOT "other" → the ordinary claim
      // gate admits them), the coordinator would otherwise receive
      // `already_claimed` with `currentAssignee === requestedAgentId` and the
      // definitive-refusal branch below would mislabel a SUCCESS as
      // `created_unassigned` (cold-review M1). Re-read the task row INSIDE the tx
      // (read-consistency with the claim mutation) + short-circuit to a real
      // success: consume the reservation + terminalize `created` with the
      // committed taskId stamped (so the replay path recovers it — M4-1). This
      // branch ALSO subsumes the "A claimed before the deadline fired" case
      // (the reconcile runs BEFORE the deadline check, so an already-won
      // assignment short-circuits to success regardless of the deadline). The
      // case where ANOTHER agent (not the requested one) won still falls through
      // to the refusal/deadline routing below unchanged (the reconcile ONLY
      // catches the matching-agent-won case).
      const reconcileTaskRow = tx.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
      if (reconcileTaskRow !== undefined && reconcileTaskRow.assignedAgentId === requestedAgentId) {
        consumeAssignmentReservationWithClient(tx, reservation.id);
        completeAttemptWithClient(tx, attemptId, {
          finalState: "created",
          terminalOutcome: "assigned",
          terminalResult: { outcome: "assigned", attemptId, taskId },
        });
        return {
          outcome: "assigned" as const,
          taskId,
          assigneeId: requestedAgentId,
        };
      }

      // Phase 2 — deadline pre-check (additive branch BEFORE the claim): if the
      // bounded reservation deadline elapsed WITHOUT the requested claim
      // committing, the requested identity LOST the race against the clock.
      // Expire the reservation + terminalize the attempt → created_unassigned in
      // this SAME tx, leaving the Task pending + ordinarily claimable (the
      // reservation gate opens for ALL claimants once it is `expired`). A future
      // deadline (`deadline` in the future) falls through to the claim/refusal/
      // transient routing below unchanged. (The matching-agent reconcile above
      // already short-circuited the case where the requested agent won before
      // the deadline fired.)
      if (reservation.deadline !== null && new Date(reservation.deadline).getTime() < Date.now()) {
        expireAssignmentReservationWithClient(tx, reservation.id, "deadline_exceeded");
        completeAttemptWithClient(tx, attemptId, {
          finalState: "created_unassigned",
          terminalOutcome: "assignment_deadline_exceeded",
          terminalResult: {
            outcome: "assignment_deadline_exceeded",
            attemptId,
            taskId,
            assignmentFailure: { reason: "deadline_exceeded" },
          },
        });
        return {
          outcome: "deadline_exceeded" as const,
          taskId,
          deadline: reservation.deadline,
        };
      }

      const claim = claimWithAuthorityClient(tx, taskId, {
        kind: "local",
        id: requestedAgentId,
      });

      // success → consume reservation + complete attempt → created.
      if (claim.success) {
        consumeAssignmentReservationWithClient(tx, reservation.id);
        completeAttemptWithClient(tx, attemptId, {
          finalState: "created",
          terminalOutcome: "assigned",
          terminalResult: { outcome: "assigned", attemptId, taskId },
        });
        return {
          outcome: "assigned" as const,
          taskId,
          assigneeId: requestedAgentId,
        };
      }

      // definitive refusal → release reservation + complete attempt → created_unassigned.
      if (DEFINITIVE_REFUSAL_CATEGORIES.has(claim.category)) {
        releaseAssignmentReservationWithClient(tx, reservation.id, claim.reason);
        // Surface the current assignee for already_claimed / not_pending so the
        // P3 retry surface can report who won. Re-read the task inside the tx
        // for read-consistency with the claim mutation.
        let currentAssignee: { kind: "local" | "remote"; id: string } | null | undefined =
          undefined;
        if (claim.category === "already_claimed" || claim.category === "not_pending") {
          const taskRow = tx.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
          if (taskRow) {
            if (taskRow.assignedAgentId !== null) {
              currentAssignee = { kind: "local", id: taskRow.assignedAgentId };
            } else if (taskRow.remoteAssignedParticipantId !== null) {
              currentAssignee = { kind: "remote", id: taskRow.remoteAssignedParticipantId };
            } else {
              // not_pending with no assignee (status flipped without claiming).
              currentAssignee = null;
            }
          }
        }
        completeAttemptWithClient(tx, attemptId, {
          finalState: "created_unassigned",
          terminalOutcome: "assignment_refused",
          terminalResult: {
            outcome: "assignment_refused",
            attemptId,
            taskId,
            assignmentFailure: { category: claim.category, reason: claim.reason },
          },
        });
        return {
          outcome: "refused" as const,
          taskId,
          category: claim.category,
          reason: claim.reason,
          ...(currentAssignee !== undefined ? { currentAssignee } : {}),
        };
      }

      // transient (observation_pending, not_found, version_conflict from CAS
      // no-op) → do NOT terminalize, do NOT touch the reservation. The claim
      // primitive performed NO writes on these paths, so the tx commits empty.
      // The lease is released by the outer finally; the recovery scan retakes.
      return {
        outcome: "resumable" as const,
        category: claim.category,
      };
    });
  } catch (err) {
    // The tx rolled back — a throw from claimWithAuthorityClient (infra error),
    // consume/release, or completeAttempt. Map to a typed resumable result via
    // the authority's canonical infra mapper (never collapses to already_claimed).
    const mapped = mapInfraErrorToFailure(err, taskId, {
      kind: "local",
      id: requestedAgentId,
    });
    return { outcome: "resumable", category: mapped.category };
  }
}

/**
 * Loads the single active reservation for an attempt, or `undefined` if none.
 * Mirrors the dispatch engine's `envelopeForAttempt` private-helper pattern: a
 * read on the passed client, never `getDb()`, never opens a tx. An attempt has
 * AT MOST one active reservation (the creation seam mints one; the coordinator
 * retires it before any second could appear). A second active reservation is a
 * data-integrity anomaly — treat the first as authoritative rather than
 * throwing (the coordinator is resumable, not crash-prone).
 */
function getActiveReservationForAttempt(
  db: TaskPublicationDbClient,
  attemptId: string,
): typeof taskCreationAssignmentReservations.$inferSelect | undefined {
  return db
    .select()
    .from(taskCreationAssignmentReservations)
    .where(
      and(
        eq(taskCreationAssignmentReservations.attemptId, attemptId),
        eq(taskCreationAssignmentReservations.state, "active"),
      ),
    )
    .all()[0];
}

// ---------------------------------------------------------------------------
// Phase 2 — recovery scan + sweeper
// ---------------------------------------------------------------------------

/**
 * Options for {@link listAttemptsPendingAssignmentWithClient}. Mirrors
 * {@link ListAttemptsPendingObservationOptions} (the observation-scan
 * counterpart in the dispatch engine) for shape parity.
 */
export interface ListAttemptsPendingAssignmentOptions {
  /** Page size. Defaults to 100. */
  limit?: number;
  /** Page offset. Defaults to 0. */
  offset?: number;
}

/**
 * Bounded recovery scan of attempts currently at `published_pending_assignment`
 * — the surface an operational scheduler (the T11 boot cron) polls to drive
 * {@link resolveTargetedAssignment}. Oldest-first (`reservedAt` ASC) so
 * prolonged-pending attempts (and elapsed deadlines) are revisited first.
 *
 * Mirrors {@link listAttemptsPendingObservationWithClient} (the dispatch
 * engine's observation scan) in shape + ordering. Terminal attempts are
 * excluded by the `state = 'published_pending_assignment'` predicate (terminal
 * states live outside this state). The scan only READS — all resolution
 * authority (lease acquire, deadline check, claim, terminalization) stays in
 * {@link resolveTargetedAssignment}, which the sweeper calls per row.
 *
 * Never calls `getDb()`, never opens a tx, never emits external effects.
 */
export function listAttemptsPendingAssignmentWithClient(
  db: TaskPublicationDbClient,
  opts: ListAttemptsPendingAssignmentOptions = {},
): TaskCreationAttemptRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.state, "published_pending_assignment"))
    .orderBy(taskCreationAttempts.reservedAt)
    .limit(limit)
    .offset(offset)
    .all();
}

/** Options for {@link sweepTargetedAssignments}. */
export interface SweepTargetedAssignmentsOptions {
  /** Page size passed to {@link listAttemptsPendingAssignmentWithClient}. */
  limit?: number;
  /** Page offset passed to {@link listAttemptsPendingAssignmentWithClient}. */
  offset?: number;
  /**
   * Worker identity forwarded to {@link resolveTargetedAssignment} for each
   * attempt's lease acquire. Defaults to a fresh `uuid()` PER attempt (each
   * resolution gets its own worker id so a lease taken on attempt N does not
   * collide with attempt N+1). Injectable for deterministic sweep tests.
   */
  workerId?: string;
  /**
   * Test injection: the drizzle client to run against. Defaults to `getDb()`.
   * Production callers omit this.
   */
  db?: TaskPublicationDbClient;
}

/**
 * Closed result of {@link sweepTargetedAssignments} — the aggregate over a
 * single sweep pass. `processed` counts every attempt the sweeper iterated;
 * the categorical fields tally the per-attempt {@link TargetedAssignmentResolution}
 * outcomes the coordinator owns. Outcomes that are NOT load-bearing for retry
 * telemetry (`terminal_replay`, `no_op`, `not_found`) are counted in
 * `processed` but not in a categorical field (they are no-ops for the sweep).
 */
export interface SweepTargetedAssignmentsResult {
  processed: number;
  assigned: number;
  refused: number;
  deadlineExceeded: number;
  resumable: number;
  leaseUnavailable: number;
}

/**
 * Recovery entry point — the thin orchestration an operational scheduler (the
 * T11 boot cron) polls. Scans `published_pending_assignment` attempts (oldest
 * first) and resolves each via {@link resolveTargetedAssignment}, which owns
 * ALL resolution authority: lease acquire (with its built-in expired-lease
 * takeover), the deadline pre-check, and the claim/refusal/transient routing.
 *
 * This sweeper is THIN — it does not re-implement lease/deadline/claim logic.
 * Automatic kill-worker recovery comes from `acquireAttemptLeaseWithClient`'s
 * CAS already encoding takeover (`leaseOwner IS NULL OR leaseExpiresAt < now`):
 * a crashed worker's expired lease is re-takeable on a LATER sweep pass, so
 * repeated sweeps converge. Lease renewal is NOT required — each resolution is
 * one quick tx (sub-millisecond); there is no long-running work to renew
 * mid-resolution.
 *
 * Sweep idempotency: resolving an already-terminal attempt returns
 * `terminal_replay` (the lease acquire refuses terminal rows), so a re-sweep
 * over settled attempts is a safe no-op. The sweeper does NOT build the cron/
 * queue (cutover concern — T11); it delivers the function the scheduler calls.
 *
 * Never calls `getDb()` directly when `opts.db` is injected.
 */
export function sweepTargetedAssignments(
  opts: SweepTargetedAssignmentsOptions = {},
): SweepTargetedAssignmentsResult {
  const db = opts.db ?? getDb();
  const attempts = listAttemptsPendingAssignmentWithClient(db, {
    limit: opts.limit,
    offset: opts.offset,
  });
  const aggregate: SweepTargetedAssignmentsResult = {
    processed: 0,
    assigned: 0,
    refused: 0,
    deadlineExceeded: 0,
    resumable: 0,
    leaseUnavailable: 0,
  };
  for (const attempt of attempts) {
    // Each attempt resolves with its own lease; forwarding a single workerId
    // would make attempt N's lease collide with attempt N+1's acquire. Default
    // to a fresh uuid per attempt; tests may override for determinism.
    const result = resolveTargetedAssignment(attempt.id, {
      db,
      workerId: opts.workerId ?? uuid(),
    });
    aggregate.processed++;
    switch (result.outcome) {
      case "assigned":
        aggregate.assigned++;
        break;
      case "refused":
        aggregate.refused++;
        break;
      case "deadline_exceeded":
        aggregate.deadlineExceeded++;
        break;
      case "resumable":
        aggregate.resumable++;
        break;
      case "lease_unavailable":
        aggregate.leaseUnavailable++;
        break;
      // terminal_replay | no_op | not_found — counted in processed only.
    }
  }
  return aggregate;
}
