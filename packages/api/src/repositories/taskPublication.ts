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
import { and, eq, max, sql } from "drizzle-orm";
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

/** Compact causal context connecting a publication to its origin chain. */
export interface CausalContext {
  root: { type: string; id: string };
  parent?: { type: string; id: string };
  hops?: Array<{ type: string; id: string; label?: string }>;
}

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

// ---------------------------------------------------------------------------
// 1. createTaskWithClient
// ---------------------------------------------------------------------------

/**
 * Inserts a `tasks` row at status `pending` on the caller-supplied client.
 *
 * Allocates `order` (like `taskCrud.createTask`) but ON THE PASSED CLIENT so the
 * allocation is visible inside the same transaction. Does NOT set
 * `creationIntegrity` — the column defaults to `0` (Legacy Partial History); only
 * the post-cutover publication coordinator stamps a higher version.
 *
 * Does NOT replace `taskCrud.createTask` (that remains the live path until later
 * tickets retire it). Never calls `getDb()`.
 */
export function createTaskWithClient(
  db: TaskPublicationDbClient,
  input: PreparedTaskInput,
): typeof tasks.$inferSelect {
  const id = uuid();
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
 *   6. Re-verify by re-read (sql.js-safe — `runResult.changes` is undefined in
 *      the test driver, so the re-read is the portable detector). State advanced
 *      to `toStage` → `transitioned`; otherwise a concurrent writer won the
 *      race → `no_op` with the actual current row.
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
  const publishedAt = publication.publishedAt ?? new Date().toISOString();
  try {
    db.update(taskCreationAttempts)
      .set({
        state: toStage,
        publishedAt: sql`COALESCE(${taskCreationAttempts.publishedAt}, ${publishedAt})`,
      })
      .where(and(eq(taskCreationAttempts.id, attemptId), eq(taskCreationAttempts.state, fromState)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  // 6. Re-verify by re-read (sql.js-safe). The conditional UPDATE took effect
  //    only if state advanced to the target; a WHERE mismatch (concurrent writer
  //    moved state between the read and the write) leaves state !== toStage.
  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  if (row.state === toStage) {
    return { outcome: "transitioned", attempt: row };
  }
  return { outcome: "no_op", attempt: row };
}

// ---------------------------------------------------------------------------
// 9. completeAttemptWithClient
// ---------------------------------------------------------------------------

/**
 * Terminates a `task_creation_attempts` row: sets the nullable terminal fields
 * (`terminal_outcome`, `terminal_result`, `completed_at`) and the final `state`.
 *
 * IDEMPOTENT on re-call: if the attempt is already completed (`completed_at` is
 * set), the existing row is returned UNCHANGED — the terminal timestamp and
 * result are not overwritten. This guarantees no side effects when a terminal
 * replay reaches this layer. Never calls `getDb()`.
 *
 * Terminal-lock integration (T3A Phase 2): terminalization is a one-way door.
 * Once `completedAt` is set here, {@link checkpointAttemptWithClient} refuses
 * any further transition (its step 2 treats `completedAt !== null` as
 * terminal-locked → `rejected_transition`). Together this primitive + the
 * transition matrix enforce the T3A guardrail: "terminal replay cannot
 * transition back to active work."
 */
export function completeAttemptWithClient(
  db: TaskPublicationDbClient,
  attemptId: string,
  terminal: TerminalResult,
): typeof taskCreationAttempts.$inferSelect {
  const existing = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!existing) throw repositoryNotFoundError("taskCreationAttempt", attemptId);

  // Idempotency: a prior completion is authoritative — return it as-is.
  if (existing.completedAt !== null) return existing;

  const completedAt = terminal.completedAt ?? new Date().toISOString();

  try {
    db.update(taskCreationAttempts)
      .set({
        state: terminal.finalState,
        terminalOutcome: terminal.terminalOutcome,
        terminalResult: terminal.terminalResult ?? null,
        completedAt,
      })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskCreationAttempt", err as Error, attemptId);
  }

  const row = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!row) throw repositoryNotFoundError("taskCreationAttempt", attemptId);
  return row;
}
