/**
 * Atomic Task Publication Coordinator (T3C — the Story-1 keystone).
 *
 * The origin-neutral guarded transaction that atomically persists a complete
 * Task aggregate + initial history + committed envelope/dispatch plan +
 * recalculation marker + optional reservation + the
 * `published_pending_observation` checkpoint. It composes the Phase-3 guard
 * primitives + the T1 `*WithClient` write primitives INSIDE the caller's
 * transaction.
 *
 * What makes this the keystone: every Story-2/3 origin (manual create, clone,
 * schedule, import, Recovery) routes its final commit through this coordinator.
 * The caller-owned-transaction contract is what lets those origins compose
 * their own domain-specific writes (recovery linkage, triage junction, schedule
 * state, import handler writes) atomically with the core Task aggregate via the
 * `participants` seam — a single exception rolls back the whole batch.
 *
 * NON-NEGOTIABLE invariants (each has a discriminating test):
 *   - **Caller-owned transactions.** The coordinator takes `db`; the caller
 *     owns the tx (the caller wraps `db.transaction((tx) =>
 *     publishTaskWithClient(tx, ...))`). It NEVER calls `getDb()`, opens its
 *     own tx, emits SSE/hooks, or triggers pre-commit effects. This is the
 *     property that makes clone/schedule/import/Recovery composition atomic.
 *   - **Participant seam is the ONLY domain-extension point.** Domain-specific
 *     writes go through `participants?(db, ctx)`; no other bypass. The hook
 *     runs inside the caller's tx; a throw rolls back the whole aggregate.
 *   - **Dispatch plan defaults to the standard 6-target creation plan; ALWAYS
 *     stops at `published_pending_observation`.** Does NOT advance to
 *     observation-satisfied or `created` — that is T4A (dispatch processing /
 *     claim execution). A caller may override the plan via `input.dispatchPlan`
 *     (e.g. tests, custom routing); an explicitly-empty plan + observation
 *     checkpoint is a valid dormant state.
 *   - **`creationIntegrity` distinguishes post-cutover Tasks.** Every Task this
 *     coordinator creates carries `POST_CUTOVER`; without it the claim paths'
 *     `isLegacyPartialHistory` gate would never engage on a published Task.
 *   - **Atomicity.** Any failure (injected or real) at ANY write rolls back the
 *     entire aggregate — the caller's tx aborts. Nothing externally observable
 *     runs until commit succeeds.
 *
 * DORMANT: no production origin routes through this coordinator yet. The
 * global cutover (T11) is what wires origins in. Until then this module is
 * exercised only by its test suite.
 *
 * See: Task Creation and Clone Technical Plan § "Single Task publication";
 * ADR-0039 (managed runtime owns classification).
 */
import type {
  tasks as tasksTable,
  taskEvents as taskEventsTable,
  taskSubtasks as taskSubtasksTable,
  taskDependencies as taskDependenciesTable,
  taskCreationEnvelopes as taskCreationEnvelopesTable,
  taskCreationDispatchTargets as taskCreationDispatchTargetsTable,
  taskCreationAssignmentReservations as taskCreationAssignmentReservationsTable,
} from "../db/schema/index.js";
import {
  createTaskWithClient,
  createTaskEventWithClient,
  createSubtaskWithClient,
  addTaskDependencyWithClient,
  markMissionForRecalculationWithClient,
  createCommittedTaskEnvelopeWithClient,
  createAssignmentReservationWithClient,
  checkpointAttemptWithClient,
  type TaskPublicationDbClient,
  type DispatchTargetInput,
  type AttemptTransitionResult,
} from "../repositories/taskPublication.js";
import {
  verifyPublicationGuard,
  authorizeCommitFromGovernance,
  type GuardMismatchReason,
  type CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type {
  CanonicalTaskPublicationProposal,
  PublicationGuard,
} from "./taskPublicationPreparation.js";
import { CREATION_TARGET_KINDS } from "./taskCreationDispatchAdapters.js";

// ---------------------------------------------------------------------------
// Result + outcome types
// ---------------------------------------------------------------------------

/**
 * Immutable committed-publication data returned by {@link publishTaskWithClient}
 * on a successful atomic publication. Carries every row the coordinator
 * inserted (or `null` for the reservation when no assignee was requested) so
 * workers/adapters downstream of the caller's commit can act without re-reading.
 *
 * `checkpoint.outcome` is `"transitioned"` on the published path — a `no_op` /
 * `rejected_transition` is a consistency failure that throws
 * {@link PublicationCheckpointConsistencyError} (rolling back the whole
 * aggregate) rather than entering this result.
 */
export interface CommittedPublication {
  task: typeof tasksTable.$inferSelect;
  event: typeof taskEventsTable.$inferSelect;
  subtasks: Array<typeof taskSubtasksTable.$inferSelect>;
  dependencies: Array<typeof taskDependenciesTable.$inferSelect>;
  envelope: typeof taskCreationEnvelopesTable.$inferSelect;
  dispatchTargets: Array<typeof taskCreationDispatchTargetsTable.$inferSelect>;
  /** `null` when `proposal.requestedAssigneeId` was null (no reservation). */
  reservation: typeof taskCreationAssignmentReservationsTable.$inferSelect | null;
  /**
   * Marker intent written by {@link markMissionForRecalculationWithClient}.
   * Represented as intent (not a re-read row) because the primitive COALESCES
   * duplicates — a second publication for an already-pending Mission performs
   * `ON CONFLICT DO NOTHING`, so the row may predate this call. The Mission
   * projection worker consumes the marker independently.
   */
  recalculationMarker: { missionId: string; reason: string };
  /**
   * The `published_pending_observation` checkpoint transition. `transitioned`
   * on the published path. (See {@link PublicationCheckpointConsistencyError}
   * for the non-transitioned consistency-failure path.)
   */
  checkpoint: AttemptTransitionResult;
}

/**
 * Closed coordinator outcome. Never throws for a guard/governance DECISION —
 * returns `{ outcome: "guard_mismatch" }` / `{ outcome: "governance_denied" }`
 * WITHOUT writing any aggregate (the attempt stays resumable; the caller
 * re-prepares under the same pending key). Infrastructure failures (a
 * repository throw) propagate as retryable transport errors; they are NOT
 * domain decisions and must not be collapsed into this result.
 *
 * A non-`transitioned` checkpoint is a CONSISTENCY FAILURE (the attempt was not
 * `pending` when the coordinator tried to advance it — a concurrent writer or a
 * misuse): it throws {@link PublicationCheckpointConsistencyError} so the
 * caller's tx rolls back the whole aggregate (atomicity) while still surfacing
 * the classification.
 */
export type PublishTaskOutcome =
  | { outcome: "guard_mismatch"; reasons: GuardMismatchReason[] }
  | {
      outcome: "governance_denied";
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
    }
  | { outcome: "published"; publication: CommittedPublication };

// ---------------------------------------------------------------------------
// Participant seam
// ---------------------------------------------------------------------------

/**
 * Context handed to the {@link PublishTaskInput.participants} hook. Carries the
 * freshly-inserted Task + initial event so domain writers (recovery linkage,
 * triage junction, schedule state, import handler writes) can reference them.
 * The hook runs INSIDE the caller's transaction on the SAME client — a throw
 * rolls back the whole aggregate (including the core Task).
 */
export interface ParticipantContext {
  /** The committed Task row (id === proposal.prospectiveTaskId). */
  task: typeof tasksTable.$inferSelect;
  /** The single initial lifecycle event (`created` / `cloned`). */
  event: typeof taskEventsTable.$inferSelect;
  /** The attempt being checkpointed. */
  attemptId: string;
  /** The canonical proposal being committed (immutable after preparation). */
  proposal: CanonicalTaskPublicationProposal;
}

/**
 * Caller-supplied domain-writes hook — the ONLY domain-extension point. Runs
 * after the core Task + initial event + subtasks/dependencies are inserted and
 * BEFORE the committed envelope / dispatch plan / reservation / checkpoint, all
 * inside the caller's transaction. A throw rolls back the whole aggregate.
 *
 * Current consumers (all Story-2/3, all DORMANT until their origins wire in):
 * clone subtasks/dependencies are NOT here (they are step 5 of the core path);
 * Recovery gate/failure-context linkage (T8A), triage cluster junction (T8A),
 * schedule occurrence state (T9A), import domain-handler writes (T10B) ARE.
 */
export type ParticipantWriter = (db: TaskPublicationDbClient, ctx: ParticipantContext) => void;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Optional assignment-reservation directive. REQUIRED when
 * `proposal.requestedAssigneeId` is non-null (the coordinator fails fast at the
 * top if it is missing). The `requestedAgentId` is sourced from
 * `proposal.requestedAssigneeId`; the caller (Story-2/3 origin) resolves the
 * configured/default deadline — the coordinator is origin-neutral and owns NO
 * deadline configuration. `leaseOwner` / `leaseExpiresAt` are optional lease
 * hints for the reservation worker.
 */
export interface AssignmentReservationDirective {
  deadline: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

/**
 * Input for {@link publishTaskWithClient}. The caller owns the transaction
 * (wrap the call in `db.transaction((tx) => publishTaskWithClient(tx, ...))`);
 * `db` here is the tx client (or the default `getDb()` client for non-tx use).
 */
export interface PublishTaskInput {
  /** The pending attempt being checkpointed to `published_pending_observation`. */
  attemptId: string;
  /** The canonical prepared proposal being committed. */
  proposal: CanonicalTaskPublicationProposal;
  /** The guard captured at preparation + stamped by governance. */
  guard: PublicationGuard;
  /**
   * Caller-supplied dispatch plan (default empty). The coordinator writes
   * whatever plan it is given and ALWAYS stops at
   * `published_pending_observation` — it does NOT advance targets to accepted
   * or open claimability (T4A). An empty plan + observation checkpoint is a
   * valid dormant state.
   */
  dispatchPlan?: DispatchTargetInput[];
  /**
   * Reservation directive — REQUIRED when `proposal.requestedAssigneeId` is
   * non-null; IGNORED when it is null. See {@link AssignmentReservationDirective}.
   */
  reservation?: AssignmentReservationDirective;
  /**
   * The ONLY domain-extension point. Runs inside the caller's tx after the core
   * aggregate and before the envelope/dispatch/reservation/checkpoint. A throw
   * rolls back the whole aggregate.
   */
  participants?: ParticipantWriter;
  /**
   * Reason stamped on the Mission recalculation marker (default
   * `"task_published"`). The marker coalesces duplicates per pending Mission.
   */
  recalculationReason?: string;
}

// ---------------------------------------------------------------------------
// Consistency-failure error (checkpoint not transitioned)
// ---------------------------------------------------------------------------

/**
 * Thrown when the `published_pending_observation` checkpoint does NOT
 * `transition` — i.e. the attempt was not `pending` when the coordinator tried
 * to advance it (`no_op` from a concurrent writer, or `rejected_transition`
 * from a terminal/skip state). This is a CONSISTENCY FAILURE: the aggregate
 * writes already ran in the caller's tx, so the ONLY way to preserve atomicity
 * (no published Task without an advanced checkpoint) is to abort the whole tx.
 *
 * The throw carries the {@link AttemptTransitionResult} so the caller can
 * classify the failure (concurrent winner vs illegal transition) for
 * diagnostics/retry. The caller's transaction rolls back — zero partial state.
 */
export class PublicationCheckpointConsistencyError extends Error {
  constructor(
    public readonly checkpoint: AttemptTransitionResult,
    public readonly attemptId: string,
  ) {
    super(
      `Publication checkpoint for attempt "${attemptId}" did not transition ` +
        `(outcome: ${checkpoint.outcome}); the aggregate was rolled back.`,
    );
    this.name = "PublicationCheckpointConsistencyError";
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** Default recalculation-marker reason when the caller omits one. */
const DEFAULT_RECALCULATION_REASON = "task_published";

/**
 * The origin-neutral atomic publication coordinator. Runs INSIDE the caller's
 * transaction — the caller wraps `db.transaction((tx) =>
 * publishTaskWithClient(tx, ...))`. NEVER calls `getDb()`, opens its own tx,
 * emits SSE/hooks, or triggers pre-commit effects.
 *
 * Composition (Technical Plan § "Single Task publication"):
 *   1. {@link verifyPublicationGuard} — on mismatch, returns
 *      `{ outcome: "guard_mismatch" }` WITHOUT writing any aggregate (the
 *      attempt stays `pending` / resumable). Never throws for the decision.
 *   2. {@link authorizeCommitFromGovernance} — on denial, returns
 *      `{ outcome: "governance_denied" }` without writing.
 *   3. {@link createTaskWithClient} — inserts the Task; the prospective Task ID
 *      becomes the final Task ID (same UUID). Stamps `creationIntegrity` to
 *      `POST_CUTOVER` so the claim gates engage. Omits `order` so the primitive
 *      allocates `max(order)+1` inside this tx.
 *   4. {@link createTaskEventWithClient} — exactly ONE initial event
 *      (`created` | `cloned`, from `proposal.initialEventAction`).
 *   5. {@link createSubtaskWithClient} + {@link addTaskDependencyWithClient}
 *      for each `proposal.subtasks` + `proposal.selectedDependencies`.
 *   6. Participant-writes seam: invokes `participants?(db, ctx)` for
 *      domain-specific writes (recovery linkage, triage junction, schedule
 *      state, import handler writes).
 *   7. {@link createCommittedTaskEnvelopeWithClient} — durable committed-event
 *      envelope + dispatch plan.
 *   8. {@link markMissionForRecalculationWithClient}.
 *   9. {@link createAssignmentReservationWithClient} — ONLY when
 *      `proposal.requestedAssigneeId` is non-null (deadline from the
 *      caller-supplied directive).
 *  10. {@link checkpointAttemptWithClient} to `published_pending_observation`.
 *      A non-`transitioned` outcome throws
 *      {@link PublicationCheckpointConsistencyError} (consistency failure →
 *      whole-aggregate rollback).
 *
 * Any failure rolls back the entire aggregate (the caller's tx aborts).
 *
 * DORMANT: no production origin calls this yet.
 */
export function publishTaskWithClient(
  db: TaskPublicationDbClient,
  input: PublishTaskInput,
): PublishTaskOutcome {
  const { attemptId, proposal, guard } = input;

  // Contract: the reservation directive is REQUIRED when an assignee is
  // requested. Fail fast BEFORE any write so a misconfigured caller never
  // produces a partial aggregate.
  if (proposal.requestedAssigneeId !== null && input.reservation === undefined) {
    throw new Error(
      `publishTaskWithClient: proposal.requestedAssigneeId is non-null but no ` +
        `reservation directive was supplied (attempt "${attemptId}"). The ` +
        `reservation deadline is caller-supplied — pass \`reservation: { deadline }\`.`,
    );
  }

  // 1. Guard re-verify — on mismatch, return WITHOUT writing. The attempt stays
  //    pending/resumable; the caller re-prepares under the same key.
  const guardResult = verifyPublicationGuard({ guard, db });
  if (guardResult.outcome === "mismatch") {
    return { outcome: "guard_mismatch", reasons: guardResult.reasons };
  }

  // 2. Governance commit-authorization — on denial, return WITHOUT writing.
  const authResult = authorizeCommitFromGovernance({
    guard,
    attemptId,
    prospectiveTaskId: proposal.prospectiveTaskId,
    proposal,
    db,
  });
  if (authResult.outcome === "denied") {
    return {
      outcome: "governance_denied",
      kind: authResult.kind,
      reason: authResult.reason,
      ...(authResult.interceptorKey !== undefined
        ? { interceptorKey: authResult.interceptorKey }
        : {}),
    };
  }

  // 3. Insert the Task. The prospective Task ID becomes the final Task ID
  //    (governance / envelope / reservation linkage resolves to the same row).
  //    Stamp POST_CUTOVER so isLegacyPartialHistory engages on the claim paths.
  //    Omit order → the primitive allocates max(order)+1 on THIS client in-tx.
  const task = createTaskWithClient(db, {
    id: proposal.prospectiveTaskId,
    missionId: proposal.targetMissionId,
    title: proposal.title,
    description: proposal.description,
    labels: proposal.labels,
    priority: proposal.priority,
    requiredDomain: proposal.requiredDomain,
    requiredCapabilities: proposal.requiredCapabilities,
    createdBy: proposal.actor.id ?? "",
    estimatedMinutes: proposal.estimatedMinutes,
    creationIntegrity: TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
  });

  // 4. Exactly ONE initial lifecycle event.
  const event = createTaskEventWithClient(db, {
    taskId: task.id,
    actorType: proposal.actor.type,
    actorId: proposal.actor.id ?? "",
    action: proposal.initialEventAction,
  });

  // 5. Editable aggregate: subtasks + selected dependencies.
  const subtasks = proposal.subtasks.map((s) =>
    createSubtaskWithClient(db, {
      taskId: task.id,
      title: s.title,
      ...(s.order !== undefined ? { order: s.order } : {}),
      // PreparedSubtaskInput.assigneeId is string|undefined (the primitive
      // defaults null). Pass only a concrete id; null/undefined both omit.
      ...(s.assigneeId ? { assigneeId: s.assigneeId } : {}),
    }),
  );
  const dependencies = proposal.selectedDependencies.map((d) =>
    addTaskDependencyWithClient(db, {
      taskId: task.id,
      dependsOnId: d.dependsOnId,
    }),
  );

  // 6. Participant seam — the ONLY domain-extension point. Runs inside this tx
  //    AFTER the core aggregate and BEFORE the envelope/dispatch/reservation/
  //    checkpoint. A throw rolls back the whole aggregate.
  if (input.participants) {
    input.participants(db, { task, event, attemptId, proposal });
  }

  // 7. Committed envelope + dispatch plan. The default is the standard
  //    6-target creation plan (one per consumer kind, all routing on
  //    habitatId); a caller may override via `input.dispatchPlan`.
  //    The envelope's occurredAt mirrors the initial event's timestamp.
  const occurredAt = event.timestamp ?? new Date().toISOString();
  const { envelope, dispatchTargets } = createCommittedTaskEnvelopeWithClient(
    db,
    {
      eventId: event.id,
      lifecycleAction: proposal.initialEventAction,
      taskId: task.id,
      habitatId: proposal.habitatId,
      occurredAt,
      attemptId,
      actorType: proposal.actor.type,
      actorId: proposal.actor.id ?? "",
      source: proposal.auditSource,
      ...(proposal.causalContext !== undefined ? { causalContext: proposal.causalContext } : {}),
      ...(proposal.cloneSourceTaskId !== null
        ? { cloneSourceTaskId: proposal.cloneSourceTaskId }
        : {}),
    },
    input.dispatchPlan ??
      CREATION_TARGET_KINDS.map((targetKind) => ({
        targetKind,
        targetKey: proposal.habitatId,
      })),
  );

  // 8. Mission recalculation marker (coalesces duplicates per pending Mission).
  const recalculationReason = input.recalculationReason ?? DEFAULT_RECALCULATION_REASON;
  markMissionForRecalculationWithClient(db, proposal.targetMissionId, recalculationReason);

  // 9. Assignment reservation — ONLY when an assignee was requested. The
  //    requestedAgentId is the proposal's requestedAssigneeId; the deadline is
  //    caller-supplied (the coordinator owns no deadline configuration).
  let reservation: CommittedPublication["reservation"] = null;
  if (proposal.requestedAssigneeId !== null && input.reservation) {
    reservation = createAssignmentReservationWithClient(db, {
      taskId: task.id,
      attemptId,
      requestedAgentId: proposal.requestedAssigneeId,
      deadline: input.reservation.deadline,
      ...(input.reservation.leaseOwner !== undefined
        ? { leaseOwner: input.reservation.leaseOwner }
        : {}),
      ...(input.reservation.leaseExpiresAt !== undefined
        ? { leaseExpiresAt: input.reservation.leaseExpiresAt }
        : {}),
    });
  }

  // 10. Checkpoint the attempt to `published_pending_observation`. A
  //     non-`transitioned` outcome is a consistency failure (the attempt was
  //     not `pending` — concurrent writer or misuse): throw so the whole
  //     aggregate rolls back (atomicity) while surfacing the classification.
  const checkpoint = checkpointAttemptWithClient(db, attemptId, {
    stage: "published_pending_observation",
  });
  if (checkpoint.outcome !== "transitioned") {
    throw new PublicationCheckpointConsistencyError(checkpoint, attemptId);
  }

  return {
    outcome: "published",
    publication: {
      task,
      event,
      subtasks,
      dependencies,
      envelope,
      dispatchTargets,
      reservation,
      recalculationMarker: { missionId: proposal.targetMissionId, reason: recalculationReason },
      checkpoint,
    },
  };
}
