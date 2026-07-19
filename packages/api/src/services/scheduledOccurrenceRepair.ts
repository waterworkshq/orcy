/**
 * Scheduled Occurrence Repair-and-Retry — T9B Phase 3 (DORMANT).
 *
 * The authorized retry publication path for a TERMINAL `rejected` occurrence.
 * Composes the milestone-1 aggregate publisher with a retry-history stamp
 * participant — DOES NOT transition the occurrence ROW state (the terminal
 * one-way door holds). DORMANT until T11 (the retry route is dormant behind
 * the same cutover flag as the other creation-publication mutation routes).
 *
 * # The load-bearing design question (terminal-state retry navigation)
 *
 * The occurrence is `rejected` (terminal — `markOccurrencePublishingWithClient`
 * refuses every further state transition). The plan (`technical-plan:344`)
 * requires the retry to "create a new attempt linked to the same occurrence"
 * + "preserve the original `scheduledFor`/ordinal." Three options were
 * considered (see the ticket's Phase-3 section for the full design question):
 *
 *   (a) Add a new state-machine edge `rejected → reserved` for retry —
 *       breaks the terminal one-way door (a terminal state would no longer
 *       be terminal). REJECTED.
 *   (b) The retry's publication lives in NEW attempt rows + a
 *       `result.retryHistory` stamp on the rejected occurrence's `result`
 *       JSON, NO occurrence-state transition. The occurrence stays
 *       `rejected`; the retry's Mission is a real Mission linked via the
 *       retryHistory stamp + the per-Task attempts. CHOSEN.
 *   (c) The retry creates a new occurrence row — violates the UNIQUE index
 *       on `(scheduledTaskId, scheduledFor)` (the retry MUST preserve the
 *       original `scheduledFor` for token consistency). REJECTED.
 *
 * (b) preserves the terminal one-way door (the plan's invariant) AND
 * preserves the original `scheduledFor`/ordinal (the plan's token-
 * consistency requirement) AND creates a real Mission (the plan's "new
 * attempt" requirement). The retryHistory stamp is the audit trail that
 * links the Mission to the rejected occurrence.
 *
 * # The retryHistory stamp mechanism
 *
 * The stamp is an additive JSON array on the occurrence's existing `result`
 * column (NO schema change). Each retry appends one entry:
 *
 * ```ts
 * {
 *   retryNumber: 1,
 *   outcome: "repaired" | "retry_failed_vetoed"
 *         | "retry_failed_validation" | "retry_failed_schedule_missing",
 *   attemptedAt: "<ISO>",
 *   actorId: "<id>",                 // the operator who triggered the retry
 *   missionId?: "<id>",              // present on "repaired"
 *   vetoes?: [...],                  // present on "retry_failed_vetoed"
 *   errors?: [...],                  // present on "retry_failed_validation"
 *   message?: "...",                 // present on "retry_failed_schedule_missing"
 * }
 * ```
 *
 * The retryNumber is derived from the prior `result.retryHistory` length
 * (+1) — a failed stamp tx (rare) leaves the prior retryHistory unchanged,
 * so the next retry re-derives the same retryNumber (no orphan gap). Prior
 * failure history (the original `result.reason` + earlier retryHistory
 * entries) is retained — the stamp is APPEND-ONLY.
 *
 * # The two stamp sites
 *
 *   - **Success (`repaired`)** — the stamp runs INSIDE the milestone-1
 *     publication tx via the {@link buildRetryHistoryParticipant stamp
 *     participant}. The Mission + Tasks + Workflow + usage + retryHistory
 *     stamp ALL commit atomically. A participant throw rolls back
 *     everything (zero orphan Mission linked to a missing retryHistory
 *     entry, zero retryHistory entry without a Mission).
 *   - **Failure (`retry_failed_*`)** — the stamp runs in a SEPARATE small
 *     tx AFTER the publish call returns the failure branch. The publish
 *     call did NOT open its tx (vetoed / rejected_validation fire BEFORE
 *     the tx; schedule_missing fires BEFORE the publish call). The stamp
 *     tx commits independently — the audit trail records the retry
 *     attempt's outcome even when no Mission was created.
 *
 * Resumable outcomes (`retry_guard_mismatch` / `retry_governance_denied` /
 * `retry_schedule_guard_mismatch` / `retry_schedule_vanished_mid_tx`) NOW
 * STAMP (T9B-05) — the retry terminalizes its coordination + per-Task
 * attempts as `batch_rejected` + advances the retryNumber, so the next
 * retry uses a fresh slot (the operator re-calls under N+2). Pre-T9B-05
 * the resumable outcomes did not stamp + the pending coordination blocked
 * re-calls; the stamp-on-resumable discipline keeps the retryHistory + the
 * coordination attempt lifecycle in sync.
 *
 * The concurrency-defense outcomes (`retry_in_progress` /
 * `retry_already_completed` / `retry_concurrent_conflict`) do NOT stamp —
 * the retry did not reach a conclusion (another caller is mid-flight OR
 * already concluded). The operator re-calls (the next retry re-derives a
 * fresh retryNumber if the in-flight call concluded).
 *
 * # Composition (T9A-milestone-1 consumer contract — adapted for retry)
 *
 *   1. RE-READ the rejected occurrence (must be `rejected`). A non-rejected
 *      occurrence refuses the retry (`illegal_source_state`).
 *   2. RE-READ the LATEST schedule (NOT the occurrence's reservation-time
 *      snapshot — the retry uses the CORRECTED schedule/template/governance;
 *      that's the point of repair). A missing schedule → terminal retry
 *      failure stamp (`retry_failed_schedule_missing`).
 *   3. RESOLVE `{{date}}/{{counter}}` tokens via the occurrence's preserved
 *      `scheduledFor` + `ordinal` (token consistency — T9A-06's durable-
 *      timestamp discipline; a retry days after the original firing renders
 *      the SAME date/counter under the same attempt keys).
 *   4. DERIVE retryNumber from the prior `result.retryHistory` length (+1).
 *   5. PREPARE via `prepareTemplateAggregate` using the LATEST schedule's
 *      templateId + habitatId + the rendered title/description/priority/
 *      labels. A `rejected_validation` → terminal retry failure stamp.
 *   6. RESERVE N per-Task attempts with retry-scoped keys
 *      `occurrence-retry-${retryNumber}-${templateId}-${i}` under the same
 *      `sourceScopeId = occurrence.id` (DISTINCT from the original
 *      publication's attempts, which are terminal; the retryNumber
 *      discriminator guarantees retry-to-retry uniqueness too).
 *   7. PUBLISH via `publishTemplateAggregateWithClient` with the
 *      {@link buildRetryHistoryParticipant retry-history stamp participant}
 *      (NOT the {@link buildOccurrenceRecordParticipant occurrence-state-
 *      transition participant} — the occurrence stays `rejected`; no
 *      `markOccurrencePublishedWithClient` call inside the tx).
 *   8. MAP the milestone-1 outcome + stamp retryHistory for the terminal
 *      failure branches (vetoed). The success stamp is in-tx (step 7);
 *      resumable branches do NOT stamp.
 *
 * # Token resolution + fingerprint (inlined, NOT imported)
 *
 * `substituteTokens` + `computeOccurrenceFingerprint` are inlined here
 * (NOT imported from `scheduledOccurrencePublication`) for the same
 * layering discipline Phase 3 adopted: avoid pulling the publication
 * module's load graph + to keep the retry path self-contained (the
 * publisher is the precedent, not a dependency). The retry composes the
 * SAME milestone-1 kernel (`publishTemplateAggregateWithClient`) — the
 * token + fingerprint helpers are leaf utilities either module can inline.
 *
 * # Why a new module (the structural analog of the recovery worker)
 *
 * `scheduledOccurrenceRecovery.ts` (T9B Phase 2) is the structural
 * precedent: a DORMANT retry/recovery module that composes the publisher
 * + adds retry-specific concerns (the lease reclaim + circuit-breaker
 * there; the retryHistory stamp + the latest-schedule re-read here). The
 * retry is a distinct flow from the initial publication + the resume — it
 * starts from a TERMINAL state + uses NEW attempt keys + records its
 * outcome in an additive JSON stamp. Keeping it in its own module keeps
 * each flow self-documenting.
 *
 * # Dormancy
 *
 * The retry route (`POST /scheduled-occurrences/:id/retry`) is the sole
 * caller. The route is dormant behind `isCreationPublicationEnabled`
 * (consistent with the other cutover-gated surfaces — the retry creates
 * POST_CUTOVER state via the milestone-1 publisher). No production caller
 * until T11 (the cutover ticket).
 *
 * See: the T9B ticket (Phase 3 — active scope); the technical plan
 * (§ "Scheduled Mission occurrence" — the `POST /scheduled-occurrences/:id/retry`
 * repair contract); the milestone-1 publisher
 * (`templateAggregatePublication.ts`); the Phase-3 publisher
 * (`scheduledOccurrencePublication.ts` — the precedent this mirrors); the
 * recovery worker (`scheduledOccurrenceRecovery.ts` — the structural
 * analog).
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { scheduledOccurrences, scheduledTasks } from "../db/schema/index.js";
import {
  getOccurrenceWithClient,
  type ScheduledOccurrenceRow,
  type ScheduledOccurrenceState,
  type OccurrenceResultJson,
} from "../repositories/scheduledOccurrences.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type AttemptTerminalResult,
  type TaskPublicationDbClient,
} from "../repositories/taskPublication.js";
import {
  prepareTemplateAggregate,
  type PrepareTemplateAggregateContext,
} from "./templateAggregatePreparation.js";
import {
  publishTemplateAggregateWithClient,
  type TemplateAggregateParticipantWriter,
  type PublishTemplateAggregateOutcome,
  type CommittedMission,
  type CommittedWorkflow,
} from "./templateAggregatePublication.js";
import {
  diffScheduleGuard,
  ScheduleGuardMismatch,
  ScheduleVanishedMidTx,
} from "./scheduledOccurrencePublication.js";

/**
 * The veto summary shape (mirrors the milestone-1 publisher's
 * `PublishTemplateAggregateOutcome.vetoed.vetoes` element shape). Inlined
 * here (rather than reaching into the conditional type) so the
 * retryHistory entry's `vetoes` field is a concrete type.
 */
type RetryVetoEntry = {
  taskIndex: number;
  veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
};
import type { CommittedPublication } from "./taskPublicationCoordinator.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import type { PublicationError } from "./taskPublicationPreparation.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types the envelope carries)
// ---------------------------------------------------------------------------

export type {
  ScheduledOccurrenceRow,
  ScheduledOccurrenceState,
  OccurrenceResultJson,
} from "../repositories/scheduledOccurrences.js";
export type { CommittedPublication } from "./taskPublicationCoordinator.js";
export type { CommittedMission, CommittedWorkflow } from "./templateAggregatePublication.js";
export type { PublicationError } from "./taskPublicationPreparation.js";
export type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";

// ---------------------------------------------------------------------------
// Provenance constants (mirror the publisher — the retry shares the
// scheduler's origin channel + actor identity; the operator who triggers
// the retry is recorded in the retryHistory entry's `actorId` field)
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a scheduled-occurrence retry. Matches the
 * publisher's {@link SCHEDULE_ACTOR_ID} — the retry is structurally a
 * scheduled-occurrence publication (the Mission is attributed to the
 * scheduler; the operator who triggered the retry is recorded in the
 * retryHistory stamp's `actorId`, NOT in the Mission's `createdBy`).
 */
const REPAIR_ACTOR_ID = "scheduler";

/**
 * The origin channel for a retry. Matches the publisher's
 * {@link SCHEDULE_AUDIT_SOURCE} — the retry is structurally a scheduled-
 * occurrence publication (same `AuditSource` enum value; the operator
 * trigger is recorded in the retryHistory stamp).
 */
const REPAIR_AUDIT_SOURCE: AuditSource = "scheduler";

/**
 * The causal-root type for a retry. Same as the publisher's
 * `OCCURRENCE_CAUSAL_ROOT_TYPE` — the retry belongs to the same occurrence
 * (the occurrence id is the root). A fresh root per retry is NOT minted
 * (the retry is causally anchored to the occurrence, not a new tick).
 */
const OCCURRENCE_CAUSAL_ROOT_TYPE = "scheduled_occurrence";

/**
 * The attempt-reservation scope kind. Same as the publisher's
 * `OCCURRENCE_SCOPE_KIND` — the retry's per-Task attempts share the
 * occurrence scope (`sourceScopeId = occurrence.id`); the retryNumber-
 * scoped `attemptKey` discriminates retry attempts from the original
 * publication's attempts + from prior retry attempts.
 */
const OCCURRENCE_SCOPE_KIND = "scheduled_occurrence";

// ---------------------------------------------------------------------------
// Token resolution (inlined — mirrors the publisher's discipline)
// ---------------------------------------------------------------------------

/**
 * Replaces `{{date}}` (YYYY-MM-DD in the schedule's timezone) and
 * `{{counter}}` tokens. Inlined here (NOT imported from
 * `scheduledOccurrencePublication`) to keep the retry path self-contained
 * (the publisher is the precedent, not a dependency). The retry MUST use
 * the occurrence's preserved `scheduledFor` instant (T9A-06 — a retry
 * days after the original firing renders the SAME date so the fingerprint
 * is stable under the same rendered payload).
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
// Request fingerprint (inlined — mirrors the publisher's discipline)
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
 * Computes the canonical request fingerprint for a retry's per-Task
 * attempts. Covers the RENDERED payload (token-substituted mission title
 * + description + priority + labels) + the templateId + the occurrence id
 * + the retryNumber (the retry discriminator — a same-occurrence retry
 * with the same rendered content under a DIFFERENT retryNumber produces a
 * different fingerprint, which is acceptable because each retry uses a
 * distinct `attemptKey` set; the fingerprint is the per-attempt dedup key
 * under the retryNumber-scoped key, NOT across retries).
 */
function computeRetryFingerprint(input: {
  occurrenceId: string;
  templateId: string;
  retryNumber: number;
  resolvedTitle: string;
  resolvedDescription: string;
  priority: string;
  labels: readonly string[];
}): string {
  const payload = {
    templateId: input.templateId,
    occurrenceId: input.occurrenceId,
    retryNumber: input.retryNumber,
    title: input.resolvedTitle,
    description: input.resolvedDescription,
    priority: input.priority,
    labels: [...input.labels].sort(),
  };
  return "scheduled_occurrence_retry:" + stableHash(stableStringify(payload));
}

// ---------------------------------------------------------------------------
// Coordination fingerprint (T9B-05 — the retry-claim identity)
// ---------------------------------------------------------------------------

/**
 * Computes the coordination attempt's request fingerprint (T9B-05). This is
 * DISTINCT from the per-Task {@link computeRetryFingerprint} — the coordination
 * is the retry-CLAIM identity (one per occurrence per retryNumber), NOT the
 * publication fingerprint. It is SCHEDULE-INDEPENDENT (the claim defends the
 * retry slot, not the rendered payload): two concurrent callers racing the
 * same occurrence at the same retryNumber produce the SAME coordination
 * fingerprint regardless of schedule state → the loser gets `replayed` (a
 * typed outcome, NOT the `PublicationCheckpointConsistencyError` 500 that the
 * unguarded race produced). A `rejected_fingerprint` here means the retryNumber
 * collided with a PRIOR retry under a different claim (a data anomaly — the
 * retryNumber derivation should guarantee uniqueness).
 */
function computeRetryCoordinationFingerprint(input: {
  occurrenceId: string;
  retryNumber: number;
}): string {
  return `scheduled_occurrence_retry_coordination:${input.occurrenceId}:${input.retryNumber}`;
}

// ---------------------------------------------------------------------------
// Schedule snapshot for the in-tx guard (T9B-04)
// ---------------------------------------------------------------------------

/**
 * Wraps a live schedule row as a {@link ScheduleRevisionJson}-shaped snapshot
 * suitable for the composed {@link diffScheduleGuard} (T9B-04). The retry does
 * NOT have a reservation-time snapshot (it re-reads the LATEST schedule), so
 * there is no `_expectedPostReservation` from a prior reservation tx. Instead
 * the retry synthesizes one from the SAME live row it just read: the expected
 * post-reservation operational state IS the pre-read state (the retry does not
 * advance the schedule or mutate `enabled`). This makes
 * {@link diffScheduleOperational} compare the in-tx re-read against the pre-
 * read operational state:
 *
 *   - `enabled` — unconditional compare (a user disable between the retry's
 *     pre-read + the tx fires the guard).
 *   - `nextRunAt` — gated by `runCount`: a concurrent reservation's advance
 *     (`runCount` delta) is ALLOWED (the retry doesn't own the schedule's
 *     advance); a user reschedule (`runCount` unchanged, `nextRunAt` changed)
 *     fires the guard.
 *
 * This mirrors the Phase-3 publisher's two-layer guard (pre-check + in-tx
 * re-check) without the reservation-time `_expectedPostReservation` (the retry
 * has no reservation). The {@link diffScheduleConfig} half is unchanged: the
 * user-authored config fields are compared directly.
 */
function buildRetryScheduleSnapshot(
  schedule: typeof scheduledTasks.$inferSelect,
): Record<string, unknown> {
  return {
    ...schedule,
    _expectedPostReservation: {
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      runCount: schedule.runCount,
    },
  };
}

// ---------------------------------------------------------------------------
// retryHistory stamp shape (additive on the occurrence's `result` JSON)
// ---------------------------------------------------------------------------

/**
 * One entry in the occurrence's `result.retryHistory` array. Each entry
 * records one retry attempt's terminal outcome (success or failure).
 * Resumable outcomes (`retry_guard_mismatch` / `retry_governance_denied`) now
 * stamp too (T9B-05): a resumable retry terminalizes its coordination + per-
 * Task attempts as `batch_rejected` + advances the retryNumber, so the next
 * retry uses a fresh slot (the operator re-calls under N+2, not the same N+1
 * — the retryHistory records the resumable attempt as a concluded entry).
 *
 * The shape is additive — the original `result.reason` / `result.vetoes`
 * / `result.errors` (from the initial publication's failure) is retained;
 * the retryHistory array accumulates alongside.
 */
export interface RetryHistoryEntry {
  /** 1-based retry number (prior retryHistory length + 1). */
  retryNumber: number;
  /**
   * The retry's terminal outcome. Matches the corresponding
   * {@link RepairScheduledOccurrenceOutcome}'s `outcome` discriminator
   * (minus the `retry_` prefix on the failure branches for brevity in
   * the JSON).
   */
  outcome:
    | "repaired"
    | "retry_failed_vetoed"
    | "retry_failed_validation"
    | "retry_failed_schedule_missing"
    | "retry_guard_mismatch"
    | "retry_governance_denied"
    | "retry_schedule_guard_mismatch"
    | "retry_schedule_vanished_mid_tx";
  /** ISO timestamp the retry was attempted. */
  attemptedAt: string;
  /** The operator who triggered the retry (the route's authenticated admin). */
  actorId: string;
  /** Present on `repaired` — the Mission the retry committed. */
  missionId?: string;
  /** Present on `retry_failed_vetoed` — the decisive vetoes (one per vetoed Task). */
  vetoes?: ReadonlyArray<RetryVetoEntry>;
  /** Present on `retry_failed_validation` — the validation errors. */
  errors?: PublicationError[];
  /** Present on `retry_failed_schedule_missing` — a diagnostic message. */
  message?: string;
  /** Present on `retry_guard_mismatch` / `retry_schedule_guard_mismatch` — the drifted fields. */
  guardFields?: readonly string[];
  /** Present on `retry_guard_mismatch` — the taskIndex whose guard drifted. */
  taskIndex?: number;
  /** Present on `retry_governance_denied` — the denial kind + reason. */
  denialKind?: string;
  denialReason?: string;
}

/**
 * Reads the prior retryHistory from the occurrence's `result` JSON. Returns
 * an empty array when the result is missing, null, lacks a `retryHistory`
 * array, or the array is malformed (defensive — production occurrences
 * carry well-formed JSON post-publication).
 */
function readRetryHistory(result: OccurrenceResultJson | null): RetryHistoryEntry[] {
  if (!result) return [];
  const raw = (result as { retryHistory?: unknown }).retryHistory;
  if (!Array.isArray(raw)) return [];
  // Defensive: filter to well-formed entries (a malformed entry is ignored;
  // the retryNumber re-derivation is based on the WELL-FORMED count).
  return raw.filter(
    (e): e is RetryHistoryEntry =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as RetryHistoryEntry).retryNumber === "number" &&
      typeof (e as RetryHistoryEntry).outcome === "string" &&
      typeof (e as RetryHistoryEntry).attemptedAt === "string" &&
      typeof (e as RetryHistoryEntry).actorId === "string",
  );
}

// ---------------------------------------------------------------------------
// The retry-history stamp participant (the success-path in-tx hook)
// ---------------------------------------------------------------------------

/**
 * Builds the retry-history stamp participant — the in-tx hook that:
 *   1. (T9B-04) RE-CHECKS the schedule guard in-tx (race-safe against a
 *      schedule edit/delete/switch between the retry's pre-read + the tx).
 *   2. (T9B-05) TERMINALIZES the retry-coordination attempt
 *      (`pending → published_pending_observation → created`) IN-TX, atomic
 *      with the aggregate + the retryHistory stamp.
 *   3. Stamps the `repaired` entry on the occurrence's `result.retryHistory`
 *      array INSIDE the milestone-1 publication tx.
 *
 * Atomic with the Mission + Tasks + Workflow + usage writes: either ALL
 * commit (the Mission + the coordination terminal + the retryHistory stamp),
 * or NONE do (a participant throw rolls back everything).
 *
 * # T9B-04 — the in-tx schedule guard
 *
 * The retry re-reads the LATEST schedule at the start (a pre-read, step 2 of
 * the adapter) + uses it to prepare the aggregate. WITHOUT the in-tx re-check,
 * a schedule edit/delete/switch between the pre-read + the tx → the stale
 * prepared aggregate commits + is stamped `repaired` (the T9A-01 analog for
 * the retry). The participant re-reads the schedule on the tx client + diffs
 * via the composed {@link diffScheduleGuard} (reused from the Phase-3 publisher).
 * On drift → throw {@link ScheduleGuardMismatch}; on missing live row → throw
 * {@link ScheduleVanishedMidTx}. Both sentinels roll back the whole aggregate;
 * the outer catch in {@link repairScheduledOccurrence} maps them to the typed
 * `retry_schedule_guard_mismatch` / `retry_schedule_vanished_mid_tx` outcomes.
 *
 * The snapshot is a LIVE-row dump synthesized via {@link buildRetryScheduleSnapshot}
 * (with a synthetic `_expectedPostReservation` matching the live row's own
 * operational fields — see the helper's doc for the gating semantics).
 *
 * # Why the participant does NOT transition the occurrence ROW state
 *
 * The occurrence is `rejected` (terminal — the state machine is forward-
 * only). The plan's load-bearing claim is that the terminal one-way door
 * holds. The retry's publication therefore lives in NEW attempt rows + a
 * retryHistory stamp on the EXISTING `result` JSON column — NO state
 * transition. The stamp is a conditional UPDATE on `id AND state='rejected'`
 * that appends to the `result` JSON's `retryHistory` array.
 *
 * @param occurrenceId          The rejected occurrence to stamp.
 * @param retryNumber           The retry number (prior retryHistory length + 1).
 * @param scheduleSnapshot      The schedule snapshot (live row + synthetic
 *   `_expectedPostReservation`) for the in-tx guard.
 * @param coordinationAttemptId The retry-coordination attempt id (terminalized
 *   to `created` in-tx on success).
 * @param actorId               The operator who triggered the retry.
 * @returns the {@link TemplateAggregateParticipantWriter} the retry passes
 *   to `publishTemplateAggregateWithClient`.
 */
function buildRetryHistoryParticipant(
  occurrenceId: string,
  retryNumber: number,
  scheduleSnapshot: Record<string, unknown>,
  coordinationAttemptId: string,
  actorId: string,
): TemplateAggregateParticipantWriter {
  return (db, ctx) => {
    // --- 1. IN-TX SCHEDULE GUARD (T9B-04) ------------------------------
    // Re-read the live schedule on the tx client + diff against the snapshot
    // captured at the retry's pre-read. A drift (edit/delete/switch) between
    // the pre-read + the tx throws a sentinel → the whole aggregate rolls
    // back → the outer catch maps to `retry_schedule_guard_mismatch` /
    // `retry_schedule_vanished_mid_tx`.
    const scheduleId = scheduleSnapshot.id as string;
    const liveSchedule = db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, scheduleId))
      .get();
    if (!liveSchedule) {
      // T9A-07 analog: the schedule vanished between the retry's pre-read +
      // the in-tx re-read. Throw the sentinel → rollback → resumable outcome.
      throw new ScheduleVanishedMidTx(scheduleId);
    }
    const drifted = diffScheduleGuard(
      scheduleSnapshot,
      liveSchedule as unknown as Record<string, unknown>,
    );
    if (drifted) {
      throw new ScheduleGuardMismatch(drifted);
    }

    // --- 2. OCCURRENCE-STATE INVARIANT (defensive) ---------------------
    // Read the current occurrence row (in-tx) to get the existing `result`
    // JSON. The occurrence MUST still be `rejected` (terminal — no
    // transitioned-out path exists, but defensive).
    const current = db
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.id, occurrenceId))
      .get();
    if (!current) {
      throw new Error(
        `repairScheduledOccurrence: occurrence "${occurrenceId}" vanished inside the publication tx — the aggregate will roll back.`,
      );
    }
    if (current.state !== "rejected") {
      throw new Error(
        `repairScheduledOccurrence: occurrence "${occurrenceId}" transitioned out of "rejected" (now "${current.state}") inside the publication tx — the aggregate will roll back.`,
      );
    }

    // --- 3. COORDINATION ATTEMPT TERMINAL (T9B-05) ---------------------
    // Advance the retry-coordination attempt
    // `pending → published_pending_observation → created` IN-TX, atomic with
    // the aggregate + the retryHistory stamp. The matrix forbids
    // `pending → created` directly, so the advance is two CAS operations
    // back-to-back (mirrors the Phase-3 publisher's participant). A
    // `rejected_transition` is a data anomaly — throw to roll back.
    const checkpoint = checkpointAttemptWithClient(db, coordinationAttemptId, {
      stage: "published_pending_observation",
    });
    if (checkpoint.outcome === "rejected_transition") {
      throw new Error(
        `repairScheduledOccurrence: coordination attempt "${coordinationAttemptId}" refused the pending → published_pending_observation checkpoint (fromState: ${checkpoint.fromState}) inside the publication tx — the aggregate will roll back.`,
      );
    }
    const completion = completeAttemptWithClient(db, coordinationAttemptId, {
      finalState: "created",
      terminalOutcome: "created",
      terminalResult: {
        outcome: "created",
        attemptId: coordinationAttemptId,
        publication: {
          retryNumber,
          missionId: ctx.mission.id,
          taskCount: ctx.tasks.length,
          attemptIds: ctx.attemptIds,
        },
      },
    });
    if (completion.outcome === "rejected_transition") {
      throw new Error(
        `repairScheduledOccurrence: coordination attempt "${coordinationAttemptId}" refused the published_pending_observation → created completion (fromState: ${completion.fromState}) inside the publication tx — the aggregate will roll back.`,
      );
    }

    // --- 4. retryHistory STAMP (`repaired`) ----------------------------
    // Append the `repaired` entry to the retryHistory array. Conditional
    // UPDATE `WHERE id AND state='rejected'`. The CAS catches a concurrent
    // state drift (impossible since `rejected` is terminal, but race-safe).
    const priorResult = (current.result ?? {}) as OccurrenceResultJson;
    const priorHistory = readRetryHistory(priorResult);
    const newEntry: RetryHistoryEntry = {
      retryNumber,
      outcome: "repaired",
      attemptedAt: new Date().toISOString(),
      actorId,
      missionId: ctx.mission.id,
    };
    const stampedResult: OccurrenceResultJson = {
      ...priorResult,
      retryHistory: [...priorHistory, newEntry],
    };
    let affected: number;
    try {
      db.update(scheduledOccurrences)
        .set({ result: stampedResult, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(scheduledOccurrences.id, occurrenceId),
            eq(scheduledOccurrences.state, "rejected"),
          ),
        )
        .run();
      affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    } catch (err) {
      throw new Error(
        `repairScheduledOccurrence: failed to stamp retryHistory on occurrence "${occurrenceId}" inside the publication tx — the aggregate will roll back. Cause: ${(err as Error).message}`,
      );
    }
    if (affected !== 1) {
      throw new Error(
        `repairScheduledOccurrence: occurrence "${occurrenceId}" CAS-missed the retryHistory stamp (state drifted mid-tx) — the aggregate will roll back.`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Failure-path stamp helper (vetoed / validation / schedule_missing)
// ---------------------------------------------------------------------------

/**
 * Stamps a failure/resumable entry on the occurrence's `result.retryHistory`
 * array in a SEPARATE small tx, OPTIONALLY terminalizing the retry's
 * coordination attempt + per-Task attempts IN THE SAME TX (T9B-05 + T9B-06).
 *
 * Used by the retry's failure paths (vetoed, rejected_validation,
 * schedule_missing) + the resumable paths (guard_mismatch, governance_denied)
 * where the milestone-1 publish call did NOT open its tx (so the in-tx
 * participant did not run). The coordination + per-Task attempts were reserved
 * BEFORE the publish call; without terminalization here they would stay
 * `pending` forever (the T9A-05 / T9B-06 orphan-attempts defect).
 *
 * # T9B-06 — vetoed-path attempt terminalization
 *
 * On the `retry_failed_vetoed` path, `terminals.perTaskAttemptTerminals`
 * carries one entry per reserved per-Task attempt:
 *   - Vetoed taskIndexes → terminal `vetoed` (the decisive veto).
 *   - Allowed-but-unpublished taskIndexes → terminal `batch_rejected`
 *     (collateral — the aggregate didn't publish).
 * The coordination → terminal `vetoed`. All terminalize IN THE SAME tx as the
 * failure-stamp (atomic — mirrors the Phase-3 publisher's
 * `terminalRejectOccurrenceWithCoordination` helper).
 *
 * # Resumable-path attempt terminalization
 *
 * On the `retry_guard_mismatch` / `retry_governance_denied` paths, the
 * per-Task + coordination attempts stay `pending` after the tx rollback.
 * T9B-05: these are terminalized as `batch_rejected` + the retryHistory
 * stamps the resumable outcome → the retryNumber advances → the next retry
 * uses a fresh slot (the operator re-calls under N+2).
 *
 * The stamp tx commits independently — the audit trail records the retry
 * attempt's outcome even when no Mission was created. A CAS miss (state
 * drift) is logged + ignored (the occurrence is no longer `rejected` — a
 * data anomaly; the failure stamp is best-effort on the failure paths).
 *
 * Returns the re-read occurrence row (reflects the stamp if it committed,
 * or the prior row if the CAS missed).
 *
 * @param occurrence  The rejected occurrence to stamp.
 * @param entry       The retryHistory entry (failure or resumable outcome).
 * @param terminals   Optional attempt terminalization (coordination + per-Task),
 *   atomic with the stamp. Omitted for the paths where the coordination was
 *   not reserved (schedule_missing fires before the coordination reservation).
 */
function stampFailureRetryHistory(
  occurrence: ScheduledOccurrenceRow,
  entry: RetryHistoryEntry,
  terminals?: {
    coordinationAttemptId: string;
    coordinationFinalState: "vetoed" | "batch_rejected" | "rejected_validation";
    coordinationTerminalOutcome: string;
    coordinationTerminalResult: AttemptTerminalResult;
    perTaskAttemptTerminals?: ReadonlyArray<{
      attemptId: string;
      finalState: "vetoed" | "batch_rejected";
      terminalOutcome: string;
      terminalResult: AttemptTerminalResult;
    }>;
  },
): ScheduledOccurrenceRow {
  const db = getDb();
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.id, occurrence.id))
      .get();
    if (!current) return occurrence; // vanished (data anomaly) — return the prior row.
    if (current.state !== "rejected") return current; // state drift — return the current row.

    // 1. Terminalize the coordination attempt (when supplied). The matrix
    //    allows `pending → vetoed | batch_rejected | rejected_validation`
    //    directly. Idempotent: `completeAttemptWithClient`'s terminal-replay
    //    fast path returns `no_op` for an already-terminal attempt.
    if (terminals !== undefined) {
      const coordinationCompletion = completeAttemptWithClient(
        tx,
        terminals.coordinationAttemptId,
        {
          finalState: terminals.coordinationFinalState,
          terminalOutcome: terminals.coordinationTerminalOutcome,
          terminalResult: terminals.coordinationTerminalResult,
        },
      );
      // A `rejected_transition` is a data anomaly (the coordination was
      // checkpointed past `pending` by a prior aggregate commit). Best-effort
      // on the failure path — log via the thrown error's propagation (the
      // stamp still proceeds; the occurrence row is the authoritative state).
      void coordinationCompletion;
    }

    // 2. Terminalize the per-Task attempts (when supplied — T9B-06 vetoed +
    //    resumable paths). Same matrix + idempotency as the coordination.
    if (terminals?.perTaskAttemptTerminals !== undefined) {
      for (const terminal of terminals.perTaskAttemptTerminals) {
        const completion = completeAttemptWithClient(tx, terminal.attemptId, {
          finalState: terminal.finalState,
          terminalOutcome: terminal.terminalOutcome,
          terminalResult: terminal.terminalResult,
        });
        void completion;
      }
    }

    // 3. Stamp the retryHistory entry (atomic with the terminalization).
    const priorResult = (current.result ?? {}) as OccurrenceResultJson;
    const priorHistory = readRetryHistory(priorResult);
    const stampedResult: OccurrenceResultJson = {
      ...priorResult,
      retryHistory: [...priorHistory, entry],
    };
    tx.update(scheduledOccurrences)
      .set({ result: stampedResult, updatedAt: new Date().toISOString() })
      .where(
        and(eq(scheduledOccurrences.id, occurrence.id), eq(scheduledOccurrences.state, "rejected")),
      )
      .run();
    const after = tx
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.id, occurrence.id))
      .get();
    return after ?? current;
  });
}

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The scheduled-occurrence retry publication command.
 *
 * The caller (the `POST /scheduled-occurrences/:id/retry` route, DORMANT
 * until T11) supplies the rejected occurrence id + the operator identity
 * (for the retryHistory stamp's audit trail). The adapter derives
 * everything else (templateId, title, schedule, attempts) from the
 * occurrence + the LIVE schedule — the input does NOT expose templateId,
 * title, scheduleRevision, attemptKey, or causalContext fields. Untrusted
 * callers cannot assert privileged publication identities.
 */
export interface RepairScheduledOccurrenceInput {
  /** The rejected occurrence to retry. */
  occurrenceId: string;
  /**
   * The operator identity (the route's authenticated admin). Recorded in
   * the retryHistory entry's `actorId` field. The Mission's `createdBy`
   * stays "scheduler" (matches the publisher's attribution — the retry is
   * structurally a scheduled-occurrence publication; the operator trigger
   * is recorded in the stamp, not the Mission row).
   */
  actorId: string;
}

// ---------------------------------------------------------------------------
// Adapter result — closed discriminated union (NEVER thrown for a decision)
// ---------------------------------------------------------------------------

/**
 * The scheduled-occurrence retry publication result envelope.
 *
 * Every branch is an origin-neutral publication outcome translated from
 * the milestone-1 {@link PublishTemplateAggregateOutcome} (plus the
 * retry-domain branches the adapter owns). The retry-domain mapping:
 *
 *   - `repaired` — the full aggregate (Mission + N Tasks + optional
 *     Workflow + usage mutation) committed atomically WITH a `repaired`
 *     entry stamped on the occurrence's `result.retryHistory` + the retry-
 *     coordination attempt terminalized to `created` in-tx. The occurrence
 *     STAYS `rejected` (the terminal one-way door holds — option (b)).
 *   - `retry_failed_vetoed` — the latest governance interceptor refused
 *     one+ Tasks BEFORE the publication tx opened. NOTHING committed (no
 *     Mission, no Tasks). A `retry_failed_vetoed` entry is stamped + the
 *     coordination + per-Task attempts are terminalized (`vetoed` /
 *     `batch_rejected`) atomically with the stamp (T9B-06). The operator
 *     can retry again (the retryNumber advances).
 *   - `retry_failed_validation` — the LATEST schedule's rendered template
 *     produced an invalid Task. A `retry_failed_validation` entry is stamped.
 *     No Mission.
 *   - `retry_failed_schedule_missing` — the schedule row vanished between
 *     the original failure + the retry. A `retry_failed_schedule_missing`
 *     entry is stamped. The operator must recreate the schedule.
 *   - `retry_schedule_guard_mismatch` — RESUMABLE (T9B-04). The schedule
 *     was EDITED between the retry's pre-read + the publication tx. The
 *     in-tx guard fired → the whole aggregate rolled back. No Mission, no
 *     stamp. The operator re-calls (the next retry re-reads the corrected
 *     schedule).
 *   - `retry_schedule_vanished_mid_tx` — RESUMABLE (T9B-04). The schedule
 *     was DELETED between the retry's pre-read + the publication tx. The
 *     in-tx guard fired → rollback. No stamp. The operator re-calls (the
 *     next retry surfaces the terminal `retry_failed_schedule_missing` if
 *     the absence persists).
 *   - `retry_guard_mismatch` — the per-Task guard drifted at publish time
 *     (inside the tx). The tx rolled back; the coordination + per-Task
 *     attempts are terminalized `batch_rejected` + a `retry_guard_mismatch`
 *     entry is stamped (T9B-05 — the retryNumber advances; the operator
 *     re-calls under a fresh slot).
 *   - `retry_governance_denied` — a stale governance decision at commit
 *     (inside the tx). Same handling as `retry_guard_mismatch` (terminalize
 *     + stamp + advance retryNumber).
 *   - `retry_in_progress` — RESUMABLE (T9B-05). A concurrent retry under
 *     the same retryNumber is mid-flight (the retry-coordination attempt is
 *     `pending` under another caller). No stamp, no terminalization (the
 *     occurrence is unchanged). The operator waits + re-calls (the next
 *     retry re-derives a fresh retryNumber if the in-flight retry concluded).
 *   - `retry_already_completed` — (T9B-05). A prior retry under the same
 *     retryNumber already concluded (the coordination attempt is terminal).
 *     The retryHistory carries the prior entry; the operator re-fetches to
 *     see the prior outcome. No stamp (the prior retry already stamped).
 *   - `retry_concurrent_conflict` — RESUMABLE (T9B-05). A concurrent retry
 *     under the same retryNumber has a DIFFERENT fingerprint (the schedule
 *     changed between the two callers' reads). No stamp. The operator
 *     re-calls.
 *   - `not_found` — no occurrence row exists for `occurrenceId`.
 *   - `illegal_source_state` — the occurrence is NOT `rejected`.
 *
 * Infrastructure failures (a repository throw) propagate as retryable
 * runtime errors EXCEPT the in-tx participant's schedule-guard sentinels
 * ({@link ScheduleGuardMismatch} / {@link ScheduleVanishedMidTx}), which
 * the outer catch maps to `retry_schedule_guard_mismatch` /
 * `retry_schedule_vanished_mid_tx` respectively. The whole aggregate rolls
 * back on any infrastructure failure (the caller's tx aborts). The
 * retryHistory stamp did NOT commit on a throw (the in-tx stamp rolled
 * back with the aggregate; the failure-stamp helper did not run).
 */
export type RepairScheduledOccurrenceOutcome =
  | {
      outcome: "repaired";
      occurrence: ScheduledOccurrenceRow;
      /** The retry number (prior retryHistory length + 1). */
      retryNumber: number;
      /** The committed Mission row. */
      mission: CommittedMission;
      /** One committed publication per Task (each POST_CUTOVER + `created` event + envelope). */
      tasks: CommittedPublication[];
      /** The committed Workflow row, or `null` when the template had no workflow. */
      workflow: CommittedWorkflow | null;
    }
  | {
      outcome: "retry_failed_vetoed";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      /** Every decisive Task-level veto (one per vetoed Task). */
      vetoes: ReadonlyArray<RetryVetoEntry>;
    }
  | {
      outcome: "retry_failed_validation";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      errors: PublicationError[];
    }
  | {
      outcome: "retry_failed_schedule_missing";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
    }
  | {
      outcome: "retry_schedule_guard_mismatch";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      /** The schedule-config fields that drifted between the pre-read + the tx. */
      fields: readonly string[];
    }
  | {
      outcome: "retry_schedule_vanished_mid_tx";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
    }
  | {
      outcome: "retry_guard_mismatch";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      taskIndex: number;
      reasons: GuardMismatchReason[];
    }
  | {
      outcome: "retry_governance_denied";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      taskIndex: number;
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
    }
  | {
      outcome: "retry_in_progress";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
    }
  | {
      outcome: "retry_already_completed";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
      /** The prior retryHistory entry for this retryNumber (re-read from the row). */
      priorEntry: RetryHistoryEntry | null;
    }
  | {
      outcome: "retry_concurrent_conflict";
      occurrence: ScheduledOccurrenceRow;
      retryNumber: number;
    }
  | {
      outcome: "illegal_source_state";
      occurrence: ScheduledOccurrenceRow;
      fromState: ScheduledOccurrenceState;
    }
  | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the milestone-1 aggregate kernel chain for an authorized retry
 * of a TERMINAL `rejected` scheduled occurrence (T9B Phase 3). DORMANT.
 *
 * The retry DOES NOT transition the occurrence ROW state — the terminal
 * one-way door holds (option (b) of the load-bearing design question; see
 * the module header). Instead, the retry:
 *   - re-reads the LATEST schedule (the corrected one);
 *   - reserves NEW per-Task attempts with retry-scoped keys;
 *   - publishes via the milestone-1 publisher with a retry-history stamp
 *     participant;
 *   - stamps a `retryHistory` entry on the occurrence's `result` JSON
 *     (atomic with the aggregate on success; in a separate small tx on
 *     failure).
 *
 * See {@link RepairScheduledOccurrenceOutcome} for the full outcome
 * vocabulary + {@link RepairScheduledOccurrenceInput} for the input
 * shape. DORMANT: no production caller until T11 (the retry route is
 * dormant behind the cutover flag).
 */
export function repairScheduledOccurrence(
  input: RepairScheduledOccurrenceInput,
): RepairScheduledOccurrenceOutcome {
  const db = getDb();

  // ----- 1. RE-READ THE REJECTED OCCURRENCE --------------------------------
  const occurrence = getOccurrenceWithClient(db, input.occurrenceId);
  if (!occurrence) return { outcome: "not_found" };
  if (occurrence.state !== "rejected") {
    return {
      outcome: "illegal_source_state",
      occurrence,
      fromState: occurrence.state as ScheduledOccurrenceState,
    };
  }

  // ----- 2. RE-READ THE LATEST SCHEDULE ------------------------------------
  const schedule = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, occurrence.scheduledTaskId))
    .get();
  if (!schedule) {
    // The schedule was deleted between the original failure + the retry.
    // Stamp `retry_failed_schedule_missing` (no coordination reserved — the
    // schedule's habitatId is unknown, so the coordination can't be reserved).
    // The duplicate-stamp risk for two concurrent schedule_missing retries is
    // accepted (rare path — the schedule is GONE; the operator must recreate).
    const retryNumber = readRetryHistory(occurrence.result).length + 1;
    const entry: RetryHistoryEntry = {
      retryNumber,
      outcome: "retry_failed_schedule_missing",
      attemptedAt: new Date().toISOString(),
      actorId: input.actorId,
      message: `Schedule "${occurrence.scheduledTaskId}" not found at retry time.`,
    };
    const stamped = stampFailureRetryHistory(occurrence, entry);
    return {
      outcome: "retry_failed_schedule_missing",
      occurrence: stamped,
      retryNumber,
    };
  }

  // ----- 3. DERIVE retryNumber ---------------------------------------------
  const retryNumber = readRetryHistory(occurrence.result).length + 1;

  // ----- 4. BUILD THE SCHEDULE SNAPSHOT (T9B-04 in-tx guard) ---------------
  // Captured BEFORE the coordination reservation (the snapshot reflects the
  // schedule state the retry's decisions are based on). The participant
  // re-reads the schedule IN-TX + diffs against this snapshot.
  const scheduleSnapshot = buildRetryScheduleSnapshot(schedule);

  // ----- 5. RESERVE THE RETRY-COORDINATION ATTEMPT (T9B-05) ---------------
  // The coordination is the concurrency-defense token (option (a) of the
  // T9B-05 design). Reserved BEFORE per-Task attempts + BEFORE the publish tx.
  // The UNIQUE index on (source, sourceScopeKind, sourceScopeId, attemptKey)
  // guarantees ONE winner per (occurrence, retryNumber); the loser gets a
  // typed outcome (NOT the PublicationCheckpointConsistencyError 500 that the
  // unguarded race produced when both callers' per-Task attempts collided).
  const actor: AuditActorRef = { type: "system", id: REPAIR_ACTOR_ID };
  const causalContext: CausalContext = {
    root: { type: OCCURRENCE_CAUSAL_ROOT_TYPE, id: occurrence.id },
  };
  const coordinationFingerprint = computeRetryCoordinationFingerprint({
    occurrenceId: occurrence.id,
    retryNumber,
  });
  const coordinationAttemptKey = `occurrence-retry-${retryNumber}-coordination`;
  const coordinationReservation = reserveAttemptWithClient(db, {
    source: REPAIR_AUDIT_SOURCE,
    sourceScopeKind: OCCURRENCE_SCOPE_KIND,
    sourceScopeId: occurrence.id,
    attemptKey: coordinationAttemptKey,
    requestFingerprint: coordinationFingerprint,
    publicationKind: "scheduled_occurrence",
    habitatId: schedule.habitatId,
    actorType: "system",
    actorId: REPAIR_ACTOR_ID,
    causalContext,
  });

  if (coordinationReservation.outcome === "replayed") {
    // Another caller reserved the same coordination (same occurrence + same
    // retryNumber). The coordination's state tells us what happened.
    const coordinationAttempt = coordinationReservation.attempt;
    if (coordinationAttempt.completedAt !== null) {
      // The coordination is TERMINAL — a prior retry under this retryNumber
      // already concluded. The retryHistory should carry the prior entry.
      // Re-read the retryHistory to surface the prior outcome.
      const reRead = getOccurrenceWithClient(db, occurrence.id) ?? occurrence;
      const priorHistory = readRetryHistory(reRead.result);
      const priorEntry = priorHistory.find((e) => e.retryNumber === retryNumber) ?? null;
      return {
        outcome: "retry_already_completed",
        occurrence: reRead,
        retryNumber,
        priorEntry,
      };
    }
    // The coordination is `pending` — another caller is mid-flight. Return
    // a typed `retry_in_progress` (resumable — the operator re-calls later;
    // the next retry re-derives a fresh retryNumber if the in-flight call
    // concluded, or the same retryNumber if it's still pending).
    return {
      outcome: "retry_in_progress",
      occurrence,
      retryNumber,
    };
  }

  if (coordinationReservation.outcome === "rejected_fingerprint") {
    // A concurrent retry under the same key has a DIFFERENT fingerprint
    // (the retryNumber collided with a prior retry under a different claim —
    // a data anomaly). Return a typed `retry_concurrent_conflict`.
    return {
      outcome: "retry_concurrent_conflict",
      occurrence,
      retryNumber,
    };
  }

  // `created` — this caller is the winner. Proceed.
  const coordinationAttemptId = coordinationReservation.attempt.id;

  // ----- 6. RESOLVE TOKENS (durable timestamp discipline — T9A-06) ---------
  const tokenContext = {
    runCount: occurrence.ordinal + 1,
    timezone: schedule.timezone ?? "UTC",
    scheduledFor: occurrence.scheduledFor,
  };
  const resolvedTitle = substituteTokens(schedule.missionTitle, tokenContext);
  const resolvedDescription = substituteTokens(schedule.missionDescription, tokenContext);

  // ----- 7. PREPARE via the milestone-1 kernel -----------------------------
  // A null templateId is a config error. A `rejected_validation` here (or from
  // the prepare) stamps a failure entry + terminalizes the coordination.
  const failValidation = (errors: PublicationError[]): RepairScheduledOccurrenceOutcome => {
    const entry: RetryHistoryEntry = {
      retryNumber,
      outcome: "retry_failed_validation",
      attemptedAt: new Date().toISOString(),
      actorId: input.actorId,
      errors,
    };
    const stamped = stampFailureRetryHistory(occurrence, entry, {
      coordinationAttemptId,
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "retry_failed_validation",
      coordinationTerminalResult: {
        outcome: "retry_failed_validation",
        attemptId: coordinationAttemptId,
        errors,
      },
    });
    return {
      outcome: "retry_failed_validation",
      occurrence: stamped,
      retryNumber,
      errors,
    };
  };

  if (!schedule.templateId) {
    return failValidation([
      { field: "templateId", code: "template_not_set", message: "Schedule has no templateId." },
    ]);
  }

  const prepareCtx: PrepareTemplateAggregateContext = {
    actor,
    auditSource: REPAIR_AUDIT_SOURCE,
    causalContext,
  };
  const prepared = prepareTemplateAggregate(
    schedule.templateId,
    schedule.habitatId,
    {
      title: resolvedTitle,
      description: resolvedDescription,
      priority: schedule.missionPriority,
      labels: schedule.missionLabels,
    },
    prepareCtx,
  );
  if (prepared.outcome === "rejected_validation") {
    return failValidation(prepared.errors);
  }

  const aggregate = prepared.aggregate;
  const taskCount = aggregate.tasks.length;

  // ----- 8. RESERVE N PER-TASK ATTEMPTS (retry-scoped keys) ----------------
  // The coordination already defended the concurrent-retry race; the per-Task
  // keys are retryNumber-scoped under the winner's slot.
  const requestFingerprint = computeRetryFingerprint({
    occurrenceId: occurrence.id,
    templateId: schedule.templateId,
    retryNumber,
    resolvedTitle,
    resolvedDescription,
    priority: schedule.missionPriority,
    labels: schedule.missionLabels,
  });

  const attemptIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    const attemptKey = `occurrence-retry-${retryNumber}-${schedule.templateId}-${i}`;
    const reservation = reserveAttemptWithClient(db, {
      source: REPAIR_AUDIT_SOURCE,
      sourceScopeKind: OCCURRENCE_SCOPE_KIND,
      sourceScopeId: occurrence.id,
      attemptKey,
      requestFingerprint,
      publicationKind: "scheduled_occurrence",
      habitatId: schedule.habitatId,
      actorType: "system",
      actorId: REPAIR_ACTOR_ID,
      causalContext,
    });

    if (reservation.outcome === "rejected_fingerprint") {
      // A data anomaly — the retryNumber discriminator + the coordination
      // defense should guarantee this is unreachable for the winner. Surface
      // as a thrown error (the coordination stays `pending` — the next retry
      // re-derives a fresh retryNumber after this throw propagates + the
      // operator re-calls).
      throw new Error(
        `repairScheduledOccurrence: retry attempt key "${attemptKey}" produced rejected_fingerprint (reserved "${reservation.reservedFingerprint}" ≠ request "${requestFingerprint}") — a retryNumber collision or a fingerprint drift. The retry aborts.`,
      );
    }

    attemptIds.push(reservation.attempt.id);
  }

  // ----- 9. PUBLISH (atomic, with the schedule-guard + coordination) -------
  // The participant: (a) re-checks the schedule guard IN-TX (T9B-04),
  // (b) terminalizes the coordination to `created` IN-TX (T9B-05),
  // (c) stamps the `repaired` retryHistory entry IN-TX. A throw (the
  // schedule-guard sentinel, the CAS-miss, or any infrastructure error)
  // rolls back the whole aggregate.
  const participants = buildRetryHistoryParticipant(
    occurrence.id,
    retryNumber,
    scheduleSnapshot,
    coordinationAttemptId,
    input.actorId,
  );

  let publishOutcome: PublishTemplateAggregateOutcome;
  try {
    publishOutcome = publishTemplateAggregateWithClient(db, {
      attemptIds,
      prepared: aggregate,
      participants,
    });
  } catch (err) {
    // T9B-04 — the in-tx schedule-guard sentinels. The whole aggregate
    // rolled back (no Mission, no Tasks, no stamp). The coordination + per-
    // Task attempts are still `pending`. Terminalize them as `batch_rejected`
    // + stamp the resumable outcome (advances retryNumber so the next retry
    // uses a fresh slot — avoids the "pending coordination blocks re-call"
    // trap). The operator re-calls; the next retry re-reads the corrected
    // schedule.
    if (err instanceof ScheduleGuardMismatch) {
      const entry: RetryHistoryEntry = {
        retryNumber,
        outcome: "retry_schedule_guard_mismatch",
        attemptedAt: new Date().toISOString(),
        actorId: input.actorId,
        guardFields: err.fields,
      };
      const stamped = stampFailureRetryHistory(occurrence, entry, {
        coordinationAttemptId,
        coordinationFinalState: "batch_rejected",
        coordinationTerminalOutcome: "retry_schedule_guard_mismatch",
        coordinationTerminalResult: {
          outcome: "retry_schedule_guard_mismatch",
          attemptId: coordinationAttemptId,
          errors: [
            {
              reason: "schedule_guard_mismatch",
              message: `Schedule drifted (fields: ${err.fields.join(", ")}) between the retry's pre-read + the publication tx.`,
            },
          ],
        },
        perTaskAttemptTerminals: attemptIds.map((attemptId) => ({
          attemptId,
          finalState: "batch_rejected" as const,
          terminalOutcome: "retry_schedule_guard_mismatch",
          terminalResult: {
            outcome: "retry_schedule_guard_mismatch",
            attemptId,
            errors: [
              {
                reason: "schedule_guard_mismatch_collateral",
                message:
                  "The aggregate rolled back on a schedule-guard mismatch; this Task was not published.",
              },
            ],
          },
        })),
      });
      return {
        outcome: "retry_schedule_guard_mismatch",
        occurrence: stamped,
        retryNumber,
        fields: err.fields,
      };
    }
    if (err instanceof ScheduleVanishedMidTx) {
      const entry: RetryHistoryEntry = {
        retryNumber,
        outcome: "retry_schedule_vanished_mid_tx",
        attemptedAt: new Date().toISOString(),
        actorId: input.actorId,
        message: `Schedule "${err.scheduleId}" vanished between the retry's pre-read + the publication tx.`,
      };
      const stamped = stampFailureRetryHistory(occurrence, entry, {
        coordinationAttemptId,
        coordinationFinalState: "batch_rejected",
        coordinationTerminalOutcome: "retry_schedule_vanished_mid_tx",
        coordinationTerminalResult: {
          outcome: "retry_schedule_vanished_mid_tx",
          attemptId: coordinationAttemptId,
          errors: [
            {
              reason: "schedule_vanished_mid_tx",
              message: `Schedule "${err.scheduleId}" vanished mid-tx.`,
            },
          ],
        },
        perTaskAttemptTerminals: attemptIds.map((attemptId) => ({
          attemptId,
          finalState: "batch_rejected" as const,
          terminalOutcome: "retry_schedule_vanished_mid_tx",
          terminalResult: {
            outcome: "retry_schedule_vanished_mid_tx",
            attemptId,
            errors: [
              {
                reason: "schedule_vanished_mid_tx_collateral",
                message:
                  "The aggregate rolled back on a mid-tx schedule vanishing; this Task was not published.",
              },
            ],
          },
        })),
      });
      return {
        outcome: "retry_schedule_vanished_mid_tx",
        occurrence: stamped,
        retryNumber,
      };
    }
    // Infrastructure error — propagate. The coordination + per-Task attempts
    // stay `pending` (the next retry re-derives a fresh retryNumber only if
    // this throw's propagation path stamps; here it does NOT stamp, so the
    // retryNumber does NOT advance — the operator re-calling hits the pending
    // coordination → `retry_in_progress`). This is the documented trade-off
    // for true infrastructure failures (rare; the operator waits for the
    // in-flight call to clear OR the coordination is manually cleared).
    throw err;
  }

  // ----- 10. MAP THE OUTCOME ----------------------------------------------
  switch (publishOutcome.outcome) {
    case "published": {
      // The participant already stamped the `repaired` retryHistory entry +
      // terminalized the coordination to `created` in-tx (atomic with the
      // aggregate). Re-read the authoritative row.
      const stampedRow = getOccurrenceWithClient(db, occurrence.id) ?? occurrence;
      return {
        outcome: "repaired",
        occurrence: stampedRow,
        retryNumber,
        mission: publishOutcome.mission,
        tasks: publishOutcome.tasks,
        workflow: publishOutcome.workflow,
      };
    }

    case "vetoed": {
      // T9B-06 — terminalize ALL reserved attempts atomically with the
      // failure stamp. The vetoed TaskIndexes → `vetoed`; the allowed-but-
      // unpublished TaskIndexes → `batch_rejected` (collateral). The
      // coordination → `vetoed`. All terminalize IN THE SAME tx as the
      // `retry_failed_vetoed` stamp.
      const vetoedTaskIndexes = new Set(publishOutcome.vetoes.map((v) => v.taskIndex));
      const perTaskAttemptTerminals = attemptIds.map((attemptId, i) => {
        if (vetoedTaskIndexes.has(i)) {
          const vetoEntry = publishOutcome.vetoes.find((v) => v.taskIndex === i);
          const veto = vetoEntry!.veto;
          return {
            attemptId,
            finalState: "vetoed" as const,
            terminalOutcome: "vetoed",
            terminalResult: {
              outcome: "vetoed",
              attemptId,
              veto,
            },
          };
        }
        return {
          attemptId,
          finalState: "batch_rejected" as const,
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
        };
      });

      const entry: RetryHistoryEntry = {
        retryNumber,
        outcome: "retry_failed_vetoed",
        attemptedAt: new Date().toISOString(),
        actorId: input.actorId,
        vetoes: publishOutcome.vetoes,
      };
      const stamped = stampFailureRetryHistory(occurrence, entry, {
        coordinationAttemptId,
        coordinationFinalState: "vetoed",
        coordinationTerminalOutcome: "vetoed",
        coordinationTerminalResult: {
          outcome: "vetoed",
          attemptId: coordinationAttemptId,
          publication: { retryNumber, vetoes: publishOutcome.vetoes },
        },
        perTaskAttemptTerminals,
      });
      return {
        outcome: "retry_failed_vetoed",
        occurrence: stamped,
        retryNumber,
        vetoes: publishOutcome.vetoes,
      };
    }

    case "guard_mismatch": {
      // Per-Task guard drift at publish time. The tx rolled back; the per-
      // Task + coordination attempts are terminalized `batch_rejected` + a
      // stamp advances the retryNumber (T9B-05 — the operator re-calls under
      // a fresh slot).
      return stampResumableOutcome(
        occurrence,
        retryNumber,
        input.actorId,
        coordinationAttemptId,
        attemptIds,
        {
          kind: "retry_guard_mismatch",
          taskIndex: publishOutcome.taskIndex,
          reasons: publishOutcome.reasons,
        },
      );
    }

    case "governance_denied": {
      return stampResumableOutcome(
        occurrence,
        retryNumber,
        input.actorId,
        coordinationAttemptId,
        attemptIds,
        {
          kind: "retry_governance_denied",
          taskIndex: publishOutcome.taskIndex,
          denialKind: publishOutcome.kind,
          denialReason: publishOutcome.reason,
          ...(publishOutcome.interceptorKey !== undefined
            ? { interceptorKey: publishOutcome.interceptorKey }
            : {}),
        },
      );
    }
  }
}

/**
 * Stamps a resumable retry outcome (`retry_guard_mismatch` /
 * `retry_governance_denied`) + terminalizes the coordination + per-Task
 * attempts as `batch_rejected` atomically with the stamp (T9B-05). Advances
 * the retryNumber so the operator's next retry uses a fresh slot.
 */
function stampResumableOutcome(
  occurrence: ScheduledOccurrenceRow,
  retryNumber: number,
  actorId: string,
  coordinationAttemptId: string,
  attemptIds: readonly string[],
  detail:
    | {
        kind: "retry_guard_mismatch";
        taskIndex: number;
        reasons: GuardMismatchReason[];
      }
    | {
        kind: "retry_governance_denied";
        taskIndex: number;
        denialKind: CommitAuthorizationDenialKind;
        denialReason: string;
        interceptorKey?: string;
      },
): RepairScheduledOccurrenceOutcome {
  const entry: RetryHistoryEntry = {
    retryNumber,
    outcome: detail.kind,
    attemptedAt: new Date().toISOString(),
    actorId,
    ...(detail.kind === "retry_guard_mismatch"
      ? { taskIndex: detail.taskIndex, guardFields: detail.reasons.map((r) => r.field) }
      : {
          taskIndex: detail.taskIndex,
          denialKind: detail.denialKind,
          denialReason: detail.denialReason,
        }),
  };
  const perTaskAttemptTerminals = attemptIds.map((attemptId) => ({
    attemptId,
    finalState: "batch_rejected" as const,
    terminalOutcome: detail.kind,
    terminalResult: {
      outcome: detail.kind,
      attemptId,
      errors: [
        {
          reason: `${detail.kind}_resumable_collateral`,
          message: "The aggregate rolled back on a resumable outcome; this Task was not published.",
        },
      ],
    },
  }));
  const stamped = stampFailureRetryHistory(occurrence, entry, {
    coordinationAttemptId,
    coordinationFinalState: "batch_rejected",
    coordinationTerminalOutcome: detail.kind,
    coordinationTerminalResult: {
      outcome: detail.kind,
      attemptId: coordinationAttemptId,
      errors: [
        {
          reason: detail.kind,
          message: `The retry concluded with a resumable ${detail.kind}; the coordination was terminalized as batch_rejected.`,
        },
      ],
    },
    perTaskAttemptTerminals,
  });
  if (detail.kind === "retry_guard_mismatch") {
    return {
      outcome: "retry_guard_mismatch",
      occurrence: stamped,
      retryNumber,
      taskIndex: detail.taskIndex,
      reasons: detail.reasons,
    };
  }
  return {
    outcome: "retry_governance_denied",
    occurrence: stamped,
    retryNumber,
    taskIndex: detail.taskIndex,
    kind: detail.denialKind,
    reason: detail.denialReason,
    ...(detail.interceptorKey !== undefined ? { interceptorKey: detail.interceptorKey } : {}),
  };
}
