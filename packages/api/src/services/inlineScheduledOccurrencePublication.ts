/**
 * Inline Scheduled Occurrence Publication Adapter — T9A-10 M1 Path A (DORMANT).
 *
 * Composes the inline-aggregate interface ({@link prepareInlineAggregate}
 * + {@link publishInlineAggregateWithClient}) for the scheduled-occurrence
 * origin when the schedule carries an inline `tasksTemplate[]` instead of
 * a `templateId` (and no `handlerKey`). This is the dormant replacement
 * for the legacy `scheduledTaskService.ts:103-133 createMissionFromSchedule`
 * + the inline branch of `:236-240 executeScheduledTask`. It ships
 * ALONGSIDE the legacy path and is exercised ONLY by tests until the
 * global cutover (T11) swaps the scheduler onto it.
 *
 * # The schedule-shape routing (T11's job)
 *
 * T11's scheduler reads each due schedule's `handlerKey` + `templateId` +
 * `tasksTemplate[]` and routes:
 *   - `handlerKey` set           → M2's `dispatchHandlerScheduledOccurrence`.
 *   - `templateId` set           → T9A's `publishScheduledOccurrence` (the
 *                                   existing templateId path).
 *   - `templateId` null +        → THIS adapter's `publishInlineScheduledOccurrence`.
 *     `tasksTemplate` non-empty
 *   - `templateId` null +        → terminal reject `empty_tasks_template`
 *     `tasksTemplate` empty        (a config error — surfaced explicitly
 *                                   rather than producing a zero-task Mission).
 *
 * # Composition (mirrors `publishScheduledOccurrence` with the inline
 * # prepare/publish substituted)
 *
 *   1. TRANSITION `reserved → publishing` + acquire the lease via
 *      `markOccurrencePublishingWithClient` (Phase 1 fused CAS — re-exported
 *      from `scheduledOccurrences.ts`, unchanged).
 *   2. PRE-CHECK the schedule config snapshot (Q5 layer 1). Mismatch →
 *      `schedule_guard_mismatch` (resumable). The guard function
 *      (`diffScheduleGuard`) is imported UNCHANGED from
 *      `scheduledOccurrencePublication.ts`.
 *   3. RESOLVE `{{date}}/{{counter}}` tokens (counter = `ordinal + 1`).
 *      `{{date}}` uses the durable `scheduledFor` (T9A-06 cross-midnight
 *      safety).
 *   4. PREPARE the inline aggregate via `prepareInlineAggregate`. On
 *      `rejected_validation` (incl. `empty_tasks_template`) → terminal reject.
 *   5. RESERVE N per-Task attempts scoped by the occurrence
 *      (`sourceScopeKind:"scheduled_occurrence"`, `sourceScopeId:occurrence.id`).
 *      Handle the replay/fingerprint branches.
 *   6. PUBLISH via `publishInlineAggregateWithClient(db, {attemptIds,
 *      prepared, participants})` where the participant is the
 *      `buildOccurrenceRecordParticipant` (IMPORTED UNCHANGED from
 *      `scheduledOccurrencePublication.ts` — the participant is shape-
 *      agnostic; it reads `ctx.mission.id`, `ctx.tasks`, `ctx.attemptIds`).
 *   7. MAP the inline outcome to occurrence state.
 *
 * # Tolerated duplication (the additive-seams constraint)
 *
 * The shared `runOccurrencePublicationBody` hardcodes the templateId
 * prepare/publish calls. The inline path needs a parallel body with the
 * inline prepare/publish substituted. Extracting a shared helper that
 * takes prepare/publish as injected functions would refactor
 * `runOccurrencePublicationBody` — banned by the additive-seams
 * constraint. The duplication is ~80 lines of "read schedule → pre-check
 * guard → resolve tokens → prepare → reserve N attempts → publish → map";
 * the two bodies are stable (the kernel contract doesn't drift).
 *
 * # Dormancy
 *
 * No production scheduler call routes through this adapter yet. Legacy
 * `executeScheduledTask` + its inline branch stay byte-identical and
 * active until T11. The T11 scheduler is the sole production caller.
 *
 * See: T9A-10 M1 ticket (Path A — inline template aggregate); the T9A
 * publisher to mirror structurally (`scheduledOccurrencePublication.ts`);
 * the M1 preparation + publication pair this composes
 * (`inlineAggregatePreparation.ts` + `inlineAggregatePublication.ts`).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { scheduledTasks } from "../db/schema/index.js";
import {
  getOccurrenceWithClient,
  markOccurrencePublishingWithClient,
  type ScheduledOccurrenceRow,
  type ScheduledOccurrenceState,
} from "../repositories/scheduledOccurrences.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  TERMINAL_ATTEMPT_STATES,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import {
  prepareInlineAggregate,
  INLINE_AGGREGATE_CAUSAL_ROOT_TYPE,
  type PrepareInlineAggregateContext,
} from "./inlineAggregatePreparation.js";
import { publishInlineAggregateWithClient } from "./inlineAggregatePublication.js";
import type { InlineAggregateParticipantWriter } from "./inlineAggregatePublication.js";
import {
  diffScheduleGuard,
  ScheduleGuardMismatch,
  ScheduleVanishedMidTx,
  terminalRejectOccurrenceWithCoordination,
  buildOccurrenceRecordParticipant,
  type OccurrenceResultJson,
} from "./scheduledOccurrencePublication.js";
import type { CommittedPublication } from "./taskPublicationCoordinator.js";
import type { TemplateAggregateParticipantContext } from "./templateAggregatePublication.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import type { PublicationError } from "./taskPublicationPreparation.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types the envelope carries — parallel to the
// templateId path's re-exports so consumers (T11 wiring, tests) can narrow
// without reaching into the milestone-1 modules directly).
// ---------------------------------------------------------------------------

export type {
  ScheduledOccurrenceRow,
  ScheduledOccurrenceState,
} from "../repositories/scheduledOccurrences.js";
export type { CommittedPublication } from "./taskPublicationCoordinator.js";
export type { CommittedInlineMission } from "./inlineAggregatePublication.js";
export type {
  PreparedInlineAggregate,
  PrepareInlineAggregateResult,
} from "./inlineAggregatePreparation.js";
export type { PublishInlineAggregateOutcome } from "./inlineAggregatePublication.js";
export type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
export type { PublicationError } from "./taskPublicationPreparation.js";
export type { AttemptTerminalResult } from "../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Provenance constants (the inline path's analog of the template path's
// SCHEDULE_ACTOR_ID / SCHEDULE_AUDIT_SOURCE / OCCURRENCE_CAUSAL_ROOT_TYPE).
// Same values — the publication kernel's audit channel is the same; the
// causal-root TYPE differs (`scheduled_inline_aggregate` vs the template
// path's `scheduled_occurrence` to distinguish the originating shape).
// ---------------------------------------------------------------------------

const SCHEDULE_ACTOR_ID = "scheduler";
const SCHEDULE_AUDIT_SOURCE: AuditSource = "scheduler";
const OCCURRENCE_SCOPE_KIND = "scheduled_occurrence";

// ---------------------------------------------------------------------------
// Token resolution (inlined to avoid reaching into the shipped occurrence
// subsystem's private helper — `scheduledOccurrencePublication.ts:638
// substituteTokens` is intentionally NOT exported. The same layering
// precedent (the templateId path inlines it for the same reason, with the
// same cross-midnight `scheduledFor` discipline — see
// `scheduledOccurrencePublication.ts:608-646`) applies here.
// ---------------------------------------------------------------------------

/**
 * Replaces `{{date}}` (YYYY-MM-DD in the schedule's timezone) and
 * `{{counter}}` (the display counter) tokens. Inlined here (NOT imported)
 * because `scheduledOccurrencePublication.substituteTokens` is a private
 * helper. Identical implementation to the templateId path's
 * `substituteTokens` (T9A-06 cross-midnight `scheduledFor` discipline).
 */
function substituteTokens(
  template: string,
  context: { runCount: number; timezone: string; scheduledFor: string },
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
  }).format(new Date(context.scheduledFor));
  return template.replaceAll("{{date}}", date).replaceAll("{{counter}}", String(context.runCount));
}

// ---------------------------------------------------------------------------
// Request fingerprint (the per-Task attempt reservation dedup key)
// ---------------------------------------------------------------------------

/** Canonical stable-JSON serializer (sorted keys, stable array order). */
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
 * Computes the canonical request fingerprint for an inline-aggregate
 * scheduled-occurrence publication. Covers the RENDERED payload (token-
 * substituted mission title + description + priority + labels) + the
 * INLINE `tasksTemplate` + the occurrence id (the scope discriminator).
 * A same-occurrence retry with the same rendered content + same inline
 * task list replays; a schedule edit that changed the rendered title OR
 * the inline task list produces a different fingerprint →
 * `rejected_fingerprint` on the same attempt key set (forces the
 * scheduler to use a new key set — typically a new occurrence after the
 * next reservation).
 *
 * Mirrors `computeOccurrenceFingerprint` from the templateId path,
 * substituting `tasksTemplate` for `templateId`. EXCLUDES provenance
 * (actor/source/causal-context) — those are server-stamped + stable
 * across retries.
 */
function computeInlineOccurrenceFingerprint(input: {
  occurrenceId: string;
  resolvedTitle: string;
  resolvedDescription: string;
  priority: string;
  labels: readonly string[];
  tasksTemplate: readonly unknown[];
}): string {
  const payload = {
    occurrenceId: input.occurrenceId,
    title: input.resolvedTitle,
    description: input.resolvedDescription,
    priority: input.priority,
    labels: [...input.labels].sort(),
    tasksTemplate: input.tasksTemplate,
  };
  return "scheduled_inline_occurrence:" + stableHash(stableStringify(payload));
}

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The inline scheduled-occurrence publication command.
 *
 * The caller (the future T11 scheduler wiring, DORMANT until then) supplies
 * the reserved occurrence id + the worker-lease directive. The adapter
 * derives everything else (inline tasks template, title, schedule snapshot,
 * attempts) from the occurrence + the live schedule — the input does NOT
 * expose templateId, title, scheduleRevision, attemptKey, or causalContext
 * fields. Untrusted callers cannot assert privileged publication identities.
 *
 * Identical in shape to the templateId path's `PublishScheduledOccurrenceInput`
 * (the entry contract is shape-agnostic; the routing happens at T11 by
 * reading the schedule row's `templateId` / `tasksTemplate`).
 */
export interface PublishInlineScheduledOccurrenceInput {
  /** The reserved occurrence to publish (transitions `reserved → publishing`). */
  occurrenceId: string;
  /** Worker identity claiming this occurrence's publication. */
  leaseOwner: string;
  /** ISO timestamp at which the lease expires (T9B's recovery signal). */
  leaseExpiresAt: string;
}

// ---------------------------------------------------------------------------
// Adapter result — closed discriminated union (NEVER thrown for a decision)
// ---------------------------------------------------------------------------

/**
 * The inline scheduled-occurrence publication result envelope.
 *
 * Identical in branch shape to `PublishScheduledOccurrenceOutcome` (the
 * templateId path) — the 12-branch outcome envelope. Every branch is an
 * origin-neutral publication outcome translated from the inline
 * {@link PublishInlineAggregateOutcome} (plus the occurrence-state-decision
 * branches the adapter owns: `not_found`, `already_publishing`,
 * `illegal_source_state`, `schedule_guard_mismatch`, `schedule_missing`,
 * `replayed`, `rejected_fingerprint`).
 *
 * The branch semantics mirror `PublishScheduledOccurrenceOutcome` 1:1
 * (see that type's docblock for the full branch-by-branch mapping); the
 * ONLY difference is `published.workflow` is always `null` on the inline
 * path (inline aggregates produce no Workflow).
 */
export type PublishInlineScheduledOccurrenceOutcome =
  | {
      outcome: "published";
      occurrence: ScheduledOccurrenceRow;
      /** The committed Mission row. */
      mission: import("./inlineAggregatePublication.js").CommittedInlineMission;
      /** One committed publication per Task (each POST_CUTOVER + `created` event + envelope). */
      tasks: CommittedPublication[];
      /** Always `null` on the inline path (no Workflow is instantiated). */
      workflow: null;
    }
  | {
      outcome: "vetoed";
      occurrence: ScheduledOccurrenceRow;
      /**
       * Every decisive Task-level veto collected by the inline publisher
       * (T9A-04 — all-failures governance). One entry per vetoed Task;
       * allowed Tasks are NOT in the list. Mirrors the inline
       * `PublishInlineAggregateOutcome.vetoed.vetoes` shape 1:1.
       */
      vetoes: ReadonlyArray<{
        taskIndex: number;
        veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
      }>;
    }
  | {
      outcome: "rejected_validation";
      occurrence: ScheduledOccurrenceRow;
      errors: PublicationError[];
    }
  | {
      outcome: "schedule_guard_mismatch";
      occurrence: ScheduledOccurrenceRow;
      /** The schedule config fields that drifted between reservation and publication. */
      fields: readonly string[];
    }
  | {
      outcome: "guard_mismatch";
      occurrence: ScheduledOccurrenceRow;
      taskIndex: number;
      reasons: GuardMismatchReason[];
    }
  | {
      outcome: "governance_denied";
      occurrence: ScheduledOccurrenceRow;
      taskIndex: number;
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
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
      outcome: "schedule_missing";
      occurrence: ScheduledOccurrenceRow;
    }
  | {
      /**
       * RESUMABLE — the schedule vanished BETWEEN the pre-check and the
       * in-tx re-check (deleted mid-tx). The participant threw
       * {@link ScheduleVanishedMidTx} → the whole aggregate rolled back.
       * The occurrence STAYS `publishing` + lease held. T9B's recovery
       * worker picks up the expired lease + retries.
       */
      outcome: "schedule_vanished_mid_tx";
      occurrence: ScheduledOccurrenceRow;
      scheduleId: string;
    }
  | {
      outcome: "replayed";
      occurrence: ScheduledOccurrenceRow;
      attemptId: string;
      terminal: AttemptTerminalResult;
    }
  | {
      outcome: "rejected_fingerprint";
      occurrence: ScheduledOccurrenceRow;
      attemptId: string;
      reservedFingerprint: string;
    };

// ---------------------------------------------------------------------------
// Shared publication body (initial + resume — mirrors
// `runOccurrencePublicationBody` with inline prepare/publish substituted)
// ---------------------------------------------------------------------------

/**
 * The shared inline publication body (STEPS 2-8). Mirrors
 * `runOccurrencePublicationBody` from the templateId path with the inline
 * `prepareInlineAggregate` + `publishInlineAggregateWithClient` substituted
 * for `prepareTemplateAggregate` + `publishTemplateAggregateWithClient`.
 *
 * Tolerated duplication (the additive-seams constraint forbids refactoring
 * the shared body to take prepare/publish as injected functions). The two
 * bodies are stable (the kernel contract doesn't drift); the duplication
 * doesn't compound.
 *
 * Returns `Exclude<PublishInlineScheduledOccurrenceOutcome, { outcome:
 * "already_publishing" }>` — the body NEVER returns `already_publishing`
 * (that outcome is STEP-1-only — the `reserved → publishing` CAS the body
 * SKIPS). Both callers accept this narrowed type.
 */
function runInlineOccurrencePublicationBody(
  db: TaskPublicationDbClient,
  currentOccurrence: ScheduledOccurrenceRow,
  leaseOwner: string,
): Exclude<PublishInlineScheduledOccurrenceOutcome, { outcome: "already_publishing" }> {
  // ----- 2. READ THE LIVE SCHEDULE ----------------------------------------
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
    const scheduleMissingMessage = `Schedule "${currentOccurrence.scheduledTaskId}" not found at publication time.`;
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
  // the templateId path uses; the inline path's `tasksTemplate` is one of
  // the CONFIG fields covered.
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

  // ----- 4. RESOLVE TOKENS ------------------------------------------------
  // counter = ordinal + 1 (1-based display matching the legacy
  // buildTokenContext's `runCount + 1`). `{{date}}` uses the DURABLE
  // `currentOccurrence.scheduledFor` (T9A-06 cross-midnight safety).
  // `substituteTokens` is IMPORTED UNCHANGED from
  // `scheduledOccurrencePublication.ts`.
  const tokenContext = {
    runCount: currentOccurrence.ordinal + 1,
    timezone: schedule.timezone ?? "UTC",
    scheduledFor: currentOccurrence.scheduledFor,
  };
  const resolvedTitle = substituteTokens(schedule.missionTitle, tokenContext);
  const resolvedDescription = substituteTokens(schedule.missionDescription, tokenContext);

  // ----- 5. PREPARE -------------------------------------------------------
  // The schedule's inline `tasksTemplate[]` drives the aggregate. An empty
  // list is the config-error gate (`empty_tasks_template`); any other
  // validation failure (column-missing, invalid-actor) is collected by the
  // PURE preparation step. NO Workflow, NO usage descriptor (the inline
  // path produces neither).
  const tasksTemplate = (schedule.tasksTemplate ?? []).map((task) => ({
    ...task,
    title: substituteTokens(task.title, tokenContext),
    ...(task.description !== undefined && {
      description: substituteTokens(task.description, tokenContext),
    }),
  }));
  const actor: AuditActorRef = { type: "system", id: SCHEDULE_ACTOR_ID };
  const causalContext: CausalContext = {
    root: { type: INLINE_AGGREGATE_CAUSAL_ROOT_TYPE, id: currentOccurrence.id },
  };
  const prepareCtx: PrepareInlineAggregateContext = {
    actor,
    auditSource: SCHEDULE_AUDIT_SOURCE,
    causalContext,
  };
  const prepared = prepareInlineAggregate(
    schedule.habitatId,
    tasksTemplate,
    {
      title: resolvedTitle,
      description: resolvedDescription,
      priority: schedule.missionPriority,
      labels: schedule.missionLabels,
    },
    prepareCtx,
  );
  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish. Terminalize the
    // coordination attempt as `rejected_validation` + mark the occurrence
    // rejected, atomically. The `empty_tasks_template` branch surfaces a
    // config error (the legacy path's degenerate zero-task Mission is
    // routed here explicitly).
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "rejected_validation", errors: prepared.errors },
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "rejected_validation",
      coordinationTerminalResult: {
        outcome: "rejected_validation",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: prepared.errors,
      },
    });
    return { outcome: "rejected_validation", occurrence: rejectedRow, errors: prepared.errors };
  }

  const aggregate = prepared.aggregate;
  const taskCount = aggregate.tasks.length;

  // ----- 6. RESERVE N PER-TASK ATTEMPTS -----------------------------------
  // Scoped by the occurrence (NOT the schedule — each occurrence gets its
  // own attempt set). The fingerprint covers the RENDERED payload + the
  // INLINE `tasksTemplate` + the occurrence id. The attempt key uses
  // `inline-${i}` (no templateId to derive from; stable across (occurrence,
  // task index) for replay).
  const requestFingerprint = computeInlineOccurrenceFingerprint({
    occurrenceId: currentOccurrence.id,
    resolvedTitle,
    resolvedDescription,
    priority: schedule.missionPriority,
    labels: schedule.missionLabels,
    tasksTemplate,
  });

  const attemptIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    // Per-Task attempt key: stable across (occurrence, task index). Same
    // occurrence + same slot → same key → replay.
    const attemptKey = `inline-${i}`;
    const reservation = reserveAttemptWithClient(db, {
      source: SCHEDULE_AUDIT_SOURCE,
      sourceScopeKind: OCCURRENCE_SCOPE_KIND,
      sourceScopeId: currentOccurrence.id,
      attemptKey,
      requestFingerprint,
      publicationKind: "scheduled_occurrence",
      habitatId: schedule.habitatId,
      actorType: "system",
      actorId: SCHEDULE_ACTOR_ID,
      causalContext,
    });

    // 6a. Fingerprint mismatch → deterministic rejection. Same handling
    // as the templateId path: terminal rejection (the fingerprint mismatch
    // indicates the rendered payload differs from the publication-time
    // payload; T9B recovery under the same keys is impossible).
    if (reservation.outcome === "rejected_fingerprint") {
      const fingerprintErrors = [
        {
          code: "rejected_fingerprint",
          message:
            `The rendered payload changed under the same attempt key set ` +
            `(reserved fingerprint "${reservation.reservedFingerprint}" ≠ request "${requestFingerprint}").`,
          attemptId: reservation.attempt.id,
        },
      ];
      const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
        occurrenceResult: {
          reason: "rejected_fingerprint",
          attemptId: reservation.attempt.id,
          reservedFingerprint: reservation.reservedFingerprint,
          requestFingerprint,
        },
        coordinationFinalState: "batch_rejected",
        coordinationTerminalOutcome: "rejected_fingerprint",
        coordinationTerminalResult: {
          outcome: "rejected_fingerprint",
          attemptId: currentOccurrence.attemptId ?? undefined,
          errors: fingerprintErrors,
        },
      });
      return {
        outcome: "rejected_fingerprint",
        occurrence: rejectedRow,
        attemptId: reservation.attempt.id,
        reservedFingerprint: reservation.reservedFingerprint,
      };
    }

    const attempt = reservation.attempt;

    // 6b. REPLAY of a TERMINAL per-Task attempt → return the stored
    //     terminal result verbatim. NO governance, NO publish, NO side
    //     effect.
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
        outcome: attempt.terminalOutcome ?? attempt.state,
      };
      return {
        outcome: "replayed",
        occurrence: currentOccurrence,
        attemptId: attempt.id,
        terminal,
      };
    }

    // 6c. REPLAY of a RECOVERING per-Task attempt (post-publish, pre-
    //     terminalization). The aggregate already committed under this key
    //     set; the adapter does NOT re-publish.
    if (
      attempt.state === "published_pending_observation" ||
      attempt.state === "published_pending_assignment"
    ) {
      const terminal: AttemptTerminalResult = { outcome: attempt.state };
      return {
        outcome: "replayed",
        occurrence: currentOccurrence,
        attemptId: attempt.id,
        terminal,
      };
    }

    // 6d. FRESH or PENDING-RESUME per-Task attempt → collect for
    //     publication. The inline publisher's pre-tx governance + in-tx
    //     publication are idempotent.
    attemptIds.push(attempt.id);
  }

  // ----- 7. PUBLISH (atomic, inside one caller-owned tx) -----------------
  // The occurrence-record participant (`buildOccurrenceRecordParticipant`,
  // IMPORTED UNCHANGED from `scheduledOccurrencePublication.ts`) composes
  // the `publishing → published` transition + Mission linkage into the
  // SAME tx as the inline aggregate (Mission + Tasks). A participant throw
  // (incl. the in-tx ScheduleGuardMismatch sentinel) rolls back the whole
  // aggregate. The participant is shape-agnostic: it only reads
  // `ctx.mission.id`, `ctx.tasks`, `ctx.attemptIds` — the inline
  // {@link InlineAggregateParticipantContext} provides all three.
  //
  // The cast on `ctx` below is type-level friction only: the existing
  // `buildOccurrenceRecordParticipant` returns a
  // `TemplateAggregateParticipantWriter` whose ctx.prepared is typed as
  // `PreparedTemplateAggregate` (which carries `usageMutation`). The
  // inline prepared aggregate (`PreparedInlineAggregate`) lacks
  // `usageMutation` because the inline path has no usage descriptor.
  // The participant NEVER accesses `ctx.prepared` at runtime (verified by
  // reading the source — it reads `ctx.mission`, `ctx.tasks`,
  // `ctx.attemptIds` only), so the cast is safe + localizes the type
  // friction to one well-documented line.
  const occurrenceParticipant = buildOccurrenceRecordParticipant(
    currentOccurrence.id,
    currentOccurrence.scheduleRevision,
    currentOccurrence.attemptId,
    // T9A-08 fencing: thread the publisher's lease owner so the
    // participant's `markOccurrencePublishedWithClient` CAS checks
    // `leaseOwner = expected`.
    leaseOwner,
  );
  const participants: InlineAggregateParticipantWriter = (db, ctx) => {
    occurrenceParticipant(db, ctx as unknown as TemplateAggregateParticipantContext);
  };

  let publishOutcome;
  try {
    publishOutcome = publishInlineAggregateWithClient(db, {
      attemptIds,
      prepared: aggregate,
      participants,
    });
  } catch (err) {
    // Map the in-tx schedule-guard sentinels to closed outcomes. The tx
    // already rolled back (the participant's throw aborted it); the
    // occurrence stays `publishing` (resumable for T9B). Nothing else
    // committed.
    if (err instanceof ScheduleGuardMismatch) {
      return {
        outcome: "schedule_guard_mismatch",
        occurrence: currentOccurrence,
        fields: err.fields,
      };
    }
    if (err instanceof ScheduleVanishedMidTx) {
      return {
        outcome: "schedule_vanished_mid_tx",
        occurrence: currentOccurrence,
        scheduleId: err.scheduleId,
      };
    }
    // Infrastructure failure — propagate as a retryable runtime error.
    throw err;
  }

  // ----- 8. MAP THE OUTCOME ----------------------------------------------
  switch (publishOutcome.outcome) {
    case "published": {
      // The participant already marked the occurrence `published` + linked
      // the Mission (atomic with the aggregate). Re-read the authoritative
      // row so the returned occurrence reflects the transition.
      const publishedRow = getOccurrenceWithClient(db, currentOccurrence.id) ?? currentOccurrence;
      return {
        outcome: "published",
        occurrence: publishedRow,
        mission: publishOutcome.mission,
        tasks: publishOutcome.tasks,
        // Always null on the inline path (no Workflow).
        workflow: null,
      };
    }

    case "vetoed": {
      // Terminal governance refusal. The tx never opened (governance runs
      // before the tx in the inline publisher); nothing committed.
      // T9A-04: `publishOutcome.vetoes` carries EVERY decisive Task-level
      // veto. T9A-05: terminalize ALL reserved attempts atomically with
      // the occurrence rejection. Same attempt-terminal mapping as the
      // templateId path (vetoed taskIndexes → `vetoed`; allowed-but-
      // unpublished → `batch_rejected`).
      const vetoedTaskIndexes = new Set(publishOutcome.vetoes.map((v) => v.taskIndex));
      const perTaskAttemptTerminals: Array<{
        attemptId: string;
        finalState: "vetoed" | "batch_rejected";
        terminalOutcome: string;
        terminalResult: AttemptTerminalResult;
      }> = [];
      for (let i = 0; i < attemptIds.length; i++) {
        const attemptId = attemptIds[i];
        if (vetoedTaskIndexes.has(i)) {
          const vetoEntry = publishOutcome.vetoes.find((v) => v.taskIndex === i);
          // The veto is guaranteed to exist (vetoes was built from the
          // same taskIndexes); the non-null assertion mirrors the
          // kernel adapters' pattern when an index-set lookup is
          // structural.
          const veto = vetoEntry!.veto;
          perTaskAttemptTerminals.push({
            attemptId,
            finalState: "vetoed",
            terminalOutcome: "vetoed",
            terminalResult: {
              outcome: "vetoed",
              attemptId,
              veto,
            },
          });
        } else {
          // Allowed-but-unpublished → collateral `batch_rejected`.
          perTaskAttemptTerminals.push({
            attemptId,
            finalState: "batch_rejected",
            terminalOutcome: "batch_rejected",
            terminalResult: {
              outcome: "batch_rejected",
              attemptId,
              errors: [
                {
                  reason: "aggregate_vetoed_collateral",
                  message:
                    "The aggregate was vetoed by another Task; this allowed Task was not published.",
                },
              ],
            },
          });
        }
      }

      const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
        occurrenceResult: {
          reason: "vetoed",
          vetoes: publishOutcome.vetoes,
        },
        coordinationFinalState: "vetoed",
        coordinationTerminalOutcome: "vetoed",
        coordinationTerminalResult: {
          outcome: "vetoed",
          attemptId: currentOccurrence.attemptId ?? undefined,
          publication: {
            vetoes: publishOutcome.vetoes,
          },
        },
        perTaskAttemptTerminals,
      });
      return {
        outcome: "vetoed",
        occurrence: rejectedRow,
        vetoes: publishOutcome.vetoes,
      };
    }

    case "guard_mismatch": {
      // RESUMABLE — per-Task guard drift at publish time. The tx rolled
      // back; the per-Task attempts stay `pending` / resumable. The
      // occurrence STAYS `publishing` + lease held (Q4).
      return {
        outcome: "guard_mismatch",
        occurrence: currentOccurrence,
        taskIndex: publishOutcome.taskIndex,
        reasons: publishOutcome.reasons,
      };
    }

    case "governance_denied": {
      // RESUMABLE — stale governance decision at commit. Same handling as
      // guard_mismatch.
      return {
        outcome: "governance_denied",
        occurrence: currentOccurrence,
        taskIndex: publishOutcome.taskIndex,
        kind: publishOutcome.kind,
        reason: publishOutcome.reason,
        ...(publishOutcome.interceptorKey !== undefined
          ? { interceptorKey: publishOutcome.interceptorKey }
          : {}),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the inline-aggregate kernel chain for a scheduled-occurrence
 * publication (occurrence-state transition + Mission + N Tasks), all
 * committed atomically inside ONE caller-owned transaction. DORMANT.
 *
 * The caller (the future T11 scheduler wiring, DORMANT until then) supplies
 * the reserved occurrence id + the worker-lease directive. The adapter:
 *
 *   1. TRANSITIONS the occurrence `reserved → publishing` + acquires the
 *      lease (Phase-1 fused CAS — `markOccurrencePublishingWithClient`).
 *   2. PRE-CHECKS the schedule config snapshot (Q5 layer 1). Mismatch →
 *      `schedule_guard_mismatch` (resumable).
 *   3. RESOLVES `{{date}}/{{counter}}` tokens (counter = `ordinal + 1`).
 *   4. PREPARES the inline aggregate via `prepareInlineAggregate` (empty
 *      tasksTemplate → `rejected_validation: empty_tasks_template`).
 *   5. RESERVES N per-Task attempts scoped by the occurrence.
 *   6. PUBLISHES atomically via `publishInlineAggregateWithClient` WITH
 *      the occurrence-record participant so the `publishing → published`
 *      transition commits with the aggregate.
 *   7. MAPS the outcome to {@link PublishInlineScheduledOccurrenceOutcome}.
 *
 * DORMANT: no production scheduler call routes through this adapter yet.
 * Legacy `executeScheduledTask` + its inline branch stay byte-identical +
 * active until T11. The scheduler wiring that drives occurrence
 * reservation + publication is T11 (the cutover ticket).
 */
export function publishInlineScheduledOccurrence(
  input: PublishInlineScheduledOccurrenceInput,
): PublishInlineScheduledOccurrenceOutcome {
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

  // ----- STEPS 2-8: shared publication body (initial + resume) ------------
  return runInlineOccurrencePublicationBody(db, currentOccurrence, input.leaseOwner);
}

// ---------------------------------------------------------------------------
// Resume entry point (T9B Phase 2 — the recovery worker's re-drive path)
// ---------------------------------------------------------------------------

/**
 * The resume publication command (T9B Phase 2). The recovery worker
 * (`recoverExpiredOccurrenceLeases`) calls this AFTER reclaiming an expired
 * lease via `reacquireExpiredOccurrenceLeaseWithClient`. The occurrence is
 * already `publishing` under the reclaimed lease — the resume SKIPS the
 * `reserved → publishing` CAS (STEP 1 of {@link publishInlineScheduledOccurrence})
 * + re-drives STEPS 2-8 (the shared {@link runInlineOccurrencePublicationBody})
 * under the reclaimed owner.
 *
 * Mirrors `resumeScheduledOccurrencePublication` from the templateId path
 * 1:1. The recovery worker routes by schedule shape: templateId set →
 * templateId resume; inline (null templateId + non-empty tasksTemplate) →
 * THIS function. (Recovery routing is T11 / a T9B amendment.)
 *
 * DORMANT: no production caller until T11. The recovery worker is the
 * sole caller.
 */
export interface ResumeInlineScheduledOccurrenceInput {
  /** The `publishing` occurrence whose expired lease was reclaimed. */
  occurrenceId: string;
  /**
   * The reclaimed lease owner (the recovery worker's identity). MUST match
   * the occurrence row's `leaseOwner`. The participant's fenced
   * terminalization checks this owner.
   */
  leaseOwner: string;
}

/**
 * The resume result envelope. Narrows {@link PublishInlineScheduledOccurrenceOutcome}
 * by EXCLUDING `already_publishing` (impossible on the resume — the
 * `reserved → publishing` CAS is skipped) + adding `not_owner` (the caller
 * doesn't hold the lease — a data anomaly if the recovery worker just
 * reclaimed). The resume NEVER returns `already_publishing`.
 */
export type ResumeInlineScheduledOccurrenceOutcome =
  | Exclude<PublishInlineScheduledOccurrenceOutcome, { outcome: "already_publishing" }>
  | { outcome: "not_owner"; occurrence: ScheduledOccurrenceRow };

/**
 * T9B Phase 2 — resumes a `publishing` inline occurrence's publication
 * under a reclaimed lease. Mirrors `resumeScheduledOccurrencePublication`
 * 1:1 with the inline body substituted. DORMANT.
 */
export function resumeInlineScheduledOccurrencePublication(
  input: ResumeInlineScheduledOccurrenceInput,
): ResumeInlineScheduledOccurrenceOutcome {
  const db = getDb();

  // ----- 0. RE-READ THE OCCURRENCE (post-reclaim) -------------------------
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
    // between the reclaim + this re-read.
    return { outcome: "not_owner", occurrence };
  }

  // ----- STEPS 2-8: shared publication body (initial + resume) ------------
  return runInlineOccurrencePublicationBody(db, occurrence, input.leaseOwner);
}

// ---------------------------------------------------------------------------
// Type narrowing helper for read consumers (T11 status surface, audit
// projections). The OccurrenceResultJson column is a loose
// `Record<string, unknown>` (additive writers layer retryHistory /
// reclaimCount / etc.); this helper narrows the SUCCESS branch by the
// `kind: "aggregate_published"` discriminator (T9A-10 M1's additive field).
// ---------------------------------------------------------------------------

/**
 * Narrows an {@link OccurrenceResultJson} to its
 * `kind: "aggregate_published"` success shape when present. Returns `null`
 * for any other shape (failure branches carrying `reason`, the recovery
 * worker's intermediate reclaim-counter JSON, repair's spread-with-
 * retryHistory, etc.). Read consumers (T11 status surface) use this to
 * discriminate without forcing a refactor of the additive writers.
 *
 * Additive (T9A-10 M1); future M2 will add a parallel
 * `asHandlerDispatched` narrows for the `kind: "handler_dispatched"`
 * success shape.
 */
export function asInlineAggregatePublishedResult(result: OccurrenceResultJson | null | undefined): {
  kind: "aggregate_published";
  missionId: string;
  taskCount: number;
  attemptIds: readonly string[];
  coordinationAttemptId: string | null;
  publishedAt: string;
} | null {
  if (!result || typeof result !== "object") return null;
  if (result.kind !== "aggregate_published") return null;
  // Defensive shallow validation — the writer is `buildOccurrenceRecordParticipant`
  // (trusted server-side); a malformed row would be a data anomaly. Treat
  // any malformed shape as "not this kind" rather than crashing.
  if (
    typeof (result as { missionId?: unknown }).missionId !== "string" ||
    typeof (result as { taskCount?: unknown }).taskCount !== "number" ||
    !Array.isArray((result as { attemptIds?: unknown }).attemptIds) ||
    typeof (result as { publishedAt?: unknown }).publishedAt !== "string"
  ) {
    return null;
  }
  const coordinationAttemptId = (result as { coordinationAttemptId?: unknown })
    .coordinationAttemptId;
  return {
    kind: "aggregate_published",
    missionId: (result as { missionId: string }).missionId,
    taskCount: (result as { taskCount: number }).taskCount,
    attemptIds: (result as { attemptIds: string[] }).attemptIds,
    coordinationAttemptId: typeof coordinationAttemptId === "string" ? coordinationAttemptId : null,
    publishedAt: (result as { publishedAt: string }).publishedAt,
  };
}
