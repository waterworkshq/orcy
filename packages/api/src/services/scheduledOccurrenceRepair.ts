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
 * Resumable outcomes (`retry_guard_mismatch` / `retry_governance_denied`)
 * do NOT stamp — the retry did not reach a conclusion + the operator can
 * call again. The next retry call re-derives the same retryNumber (the
 * stamp was not appended) and proceeds. This mirrors the original
 * publisher's resumable discipline (the occurrence stays unchanged for
 * the next attempt).
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
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
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
// retryHistory stamp shape (additive on the occurrence's `result` JSON)
// ---------------------------------------------------------------------------

/**
 * One entry in the occurrence's `result.retryHistory` array. Each entry
 * records one retry attempt's terminal outcome (success or failure).
 * Resumable outcomes do NOT stamp (the operator can retry again; the
 * next retry re-derives the same retryNumber).
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
    | "retry_failed_schedule_missing";
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
 * Builds the retry-history stamp participant — the in-tx hook that stamps
 * a `repaired` entry on the occurrence's `result.retryHistory` array
 * INSIDE the milestone-1 publication tx. Atomic with the Mission + Tasks
 * + Workflow + usage writes: either ALL commit (the Mission + the
 * retryHistory stamp), or NONE do (a participant throw rolls back both).
 *
 * # Why the participant does NOT transition the occurrence ROW state
 *
 * The occurrence is `rejected` (terminal — the state machine is forward-
 * only). The plan's load-bearing claim is that the terminal one-way door
 * holds. The retry's publication therefore lives in NEW attempt rows + a
 * retryHistory stamp on the EXISTING `result` JSON column — NO state
 * transition. The stamp is a conditional UPDATE on `id AND state='rejected'`
 * that appends to the `result` JSON's `retryHistory` array. The CAS
 * condition is `state='rejected'` (a terminal state carries no lease to
 * fence; the conditional catches a state-drift data anomaly — e.g. a
 * concurrent repair transitioned the occurrence out of `rejected`, which
 * is structurally impossible but defensive).
 *
 * # Why the CAS classification is throw-on-miss
 *
 * The participant runs INSIDE the milestone-1 tx. A CAS miss here means
 * the occurrence is NO LONGER `rejected` (it transitioned out — a data
 * anomaly since `rejected` is terminal). Throwing rolls back the whole
 * aggregate (Mission + Tasks + Workflow + usage + this stamp) so the
 * retry does NOT commit a Mission linked to an occurrence that's no
 * longer in the expected state. The outer catch in
 * {@link repairScheduledOccurrence} propagates the throw as an
 * infrastructure error (the operator can retry again).
 *
 * @param occurrenceId   The rejected occurrence to stamp.
 * @param retryNumber    The retry number (prior retryHistory length + 1).
 * @param missionId      The Mission id the retry just committed (carried
 *   via the participant context — same as the publisher's participant).
 * @param taskCount      The number of Tasks committed (audit detail).
 * @param attemptIds     The per-Task attempt ids (audit detail).
 * @param actorId        The operator who triggered the retry.
 * @returns the {@link TemplateAggregateParticipantWriter} the retry passes
 *   to `publishTemplateAggregateWithClient`.
 */
function buildRetryHistoryParticipant(
  occurrenceId: string,
  retryNumber: number,
  actorId: string,
): TemplateAggregateParticipantWriter {
  return (db, ctx) => {
    // 1. Read the current occurrence row (in-tx) to get the existing
    //    `result` JSON. The occurrence MUST still be `rejected` (terminal —
    //    no transitioned-out path exists, but defensive).
    const current = db
      .select()
      .from(scheduledOccurrences)
      .where(eq(scheduledOccurrences.id, occurrenceId))
      .get();
    if (!current) {
      // Vanished mid-tx (data anomaly — the occurrence existed at the
      // retry's pre-check). Throw to roll back the aggregate.
      throw new Error(
        `repairScheduledOccurrence: occurrence "${occurrenceId}" vanished inside the publication tx — the aggregate will roll back.`,
      );
    }
    if (current.state !== "rejected") {
      // State drifted mid-tx (data anomaly — `rejected` is terminal). Throw
      // to roll back — the retry MUST NOT commit a Mission linked to an
      // occurrence that's no longer `rejected`.
      throw new Error(
        `repairScheduledOccurrence: occurrence "${occurrenceId}" transitioned out of "rejected" (now "${current.state}") inside the publication tx — the aggregate will roll back.`,
      );
    }

    // 2. Append the `repaired` entry to the retryHistory array.
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

    // 3. Conditional UPDATE `WHERE id AND state='rejected'`. The CAS
    //    catches a concurrent state drift between the read + the UPDATE
    //    (the row changed state in the microsecond window — impossible
    //    since `rejected` is terminal, but the CAS is the race-safe
    //    authority). `SELECT changes() AS n` is the portable signal (1 →
    //    stamped; 0 → state drift, throw).
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
      // The CAS lost — the occurrence is no longer `rejected` (a data
      // anomaly). Throw to roll back the aggregate.
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
 * Stamps a failure entry on the occurrence's `result.retryHistory` array
 * in a SEPARATE small tx. Used by the retry's failure paths (vetoed,
 * rejected_validation, schedule_missing) where the milestone-1 publish
 * call did NOT open its tx (so the in-tx participant did not run).
 *
 * The stamp tx commits independently — the audit trail records the retry
 * attempt's outcome even when no Mission was created. A CAS miss (state
 * drift) is logged + ignored (the occurrence is no longer `rejected` — a
 * data anomaly; the failure stamp is best-effort on the failure paths).
 *
 * Returns the re-read occurrence row (reflects the stamp if it committed,
 * or the prior row if the CAS missed).
 */
function stampFailureRetryHistory(
  occurrence: ScheduledOccurrenceRow,
  entry: RetryHistoryEntry,
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
 * retry-domain branches the adapter owns: `not_found`,
 * `illegal_source_state`, `retry_failed_schedule_missing`). The retry-
 * domain mapping:
 *
 *   - `repaired` — the full aggregate (Mission + N Tasks + optional
 *     Workflow + usage mutation) committed atomically WITH a `repaired`
 *     entry stamped on the occurrence's `result.retryHistory`. The
 *     occurrence STAYS `rejected` (the terminal one-way door holds —
 *     option (b)). The retry's Mission is a real Mission linked via the
 *     retryHistory stamp + the per-Task attempts.
 *   - `retry_failed_vetoed` — the latest governance interceptor refused
 *     one Task BEFORE the publication tx opened. NOTHING committed (no
 *     Mission, no Tasks). A `retry_failed_vetoed` entry is stamped on
 *     the occurrence's `result.retryHistory`. The operator can retry
 *     again (after correcting the governance policy / the Task definition).
 *   - `retry_failed_validation` — the LATEST schedule's rendered template
 *     produced an invalid Task (empty title after substitution, missing
 *     template, missing templateId on the schedule). A
 *     `retry_failed_validation` entry is stamped. No Mission.
 *   - `retry_failed_schedule_missing` — the schedule row vanished between
 *     the original failure + the retry (the schedule was deleted). A
 *     `retry_failed_schedule_missing` entry is stamped. The operator must
 *     recreate the schedule before retrying.
 *   - `not_found` — no occurrence row exists for `occurrenceId`.
 *   - `illegal_source_state` — the occurrence is NOT `rejected` (it's
 *     `reserved` / `publishing` / `published`). Only `rejected`
 *     occurrences can be retried (a `publishing` occurrence is still in
 *     flight; a `published` occurrence already succeeded; a `reserved`
 *     occurrence hasn't been published yet).
 *   - `retry_guard_mismatch` — RESUMABLE. A per-Task guard drift at
 *     publish time. The tx rolled back; NO retryHistory entry stamped
 *     (the retry did not reach a conclusion). The operator can retry
 *     again (the next retry re-derives the same retryNumber).
 *   - `retry_governance_denied` — RESUMABLE. A stale governance decision
 *     at commit. The tx rolled back; NO retryHistory entry stamped. The
 *     operator can retry again.
 *
 * Infrastructure failures (a repository throw) propagate as retryable
 * runtime errors EXCEPT the in-tx participant's own throws (the CAS-miss
 * sentinels for state drift / vanished occurrence). The whole aggregate
 * rolls back on any infrastructure failure (the caller's tx aborts). The
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
  // Only `rejected` occurrences can be retried. A `reserved`/`publishing`
  // occurrence is still in flight (use the publisher / recovery worker,
  // not the retry). A `published` occurrence already succeeded (no retry
  // needed).
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
  // The retry uses the CURRENT schedule (NOT the reservation-time snapshot
  // — the whole point of repair is to pick up the corrected schedule +
  // template + governance). A missing schedule is a terminal retry
  // failure (the operator must recreate the schedule before retrying).
  const schedule = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, occurrence.scheduledTaskId))
    .get();
  if (!schedule) {
    // Stamp a `retry_failed_schedule_missing` entry on the retryHistory.
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

  // ----- 3. RESOLVE TOKENS (durable timestamp discipline — T9A-06) ---------
  // counter = ordinal + 1 (matches the publisher). {{date}} is formatted
  // from the occurrence's preserved `scheduledFor` instant (NOT wall-clock
  // `new Date()`) so a retry days after the original firing renders the
  // SAME date → the same fingerprint → token consistency (the plan's
  // "preserve the original scheduledFor/ordinal for token consistency").
  const tokenContext = {
    runCount: occurrence.ordinal + 1,
    timezone: schedule.timezone ?? "UTC",
    scheduledFor: occurrence.scheduledFor,
  };
  const resolvedTitle = substituteTokens(schedule.missionTitle, tokenContext);
  const resolvedDescription = substituteTokens(schedule.missionDescription, tokenContext);

  // ----- 4. DERIVE retryNumber ---------------------------------------------
  // 1-based; derived from the prior retryHistory length so a failed stamp
  // tx (rare) does not orphan a retryNumber gap (the next retry re-
  // derives the same number).
  const retryNumber = readRetryHistory(occurrence.result).length + 1;

  // ----- 5. PREPARE via the milestone-1 kernel -----------------------------
  // A null templateId is a config error (the inline createMissionFromSchedule
  // path is a separate legacy concern; T9A's scope is the templateId path).
  // A `rejected_validation` here stamps a failure entry + returns.
  if (!schedule.templateId) {
    const validationErrors: PublicationError[] = [
      {
        field: "templateId",
        code: "template_not_set",
        message: "Schedule has no templateId.",
      },
    ];
    const entry: RetryHistoryEntry = {
      retryNumber,
      outcome: "retry_failed_validation",
      attemptedAt: new Date().toISOString(),
      actorId: input.actorId,
      errors: validationErrors,
    };
    const stamped = stampFailureRetryHistory(occurrence, entry);
    return {
      outcome: "retry_failed_validation",
      occurrence: stamped,
      retryNumber,
      errors: validationErrors,
    };
  }

  const actor: AuditActorRef = { type: "system", id: REPAIR_ACTOR_ID };
  const causalContext: CausalContext = {
    root: { type: OCCURRENCE_CAUSAL_ROOT_TYPE, id: occurrence.id },
  };
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
    const entry: RetryHistoryEntry = {
      retryNumber,
      outcome: "retry_failed_validation",
      attemptedAt: new Date().toISOString(),
      actorId: input.actorId,
      errors: prepared.errors,
    };
    const stamped = stampFailureRetryHistory(occurrence, entry);
    return {
      outcome: "retry_failed_validation",
      occurrence: stamped,
      retryNumber,
      errors: prepared.errors,
    };
  }

  const aggregate = prepared.aggregate;
  const taskCount = aggregate.tasks.length;

  // ----- 6. RESERVE N PER-TASK ATTEMPTS (retry-scoped keys) ----------------
  // The retry's per-Task attempts share the occurrence scope (same
  // `sourceScopeId = occurrence.id`) but use RETRY-SCOPED keys so they're
  // DISTINCT from the original publication's attempts (which are terminal
  // — vetoed / batch_rejected / etc.) AND from prior retry attempts. The
  // retryNumber discriminator guarantees retry-to-retry uniqueness.
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
    // Per-Task retry attempt key: stable across (template, retry, task
    // index). Same occurrence + same retryNumber + same template + same
    // slot → same key → replay on a retry's own re-run.
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

    // A `rejected_fingerprint` on a retry's attempt is a data anomaly —
    // the retryNumber discriminator should guarantee uniqueness. Surface
    // as a thrown error (the operator should not see this in production;
    // it indicates a bug in retryNumber derivation or a same-key
    // collision). The attempts reserved so far stay `pending` (they're
    // harmless orphans — the next retry uses a different retryNumber).
    if (reservation.outcome === "rejected_fingerprint") {
      throw new Error(
        `repairScheduledOccurrence: retry attempt key "${attemptKey}" produced rejected_fingerprint (reserved "${reservation.reservedFingerprint}" ≠ request "${requestFingerprint}") — a retryNumber collision or a fingerprint drift. The retry aborts.`,
      );
    }

    // REPLAY of a prior terminal / recovering attempt under the retry's
    // own keys. The retry's keys are retryNumber-scoped, so a prior
    // terminal under these EXACT keys means a prior retry call already
    // reached this point. Treat as a replay: return the stored state.
    // (This is the rare case where the operator called retry twice in
    // quick succession before the first retry's stamp committed — the
    // second call sees the first's pending attempts.)
    if (
      reservation.attempt.state === "published_pending_observation" ||
      reservation.attempt.state === "published_pending_assignment" ||
      reservation.attempt.state === "created" ||
      reservation.attempt.state === "created_unassigned" ||
      reservation.attempt.state === "rejected_validation" ||
      reservation.attempt.state === "vetoed" ||
      reservation.attempt.state === "batch_rejected"
    ) {
      // The retry's own keys already reached a terminal / recovering
      // state. This indicates a concurrent retry call under the same
      // retryNumber (a race). For idempotency, return the prior terminal
      // — surface as a typed `illegal_source_state` (the occurrence is
      // `rejected`, but the retry's own attempts are not pending — the
      // operator should re-fetch the retryHistory to see the prior
      // retry's outcome).
      return {
        outcome: "illegal_source_state",
        occurrence,
        fromState: occurrence.state as ScheduledOccurrenceState,
      };
    }

    attemptIds.push(reservation.attempt.id);
  }

  // ----- 7. PUBLISH (atomic, inside one caller-owned tx) -------------------
  // The retry-history stamp participant runs INSIDE the milestone-1 tx —
  // AFTER the Mission + Tasks + Workflow + usage mutation commit + BEFORE
  // the tx returns. A throw (the CAS-miss sentinel for state drift, or
  // any infrastructure error) rolls back the whole aggregate.
  const participants = buildRetryHistoryParticipant(occurrence.id, retryNumber, input.actorId);

  let publishOutcome: PublishTemplateAggregateOutcome;
  publishOutcome = publishTemplateAggregateWithClient(db, {
    attemptIds,
    prepared: aggregate,
    participants,
  });
  // The in-tx participant may throw (the CAS-miss sentinel for state drift,
  // or any infrastructure error). The whole aggregate rolls back (Mission
  // + Tasks + Workflow + usage + the retryHistory stamp). The occurrence
  // STAYS `rejected`; no retryHistory entry was stamped. The throw
  // propagates as a retryable runtime error — the operator can call the
  // retry endpoint again.

  // ----- 8. MAP THE OUTCOME -----------------------------------------------
  switch (publishOutcome.outcome) {
    case "published": {
      // The participant already stamped the `repaired` retryHistory entry
      // in-tx (atomic with the aggregate). Re-read the authoritative row.
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
      // The latest governance refused one or more Tasks BEFORE the tx
      // opened. The participant did NOT run (the tx never opened). Stamp
      // a `retry_failed_vetoed` entry in a separate small tx.
      const entry: RetryHistoryEntry = {
        retryNumber,
        outcome: "retry_failed_vetoed",
        attemptedAt: new Date().toISOString(),
        actorId: input.actorId,
        vetoes: publishOutcome.vetoes,
      };
      const stamped = stampFailureRetryHistory(occurrence, entry);
      return {
        outcome: "retry_failed_vetoed",
        occurrence: stamped,
        retryNumber,
        vetoes: publishOutcome.vetoes,
      };
    }

    case "guard_mismatch": {
      // RESUMABLE — per-Task guard drift at publish time. The tx rolled
      // back; NO retryHistory entry stamped (the retry did not reach a
      // conclusion). The operator can retry again; the next retry re-
      // derives the same retryNumber.
      return {
        outcome: "retry_guard_mismatch",
        occurrence,
        retryNumber,
        taskIndex: publishOutcome.taskIndex,
        reasons: publishOutcome.reasons,
      };
    }

    case "governance_denied": {
      // RESUMABLE — stale governance decision at commit. Same handling
      // as guard_mismatch.
      return {
        outcome: "retry_governance_denied",
        occurrence,
        retryNumber,
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
