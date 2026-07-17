/**
 * Task Publication Persistence — transaction-aware, DORMANT primitives.
 *
 * Phase 2 of T1. These `*WithClient` functions mirror the Pulse precedent
 * (`PulseDbClient` / `createPulseWithClient` in `pulse.ts`): each accepts a
 * caller-supplied drizzle client (the default `getDb()` OR a `tx` from
 * `db.transaction(cb)`), validates its input, and inserts on THAT client only.
 *
 * Load-bearing invariant — NONE of these primitives:
 *   - call `getDb()` (they would escape the caller's transaction),
 *   - open their own transaction (no nested transactions),
 *   - emit external effects (SSE / hooks / webhooks).
 * They only validate + insert on the caller-supplied client. The publication
 * coordinator (later tickets) composes them inside one `db.transaction((tx) => …)`
 * to achieve the atomicity that `taskCrud.createTask` cannot (it is a bare
 * `getDb()` insert with no transaction).
 *
 * These primitives are DORMANT: no production origin routes through them yet.
 * See `db/schema/taskPublication.ts` (Phase 1) for the dormant storage they
 * write against, and the Technical Plan § "Transactional Persistence".
 */
import { getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskDependencies,
  taskSubtasks,
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
  missionRecalculationMarkers,
} from "../db/schema/index.js";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { CausalContext } from "@orcy/shared";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryUpdateError,
  repositoryNotFoundError,
} from "../errors/repository.js";

// ---------------------------------------------------------------------------
// Shared client type (mirrors PulseDbClient exactly)
// ---------------------------------------------------------------------------

/**
 * Drizzle client accepted by every `*WithClient` primitive in this module.
 * The default `getDb()` client and a transactional `tx` from
 * `db.transaction(cb)` both satisfy this shape. The publication coordinator
 * passes a `tx` so every insert shares one atomic unit; an exception rolls
 * back the whole batch.
 *
 * Mirrors `PulseDbClient` (`repositories/pulse.ts`).
 */
export type TaskPublicationDbClient = ReturnType<typeof getDb>;

/** Actor provenance union shared across publication tables. */
type ActorType = "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";

// ---------------------------------------------------------------------------
// JSON column shapes (mirror db/schema/taskPublication.ts; not exported there)
// ---------------------------------------------------------------------------

/**
 * Re-exported from `@orcy/shared` so existing callers keep resolving
 * `import type { CausalContext } from "../repositories/taskPublication.js"`.
 * Canonical definition lives in `packages/shared/src/types/causalContext.ts`.
 */
export type { CausalContext, CausalRef, CausalHop } from "@orcy/shared";

/** Compact terminal outcome sufficient for deduplication and audit replay. */
export interface AttemptTerminalResult {
  outcome: string;
  attemptId?: string;
  taskId?: string;
  publication?: unknown;
  errors?: unknown[];
  veto?: unknown;
  assignmentFailure?: unknown;
}

// ---------------------------------------------------------------------------
// Prepared-input / result types
// ---------------------------------------------------------------------------

/** Prepared Task row for {@link createTaskWithClient}. */
export interface PreparedTaskInput {
  missionId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: "low" | "medium" | "high" | "critical";
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  createdBy: string;
  /** When omitted, the primitive allocates `max(order)+1` ON THE PASSED CLIENT. */
  order?: number;
  estimatedMinutes?: number | null;
  /**
   * Caller-supplied Task ID. When omitted, the primitive mints a fresh `uuid()`
   * (byte-identical to the pre-extension behavior). The atomic publication
   * coordinator (T3C) passes the prospective Task ID so governance-decision /
   * envelope / reservation linkage resolves to the SAME row — additive;
   * legacy callers continue to receive a minted id.
   */
  id?: string;
  /**
   * Creation-integrity version stamped on the inserted row. When omitted, the
   * column default (`0` = Legacy Partial History) applies — byte-identical to
   * the pre-extension behavior. The atomic publication coordinator (T3C) passes
   * {@link TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER} so the claim paths'
   * `isLegacyPartialHistory` gate engages on the committed Task. Additive.
   */
  creationIntegrity?: number;
}

/** Prepared initial lifecycle event (`created` / `cloned`) for {@link createTaskEventWithClient}. */
export interface PreparedTaskEventInput {
  taskId: string;
  actorType: ActorType;
  actorId: string;
  action: "created" | "cloned";
  fromColumnId?: string;
  toColumnId?: string;
  fromStatus?: string;
  toStatus?: string;
  metadata?: Record<string, unknown>;
}

/** Prepared Subtask row for {@link createSubtaskWithClient}. */
export interface PreparedSubtaskInput {
  taskId: string;
  title: string;
  order?: number;
  completed?: boolean;
  assigneeId?: string;
}

/** Prepared dependency edge for {@link addTaskDependencyWithClient}. */
export interface PreparedDependencyInput {
  taskId: string;
  dependsOnId: string;
}

/** Prepared committed-envelope row for {@link createCommittedTaskEnvelopeWithClient}. */
export interface CommittedEnvelopeInput {
  eventId: string;
  lifecycleAction: "created" | "cloned";
  taskId: string;
  habitatId: string;
  occurredAt: string;
  attemptId: string;
  actorType: ActorType;
  actorId: string;
  source: string;
  causalContext?: CausalContext;
  cloneSourceTaskId?: string;
}

/** A single dispatch-target entry in a {@link CommittedEnvelopeInput} dispatch plan. */
export interface DispatchTargetInput {
  targetKind: string;
  targetKey: string;
}

/** Combined result of {@link createCommittedTaskEnvelopeWithClient}. */
export interface CommittedEnvelopeResult {
  envelope: typeof taskCreationEnvelopes.$inferSelect;
  dispatchTargets: Array<typeof taskCreationDispatchTargets.$inferSelect>;
}

/** Prepared assignment-reservation row for {@link createAssignmentReservationWithClient}. */
export interface PreparedReservationInput {
  taskId: string;
  attemptId: string;
  /**
   * The local agent this reservation targets. REQUIRED at the creation seam so
   * the primitive never mints a NULL `requested_agent_id` (an active NULL
   * reservation is an invalid state the claim gate defends against — see
   * `activeReservationForOther` in `claimAuthority.ts`). The schema COLUMN
   * stays nullable (no migration): the gate is the defender, not the column.
   */
  requestedAgentId: string;
  deadline: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

/** Checkpoint directive for {@link checkpointAttemptWithClient}. */
export interface AttemptCheckpoint {
  /** The post-publish state to advance to. */
  stage: "published_pending_observation" | "published_pending_assignment";
  /** Defaults to `now` (ISO) when omitted. */
  publishedAt?: string;
}

/** Terminal completion directive for {@link completeAttemptWithClient}. */
export interface TerminalResult {
  terminalOutcome: string;
  terminalResult?: AttemptTerminalResult;
  finalState:
    | "created"
    | "created_unassigned"
    | "rejected_validation"
    | "vetoed"
    | "batch_rejected";
  /** Defaults to `now` (ISO) when omitted. Set only on first completion (idempotent). */
  completedAt?: string;
}

/**
 * Closed result of {@link checkpointAttemptWithClient} — the compare-and-set
 * transition matrix. Never throws for an expected transition decision; only
 * infrastructure failures (retryable transport) throw.
 *
 * - `transitioned`        — a legal forward transition fired (compare-and-set
 *                           UPDATE matched the expected current state).
 * - `no_op`                — same-state request (returns the row unchanged; does
 *                           NOT re-stamp `publishedAt`), OR a concurrent writer
 *                           moved state between the in-tx read and the
 *                           conditional UPDATE so the WHERE did not match.
 * - `rejected_transition`  — the request is illegal: backward, a forward skip,
 *                           or a transition out of a terminal state (the
 *                           T3A guardrail: "terminal replay cannot transition
 *                           back to active work"). `fromState`/`toStage` carry
 *                           the rejected pair for diagnostics.
 */
export type AttemptTransitionResult =
  | { outcome: "transitioned"; attempt: typeof taskCreationAttempts.$inferSelect }
  | { outcome: "no_op"; attempt: typeof taskCreationAttempts.$inferSelect }
  | {
      outcome: "rejected_transition";
      attempt: typeof taskCreationAttempts.$inferSelect;
      /** State read on the passed client when the request was decided. */
      fromState: string;
      /** Target checkpoint stage the request named. */
      toStage: AttemptCheckpoint["stage"];
    };

/**
 * Closed result of {@link completeAttemptWithClient} — terminalization through
 * the same compare-and-set transition matrix as
 * {@link checkpointAttemptWithClient}. Never throws for an expected completion
 * decision; only infrastructure failures (retryable transport) throw.
 *
 * - `completed`           — the legal `fromState→finalState` CAS UPDATE matched
 *                           exactly one row (this call installed the terminal
 *                           state, timestamp, and result).
 * - `no_op`               — the attempt was ALREADY terminal (the CAS
 *                           `completedAt IS NULL` predicate matched zero rows):
 *                           a concurrent completion won, or a terminal replay
 *                           reached this layer. The authoritative terminal row
 *                           is returned UNCHANGED — the loser never overwrites
 *                           the winner's result.
 * - `rejected_transition` — the `fromState→finalState` pair is illegal (e.g.
 *                           `pending→created` bypasses the observation/
 *                           assignment gates, or a terminal state is being
 *                           re-asserted via a different `finalState`).
 *                           `fromState`/`toFinalState` carry the rejected pair.
 */
export type AttemptCompletionResult =
  | { outcome: "completed"; attempt: typeof taskCreationAttempts.$inferSelect }
  | { outcome: "no_op"; attempt: typeof taskCreationAttempts.$inferSelect }
  | {
      outcome: "rejected_transition";
      attempt: typeof taskCreationAttempts.$inferSelect;
      /** Live state read on the passed client when the request was decided. */
      fromState: string;
      /** Final state the request named. */
      toFinalState: TerminalResult["finalState"];
    };

/**
 * Terminal attempt states — once reached, the transition API refuses any
 * further active-work transition (the one-way terminal door). Set both by
 * {@link completeAttemptWithClient} and reachable directly from `pending`
 * (rejected_validation / vetoed / batch_rejected).
 *
 * Exported so the lease primitives (`taskCreationAttempts.ts` Phase 3) reuse
 * the SAME canonical set rather than duplicating it — the terminal-lock is a
 * shared domain invariant, not per-module logic.
 */
export const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "created",
  "created_unassigned",
  "rejected_validation",
  "vetoed",
  "batch_rejected",
]);

/**
 * Attempt states that lie STRICTLY PAST the creation-dispatch observation
 * checkpoint — i.e. the attempt advanced beyond `published_pending_observation`.
 * The T4A Phase 3 claim gate reads this to decide whether a post-cutover Task's
 * creation has been observed (claimability open):
 *   - `published_pending_assignment` — observation satisfied, awaiting assignment.
 *   - `created`                     — terminal success (no-reservation path).
 *   - `created_unassigned`          — terminal success (reservation released;
 *                                     still claimable — observation is done).
 *
 * Every OTHER attempt state (`pending`, `published_pending_observation`, and the
 * terminal-failure states already in {@link TERMINAL_ATTEMPT_STATES}) is treated
 * as NOT observed → `observation_pending` (fail-safe: keep unavailable). Kept
 * alongside {@link TERMINAL_ATTEMPT_STATES} so the Phase 3 predicate is
 * data-driven + auditable, not an inline literal.
 */
export const POST_OBSERVATION_STATES: ReadonlySet<string> = new Set([
  "published_pending_assignment",
  "created",
  "created_unassigned",
]);

/**
 * Legal forward checkpoint transitions ONLY. The state machine is forward-only:
 * `pending → published_pending_observation → published_pending_assignment`.
 * Same-state and every other pair are handled by the caller (no-op / rejected).
 */
function isLegalCheckpointForward(from: string, to: AttemptCheckpoint["stage"]): boolean {
  if (from === "pending" && to === "published_pending_observation") return true;
  if (from === "published_pending_observation" && to === "published_pending_assignment")
    return true;
  return false;
}

/**
 * Legal forward TERMINAL transitions ONLY (completion / terminalization). Pairs
 * the live `fromState` with the requested `finalState`. Terminalization is a
 * one-way door that must respect the forward-only state machine:
 *   - `pending` → early failure exits (`rejected_validation`, `vetoed`,
 *     `batch_rejected`) — governance/validation failures detected before any
 *     checkpoint. `pending → created*` is REJECTED (success requires passing
 *     both checkpoints; a direct jump would bypass the observation/assignment
 *     gates).
 *   - `published_pending_observation` → `created` ONLY (T4A Phase 2 widened
 *     this edge: when every dispatch target is accepted AND there is no active
 *     assignment reservation, observation satisfaction terminalizes the
 *     attempt directly to `created`). `→ created_unassigned` is REJECTED here
 *     — that is a LATER assignment-exhaustion terminal reached from
 *     `published_pending_assignment` (observation is about dispatch acceptance,
 *     not assignment). Failure terminals from observation are a later
 *     governance exit, not modeled here.
 *   - `published_pending_assignment` → success terminals (`created`,
 *     `created_unassigned`) — reached only after the assignment gate.
 *
 * Same {@link isLegalCheckpointForward} machinery + the canonical
 * {@link TERMINAL_ATTEMPT_STATES} set — the forward invariant is shared, not
 * per-function.
 */
function isLegalTerminalForward(from: string, to: TerminalResult["finalState"]): boolean {
  if (from === "pending") {
    return to === "rejected_validation" || to === "vetoed" || to === "batch_rejected";
  }
  if (from === "published_pending_observation") {
    // T4A Phase 2: the no-reservation observation-success terminal ONLY.
    // `created_unassigned` stays illegal here (assignment-exhaustion is reached
    // from published_pending_assignment, not observation).
    return to === "created";
  }
  if (from === "published_pending_assignment") {
    return to === "created" || to === "created_unassigned";
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. createTaskWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts a `tasks` row at status `pending` on the caller-supplied client.
 *
 * Allocates `order` (like `taskCrud.createTask`) but ON THE PASSED CLIENT so the
 * allocation is visible inside the same transaction.
 *
 * Stamps `creationIntegrity` ONLY when the caller supplies it (T3C passes the
 * post-cutover version); when omitted the column default (`0` = Legacy Partial
 * History) applies — byte-identical to the pre-extension behavior. Likewise the
 * caller may supply an explicit `id` (the prospective Task ID); when omitted the
 * primitive mints a fresh `uuid()` — byte-identical for legacy callers.
 *
 * Does NOT replace `taskCrud.createTask` (that remains the live path until later
 * tickets retire it). Never calls `getDb()`.
 */
export function createTaskWithClient(
  db: TaskPublicationDbClient,
  input: PreparedTaskInput,
): typeof tasks.$inferSelect {
  const id = input.id ?? uuid();
  const now = new Date().toISOString();

  let order = input.order;
  if (order === undefined) {
    const result = db
      .select({ maxOrder: max(tasks.order) })
      .from(tasks)
      .where(eq(tasks.missionId, input.missionId))
      .get();
    order = (result?.maxOrder ?? -1) + 1;
  }

  let rows;
  try {
    rows = db
      .insert(tasks)
      .values({
        id,
        missionId: input.missionId,
        title: input.title,
        description: input.description ?? "",
        priority: input.priority ?? "medium",
        requiredDomain: input.requiredDomain ?? null,
        requiredCapabilities: input.requiredCapabilities ?? [],
        status: "pending",
        labels: input.labels ?? [],
        order,
        createdBy: input.createdBy,
        estimatedMinutes: input.estimatedMinutes ?? null,
        createdAt: now,
        updatedAt: now,
        // Additive (T3C): only stamped when the caller supplies it. Omitted →
        // the column default (0 = Legacy Partial History) applies, byte-identical
        // to the pre-extension insert.
        ...(input.creationIntegrity !== undefined
          ? { creationIntegrity: input.creationIntegrity }
          : {}),
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("task", err as Error, id);
  }

  if (rows.length > 0) return rows[0];
  // RETURNING empty (unreachable-in-production SQLite quirk): re-read on the
  // SAME client so the SELECT stays inside the caller's transaction.
  const fallback = db.select().from(tasks).where(eq(tasks.id, id)).all();
  if (fallback.length > 0) return fallback[0];
  throw repositoryNotFoundError("task", id);
}

// ---------------------------------------------------------------------------
// 2. createTaskEventWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts the initial lifecycle `task_events` row (`created` / `cloned`) on the
 * caller-supplied client. Never calls `getDb()`.
 */
export function createTaskEventWithClient(
  db: TaskPublicationDbClient,
  input: PreparedTaskEventInput,
): typeof taskEvents.$inferSelect {
  const id = uuid();

  let rows;
  try {
    rows = db
      .insert(taskEvents)
      .values({
        id,
        taskId: input.taskId,
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        fromColumnId: input.fromColumnId ?? null,
        toColumnId: input.toColumnId ?? null,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        metadata: input.metadata ?? {},
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("taskEvent", err as Error, id);
  }

  if (rows.length > 0) return rows[0];
  const fallback = db.select().from(taskEvents).where(eq(taskEvents.id, id)).all();
  if (fallback.length > 0) return fallback[0];
  throw repositoryNotFoundError("taskEvent", id);
}

// ---------------------------------------------------------------------------
// 3. createSubtaskWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts a `task_subtasks` row on the caller-supplied client. Never calls `getDb()`.
 */
export function createSubtaskWithClient(
  db: TaskPublicationDbClient,
  input: PreparedSubtaskInput,
): typeof taskSubtasks.$inferSelect {
  const id = uuid();

  let rows;
  try {
    rows = db
      .insert(taskSubtasks)
      .values({
        id,
        taskId: input.taskId,
        title: input.title,
        order: input.order ?? 0,
        completed: input.completed ?? false,
        assigneeId: input.assigneeId ?? null,
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("taskSubtask", err as Error, id);
  }

  if (rows.length > 0) return rows[0];
  const fallback = db.select().from(taskSubtasks).where(eq(taskSubtasks.id, id)).all();
  if (fallback.length > 0) return fallback[0];
  throw repositoryNotFoundError("taskSubtask", id);
}

// ---------------------------------------------------------------------------
// 4. addTaskDependencyWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts a `task_dependencies` edge on the caller-supplied client. Never calls `getDb()`.
 */
export function addTaskDependencyWithClient(
  db: TaskPublicationDbClient,
  input: PreparedDependencyInput,
): typeof taskDependencies.$inferSelect {
  let rows;
  try {
    rows = db
      .insert(taskDependencies)
      .values({
        taskId: input.taskId,
        dependsOnId: input.dependsOnId,
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError(
      "taskDependency",
      err as Error,
      `${input.taskId}->${input.dependsOnId}`,
    );
  }

  if (rows.length > 0) return rows[0];
  const fallback = db
    .select()
    .from(taskDependencies)
    .where(
      sql`${taskDependencies.taskId} = ${input.taskId} AND ${taskDependencies.dependsOnId} = ${input.dependsOnId}`,
    )
    .all();
  if (fallback.length > 0) return fallback[0];
  throw repositoryNotFoundError("taskDependency", `${input.taskId}->${input.dependsOnId}`);
}

// ---------------------------------------------------------------------------
// 5. markMissionForRecalculationWithClient
// ---------------------------------------------------------------------------

/**
 * Records that a committed Task change requires Mission projection, COALESCING
 * duplicates: the partial unique index `uq_mission_recalc_markers_pending`
 * (`mission_id WHERE state='pending'`) ensures at most one pending marker per
 * Mission. A second call for an already-pending Mission performs an
 * `ON CONFLICT DO NOTHING` (no throw, no duplicate row) rather than failing.
 *
 * `mission_id` is plain text (no FK) — the marker is operational history that
 * outlives habitat replacement. Never calls `getDb()`.
 */
export function markMissionForRecalculationWithClient(
  db: TaskPublicationDbClient,
  missionId: string,
  reason: string,
): void {
  const id = uuid();
  try {
    db.insert(missionRecalculationMarkers)
      .values({
        id,
        missionId,
        reason,
        state: "pending",
      })
      // Bare ON CONFLICT DO NOTHING — drizzle 0.45.2's onConflictDoNothing does
      // not support a partial-index predicate (its `where` lands AFTER `DO
      // NOTHING`, which is invalid for the partial index; only
      // onConflictDoUpdate carries `targetWhere`). The bare form resolves
      // against ALL uniqueness constraints, which is safe here: `id` is always a
      // fresh uuid (never conflicts), so only the partial unique index
      // `uq_mission_recalc_markers_pending` (`mission_id WHERE state='pending'`)
      // can fire — coalescing the duplicate pending marker silently.
      .onConflictDoNothing()
      .run();
  } catch (err) {
    throw repositoryCreateError("missionRecalculationMarker", err as Error, id);
  }
}

// ---------------------------------------------------------------------------
// 6. createCommittedTaskEnvelopeWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts the committed `task_creation_envelopes` row AND its
 * `task_creation_dispatch_targets` rows in one call. The caller's transaction
 * makes the envelope + targets atomic (if either side fails, both roll back).
 *
 * Dispatch targets are unique per `(eventId, targetKind, targetKey)`. Each is
 * seeded at state `pending`. Never calls `getDb()`.
 */
export function createCommittedTaskEnvelopeWithClient(
  db: TaskPublicationDbClient,
  envelope: CommittedEnvelopeInput,
  dispatchPlan: DispatchTargetInput[],
): CommittedEnvelopeResult {
  try {
    db.insert(taskCreationEnvelopes)
      .values({
        eventId: envelope.eventId,
        lifecycleAction: envelope.lifecycleAction,
        taskId: envelope.taskId,
        habitatId: envelope.habitatId,
        occurredAt: envelope.occurredAt,
        attemptId: envelope.attemptId,
        actorType: envelope.actorType,
        actorId: envelope.actorId,
        source: envelope.source,
        causalContext: envelope.causalContext,
        cloneSourceTaskId: envelope.cloneSourceTaskId ?? null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskCreationEnvelope", err as Error, envelope.eventId);
  }

  const createdTargets: Array<typeof taskCreationDispatchTargets.$inferSelect> = [];
  for (const target of dispatchPlan) {
    const targetId = uuid();
    try {
      const rows = db
        .insert(taskCreationDispatchTargets)
        .values({
          id: targetId,
          eventId: envelope.eventId,
          targetKind: target.targetKind,
          targetKey: target.targetKey,
          state: "pending",
        })
        .returning()
        .all();
      if (rows.length > 0) {
        createdTargets.push(rows[0]);
      } else {
        const fallback = db
          .select()
          .from(taskCreationDispatchTargets)
          .where(eq(taskCreationDispatchTargets.id, targetId))
          .all();
        if (fallback.length > 0) createdTargets.push(fallback[0]);
      }
    } catch (err) {
      throw repositoryCreateError("taskCreationDispatchTarget", err as Error, targetId);
    }
  }

  const envelopeRow = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.eventId, envelope.eventId))
    .all()[0];
  if (!envelopeRow) throw repositoryNotFoundError("taskCreationEnvelope", envelope.eventId);

  return { envelope: envelopeRow, dispatchTargets: createdTargets };
}

// ---------------------------------------------------------------------------
// 7. createAssignmentReservationWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts a `task_creation_assignment_reservations` row (state `active`) on the
 * caller-supplied client. `task_id` is plain text (no FK) — the reservation is
 * audit history that outlives habitat replacement. Never calls `getDb()`.
 */
export function createAssignmentReservationWithClient(
  db: TaskPublicationDbClient,
  input: PreparedReservationInput,
): typeof taskCreationAssignmentReservations.$inferSelect {
  const id = uuid();

  let rows;
  try {
    rows = db
      .insert(taskCreationAssignmentReservations)
      .values({
        id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        requestedAgentId: input.requestedAgentId,
        deadline: input.deadline,
        leaseOwner: input.leaseOwner ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        state: "active",
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("taskCreationAssignmentReservation", err as Error, id);
  }

  if (rows.length > 0) return rows[0];
  const fallback = db
    .select()
    .from(taskCreationAssignmentReservations)
    .where(eq(taskCreationAssignmentReservations.id, id))
    .all();
  if (fallback.length > 0) return fallback[0];
  throw repositoryNotFoundError("taskCreationAssignmentReservation", id);
}

// ---------------------------------------------------------------------------
// 7b. hasActiveReservationForAttemptWithClient
// ---------------------------------------------------------------------------

/**
 * Whether ANY active assignment reservation exists for an attempt on the passed
 * client. The `created` vs `published_pending_assignment` decision signal for
 * T4A Phase 2's observation-advancement: a post-cutover attempt at
 * `published_pending_observation` whose dispatch targets are all accepted
 * terminalizes to `created` (no reservation) or checkpoints to
 * `published_pending_assignment` (active reservation — the assignment gate
 * still owes the requested claim).
 *
 * Existence probe (`SELECT 1 ... LIMIT 1`) — NOT by taskId + claimant (that is
 * the claim-gate's `activeReservationForOther` in `claimAuthority.ts`, a
 * different question). Here the question is "does THIS attempt hold an
 * outstanding active reservation?" — keyed by `attemptId` alone.
 *
 * Never calls `getDb()`, never opens a tx, never emits external effects.
 */
export function hasActiveReservationForAttemptWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
): boolean {
  const row = db
    .select({ one: sql<number>`1` })
    .from(taskCreationAssignmentReservations)
    .where(
      and(
        eq(taskCreationAssignmentReservations.attemptId, attemptId),
        eq(taskCreationAssignmentReservations.state, "active"),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// 7c/7d. Reservation state transitions (T5 Phase 1) — active → consumed / released
//
// The two one-way transitions out of `state = "active"` that the assignment
// coordinator (services/taskCreationAssignmentCoordinator.ts) drives atomically
// with the claim + attempt terminalization:
//   - consume  — the requested claim SUCCEEDED; the reservation is retired so
//                the gate (activeReservationForOther) no longer blocks anyone.
//   - release  — the requested claim was definitively REFUSED (or the bounded
//                deadline exhausted, a P2 concern); the reservation is retired
//                AND the specific failure reason is stamped for audit/retry.
//
// Both use the SAME compare-and-set shape as {@link completeAttemptWithClient}
// (`WHERE id AND state = 'active'`, classify from `SELECT changes()`): a
// concurrent consumer/releaser/expiry is serialized by SQLite, and the loser's
// CAS matches zero rows → `no_op` (the authoritative row is returned UNCHANGED
// — the loser never overwrites the winner's state/reason). This is the
// portable cross-backend pattern (sql.js `run()` does not return `{changes}`).
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link consumeAssignmentReservationWithClient} /
 * {@link releaseAssignmentReservationWithClient}. Mirrors the CAS transition
 * matrix shape of {@link AttemptCompletionResult}.
 *
 * - `transitioned` — the legal `active → consumed|released` CAS UPDATE matched
 *                    exactly one row (this call retired the reservation).
 * - `no_op`         — the reservation was ALREADY retired (the CAS
 *                    `state = 'active'` predicate matched zero rows): a
 *                    concurrent transition won, or a replay reached this layer.
 *                    The authoritative row is returned UNCHANGED.
 */
export type ReservationTransitionResult =
  | { outcome: "transitioned"; reservation: typeof taskCreationAssignmentReservations.$inferSelect }
  | { outcome: "no_op"; reservation: typeof taskCreationAssignmentReservations.$inferSelect };

/** Classify a reservation CAS UPDATE from its affected-row count. Shared by
 * consume + release so both follow the identical post-CAS re-read + classify
 * discipline as {@link completeAttemptWithClient} (lines 1057-1070). */
function classifyReservationCas(
  db: TaskPublicationDbClient,
  reservationId: string,
  affected: number,
): ReservationTransitionResult {
  const row = db
    .select()
    .from(taskCreationAssignmentReservations)
    .where(eq(taskCreationAssignmentReservations.id, reservationId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationAssignmentReservation", reservationId);
  return affected === 1
    ? { outcome: "transitioned", reservation: row }
    : { outcome: "no_op", reservation: row };
}

/**
 * Retires an `active` reservation to `consumed` on the caller-supplied client.
 * Called by the assignment coordinator AFTER the requested claim committed
 * (the gate was satisfied by the matching identity, the Task is now claimed).
 * Compare-and-set on `state = 'active'`; a concurrent consume/release/expiry
 * makes the loser's CAS match zero rows → `no_op` (the winner's row returned
 * UNCHANGED). Never calls `getDb()`, never opens a tx, never emits effects.
 *
 * Throws {@link repositoryNotFoundError} only when the reservation does not
 * exist (a data-integrity condition, not an expected transition outcome).
 */
export function consumeAssignmentReservationWithClient(
  db: TaskPublicationDbClient,
  reservationId: string,
): ReservationTransitionResult {
  let affected: number;
  try {
    db.update(taskCreationAssignmentReservations)
      .set({ state: "consumed", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(taskCreationAssignmentReservations.id, reservationId),
          eq(taskCreationAssignmentReservations.state, "active"),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationAssignmentReservation", err as Error, reservationId);
  }
  return classifyReservationCas(db, reservationId, affected);
}

/**
 * Retires an `active` reservation to `released` AND stamps `failureReason` on
 * the caller-supplied client. Called by the assignment coordinator when the
 * requested claim was DEFINITIVELY refused (the gate stays closed for the
 * requested identity, and the bounded deadline path in P2 will use the same
 * primitive with `reason: "deadline_exceeded"`). Compare-and-set on
 * `state = 'active'`; a concurrent consume/release/expiry → `no_op`.
 *
 * `failureReason` is a free-form audit string — the coordinator passes the
 * preserved {@link ClaimRefusalReason} (e.g. `"ineligible"`,
 * `"dependencies_unmet"`) so retry/audit surfaces can reconstruct why the
 * reservation was retired without re-reading the attempt's terminalResult.
 *
 * Never calls `getDb()`, never opens a tx, never emits effects. Throws
 * {@link repositoryNotFoundError} only when the reservation does not exist.
 */
export function releaseAssignmentReservationWithClient(
  db: TaskPublicationDbClient,
  reservationId: string,
  reason: string,
): ReservationTransitionResult {
  let affected: number;
  try {
    db.update(taskCreationAssignmentReservations)
      .set({
        state: "released",
        failureReason: reason,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(taskCreationAssignmentReservations.id, reservationId),
          eq(taskCreationAssignmentReservations.state, "active"),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationAssignmentReservation", err as Error, reservationId);
  }
  return classifyReservationCas(db, reservationId, affected);
}

// ---------------------------------------------------------------------------
// 7b. creationObservationStateForTaskWithClient — the Phase 3 claim-gate signal
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link creationObservationStateForTaskWithClient}. The claim
 * gate reads ONLY `.observed`; `attemptState` / `reason` are diagnostics for
 * tests + operational introspection.
 */
export type CreationObservationState =
  | { observed: true; attemptState: string }
  | { observed: false; attemptState?: string; reason?: "no_envelope" | "no_attempt" };

/**
 * Resolves whether a Task's creation has been OBSERVED past the dispatch
 * checkpoint — the T4A Phase 3 claim-gate signal. Pure read on `db`; never
 * calls `getDb()`, never opens a tx, never throws for a decision.
 *
 * Resolution: Task → `taskCreationEnvelopes` (by `taskId`) → `attemptId` →
 * `taskCreationAttempts.state`. A Task may carry multiple envelopes (e.g. a
 * later clone); the gate is satisfied when ANY envelope's attempt advanced past
 * `published_pending_observation` (a successfully-created Task must not be
 * blocked by an unrelated in-flight envelope). See
 * {@link POST_OBSERVATION_STATES}.
 *
 * Fail-safe (ADR-0038 — keep unavailable on doubt):
 *   - no envelope for the task → `{ observed: false, reason: "no_envelope" }`
 *   - envelope exists but its attempt is unresolvable (FK violation; unreachable
 *     under `PRAGMA foreign_keys = ON`) → `{ observed: false, reason: "no_attempt" }`
 *   - attempt resolved but NOT in a post-observation state →
 *     `{ observed: false, attemptState }`
 *
 * Mirrors {@link hasActiveReservationForAttemptWithClient} (existence probe by
 * `attemptId`); this is the envelope-keyed counterpart keyed by `taskId`.
 */
export function creationObservationStateForTaskWithClient(
  db: TaskPublicationDbClient,
  taskId: string,
): CreationObservationState {
  // LEFT JOIN so a corrupt envelope (missing attempt row) is distinguishable
  // from a missing envelope — both are fail-safe `observed: false` but carry
  // different diagnostic reasons.
  const rows = db
    .select({ attemptState: taskCreationAttempts.state })
    .from(taskCreationEnvelopes)
    .leftJoin(taskCreationAttempts, eq(taskCreationEnvelopes.attemptId, taskCreationAttempts.id))
    .where(eq(taskCreationEnvelopes.taskId, taskId))
    .all() as { attemptState: string | null }[];

  if (rows.length === 0) {
    return { observed: false, reason: "no_envelope" };
  }

  const resolvable = rows.filter((r): r is { attemptState: string } => r.attemptState !== null);
  if (resolvable.length === 0) {
    return { observed: false, reason: "no_attempt" };
  }

  const observed = resolvable.find((r) => POST_OBSERVATION_STATES.has(r.attemptState));
  if (observed) {
    return { observed: true, attemptState: observed.attemptState };
  }
  return { observed: false, attemptState: resolvable[0].attemptState };
}

// ---------------------------------------------------------------------------
// 8. checkpointAttemptWithClient
// ---------------------------------------------------------------------------

/**
 * Advances a `task_creation_attempts` row through the forward-only checkpoint
 * state machine via a **compare-and-set** transition matrix (the T3A Phase 2 /
 * M4 fix — replaces the permissive unconditional UPDATE that overwrote state
 * and `publishedAt` without inspecting current state / `completedAt`).
 *
 * Legal forward transitions ONLY:
 *   - `pending → published_pending_observation`
 *   - `published_pending_observation → published_pending_assignment`
 *
 * Decision order (all inside the caller's transaction, all on the passed
 * client — never `getDb()`, never a nested tx, never an external effect):
 *   1. Read current row on `tx` (in-tx decision support).
 *   2. Terminal-lock: `completedAt` set OR a terminal `state` →
 *      `rejected_transition` (the guardrail: terminal replay cannot transition
 *      back to active work).
 *   3. Same-state (`from === to`) → `no_op`, row unchanged, `publishedAt` NOT
 *      re-stamped.
 *   4. Non-legal-forward (backward, forward-skip) → `rejected_transition`.
 *   5. Compare-and-set UPDATE: `WHERE id = attemptId AND state = fromState`, so
 *      a concurrent state mutation between the read and the write no-ops rather
 *      than corrupting. `publishedAt` is preserved via `COALESCE` (the FIRST
 *      checkpoint wins; later transitions never overwrite it).
 *   6. Classify from the UPDATE's **affected-row count** on the SAME client
 *      via `SELECT changes() AS n` (mirrors `mission.ts`; works on BOTH
 *      better-sqlite3 and sql.js, unlike drizzle's `run().changes` which is
 *      undefined in the test driver). `transitioned` ONLY when THIS UPDATE
 *      advanced exactly one row; a concurrent writer that moved state between
 *      the in-tx read (step 1) and this conditional UPDATE makes the
 *      `state = fromState` predicate match zero rows → `no_op` with the
 *      winner's row. Re-reading alone is INSUFFICIENT — a losing CAS whose
 *      target state a concurrent writer happened to reach would see the
 *      target on re-read and falsely report `transitioned`.
 *
 * Throws {@link repositoryNotFoundError} only when the attempt does not exist
 * (a data-integrity / transport condition, not an expected transition outcome).
 * Infrastructure failures throw (retryable transport).
 */
export function checkpointAttemptWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  publication: AttemptCheckpoint,
): AttemptTransitionResult {
  // 1. In-tx read of the current state (supports the compare-and-set decision).
  const current = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .get();
  if (!current) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  const fromState = current.state;
  const toStage = publication.stage;

  // 2. Terminal-lock: a completed / terminal attempt cannot transition back to
  //    active work. `completedAt` is the strongest signal (completeAttempt sets
  //    it atomically with a terminal state); the state set covers direct-from-
  //    pending terminals that never set completedAt via the checkpoint path.
  if (current.completedAt !== null || TERMINAL_ATTEMPT_STATES.has(fromState)) {
    return { outcome: "rejected_transition", attempt: current, fromState, toStage };
  }

  // 3. Same-state = no-op (return the row unchanged; do NOT re-stamp publishedAt).
  if (fromState === toStage) {
    return { outcome: "no_op", attempt: current };
  }

  // 4. Legal forward transitions ONLY (rejects backward + forward-skip).
  if (!isLegalCheckpointForward(fromState, toStage)) {
    return { outcome: "rejected_transition", attempt: current, fromState, toStage };
  }

  // 5. Compare-and-set: conditional UPDATE whose WHERE includes the expected
  //    current state, so a concurrent state change between the read and the
  //    write no-ops rather than corrupting. COALESCE preserves the FIRST
  //    publishedAt across subsequent transitions.
  // 6. Classify from the UPDATE's affected-row count (NOT the re-read state):
  //    a losing CAS whose target a concurrent writer reached would show the
  //    target on re-read, so only a one-row change counts as `transitioned`.
  const publishedAt = publication.publishedAt ?? new Date().toISOString();
  let affected: number;
  try {
    db.update(taskCreationAttempts)
      .set({
        state: toStage,
        publishedAt: sql`COALESCE(${taskCreationAttempts.publishedAt}, ${publishedAt})`,
      })
      .where(and(eq(taskCreationAttempts.id, attemptId), eq(taskCreationAttempts.state, fromState)))
      .run();
    // `SELECT changes()` returns the rows affected by the LAST statement on
    // this connection — portable across both backends (mission.ts:324).
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  // Re-read the current row: when affected === 1 it is the row we just
  // advanced; when affected === 0 a concurrent writer moved state between the
  // in-tx read (step 1) and the conditional UPDATE, so this is the winner's
  // row. The row is the RETURN VALUE for both outcomes — the OUTCOME is
  // decided solely by the affected-row count above.
  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  return affected === 1
    ? { outcome: "transitioned", attempt: row }
    : { outcome: "no_op", attempt: row };
}

// ---------------------------------------------------------------------------
// 9. completeAttemptWithClient
// ---------------------------------------------------------------------------

/**
 * Terminates a `task_creation_attempts` row: sets the nullable terminal fields
 * (`terminal_outcome`, `terminal_result`, `completed_at`) and the final `state`
 * through the SAME compare-and-set transition matrix as
 * {@link checkpointAttemptWithClient} (the R1 fix — the prior `.where(eq(id))`
 * UPDATE bypassed the matrix and was not compare-and-set).
 *
 * Decision order (all on the passed client — never `getDb()`, never a nested
 * tx, never an external effect):
 *   1. Read the current row (in-tx decision support).
 *   2. Terminal-replay fast path: `completedAt !== null` → `no_op` returning
 *      the authoritative terminal row UNCHANGED (a prior completion wins; the
 *      loser never overwrites the winner). The legality of a SETTLED attempt
 *      is not re-judged.
 *   3. Legal-pair check on the LIVE (non-terminal) `fromState`:
 *      {@link isLegalTerminalForward}(`fromState`, `finalState`). An illegal
 *      pair (e.g. `pending→created`, which would bypass the observation/
 *      assignment gates) → `rejected_transition`.
 *   4. Compare-and-set UPDATE `WHERE id AND state = fromState AND completedAt
 *      IS NULL`: the `completedAt IS NULL` predicate is the terminal-lock CAS
 *      — two concurrent completions both pass the read-side fast path (both
 *      read non-terminal), but only one UPDATE matches (the other's
 *      `completedAt` is now non-null). The `state = fromState` predicate
 *      additionally guards against state drift between the read and the write.
 *   5. Classify from the UPDATE's affected-row count (`SELECT changes() AS n`,
 *      portable across both backends). One row → `completed` (this call
 *      installed the terminal envelope). Zero rows → `no_op`: a concurrent
 *      completion terminalized the attempt between the read and the UPDATE, so
 *      the authoritative terminal row is returned UNCHANGED.
 *
 * Terminal-lock integration (T3A Phase 2): once `completedAt` is set here,
 * {@link checkpointAttemptWithClient} refuses any further transition (its
 * step 2 treats `completedAt !== null` as terminal-locked →
 * `rejected_transition`). Together this primitive + the checkpoint matrix
 * enforce the T3A guardrail: "terminal replay cannot transition back to
 * active work."
 *
 * Throws {@link repositoryNotFoundError} only when the attempt does not exist.
 */
export function completeAttemptWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  terminal: TerminalResult,
): AttemptCompletionResult {
  // 1. In-tx read of the current state (supports the legal-pair + CAS decision).
  const current = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!current) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  const fromState = current.state;
  const toFinalState = terminal.finalState;

  // 2. Terminal-replay fast path: an attempt that is ALREADY terminal
  //    (`completedAt !== null`) is authoritative — return it UNCHANGED as
  //    `no_op`, regardless of the requested `finalState`. This is the
  //    idempotent re-call / replay case (the prior completion wins; a loser
  //    never overwrites the winner's result/timestamp). The legality of a
  //    SETTLED attempt is not re-judged — only LIVE (non-terminal) transitions
  //    are subject to the legal-pair check below. The CAS in step 4 is the
  //    race defender for two concurrent completions that both read
  //    non-terminal here.
  if (current.completedAt !== null) {
    return { outcome: "no_op", attempt: current };
  }

  // 3. Legal terminal pair ONLY for the LIVE (non-terminal) state (rejects
  //    `pending→created*` and other bypasses of the observation/assignment
  //    gates). `fromState` is necessarily non-terminal here (step 2 returned).
  if (!isLegalTerminalForward(fromState, toFinalState)) {
    return {
      outcome: "rejected_transition",
      attempt: current,
      fromState,
      toFinalState,
    };
  }

  // 4. Compare-and-set terminalization: the `completedAt IS NULL` predicate is
  //    the one-way door (two concurrent completions race; only the first
  //    UPDATE matches). `state = fromState` guards against state drift.
  const completedAt = terminal.completedAt ?? new Date().toISOString();
  let affected: number;
  try {
    db.update(taskCreationAttempts)
      .set({
        state: toFinalState,
        terminalOutcome: terminal.terminalOutcome,
        terminalResult: terminal.terminalResult ?? null,
        completedAt,
      })
      .where(
        and(
          eq(taskCreationAttempts.id, attemptId),
          eq(taskCreationAttempts.state, fromState),
          isNull(taskCreationAttempts.completedAt),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  // 4. Re-read the authoritative terminal row (the return value for both
  //    outcomes). When affected === 1 it is the row we just terminalized; when
  //    affected === 0 a concurrent completion won, and this is the winner's
  //    row returned UNCHANGED (the loser never overwrites the winner).
  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  return affected === 1
    ? { outcome: "completed", attempt: row }
    : { outcome: "no_op", attempt: row };
}
