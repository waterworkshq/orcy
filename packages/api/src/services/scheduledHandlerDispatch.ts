/**
 * Scheduled Handler Dispatch Adapter — T9A-10 M2 Path B (DORMANT).
 *
 * Composes the handler-dispatch flow for the scheduled-occurrence origin
 * when the schedule carries a `handlerKey` (instead of a `templateId` or an
 * inline `tasksTemplate[]`). This is the dormant replacement for the legacy
 * `scheduledTaskService.ts:170-208 executeScheduledTask` handlerKey branch.
 * It ships ALONGSIDE the legacy path and is exercised ONLY by tests until
 * the global cutover (T11) swaps the scheduler onto it.
 *
 * # The handler IS the work
 *
 * Unlike the templateId / inline paths (which publish a Mission + N Tasks
 * atomically through the kernel), the dispatch path runs an arbitrary
 * registered JS handler. The handler returns a compact result
 * (`{success, error?, missionId?}`); the occurrence is the durable
 * "schedule fired" audit. No parent-level Mission is created; handlers
 * that spawn child schedules (wiki-cadence) are separate firings with
 * their own occurrences.
 *
 * # Composition (mirrors `publishScheduledOccurrence` / `publishInlineScheduledOccurrence`)
 *
 *   1. TRANSITION `reserved → publishing` + acquire the lease via
 *      `markOccurrencePublishingWithClient` (Phase 1 fused CAS — re-exported
 *      from `scheduledOccurrences.ts`, unchanged).
 *   2. READ THE LIVE SCHEDULE. Missing → terminal reject `schedule_missing`.
 *   3. PRE-CHECK the schedule config snapshot via the COMPOSED guard
 *      (`diffScheduleGuard`, IMPORTED UNCHANGED from
 *      `scheduledOccurrencePublication.ts`). Mismatch → resumable
 *      `schedule_guard_mismatch` (occurrence stays `publishing`).
 *   4. LOOK UP the handler via `getScheduledTaskHandler(schedule.handlerKey)`
 *      (the new registry module). Missing registration → terminal reject
 *      `handler_not_registered` (preserves the legacy fail-loud guard at
 *      `scheduledTaskService.ts:172-184`).
 *   5. REPLAY GUARD — if the coordination attempt is already terminal, a
 *      prior dispatch won; return `replayed` with the stored terminal
 *      WITHOUT re-running the handler. (Defensive — the success-
 *      terminalization helper commits the coordination-attempt terminal +
 *      the occurrence ROW transition atomically, so this branch is
 *      unreachable in production. Kept for envelope parity with
 *      `PublishScheduledOccurrenceOutcome`.)
 *   6. RUN THE HANDLER — OUTSIDE ANY TRANSACTION. The handler signature is
 *      `(schedule: ScheduledTask) => {success, error?, missionId?}`. A
 *      throw OR a `{success:false}` return → terminal reject
 *      `handler_failed`. The handler's optional `missionId` is preserved
 *      verbatim in the result JSON; it is NOT linked to the occurrence's
 *      `createdMissionId` column (which stays `null`).
 *   7. TERMINALIZE — one caller-owned tx:
 *      - SUCCESS: `terminalPublishDispatchedOccurrenceWithCoordination`
 *        advances the coordination attempt `pending →
 *        published_pending_observation → created` (the two-step advance
 *        the matrix requires) AND transitions the occurrence
 *        `publishing → published` with `createdMissionId: null` + the
 *        `{kind: "handler_dispatched", handlerKey, handlerResult,
 *        dispatchedAt}` result.
 *      - FAILURE: `terminalRejectOccurrenceWithCoordination` (IMPORTED
 *        UNCHANGED) advances the coordination attempt to
 *        `rejected_validation` directly from `pending` AND transitions the
 *        occurrence `publishing → rejected` with the
 *        `{reason: "handler_failed", handlerKey, error}` result.
 *
 * # The handler runs OUTSIDE any transaction (load-bearing)
 *
 * Handler code is arbitrary; do not hold a DB tx open across its execution.
 * The terminalization tx opens AFTER the handler returns. A handler crash
 * leaves the occurrence `publishing` (no tx opened); T9B's recovery worker
 * re-drives the lease under a reclaimed owner.
 *
 * # Handler idempotency contract (load-bearing)
 *
 * Handlers MUST be idempotent under re-dispatch. T9B's recovery worker
 * re-drives `publishing` occurrences on expired leases; a handler that
 * mutates external state must tolerate being called more than once for the
 * same schedule firing. The wiki-cadence handler is currently NOT idempotent
 * in the recovery window (its spawned-child schedules are not deduped by
 * name) — that regression is closed by a separate milestone (the dedup fix
 * ships alongside or after this dispatch path). The dispatch path ships
 * with the documented contract; the wiki-cadence fix closes the regression.
 *
 * # No SSE, no logger (load-graph discipline)
 *
 * The dispatch function returns a typed outcome; it does NOT emit SSE
 * (`scheduled_task.executed` / `scheduled_task.failed`). T11's scheduler
 * wrapper owns SSE emission — it maps the typed outcome to the SSE channel.
 * No logger dependency either (the scheduler's outer try/catch logs).
 * Mirrors `inlineScheduledOccurrencePublication.ts` / Phase 3's discipline.
 *
 * # Dormancy
 *
 * No production scheduler call routes through this adapter yet. Legacy
 * `executeScheduledTask` + its handlerKey branch stay byte-identical and
 * active until T11. The T11 scheduler is the sole production caller.
 *
 * See: T9A-10 M2 ticket (Path B — handler dispatch); the T9A + M1
 * publishers to mirror structurally (`scheduledOccurrencePublication.ts`
 * + `inlineScheduledOccurrencePublication.ts`); the new registry module
 * this composes (`repositories/scheduledHandlerRegistry.ts`).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scheduledTasks, taskCreationAttempts } from "../db/schema/index.js";
import {
  getOccurrenceWithClient,
  markOccurrencePublishingWithClient,
  markOccurrencePublishedWithClient,
  type ScheduledOccurrenceRow,
  type ScheduledOccurrenceState,
  type OccurrenceResultJson,
} from "../repositories/scheduledOccurrences.js";
import {
  TERMINAL_ATTEMPT_STATES,
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import {
  getScheduledTaskHandler,
  type ScheduledTaskHandlerResult,
} from "../repositories/scheduledHandlerRegistry.js";
import {
  diffScheduleGuard,
  terminalRejectOccurrenceWithCoordination,
} from "./scheduledOccurrencePublication.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types the envelope carries — parallel to the
// templateId / inline paths' re-exports so consumers (T11 wiring, tests) can
// narrow without reaching into the milestone modules directly).
// ---------------------------------------------------------------------------

export type {
  ScheduledOccurrenceRow,
  ScheduledOccurrenceState,
} from "../repositories/scheduledOccurrences.js";
export type { ScheduledTaskHandlerResult } from "../repositories/scheduledHandlerRegistry.js";
export type { AttemptTerminalResult } from "../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The handler-dispatch scheduled-occurrence command.
 *
 * Identical in shape to the templateId path's `PublishScheduledOccurrenceInput`
 * and the inline path's `PublishInlineScheduledOccurrenceInput` (the entry
 * contract is shape-agnostic; the routing happens at T11 by reading the
 * schedule row's `handlerKey` / `templateId` / `tasksTemplate`). The caller
 * (the future T11 scheduler wiring, DORMANT until then) supplies the reserved
 * occurrence id + the worker-lease directive. The adapter derives everything
 * else (handlerKey, handler, schedule snapshot) from the occurrence + the
 * live schedule.
 */
export interface PublishHandlerDispatchInput {
  /** The reserved occurrence to dispatch (transitions `reserved → publishing`). */
  occurrenceId: string;
  /** Worker identity claiming this occurrence's dispatch. */
  leaseOwner: string;
  /** ISO timestamp at which the lease expires (T9B's recovery signal). */
  leaseExpiresAt: string;
}

// ---------------------------------------------------------------------------
// Adapter result — closed discriminated union (NEVER thrown for a decision)
// ---------------------------------------------------------------------------

/**
 * The handler-dispatch scheduled-occurrence result envelope. A NEW closed
 * union parallel to `PublishScheduledOccurrenceOutcome` (templateId path)
 * and `PublishInlineScheduledOccurrenceOutcome` (inline path).
 *
 * Every branch is an origin-neutral dispatch outcome. The dispatch-domain
 * mapping:
 *
 *   - `dispatched` — the handler returned `{success:true}`. The coordination
 *     attempt advanced `pending → published_pending_observation → created`
 *     AND the occurrence transitioned `publishing → published` with
 *     `createdMissionId: null` + the `{kind: "handler_dispatched",
 *     handlerKey, handlerResult, dispatchedAt}` result. The occurrence's
 *     lease is RETIRED atomically with the transition. The handler's
 *     optional `missionId` is preserved in the result JSON (audit only;
 *     NOT linked to the occurrence ROW).
 *   - `handler_failed` — the handler threw OR returned `{success:false}`.
 *     Terminal; occurrence `rejected` with the `{reason: "handler_failed",
 *     handlerKey, error}` result. The coordination attempt terminalized as
 *     `rejected_validation` directly from `pending` (the matrix allows this
 *     edge for failure terminals).
 *   - `handler_not_registered` — `getScheduledTaskHandler` returned `null`.
 *     Terminal; occurrence `rejected` with the `{reason:
 *     "handler_not_registered", handlerKey}` result. Preserves the legacy
 *     `scheduledTaskService.ts:172-184` fail-loud guard semantics (a
 *     domain service forgot to register at boot → configuration error,
 *     surfaced explicitly rather than silently falling through).
 *   - `schedule_guard_mismatch` — RESUMABLE. A schedule config edit between
 *     reservation and dispatch was detected (PRE-check). The occurrence
 *     STAYS `publishing` + the lease is held. T9B's recovery worker picks
 *     up the expired lease + retries under the reclaimed owner. The
 *     `fields` payload carries the changed schedule config field names for
 *     diagnostics.
 *   - `schedule_missing` — the schedule row vanished between reservation
 *     and dispatch. Terminal; occurrence `rejected`.
 *   - `schedule_vanished_mid_tx` — RESUMABLE (defensive). The dispatch path
 *     has NO participant (the handler runs OUTSIDE any tx; the
 *     terminalization tx does not re-read the schedule), so this branch is
 *     unreachable on the dispatch path in production. Kept for envelope
 *     parity with `PublishScheduledOccurrenceOutcome` so consumers can
 *     handle the full schedule-origin outcome space generically.
 *   - `already_publishing` — a CONCURRENT worker already transitioned this
 *     occurrence to `publishing` and holds an ACTIVE lease (STEP-1-only —
 *     the `reserved → publishing` CAS the body SKIPS).
 *   - `illegal_source_state` — the occurrence is in a TERMINAL state
 *     (`published` or `rejected`); the `reserved → publishing` transition
 *     is refused. `fromState` carries the terminal state.
 *   - `not_found` — no occurrence row exists for `occurrenceId`.
 *   - `replayed` — the coordination attempt was already terminal (a prior
 *     dispatch won). The stored terminal is returned verbatim; the handler
 *     is NOT re-run. Defensive — the success/failure terminalization
 *     helpers commit the coordination-attempt terminal + the occurrence ROW
 *     transition atomically, so a terminal coordination attempt implies a
 *     terminal occurrence (which the initial path's STEP 1 / the resume
 *     path's STEP 0 would have caught). Unreachable in production; kept
 *     for envelope parity.
 *
 * Infrastructure failures (a repository throw) propagate as retryable
 * runtime errors. The whole terminalization tx rolls back on any
 * infrastructure failure.
 */
export type PublishHandlerDispatchOutcome =
  | {
      outcome: "dispatched";
      occurrence: ScheduledOccurrenceRow;
      /** The handlerKey that dispatched (=== `scheduledTasks.handlerKey`). */
      handlerKey: string;
      /** The verbatim handler-returned result. */
      handlerResult: { success: boolean; error?: string; missionId?: string };
      /** ISO timestamp the handler returned. */
      dispatchedAt: string;
    }
  | {
      outcome: "handler_failed";
      occurrence: ScheduledOccurrenceRow;
      /** The handlerKey whose handler failed. */
      handlerKey: string;
      /** The handler's error message (thrown `.message` OR returned `error`). */
      error: string;
    }
  | {
      outcome: "handler_not_registered";
      occurrence: ScheduledOccurrenceRow;
      /** The handlerKey with no registered handler. */
      handlerKey: string;
    }
  | {
      outcome: "schedule_guard_mismatch";
      occurrence: ScheduledOccurrenceRow;
      /** The schedule config fields that drifted between reservation and dispatch. */
      fields: readonly string[];
    }
  | {
      outcome: "schedule_missing";
      occurrence: ScheduledOccurrenceRow;
    }
  | {
      /**
       * RESUMABLE (defensive — unreachable on the dispatch path in
       * production). Mirrors the templateId / inline paths' envelope branch
       * for cross-shape consumer parity.
       */
      outcome: "schedule_vanished_mid_tx";
      occurrence: ScheduledOccurrenceRow;
      scheduleId: string;
    }
  | {
      outcome: "already_publishing";
      occurrence: ScheduledOccurrenceRow;
    }
  | {
      outcome: "illegal_source_state";
      occurrence: ScheduledOccurrenceRow;
      fromState: ScheduledOccurrenceState;
    }
  | { outcome: "not_found" }
  | {
      outcome: "replayed";
      occurrence: ScheduledOccurrenceRow;
      attemptId: string;
      terminal: AttemptTerminalResult;
    };

// ---------------------------------------------------------------------------
// Success terminalization helper (parallel to
// `terminalRejectOccurrenceWithCoordination` for the failure path)
// ---------------------------------------------------------------------------

/**
 * The success-terminalization args. The helper advances the coordination
 * attempt `pending → published_pending_observation → created` AND transitions
 * the occurrence `publishing → published` with the
 * `{kind: "handler_dispatched", …}` result, all in ONE caller-owned tx.
 */
export interface TerminalPublishDispatchedOccurrenceArgs {
  /** The handlerKey that dispatched (=== `scheduledTasks.handlerKey`). */
  handlerKey: string;
  /** The verbatim handler-returned result. */
  handlerResult: { success: boolean; error?: string; missionId?: string };
  /** ISO timestamp the handler returned (the dispatch moment). */
  dispatchedAt: string;
}

/**
 * Success-terminalization helper for handler-dispatched occurrences
 * (parallel to {@link terminalRejectOccurrenceWithCoordination} for the
 * failure path). In ONE caller-owned tx:
 *
 *   1. (when coordination attempt linked) CHECKPOINT the coordination
 *      attempt `pending → published_pending_observation` via
 *      `checkpointAttemptWithClient`. The matrix forbids
 *      `pending → created` directly (the observation/assignment gates
 *      would be bypassed); the two-step advance is required.
 *   2. (when coordination attempt linked) COMPLETE the coordination attempt
 *      `published_pending_observation → created` via
 *      `completeAttemptWithClient` with `terminalOutcome: "dispatched"` +
 *      the handler-result terminal detail.
 *   3. MARK the occurrence `published` via
 *      `markOccurrencePublishedWithClient` with:
 *        - `leaseOwner` (T9A-08 fenced CAS — the caller holds the lease);
 *        - `createdMissionId: null` (handler dispatch produces no Mission;
 *          handlers that spawn child schedules don't link a Mission at the
 *          parent level);
 *        - `result: {kind: "handler_dispatched", handlerKey, handlerResult,
 *           dispatchedAt}` (the typed discriminator read consumers narrow
 *           on; additive to the loose envelope).
 *
 * All three commit atomically — or roll back together on any throw. The
 * occurrence ROW is the authoritative state; the coordination attempt is
 * the audit / coordination surface.
 *
 * # T9A-08 fencing
 *
 * The terminal CAS checks `leaseOwner = expected`. A stale worker whose
 * lease was reclaimed by T9B's recovery worker surfaces as `not_owner` →
 * THROW (the helper's tx rolls back; the coordination-attempt + occurrence
 * transitions all roll back; the occurrence STAYS `publishing` under the
 * new owner's lease, and the outer caller propagates the throw).
 *
 * @param db The caller-owned tx client (the helper opens `db.transaction`).
 * @param occurrence The `publishing` occurrence ROW (carries `leaseOwner` +
 *   `attemptId` for the fenced CAS + the coordination-attempt link).
 * @param args The handler-dispatch detail (handlerKey, handlerResult,
 *   dispatchedAt) stamped on the result JSON.
 * @returns The authoritative `published` occurrence ROW.
 */
export function terminalPublishDispatchedOccurrenceWithCoordination(
  db: TaskPublicationDbClient,
  occurrence: ScheduledOccurrenceRow,
  args: TerminalPublishDispatchedOccurrenceArgs,
): ScheduledOccurrenceRow {
  return db.transaction((tx) => {
    // --- 1. ADVANCE THE COORDINATION ATTEMPT (two-step: pending →
    //         published_pending_observation → created). Skipped when
    //         `attemptId` is null (defensive — pre-T9A-03 occurrence rows
    //         that predate the link). The matrix forbids `pending →
    //         created` directly (the observation/assignment gates would be
    //         bypassed), so the advance is two CAS operations back-to-back
    //         inside this tx.
    if (occurrence.attemptId !== null) {
      const checkpoint = checkpointAttemptWithClient(tx, occurrence.attemptId, {
        stage: "published_pending_observation",
      });
      // Expected outcomes:
      //   - `transitioned` (typical) — `pending → published_pending_observation`.
      //   - `no_op` — same-state request OR a concurrent writer already
      //     checkpointed (idempotent; the subsequent complete is still
      //     legal from `published_pending_observation`).
      //   - `rejected_transition` — the attempt is terminal (a prior
      //     failure terminalized it from `pending` directly) OR an illegal
      //     pair. A data anomaly — throw to roll back.
      if (checkpoint.outcome === "rejected_transition") {
        throw new Error(
          `dispatchHandlerScheduledOccurrence: coordination attempt "${occurrence.attemptId}" refused the pending → published_pending_observation checkpoint (fromState: ${checkpoint.fromState}) inside the dispatch terminalization tx — the occurrence stays "publishing" for T9B recovery.`,
        );
      }

      const completion = completeAttemptWithClient(tx, occurrence.attemptId, {
        finalState: "created",
        terminalOutcome: "dispatched",
        terminalResult: {
          outcome: "dispatched",
          attemptId: occurrence.attemptId,
          // `publication` is the AttemptTerminalResult's free-form detail
          // slot — carries the handlerKey + the verbatim handlerResult for
          // the audit / `GET /task-creation-attempts/:attemptId` surface.
          publication: {
            handlerKey: args.handlerKey,
            handlerResult: args.handlerResult,
            dispatchedAt: args.dispatchedAt,
          },
        },
      });
      // The completion's CAS predicate is `state = 'published_pending_observation'
      // AND completedAt IS NULL`. Expected outcomes:
      //   - `completed` (typical) — terminalized to `created`.
      //   - `no_op` — idempotent replay (a prior completion won; the
      //     coordination attempt is already terminal `created`).
      //   - `rejected_transition` — illegal pair (the checkpoint didn't
      //     fire for some reason, leaving the attempt at `pending` and
      //     making `pending → created` illegal). A data anomaly — throw.
      if (completion.outcome === "rejected_transition") {
        throw new Error(
          `dispatchHandlerScheduledOccurrence: coordination attempt "${occurrence.attemptId}" refused the published_pending_observation → created completion (fromState: ${completion.fromState}) inside the dispatch terminalization tx — the occurrence stays "publishing" for T9B recovery.`,
        );
      }
    }

    // --- 2. MARK THE OCCURRENCE PUBLISHED with `createdMissionId: null`
    //         (handler dispatch produces no Mission) + the typed
    //         `{kind: "handler_dispatched", …}` result. The terminal CAS
    //         checks `leaseOwner = expected` (T9A-08 fencing). The
    //         occurrence ROW transition + the coordination-attempt
    //         terminalization commit atomically (one tx).
    //
    // A stale worker whose lease was reclaimed by T9B surfaces as
    // `not_owner` → THROW (the helper's tx rolls back — the coordination-
    // attempt terminalization rolls back; the occurrence STAYS
    // `publishing` under the new owner's lease).
    const result: OccurrenceResultJson = {
      // The discriminator field distinguishing the handler-dispatched
      // success shape from the `aggregate_published` success shape (M1)
      // + the existing failure shapes (which carry a `reason` field
      // instead). Read consumers discriminate by `kind` vs `reason`.
      kind: "handler_dispatched",
      handlerKey: args.handlerKey,
      handlerResult: args.handlerResult,
      dispatchedAt: args.dispatchedAt,
    };
    const transition = markOccurrencePublishedWithClient(tx, occurrence.id, {
      leaseOwner: occurrence.leaseOwner,
      createdMissionId: null,
      result,
    });
    if (transition.outcome !== "transitioned") {
      throw new Error(
        `dispatchHandlerScheduledOccurrence: occurrence "${occurrence.id}" refused the publishing → published transition (outcome: ${transition.outcome}) inside the dispatch terminalization tx — the terminalization will roll back.`,
      );
    }
    return transition.occurrence;
  });
}

// ---------------------------------------------------------------------------
// Shared dispatch body (initial + resume — mirrors the templateId / inline
// paths' `runOccurrencePublicationBody` / `runInlineOccurrencePublicationBody`)
// ---------------------------------------------------------------------------

/**
 * The shared handler-dispatch body (STEPS 2-7). Mirrors the structural shape
 * of `runOccurrencePublicationBody` (templateId) /
 * `runInlineOccurrencePublicationBody` (inline) with the handler call
 * substituted for the aggregate prepare/publish.
 *
 * The body assumes the occurrence is ALREADY `publishing` + the caller holds
 * the lease. Returns `Exclude<PublishHandlerDispatchOutcome, { outcome:
 * "already_publishing" }>` — the body NEVER returns `already_publishing`
 * (that outcome is STEP-1-only — the `reserved → publishing` CAS the body
 * SKIPS). Both callers accept this narrowed type.
 *
 * # The handler runs OUTSIDE any transaction (load-bearing)
 *
 * Step 6 (the handler call) is OUTSIDE any tx. The terminalization tx
 * (step 7) opens AFTER the handler returns. A handler crash leaves the
 * occurrence `publishing` (no tx opened) — T9B's recovery worker re-drives
 * the lease under a reclaimed owner.
 */
function runHandlerDispatchBody(
  db: TaskPublicationDbClient,
  currentOccurrence: ScheduledOccurrenceRow,
): Exclude<PublishHandlerDispatchOutcome, { outcome: "already_publishing" }> {
  // ----- 2. READ THE LIVE SCHEDULE ----------------------------------------
  // The schedule row provides the handlerKey, habitatId, and the schedule-
  // config snapshot for the pre-check guard. The occurrence carries only
  // the schedule id (plain text) + the reservation-time snapshot. The
  // schedule_missing branch is terminal (occurrence `rejected`) — there is
  // no dispatch basis without a schedule.
  const schedule = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, currentOccurrence.scheduledTaskId))
    .get();
  if (!schedule) {
    // Terminal: the schedule row vanished. Terminalize the coordination
    // attempt as `batch_rejected` (aggregate-level data anomaly) + mark
    // the occurrence rejected, atomically. The shared
    // `terminalRejectOccurrenceWithCoordination` helper is IMPORTED
    // UNCHANGED from `scheduledOccurrencePublication.ts`.
    const scheduleMissingMessage = `Schedule "${currentOccurrence.scheduledTaskId}" not found at dispatch time.`;
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "schedule_missing", message: scheduleMissingMessage },
      coordinationFinalState: "batch_rejected",
      coordinationTerminalOutcome: "schedule_missing",
      coordinationTerminalResult: {
        outcome: "schedule_missing",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: [{ reason: "schedule_missing", message: scheduleMissingMessage }],
      },
    });
    return { outcome: "schedule_missing", occurrence: rejectedRow };
  }

  // ----- 3. PRE-CHECK: SCHEDULE GUARD (Q5 layer 1) ------------------------
  // The composed guard (`diffScheduleGuard`, IMPORTED UNCHANGED) compares
  // user-authored CONFIG fields against the pre-reservation snapshot, AND
  // user-mutable OPERATIONAL fields (`enabled`, `nextRunAt`) against the
  // `_expectedPostReservation` values the reservation stamped. Same guard
  // the templateId / inline paths use. A mismatch is a schedule edit →
  // resumable `schedule_guard_mismatch` (the occurrence stays `publishing`;
  // T9B recovers).
  const drifted = diffScheduleGuard(
    currentOccurrence.scheduleRevision,
    schedule as unknown as Record<string, unknown>,
  );
  if (drifted) {
    // Resumable — do NOT terminalize. Occurrence stays `publishing`.
    return {
      outcome: "schedule_guard_mismatch",
      occurrence: currentOccurrence,
      fields: drifted,
    };
  }

  // ----- 4. LOOK UP THE HANDLER -------------------------------------------
  // The dispatch path is routed here ONLY for schedules with a handlerKey
  // (T11's routing matrix). Defensively coerce null to empty string — an
  // empty key never matches a registered handler (registrars use non-empty
  // keys like "wiki-cadence"), so the null-handlerKey case folds into the
  // `handler_not_registered` terminal rejection.
  const handlerKey = schedule.handlerKey ?? "";
  const handler = getScheduledTaskHandler(handlerKey);
  if (!handler) {
    // Terminal: no handler registered for this key. Preserves the legacy
    // `scheduledTaskService.ts:172-184` fail-loud guard semantics — a
    // domain service forgot to register at boot → configuration error
    // surfaced explicitly rather than silently falling through to mission
    // creation. The dispatch function returns a typed outcome (no SSE
    // inside); T11's scheduler wrapper maps to the `scheduled_task.failed`
    // SSE channel + logs.
    const message = `No handler registered for handlerKey "${handlerKey}" on scheduled task ${schedule.name} (id=${schedule.id}). Register it at boot via registerScheduledTaskHandler.`;
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "handler_not_registered", handlerKey, message },
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "handler_not_registered",
      coordinationTerminalResult: {
        outcome: "handler_not_registered",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: [{ reason: "handler_not_registered", message }],
      },
    });
    return { outcome: "handler_not_registered", occurrence: rejectedRow, handlerKey };
  }

  // ----- 5. REPLAY GUARD --------------------------------------------------
  // If the coordination attempt is already terminal, a prior dispatch won.
  // Return the stored terminal verbatim; do NOT re-run the handler.
  // Defensive — the success/failure terminalization helpers commit the
  // coordination-attempt terminal + the occurrence ROW transition
  // atomically, so a terminal coordination attempt implies a terminal
  // occurrence (which the initial path's STEP 1 / the resume path's STEP 0
  // would have caught). Unreachable in production; kept for envelope
  // parity with `PublishScheduledOccurrenceOutcome`.
  if (currentOccurrence.attemptId !== null) {
    const attemptRow = db
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, currentOccurrence.attemptId))
      .get();
    if (attemptRow && TERMINAL_ATTEMPT_STATES.has(attemptRow.state)) {
      const terminal: AttemptTerminalResult = attemptRow.terminalResult ?? {
        outcome: attemptRow.terminalOutcome ?? attemptRow.state,
      };
      return {
        outcome: "replayed",
        occurrence: currentOccurrence,
        attemptId: attemptRow.id,
        terminal,
      };
    }
  }

  // ----- 6. RUN THE HANDLER (OUTSIDE ANY TX) ------------------------------
  // The handler signature is `(schedule: ScheduledTask) => {success, error?,
  // missionId?}`. It runs OUTSIDE any transaction — handler code is
  // arbitrary; do not hold a DB tx open across its execution. A throw OR a
  // `{success:false}` return → terminal reject `handler_failed`. The
  // handler's optional `missionId` is preserved verbatim in the result
  // JSON (audit only); it is NOT linked to the occurrence ROW's
  // `createdMissionId` column (which stays `null`).
  const dispatchedAt = new Date().toISOString();
  let handlerResult: ScheduledTaskHandlerResult;
  try {
    handlerResult = handler(schedule as unknown as Parameters<typeof handler>[0]);
  } catch (err) {
    // Terminal: the handler threw. Terminalize the coordination attempt as
    // `rejected_validation` + mark the occurrence rejected with the
    // handler-failed result, atomically.
    const error = (err as Error).message ?? "handler threw";
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "handler_failed", handlerKey, error },
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "handler_failed",
      coordinationTerminalResult: {
        outcome: "handler_failed",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: [{ reason: "handler_failed", message: error }],
      },
    });
    return { outcome: "handler_failed", occurrence: rejectedRow, handlerKey, error };
  }

  if (!handlerResult.success) {
    // Terminal: the handler returned `{success:false}`. Same handling as a
    // throw — terminal reject with the handler-returned error (or a
    // generic sentinel when the handler left `error` unset).
    const error = handlerResult.error ?? "handler failed";
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "handler_failed", handlerKey, error },
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "handler_failed",
      coordinationTerminalResult: {
        outcome: "handler_failed",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: [{ reason: "handler_failed", message: error }],
      },
    });
    return { outcome: "handler_failed", occurrence: rejectedRow, handlerKey, error };
  }

  // ----- 7. TERMINALIZE (SUCCESS) -----------------------------------------
  // The handler returned `{success:true}`. Advance the coordination attempt
  // `pending → published_pending_observation → created` AND transition the
  // occurrence `publishing → published` with `createdMissionId: null` + the
  // `{kind: "handler_dispatched", handlerKey, handlerResult, dispatchedAt}`
  // result, in ONE caller-owned tx. The matrix forbids `pending → created`
  // directly, hence the two-step advance inside the helper.
  const publishedRow = terminalPublishDispatchedOccurrenceWithCoordination(db, currentOccurrence, {
    handlerKey,
    handlerResult,
    dispatchedAt,
  });
  return {
    outcome: "dispatched",
    occurrence: publishedRow,
    handlerKey,
    handlerResult,
    dispatchedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the handler-dispatch flow for a scheduled-occurrence publication
 * (occurrence-state transition + handler invocation + coordination-attempt
 * terminalization), all committed atomically inside ONE caller-owned
 * transaction (the terminalization tx; the handler runs OUTSIDE any tx).
 * DORMANT.
 *
 * The caller (the future T11 scheduler wiring, DORMANT until then) supplies
 * the reserved occurrence id + the worker-lease directive. The adapter:
 *
 *   1. TRANSITIONS the occurrence `reserved → publishing` + acquires the
 *      lease (Phase-1 fused CAS — `markOccurrencePublishingWithClient`).
 *   2. READS the live schedule. Missing → terminal reject `schedule_missing`.
 *   3. PRE-CHECKS the schedule config snapshot (Q5 layer 1). Mismatch →
 *      resumable `schedule_guard_mismatch`.
 *   4. LOOKS UP the handler via `getScheduledTaskHandler`. Missing →
 *      terminal reject `handler_not_registered`.
 *   5. REPLAY GUARD — coordination attempt already terminal → return
 *      `replayed` (defensive; unreachable in production).
 *   6. RUNS the handler OUTSIDE any tx. Throw / `{success:false}` →
 *      terminal reject `handler_failed`.
 *   7. TERMINALIZES — success → `terminalPublishDispatchedOccurrenceWithCoordination`
 *      (occurrence `published` + coordination attempt `created` + result
 *      `{kind: "handler_dispatched", …}`).
 *
 * DORMANT: no production scheduler call routes through this adapter yet.
 * Legacy `executeScheduledTask` + its handlerKey branch stay byte-identical
 * and active until T11. The scheduler wiring that drives occurrence
 * reservation + dispatch is T11 (the cutover ticket).
 */
export function dispatchHandlerScheduledOccurrence(
  input: PublishHandlerDispatchInput,
): PublishHandlerDispatchOutcome {
  const db = getDb();

  // ----- 1. RESERVED → PUBLISHING + ACQUIRE LEASE -------------------------
  // The fused CAS: the FIRST worker to transition wins the lease. Losers
  // get `already_publishing`; terminal occurrences get `illegal_source_state`.
  const publishing = markOccurrencePublishingWithClient(db, input.occurrenceId, {
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
  });
  if (publishing.outcome === "not_found") return { outcome: "not_found" };
  if (publishing.outcome === "already_publishing") {
    return { outcome: "already_publishing", occurrence: publishing.occurrence };
  }
  if (publishing.outcome === "illegal_source_state") {
    return {
      outcome: "illegal_source_state",
      occurrence: publishing.occurrence,
      fromState: publishing.fromState,
    };
  }
  // `transitioned` — this worker owns the lease; proceed. Re-read through
  // the root client so the snapshot reflects the lease transition.
  const occurrence: ScheduledOccurrenceRow = publishing.occurrence;
  const currentOccurrence = getOccurrenceWithClient(db, occurrence.id) ?? occurrence;

  // ----- STEPS 2-7: shared dispatch body (initial + resume) ---------------
  return runHandlerDispatchBody(db, currentOccurrence);
}

// ---------------------------------------------------------------------------
// Resume entry point (T9B Phase 2 — the recovery worker's re-drive path)
// ---------------------------------------------------------------------------

/**
 * The resume dispatch command (T9B Phase 2). The recovery worker
 * (`recoverExpiredOccurrenceLeases`) calls this AFTER reclaiming an expired
 * lease via `reacquireExpiredOccurrenceLeaseWithClient`. The occurrence is
 * already `publishing` under the reclaimed lease — the resume SKIPS the
 * `reserved → publishing` CAS (STEP 1 of {@link dispatchHandlerScheduledOccurrence})
 * + re-drives STEPS 2-7 (the shared {@link runHandlerDispatchBody}) under
 * the reclaimed owner.
 *
 * Mirrors `resumeScheduledOccurrencePublication` (templateId) /
 * `resumeInlineScheduledOccurrencePublication` (inline) 1:1. The recovery
 * worker routes by schedule shape (T11 / a T9B amendment).
 *
 * # Handler re-dispatch contract (load-bearing)
 *
 * Re-running the handler is required because the handler IS the work.
 * Handlers MUST be idempotent under re-dispatch. The wiki-cadence handler
 * is currently NOT idempotent in the recovery window — the idempotency fix
 * ships as a separate milestone that closes the regression this dispatch
 * path introduces.
 *
 * DORMANT: no production caller until T11. The recovery worker is the
 * sole caller.
 */
export interface ResumeHandlerDispatchInput {
  /** The `publishing` occurrence whose expired lease was reclaimed. */
  occurrenceId: string;
  /**
   * The reclaimed lease owner (the recovery worker's identity). MUST match
   * the occurrence row's `leaseOwner` (the reclaim transferred it). The
   * terminalization helper's fenced CAS checks this owner.
   */
  leaseOwner: string;
}

/**
 * The resume result envelope. Narrows {@link PublishHandlerDispatchOutcome}
 * by EXCLUDING `already_publishing` (impossible on the resume — the
 * `reserved → publishing` CAS is skipped) + adding `not_owner` (the caller
 * doesn't hold the lease — a data anomaly if the recovery worker just
 * reclaimed). The resume NEVER returns `already_publishing`.
 */
export type ResumeHandlerDispatchOutcome =
  | Exclude<PublishHandlerDispatchOutcome, { outcome: "already_publishing" }>
  | { outcome: "not_owner"; occurrence: ScheduledOccurrenceRow };

/**
 * T9B Phase 2 — resumes a `publishing` handler-dispatch occurrence under a
 * reclaimed lease. Mirrors `resumeScheduledOccurrencePublication` /
 * `resumeInlineScheduledOccurrencePublication` 1:1. DORMANT.
 */
export function resumeHandlerScheduledOccurrenceDispatch(
  input: ResumeHandlerDispatchInput,
): ResumeHandlerDispatchOutcome {
  const db = getDb();

  // ----- 0. RE-READ THE OCCURRENCE (post-reclaim) -------------------------
  // The caller (the recovery worker) just reclaimed the expired lease via
  // `reacquireExpiredOccurrenceLeaseWithClient`. The occurrence must be
  // `publishing` with `leaseOwner === input.leaseOwner`. A mismatch here is
  // a data anomaly (the lease was stolen between the reclaim + this re-read).
  const occurrence = getOccurrenceWithClient(db, input.occurrenceId);
  if (!occurrence) return { outcome: "not_found" };
  if (occurrence.state !== "publishing") {
    return {
      outcome: "illegal_source_state",
      occurrence,
      fromState: occurrence.state as ScheduledOccurrenceState,
    };
  }
  if (occurrence.leaseOwner !== input.leaseOwner) {
    // The caller doesn't hold the lease — a concurrent worker stole it
    // between the reclaim + this re-read. Return a typed `not_owner` so the
    // caller can distinguish "lost the lease" from "wrong state".
    return { outcome: "not_owner", occurrence };
  }

  // ----- STEPS 2-7: shared dispatch body (initial + resume) ---------------
  return runHandlerDispatchBody(db, occurrence);
}

// ---------------------------------------------------------------------------
// Type narrowing helper for read consumers (T11 status surface, audit
// projections). Parallel to `asInlineAggregatePublishedResult` (M1) —
// narrows the SUCCESS branch by the `kind: "handler_dispatched"`
// discriminator.
// ---------------------------------------------------------------------------

/**
 * Narrows an {@link OccurrenceResultJson} to its
 * `kind: "handler_dispatched"` success shape when present. Returns `null`
 * for any other shape (the `aggregate_published` success shape, failure
 * branches carrying `reason`, the recovery worker's intermediate reclaim-
 * counter JSON, repair's spread-with-retryHistory, etc.). Read consumers
 * (T11 status surface) use this to discriminate without forcing a refactor
 * of the additive writers.
 *
 * Additive (T9A-10 M2); parallel to M1's `asInlineAggregatePublishedResult`.
 */
export function asHandlerDispatchedResult(result: OccurrenceResultJson | null | undefined): {
  kind: "handler_dispatched";
  handlerKey: string;
  handlerResult: { success: boolean; error?: string; missionId?: string };
  dispatchedAt: string;
} | null {
  if (!result || typeof result !== "object") return null;
  if (result.kind !== "handler_dispatched") return null;
  // Defensive shallow validation — the writer is
  // `terminalPublishDispatchedOccurrenceWithCoordination` (trusted server-
  // side); a malformed row would be a data anomaly. Treat any malformed
  // shape as "not this kind" rather than crashing.
  if (
    typeof (result as { handlerKey?: unknown }).handlerKey !== "string" ||
    typeof (result as { dispatchedAt?: unknown }).dispatchedAt !== "string" ||
    typeof (result as { handlerResult?: unknown }).handlerResult !== "object" ||
    (result as { handlerResult?: unknown }).handlerResult === null
  ) {
    return null;
  }
  const handlerResult = (result as { handlerResult: { success?: unknown } }).handlerResult;
  if (typeof handlerResult.success !== "boolean") return null;
  return {
    kind: "handler_dispatched",
    handlerKey: (result as { handlerKey: string }).handlerKey,
    handlerResult: handlerResult as { success: boolean; error?: string; missionId?: string },
    dispatchedAt: (result as { dispatchedAt: string }).dispatchedAt,
  };
}
