/**
 * Scheduled Occurrence Publication Adapter — T9A Phase 3 (DORMANT).
 *
 * Composes the T9A-milestone-1 aggregate interface — prepare → reserve N
 * attempts → publish — for the scheduled-occurrence origin (the
 * scheduler-driven Mission spawned by a due `scheduledTasks` row). This is
 * the dormant replacement for the legacy
 * `scheduledTaskService.ts:103 createMissionFromSchedule` + the template
 * branch of `:213-240 executeScheduledTask`. It ships ALONGSIDE the legacy
 * paths and is exercised ONLY by tests until the global cutover (T11) swaps
 * the scheduler onto it.
 *
 * # Why a new adapter (the structural analog of `triageMissionPublication`)
 *
 * The 6 single-Task origin adapters each compose ONE Task through the kernel
 * chain. A scheduled occurrence is structurally an AGGREGATE origin: a single
 * firing produces a Mission + N Tasks (one per `tasksTemplate` entry in the
 * referenced mission template) + the durable `scheduled_occurrences` row.
 * Composing it as N single-Task publications would lose the aggregate
 * atomicity + the occurrence-state transition.
 *
 * The T9A-milestone-1 decomposed interface (`prepareTemplateAggregate` +
 * `publishTemplateAggregateWithClient`) is the aggregate-scale kernel. This
 * adapter composes it with the occurrence-record state machine as a
 * caller-supplied transaction participant — the `reserved → publishing →
 * published | rejected` transition commits atomically WITH the aggregate
 * (Mission + Tasks + Workflow + usage).
 *
 * # The occurrence-state atomicity (the defining feature)
 *
 * The legacy `executeScheduledTask` flow performs NON-atomic writes:
 *   1. `claimExecution` advances the schedule (commits).
 *   2. `applyTemplate` inserts Mission + Tasks + Workflow + usage in its OWN
 *      tx (commits).
 *   3. `finalizeExecution(id, missionId)` stamps `lastCreatedMissionId`
 *      (commits).
 *   4. A one-shot is disabled on success only (`:244-246`).
 *
 * A crash between any two leaves orphan state: a schedule advanced with no
 * Mission, a Mission with no `lastCreatedMissionId` link, a one-shot that
 * refires because publication failed before step 4. There is no durable
 * occurrence record at all.
 *
 * Phase 2 (`reserveScheduledOccurrence`) fixed the schedule-advance +
 * one-shot-disable atomicity + created the durable occurrence record (state
 * `reserved`). THIS adapter (Phase 3) closes the loop: it transitions the
 * occurrence `reserved → publishing`, publishes the aggregate, and
 * terminalizes the occurrence `publishing → published | rejected` INSIDE the
 * milestone-1 publication tx via the {@link buildOccurrenceRecordParticipant
 * occurrence-record participant}. Either the Mission + Tasks + Workflow +
 * usage + occurrence-state transition ALL commit, or NONE do. The crash
 * window is eliminated.
 *
 * # First-time governance (NET-NEW for schedules)
 *
 * The legacy `applyTemplate` / `createMissionFromSchedule` paths insert Tasks
 * directly via `tx.insert(tasks)` — NO `created` Lifecycle Event, NO
 * prospective governance, NO envelope. The Tasks produced by THIS adapter get
 * all three FOR THE FIRST TIME, inherited from the T9A-milestone-1 publisher
 * (which composes `publishTaskWithClient` per Task):
 *
 *   - **`created` Lifecycle Event** — `publishTaskWithClient` always creates
 *     exactly one initial event (`proposal.initialEventAction = "created"`).
 *   - **`creationIntegrity: POST_CUTOVER`** — stamped automatically by the
 *     coordinator (engages the claim gates).
 *   - **Prospective governance** — `governTaskPublication` runs the enrolled
 *     `taskCreated` interceptors BEFORE the publication tx opens; a veto on
 *     ANY Task returns `{outcome:"vetoed"}` WITHOUT opening the tx — zero
 *     orphan Mission, zero partial aggregate. Today the schedule path
 *     bypasses governance entirely; this adapter removes the exemption.
 *
 * # Token resolution (legacy parity)
 *
 * The legacy `buildTokenContext` (`scheduledTaskService.ts:99-101`) returns
 * `{ runCount: schedule.runCount + 1, timezone }` where `schedule.runCount`
 * is the PRE-advance value (= the occurrence's stored `ordinal`). The display
 * counter is therefore 1-based: `ordinal + 1`. This adapter builds the
 * equivalent context from the occurrence's stored `ordinal` (so a stale
 * schedule read does not perturb the counter) + the schedule's `timezone`:
 *
 *   ```ts
 *   const tokenContext = {
 *     runCount: occurrence.ordinal + 1,
 *     timezone: schedule.timezone ?? "UTC",
 *   };
 *   substituteTokens(schedule.missionTitle, tokenContext);
 *   ```
 *
 * `substituteTokens` is inlined here (not imported from
 * `scheduledTaskService`) to avoid pulling that module's handler-registry
 * side effects + SSE/logger dependencies into the load graph — the same
 * layering discipline Phase 2 adopted (`scheduledOccurrenceReservation.ts`
 * header § "nextRunAt").
 *
 * # The optimistic schedule guard (Q5)
 *
 * The occurrence carries a `scheduleRevision` JSON snapshot of the schedule
 * row at reservation time (Phase 2's full-row snapshot). A schedule EDIT
 * between reservation and publication would invalidate the occurrence's
 * basis (different templateId, different mission title, etc.). The plan
 * requires this to surface as a resumable guard mismatch.
 *
 * The snapshot is a FULL-row dump, which includes operational fields the
 * reservation itself mutates (`runCount`, `lastRunAt`, `nextRunAt`,
 * `lastCreatedMissionId`, `updatedAt`) + `enabled` (Phase 2 disables a
 * one-shot at reservation). A naive full-row diff would ALWAYS mismatch
 * (the reservation tx advanced the schedule). The guard therefore diffs
 * ONLY the user-authored CONFIGURATION subset (`SCHEDULE_CONFIG_FIELDS` —
 * templateId, scheduleType, cronExpression, intervalMinutes, scheduledAt,
 * timezone, name, description, missionTitle, missionDescription,
 * missionPriority, missionLabels, missionDomain, handlerKey, tasksTemplate).
 * A diff hit → `schedule_guard_mismatch`.
 *
 * Two-layer guard (mirrors `verifyPublicationGuard`'s prep-snapshot +
 * in-tx re-verify discipline):
 *
 *   1. **PRE-CHECK** (before prepare): read live schedule, diff to the
 *      snapshot. Mismatch → return `{outcome:"schedule_guard_mismatch"}`
 *      early — no prepare, no attempts reserved, occurrence stays
 *      `publishing` for T9B recovery.
 *   2. **IN-TX RE-CHECK** (inside the participant): re-read the schedule on
 *      the tx client, re-diff. Mismatch → throw {@link ScheduleGuardMismatch}
 *      (a sentinel) → the participant throws inside the milestone-1 tx → the
 *      whole aggregate rolls back → the outer catch maps the sentinel to
 *      `{outcome:"schedule_guard_mismatch"}`. Race-safe authority for the
 *      microsecond window between the pre-check and the tx.
 *
 * # Design questions resolved
 *
 *   - **Q1 (singular `attempt_id` column vs N per-Task attempts):** T9A-03
 *     RESOLVED — the singular column carries the OCCURRENCE-LEVEL
 *     COORDINATION attempt (reserved at Phase-2 reservation time with
 *     `attemptKey:"occurrence"`, linked via the occurrence row's `attemptId`
 *     column via `setOccurrenceAttemptIdWithClient`). The N per-Task attempts
 *     are SEPARATE — reserved by THIS publisher with
 *     `(source:"scheduler", sourceScopeKind:"scheduled_occurrence",
 *     sourceScopeId:occurrence.id, attemptKey:"${templateId}-${i}")`. Both
 *     attempt sets share the scope `(source, sourceScopeKind,
 *     sourceScopeId)` but are distinguished by `attemptKey` ("occurrence" vs
 *     "${templateId}-${i}"). The coordination attempt's lifecycle advances
 *     in lockstep with the occurrence ROW:
 *       - occurrence `reserved` → coordination attempt `pending` (reserved).
 *       - occurrence `publishing` → coordination attempt STAYS `pending`
 *         (NO `published_pending_observation` checkpoint at publication
 *         start — the occurrence ROW is the real progress tracker; the N
 *         per-Task attempts already track publication progress via their
 *         own `published_pending_observation` checkpoints; the
 *         coordination attempt reaches terminal directly from `pending` on
 *         failure, and via `pending → published_pending_observation →
 *         created` on success inside the participant).
 *       - occurrence `published` → coordination attempt `created` (terminal
 *         success — 2 ops in the participant: `checkpointAttemptWithClient`
 *         then `completeAttemptWithClient`; matrix forbids
 *         `pending → created` directly).
 *       - occurrence `rejected` (non-veto: `rejected_validation`,
 *         `schedule_missing`, `rejected_fingerprint`) → coordination
 *         attempt `rejected_validation` (for `rejected_validation`) /
 *         `batch_rejected` (for `schedule_missing` + `rejected_fingerprint`)
 *         via the `terminalRejectOccurrenceWithCoordination` helper,
 *         atomic with the occurrence ROW transition.
 *       - occurrence `rejected` (VETOED) → coordination attempt STAYS
 *         `pending` (T9A-05 arc 2 owns the vetoed terminalization —
 *         will terminalize as `vetoed` when wired).
 *   - **Q2 (all-failures vs first-veto):** FIRST-VETO. The milestone-1
 *     publisher governs all N Tasks before the tx + returns first-veto. The
 *     occurrence publisher maps `vetoed` directly (no own batch-govern loop).
 *     Sufficient for the typical 1-3 Task schedule; matches the triage
 *     precedent. A multi-veto surface, if ever needed, belongs at the
 *     milestone-1 level (not just for schedules). NOTE: T9A-04 arc 2 will
 *     revisit this — all-failures governance at the milestone-1 level.
 *   - **Q4 (resumable outcome handling):** STAY `publishing`. On
 *     `guard_mismatch` / `governance_denied` / `schedule_guard_mismatch`,
 *     the occurrence stays `publishing` + the lease is held (NOT released —
 *     Phase 1 carry-over: terminal transitions retire the lease; the
 *     publisher does not release on success/failure). The per-Task attempts
 *     stay `pending` / resumable under their keys. T9B's lease-recovery
 *     worker detects `state='publishing' AND leaseExpiresAt < now` and
 *     retries publication under the SAME attempt keys.
 *   - **Q5 (the publication guard):** two-layer PRE-CHECK + IN-TX RE-CHECK
 *     (see "The optimistic schedule guard" above).
 *
 * # Composition (T9A-milestone-1 consumer contract)
 *
 *   1. TRANSITION `reserved → publishing` + acquire the lease via
 *      `markOccurrencePublishingWithClient` (Phase 1 fused CAS). Handle
 *      `already_publishing` (concurrent worker owns it — return),
 *      `illegal_source_state` (terminal — return), `not_found` (return).
 *   2. PRE-CHECK the schedule config snapshot (Q5). Mismatch → return
 *      `schedule_guard_mismatch` (occurrence stays `publishing`).
 *   3. RESOLVE `{{date}}/{{counter}}` tokens via the inlined
 *      `substituteTokens` (counter = `ordinal + 1`).
 *   4. PREPARE via `prepareTemplateAggregate(templateId, habitatId,
 *      {title, description, priority, labels}, ctx)`. On
 *      `rejected_validation` → `markOccurrenceRejectedWithClient` + return
 *      (terminal).
 *   5. RESERVE N per-Task attempts scoped by the occurrence —
 *      `sourceScopeKind:"scheduled_occurrence"`,
 *      `sourceScopeId:occurrence.id`, `attemptKey:"${templateId}-${i}"`.
 *      Handle the replay/fingerprint branches (mirror the triage adapter).
 *   6. PUBLISH via `publishTemplateAggregateWithClient(db, {attemptIds,
 *      prepared, participants})` where the participant is the
 *      {@link buildOccurrenceRecordParticipant occurrence-record participant}.
 *      The participant runs INSIDE the milestone-1 tx (after Mission + Tasks
 *      + Workflow + usage) + (a) re-checks the schedule guard in-tx, then
 *      (b) calls `markOccurrencePublishedWithClient(tx, occurrence.id, ...)`
 *      — so the `publishing → published` transition + Mission linkage
 *      commit ATOMICALLY with the aggregate.
 *   7. MAP the milestone-1 outcome to occurrence state (see the
 *      {@link PublishScheduledOccurrenceOutcome} branches).
 *
 * # Dormancy
 *
 * No production scheduler call routes through this adapter yet. Legacy
 * `executeScheduledTask` + its `processDueTasks` caller stay byte-identical
 * and active until T11. The scheduler wiring that drives occurrence
 * reservation + publication is T11 (the cutover ticket). The lease-recovery
 * worker for resumable-failure retry is T9B.
 *
 * See: T9A ticket (Phase 3 — active scope); the T9A-milestone-1 publisher
 * (`templateAggregatePublication`); the Phase-2 reservation
 * (`scheduledOccurrenceReservation`); the Phase-1 occurrence repo
 * (`scheduledOccurrences`); the closest structural precedent
 * (`triageMissionPublication` — mirror for the N-attempt reservation +
 * outcome mapping).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { scheduledTasks } from "../db/schema/index.js";
import {
  getOccurrenceWithClient,
  markOccurrencePublishingWithClient,
  markOccurrencePublishedWithClient,
  markOccurrenceRejectedWithClient,
  type ScheduledOccurrenceRow,
  type ScheduledOccurrenceState,
  type ScheduleRevisionJson,
  type OccurrenceResultJson,
} from "../repositories/scheduledOccurrences.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  TERMINAL_ATTEMPT_STATES,
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import {
  prepareTemplateAggregate,
  type PrepareTemplateAggregateContext,
} from "./templateAggregatePreparation.js";
import {
  publishTemplateAggregateWithClient,
  type TemplateAggregateParticipantWriter,
} from "./templateAggregatePublication.js";
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
  ScheduleRevisionJson,
  OccurrenceResultJson,
} from "../repositories/scheduledOccurrences.js";
export type { CommittedPublication } from "./taskPublicationCoordinator.js";
export type { CommittedMission, CommittedWorkflow } from "./templateAggregatePublication.js";
export type { PublicationError } from "./taskPublicationPreparation.js";
export type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
export type { AttemptTerminalResult } from "../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Provenance constants
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a scheduled-occurrence publication.
 *
 * Preserves the legacy `applyTemplate(... "system")` /
 * `createMissionFromSchedule(... createdBy: "system")` attribution as
 * structured provenance — the {@link AuditActorRef} carries it with
 * `type: "system"`. The id is the more descriptive `"scheduler"` (vs the
 * legacy generic `"system"`) for observability — the structure
 * (`{type: "system", id: …}`) is what makes it structured provenance,
 * replacing the legacy bare string. The adapter stamps it; untrusted
 * callers cannot assert this. Mirrors the triage adapter's `TRIAGE_ACTOR_ID`.
 */
const SCHEDULE_ACTOR_ID = "scheduler";

/**
 * The origin channel for a scheduled-occurrence publication. `"scheduler"` is
 * the valid `AuditSource` enum value (AUDIT_SOURCES) that matches the legacy
 * origin (the Mission is auto-created by the scheduler in response to a due
 * schedule). The adapter stamps it; the input does not expose `auditSource`.
 */
const SCHEDULE_AUDIT_SOURCE: AuditSource = "scheduler";

/**
 * The causal-root type for a scheduled-occurrence publication. The root id is
 * the occurrence id (the durable record for this specific firing). A fresh
 * root per occurrence — no inherited hops (the schedule tick is itself the
 * originating action).
 */
const OCCURRENCE_CAUSAL_ROOT_TYPE = "scheduled_occurrence";

/**
 * The attempt-reservation scope kind. Paired with
 * `sourceScopeId = occurrence.id`, this forms the per-occurrence reservation
 * scope — same-occurrence retry replays; a different occurrence (even of the
 * same schedule) creates a distinct attempt set.
 */
const OCCURRENCE_SCOPE_KIND = "scheduled_occurrence";

// ---------------------------------------------------------------------------
// The schedule config subset (the optimistic publication guard's diff scope)
// ---------------------------------------------------------------------------

/**
 * The schedule-row fields whose change between reservation and publication
 * indicates a user EDIT (vs the operational mutations the reservation itself
 * performs). The {@link diffScheduleConfig} guard compares ONLY these fields
 * of the live schedule row to the occurrence's `scheduleRevision` snapshot.
 *
 * EXCLUDES (intentionally — the reservation tx or normal operation mutates
 * these, so including them would always mismatch):
 *   - `enabled` — Phase 2 disables a one-shot at reservation. Including it
 *     would fire the guard on every one-shot publication.
 *   - `runCount`, `lastRunAt`, `nextRunAt` — the reservation advance CAS
 *     mutates these.
 *   - `lastCreatedMissionId` — a prior publication stamps this.
 *   - `createdAt`, `updatedAt` — timestamps.
 *   - `habitatId` — immutable for a schedule row (cascade-delete habitat
 *     also removes the schedule); including it adds nothing.
 *   - `createdBy` — immutable post-create.
 *
 * The set is the "user-authored configuration" — the fields a `PUT
 * /scheduled-tasks/:id` would mutate. Any change here is a real edit the
 * publication should not silently absorb under the occurrence's stale basis.
 */
const SCHEDULE_CONFIG_FIELDS = [
  "templateId",
  "scheduleType",
  "cronExpression",
  "intervalMinutes",
  "scheduledAt",
  "timezone",
  "name",
  "description",
  "missionTitle",
  "missionDescription",
  "missionPriority",
  "missionLabels",
  "missionDomain",
  "handlerKey",
  "tasksTemplate",
] as const;

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
 * Extracts the schedule config subset from a full schedule row (live or
 * snapshot) as a stable-keyed record. Returns `undefined` for each MISSING
 * field (a snapshot from an older schema version might lack a newer field);
 * the diff treats `undefined !== <value>` as a mismatch (an addition is also
 * an edit).
 */
function extractScheduleConfig(
  row: Record<string, unknown>,
): Record<(typeof SCHEDULE_CONFIG_FIELDS)[number], unknown> {
  const out = {} as Record<(typeof SCHEDULE_CONFIG_FIELDS)[number], unknown>;
  for (const field of SCHEDULE_CONFIG_FIELDS) {
    out[field] = row[field];
  }
  return out;
}

/**
 * Computes the config fields that differ between the reservation-time
 * snapshot and the live schedule row. Returns `null` when no config field
 * differs (guard passes); otherwise the list of changed field names
 * (the `schedule_guard_mismatch` payload).
 *
 * Comparison is by STABLE JSON serialization of each field's value — handles
 * nested objects (`tasksTemplate` entries, `missionLabels` arrays) without
 * key-order sensitivity.
 */
function diffScheduleConfig(
  snapshot: ScheduleRevisionJson | null,
  live: Record<string, unknown>,
): readonly string[] | null {
  if (!snapshot) {
    // No snapshot (Phase 2 carry-over defensive: reservation always stamps
    // one). Treat as no-config-known → cannot diff → guard passes (the
    // occurrence's basis is the live schedule, which is what we publish).
    return null;
  }
  const snapshotConfig = extractScheduleConfig(snapshot);
  const liveConfig = extractScheduleConfig(live);
  const drifted: string[] = [];
  for (const field of SCHEDULE_CONFIG_FIELDS) {
    if (stableStringify(snapshotConfig[field]) !== stableStringify(liveConfig[field])) {
      drifted.push(field);
    }
  }
  return drifted.length > 0 ? drifted : null;
}

// ---------------------------------------------------------------------------
// Token resolution (inlined to avoid the scheduledTaskService module load)
// ---------------------------------------------------------------------------

/**
 * Replaces `{{date}}` (YYYY-MM-DD in the schedule's timezone) and
 * `{{counter}}` (the display counter) tokens. Byte-identical to
 * `scheduledTaskService.substituteTokens` — inlined here to avoid pulling
 * that module's handler-registry + SSE/logger dependencies into the load
 * graph (Phase 2's `scheduledOccurrenceReservation` adopted the same
 * layering discipline for `calculateNextRun`).
 */
function substituteTokens(
  template: string,
  context: { runCount: number; timezone: string },
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
  }).format(new Date());
  return template.replaceAll("{{date}}", date).replaceAll("{{counter}}", String(context.runCount));
}

// ---------------------------------------------------------------------------
// Request fingerprint (the per-Task attempt reservation dedup key)
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for a scheduled-occurrence
 * publication. Covers the RENDERED payload (token-substituted mission title
 * + description + priority + labels) + the templateId + the occurrence id
 * (the scope discriminator). A same-occurrence retry with the same rendered
 * content replays; a schedule edit that changed the rendered title produces
 * a different fingerprint → `rejected_fingerprint` on the same attempt key
 * set (forces the scheduler to use a new key set — typically a new
 * occurrence after the next reservation). Mirrors the triage adapter's
 * `computeTriageFingerprint`.
 *
 * EXCLUDES provenance (actor/source/causal-context) — those are
 * server-stamped + stable across retries.
 */
function computeOccurrenceFingerprint(input: {
  occurrenceId: string;
  templateId: string;
  resolvedTitle: string;
  resolvedDescription: string;
  priority: string;
  labels: readonly string[];
}): string {
  const payload = {
    templateId: input.templateId,
    occurrenceId: input.occurrenceId,
    title: input.resolvedTitle,
    description: input.resolvedDescription,
    priority: input.priority,
    labels: [...input.labels].sort(),
  };
  return "scheduled_occurrence:" + stableHash(stableStringify(payload));
}

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The scheduled-occurrence publication command.
 *
 * The caller (the future T11 scheduler wiring, DORMANT until then) supplies
 * the reserved occurrence id + the worker-lease directive. The adapter
 * derives everything else (templateId, title, schedule snapshot, attempts)
 * from the occurrence + the live schedule — the input does NOT expose
 * templateId, title, scheduleRevision, attemptKey, or causalContext fields.
 * Untrusted callers cannot assert privileged publication identities.
 */
export interface PublishScheduledOccurrenceInput {
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
 * The scheduled-occurrence publication result envelope.
 *
 * Every branch is an origin-neutral publication outcome translated from the
 * T9A-milestone-1 {@link PublishTemplateAggregateOutcome} (plus the
 * occurrence-state-decision branches the adapter owns: `not_found`,
 * `already_publishing`, `illegal_source_state`, `schedule_guard_mismatch`,
 * `schedule_missing`, `replayed`, `rejected_fingerprint`). The
 * occurrence-domain mapping:
 *
 *   - `published` — the full aggregate (Mission + N Tasks + optional
 *     Workflow + usage mutation) committed atomically WITH the occurrence's
 *     `publishing → published` transition + Mission linkage. Each per-Task
 *     attempt is at `published_pending_observation` (RECOVERING, not
 *     terminal): the dispatcher (T4A) advances observation, then the
 *     assignment coordinator (T5) resolves any targeted reservation. The
 *     occurrence's lease is RETIRED atomically with the transition.
 *   - `vetoed` — **the visible blocked outcome (NET-NEW for schedules).** A
 *     governance interceptor refused one Task BEFORE the publication tx
 *     opened. NOTHING committed (no Mission, no Tasks, no Workflow, no
 *     usage). The occurrence transitions `publishing → rejected` (terminal)
 *     with the veto details. Today schedule Tasks bypass governance entirely
 *     via `applyTemplate`/`createMissionFromSchedule`; this adapter removes
 *     the exemption — the veto is the first governance decision a schedule
 *     Task ever carries. The scheduler (T11) surfaces this as a blocked
 *     schedule log entry (NOT a swallowed error).
 *   - `rejected_validation` — the rendered template produced an invalid Task
 *     (empty title after substitution, missing workflow variable, missing
 *     template, missing templateId on the schedule). Terminal; occurrence
 *     `rejected`. The scheduler surfaces a configuration error.
 *   - `schedule_guard_mismatch` — RESUMABLE. A schedule config edit between
 *     reservation and publication was detected (PRE-check or IN-tx). The tx
 *     rolled back; the occurrence STAYS `publishing` + the lease is held.
 *     T9B's recovery worker will pick up the expired lease + retry under
 *     the SAME attempt keys (which stayed `pending` / resumable). The
 *     `fields` payload carries the changed schedule config field names for
 *     diagnostics.
 *   - `guard_mismatch` — RESUMABLE. A per-Task guard drift at publish time.
 *     The tx rolled back; the per-Task attempts stay `pending` / resumable.
 *     Occurrence stays `publishing`. The scheduler (or T9B) retries under
 *     the SAME keys.
 *   - `governance_denied` — RESUMABLE. A stale governance decision at commit
 *     time. The tx rolled back; occurrence stays `publishing`. The scheduler
 *     re-governs under the SAME keys.
 *   - `not_found` — no occurrence row exists for `occurrenceId` (typed
 *     not-found; nothing to publish).
 *   - `already_publishing` — a CONCURRENT worker already transitioned this
 *     occurrence to `publishing` and holds an ACTIVE lease. This call did
 *     NOT acquire the lease + MUST NOT proceed with publication. The
 *     current row is returned for diagnostics. The caller treats this as
 *     "another worker owns the work" + returns.
 *   - `illegal_source_state` — the occurrence is in a TERMINAL state
 *     (`published` or `rejected`); the `reserved → publishing` transition
 *     is refused. `fromState` carries the terminal state. A replay of an
 *     already-handled occurrence (the scheduler retried after success).
 *   - `schedule_missing` — the schedule row vanished between reservation
 *     and publication (`scheduledTasks.id` is a plain-text non-cascading
 *     reference on the occurrence, but the schedule row itself may be
 *     deleted). Terminal; occurrence `rejected`. The scheduler surfaces a
 *     data-anomaly error.
 *   - `replayed` — a same-`(scope, attemptKey)` reservation hit a
 *     non-pending per-Task attempt (terminal or recovering). The stored
 *     state is returned verbatim (no re-run). The idempotent-retry
 *     guardrail for the scheduler: a re-drive after a worker crash that
 *     ACTUALLY completed replays without re-running the publication side
 *     effects. The occurrence stays in its CURRENT state (typically
 *     `publishing` if recovery is mid-flight, or already terminal).
 *   - `rejected_fingerprint` — the rendered payload changed under the same
 *     attempt keys (a schedule edit altered the token-substituted title
 *     between reservations — rare; the schedule-revision guard usually
 *     catches this first). The scheduler uses a new key set.
 *
 * Infrastructure failures (a repository throw, INCLUDING the participant's
 * own throws on the in-tx schedule guard) propagate as retryable runtime
 * errors EXCEPT the {@link ScheduleGuardMismatch} sentinel, which the outer
 * catch maps to `schedule_guard_mismatch`. The whole aggregate rolls back on
 * any infrastructure failure (the caller's tx aborts).
 */
export type PublishScheduledOccurrenceOutcome =
  | {
      outcome: "published";
      occurrence: ScheduledOccurrenceRow;
      /** The committed Mission row. */
      mission: import("./templateAggregatePublication.js").CommittedMission;
      /** One committed publication per Task (each POST_CUTOVER + `created` event + envelope). */
      tasks: CommittedPublication[];
      /** The committed Workflow row, or `null` when the template had no workflow. */
      workflow: import("./templateAggregatePublication.js").CommittedWorkflow | null;
    }
  | {
      outcome: "vetoed";
      occurrence: ScheduledOccurrenceRow;
      /** Index into the prepared Task list of the Task whose governance was vetoed. */
      taskIndex: number;
      /** The decisive veto (first-veto-per-Task from `governTaskPublication`). */
      veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
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

// Re-export the T9A-milestone-1 outcome type so consumers (T11 wiring,
// tests) can narrow without reaching into the milestone-1 module directly.
export type { PublishTemplateAggregateOutcome } from "./templateAggregatePublication.js";

// ---------------------------------------------------------------------------
// In-tx abort sentinel (schedule-guard mismatch signal from the participant)
// ---------------------------------------------------------------------------

/**
 * Thrown INSIDE the publication tx by the
 * {@link buildOccurrenceRecordParticipant occurrence-record participant} when
 * the in-tx schedule-config re-check detects drift. The throw rolls back the
 * whole aggregate (Mission + Tasks + Workflow + usage + occurrence-state
 * transition); the outer catch in {@link publishScheduledOccurrence} maps
 * the carried fields to `{outcome:"schedule_guard_mismatch"}`.
 *
 * NOT an infrastructure error — it is the in-tx signal that the schedule was
 * edited in the microsecond window between the pre-check and the tx. The
 * milestone-1 publisher's own per-Task guard_mismatch surfaces via its own
 * `AggregatePublicationAbort` sentinel; this is the schedule-level analog.
 */
class ScheduleGuardMismatch extends Error {
  constructor(public readonly fields: readonly string[]) {
    super(
      `ScheduleGuardMismatch: schedule config drifted between reservation and publication (fields: ${fields.join(", ")}).`,
    );
    this.name = "ScheduleGuardMismatch";
  }
}

// ---------------------------------------------------------------------------
// Occurrence-record participant (the ONLY domain-extension point usage)
// ---------------------------------------------------------------------------

/**
 * Builds the occurrence-record participant — the atomic occurrence-state
 * transition fix.
 *
 * The legacy path performs the occurrence-state transition + Mission linkage
 * as a NON-atomic side effect AFTER the publication commits (or not at all —
 * there is no occurrence record today). This participant moves the
 * `publishing → published` transition + the `createdMissionId` linkage INTO
 * the T9A-milestone-1 publication transaction (on the passed tx client).
 * The transition commits atomically WITH the Mission + Tasks + Workflow +
 * usage mutation: either ALL commit, or NONE do.
 *
 * The participant also performs the in-tx schedule-guard re-check (Q5 layer
 * 2). On a config drift it throws {@link ScheduleGuardMismatch} → the whole
 * aggregate rolls back → the outer catch maps to `schedule_guard_mismatch`.
 *
 * # Why this is exported
 *
 * The atomic occurrence-state transition is a load-bearing claim (the ticket
 * § "Atomic occurrence-state transition"). The dedicated atomicity test
 * composes a wrapped participant (real-participant + throw) directly with
 * `publishTemplateAggregateWithClient` to prove the transition rolls back
 * with the aggregate. Mirrors how `triageMissionPublication` exports
 * `buildTriageClusterJunctionParticipant` for the same test shape.
 *
 * # T9A-03 in-tx occurrence-level attempt lifecycle advance
 *
 * When `coordinationAttemptId` is supplied (the post-T9A-03 normal case —
 * the reservation tx stamped it on the occurrence row), the participant
 * ALSO advances the occurrence-level coordination attempt
 * `pending → published_pending_observation → created` IN-TX, atomic with
 * the occurrence ROW's `publishing → published` transition + the aggregate
 * writes. Both attempt operations use the kernel's CAS matrix
 * (`checkpointAttemptWithClient` + `completeAttemptWithClient`):
 *   - `pending → published_pending_observation` (the checkpoint).
 *   - `published_pending_observation → created` (the terminal success).
 * The matrix forbids `pending → created` directly (success requires passing
 * through the observation checkpoint — `isLegalTerminalForward`), so BOTH
 * operations are required.
 *
 * Why the coordination attempt reaches `created` (not `created_unassigned`)
 * — there is no targeted-assignment reservation on a schedule's
 * aggregate-level coordination attempt. The per-Task attempts handle their
 * own observation+assignment checkpoints; the coordination attempt's
 * terminal `created` mirrors "the occurrence's lifecycle is committed
 * successful" — the aggregate-coordination analog of the per-Task `created`.
 *
 * @param occurrenceId           The occurrence whose state to terminalize.
 * @param scheduleConfigSnapshot The reservation-time schedule config (the
 *     in-tx re-check diff baseline). When `null`, the in-tx re-check is
 *   skipped (the PRE-check is the only guard — defensive for an older
 *     occurrence row that predates the snapshot).
 * @param coordinationAttemptId  The occurrence-level coordination attempt id
 *   (T9A-03). When non-null, the participant advances it
 *   `pending → published_pending_observation → created` in-tx alongside the
 *   occurrence ROW's `publishing → published` transition. When null
 *   (defensive — pre-T9A-03 occurrence rows), the participant skips the
 *   attempt lifecycle (the occurrence ROW is the authoritative state).
 * @returns the {@link TemplateAggregateParticipantWriter} the adapter passes
 *   to `publishTemplateAggregateWithClient`.
 */
export function buildOccurrenceRecordParticipant(
  occurrenceId: string,
  scheduleConfigSnapshot: ScheduleRevisionJson | null,
  coordinationAttemptId: string | null,
): TemplateAggregateParticipantWriter {
  return (db, ctx) => {
    // --- 1. IN-TX schedule-guard re-check (Q5 layer 2 — race-safe) -------
    // Re-read the live schedule on the tx client + diff to the snapshot. A
    // drift in the microsecond window between the pre-check and the tx
    // throws → the whole aggregate rolls back. Skipped when no snapshot
    // (defensive — should not happen post-Phase-2).
    //
    // NOTE: the snapshot is a FULL schedule-row dump (Phase 2 stores
    // `{ ...schedule }`), so its primary key is `id`, NOT `scheduledTaskId`
    // (the latter is the occurrence-row column pointing AT the schedule).
    if (scheduleConfigSnapshot) {
      const liveSchedule = db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, scheduleConfigSnapshot.id as string))
        .get();
      if (liveSchedule) {
        const drifted = diffScheduleConfig(
          scheduleConfigSnapshot,
          liveSchedule as unknown as Record<string, unknown>,
        );
        if (drifted) {
          throw new ScheduleGuardMismatch(drifted);
        }
      }
      // If the schedule vanished mid-tx (deleted between pre-check + tx),
      // the in-tx re-read is undefined. The participant CANNOT mark the
      // occurrence published without a schedule context — throw to roll
      // back. The outer catch propagates this as an infrastructure error
      // (the scheduler's outer try/catch logs it; the occurrence stays
      // `publishing` for T9B).
      // NOTE: the schedule_missing terminal outcome is the PRE-check path;
      // the in-tx vanishing is a rare race treated as retryable.
    }

    // --- 2. OCCURRENCE-STATE TRANSITION (`publishing → published`) -------
    // Marks the occurrence published + stamps the created Mission id + a
    // compact result + RETIRES the lease. Composed inside the milestone-1
    // tx → atomic with the Mission + Tasks + Workflow + usage writes. A
    // throw here (or any later participant throw) rolls back BOTH the
    // aggregate AND this transition → the occurrence stays `publishing`
    // (the load-bearing atomicity claim).
    const result: OccurrenceResultJson = {
      missionId: ctx.mission.id,
      taskCount: ctx.tasks.length,
      attemptIds: ctx.attemptIds,
      coordinationAttemptId: coordinationAttemptId,
      publishedAt: new Date().toISOString(),
    };
    const transition = markOccurrencePublishedWithClient(db, occurrenceId, {
      createdMissionId: ctx.mission.id,
      result,
    });
    // The occurrence was marked `publishing` by THIS adapter immediately
    // before opening the publication tx. The transition MUST succeed
    // (the only legal source state is `publishing`, which we just
    // installed). A `no_op` (concurrent terminalization) or
    // `illegal_source_state` here is a data anomaly — throw to roll back
    // the aggregate (we will not commit a Mission whose occurrence
    // refused to link).
    if (transition.outcome !== "transitioned") {
      throw new Error(
        `publishScheduledOccurrence: occurrence "${occurrenceId}" refused the publishing → published transition (outcome: ${transition.outcome}) inside the publication tx — the aggregate will roll back.`,
      );
    }

    // --- 3. T9A-03 OCCURRENCE-LEVEL COORDINATION ATTEMPT LIFECYCLE -------
    // Advance the occurrence-level coordination attempt
    // `pending → published_pending_observation → created` IN-TX, atomic with
    // the occurrence ROW's `publishing → published` transition + the
    // aggregate. The coordination attempt is the aggregate-level audit /
    // coordination handle (reserved at reservation time); the per-Task
    // attempts (advanced by the milestone-1 publisher to
    // `published_pending_observation`) are SEPARATE — this advance is NOT a
    // substitute for them. The matrix forbids `pending → created` directly,
    // so the advance is two CAS operations back-to-back inside this tx.
    //
    // Skipped when `coordinationAttemptId` is null (defensive — pre-T9A-03
    // occurrence rows that lack the link). The occurrence ROW is the
    // authoritative state; the attempt lifecycle is the audit/coordination
    // surface.
    if (coordinationAttemptId !== null) {
      const checkpoint = checkpointAttemptWithClient(db, coordinationAttemptId, {
        stage: "published_pending_observation",
      });
      // The coordination attempt was reserved at `pending` in the
      // reservation tx. The expected outcomes here:
      //   - `transitioned` (typical) — `pending → published_pending_observation`.
      //   - `no_op` — same-state request OR a concurrent writer already
      //     checkpointed (idempotent; the subsequent complete is still
      //     legal from `published_pending_observation`).
      //   - `rejected_transition` — the attempt is terminal (a prior
      //     failure terminalized it from `pending` directly) OR an illegal
      //     pair. A data anomaly — throw to roll back.
      if (checkpoint.outcome === "rejected_transition") {
        throw new Error(
          `publishScheduledOccurrence: coordination attempt "${coordinationAttemptId}" refused the pending → published_pending_observation checkpoint (fromState: ${checkpoint.fromState}) inside the publication tx — the aggregate will roll back.`,
        );
      }

      const completion = completeAttemptWithClient(db, coordinationAttemptId, {
        finalState: "created",
        terminalOutcome: "created",
        terminalResult: {
          outcome: "created",
          attemptId: coordinationAttemptId,
          // `publication` is the AttemptTerminalResult's free-form detail
          // slot — carries the coordination-relevant identifiers (mission +
          // task count + the N per-Task attempt ids) for the audit /
          // `GET /task-creation-attempts/:attemptId` surface.
          publication: {
            missionId: ctx.mission.id,
            taskCount: ctx.tasks.length,
            attemptIds: ctx.attemptIds,
          },
        },
      });
      // The completion's CAS predicate is `state = 'published_pending_observation'
      // AND completedAt IS NULL`. The expected outcomes:
      //   - `completed` (typical) — terminalized to `created`.
      //   - `no_op` — idempotent replay (a prior completion won; the
      //     coordination attempt is already terminal `created`).
      //   - `rejected_transition` — illegal pair (the checkpoint didn't
      //     fire for some reason, leaving the attempt at `pending` and
      //     making `pending → created` illegal). A data anomaly — throw.
      if (completion.outcome === "rejected_transition") {
        throw new Error(
          `publishScheduledOccurrence: coordination attempt "${coordinationAttemptId}" refused the published_pending_observation → created completion (fromState: ${completion.fromState}) inside the publication tx — the aggregate will roll back.`,
        );
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the T9A-milestone-1 aggregate kernel chain for a
 * scheduled-occurrence publication (occurrence-state transition + Mission +
 * N Tasks + optional Workflow + usage mutation), all committed atomically
 * inside ONE caller-owned transaction. DORMANT.
 *
 * The caller (the future T11 scheduler wiring, DORMANT until then) supplies
 * the reserved occurrence id + the worker-lease directive. The adapter:
 *
 *   1. TRANSITIONS the occurrence `reserved → publishing` + acquires the
 *      lease (Phase-1 fused CAS — `markOccurrencePublishingWithClient`).
 *   2. PRE-CHECKS the schedule config snapshot (Q5 layer 1). Mismatch →
 *      `schedule_guard_mismatch` (resumable).
 *   3. RESOLVES `{{date}}/{{counter}}` tokens (counter = `ordinal + 1`).
 *   4. PREPARES the complete aggregate via `prepareTemplateAggregate`.
 *   5. RESERVES N per-Task attempts scoped by the occurrence
 *      (`sourceScopeKind:"scheduled_occurrence"`, `sourceScopeId:occurrence.id`).
 *   6. PUBLISHES atomically via `publishTemplateAggregateWithClient` WITH the
 *      {@link buildOccurrenceRecordParticipant occurrence-record participant}
 *      so the `publishing → published` transition + Mission linkage commit
 *      with the aggregate.
 *   7. MAPS the outcome to {@link PublishScheduledOccurrenceOutcome}.
 *
 * # Visible blocked outcome
 *
 * NEVER returns `null` (the legacy path's swallowed error). Every expected
 * publication decision is a typed result branch. The `vetoed` branch is the
 * visible blocked outcome — NET-NEW for schedules. The scheduler (T11)
 * translates `vetoed` / `rejected_validation` into a blocked schedule log
 * entry; `published` maps to the legacy `{missionId}` return shape
 * (carried as `result.mission.id`).
 *
 * # Resumable outcomes (Q4)
 *
 * `schedule_guard_mismatch` / `guard_mismatch` / `governance_denied` leave
 * the occurrence `publishing` + the lease held (NOT released — terminal
 * transitions retire the lease; the publisher does not release on
 * resumable outcomes). T9B's recovery worker picks up the expired lease +
 * retries under the SAME attempt keys (which stayed `pending` /
 * resumable because the publication tx rolled back).
 *
 * # Infrastructure failures
 *
 * A repository throw (including the participant's own
 * `ScheduleGuardMismatch` sentinel) propagates as a retryable runtime error
 * EXCEPT `ScheduleGuardMismatch`, which is mapped to the closed
 * `schedule_guard_mismatch` outcome. The whole aggregate rolls back. The
 * scheduler's outer try/catch logs the error; T9B's recovery worker handles
 * the retry.
 *
 * DORMANT: no production scheduler call routes through this adapter yet.
 * Legacy `executeScheduledTask` + `processDueTasks` stay byte-identical +
 * active until T11.
 */
// ---------------------------------------------------------------------------
// Internal: atomic coordination-attempt terminalization + occurrence rejection
// (T9A-03 — the non-veto failure paths)
// ---------------------------------------------------------------------------

/**
 * Terminal rejection helper for the four NON-VETO failure paths
 * (rejected_validation × 2, schedule_missing, rejected_fingerprint).
 * Terminalizes the occurrence-level coordination attempt (when linked) +
 * marks the occurrence ROW `rejected` IN ONE CALLER-SUPPLIED TX, so the two
 * state changes commit atomically (or roll back together). The occurrence
 * ROW remains the authoritative state; the coordination attempt's
 * terminalization is the audit / coordination surface.
 *
 * Lifecycle mapping (T9A-03, grounded against `isLegalTerminalForward` in
 * `taskPublication.ts:350-364`):
 *
 *   | occurrence failure    | coordination attempt finalState | rationale |
 *   |-----------------------|---------------------------------|-----------|
 *   | rejected_validation   | `rejected_validation`           | The same  |
 *   |                       |                                 | canonical |
 *   |                       |                                 | / scope   |
 *   |                       |                                 | failure   |
 *   |                       |                                 | the       |
 *   |                       |                                 | attempt   |
 *   |                       |                                 | state     |
 *   |                       |                                 | machine   |
 *   |                       |                                 | models.   |
 *   | schedule_missing      | `batch_rejected`                | Aggregate |
 *   |                       |                                 | -level    |
 *   |                       |                                 | data      |
 *   |                       |                                 | anomaly   |
 *   |                       |                                 | (the      |
 *   |                       |                                 | schedule  |
 *   |                       |                                 | row       |
 *   |                       |                                 | vanished).|
 *   | rejected_fingerprint  | `batch_rejected`                | Aggregate |
 *   |                       |                                 | -level    |
 *   |                       |                                 | config    |
 *   |                       |                                 | drift     |
 *   |                       |                                 | (the      |
 *   |                       |                                 | rendered  |
 *   |                       |                                 | payload   |
 *   |                       |                                 | changed). |
 *
 * All three finalStates are legal from `pending` per `isLegalTerminalForward`
 * — the coordination attempt stays `pending` from reservation until terminal
 * (no intermediate `published_pending_observation` checkpoint on the failure
 * paths — the occurrence ROW is the real progress tracker; the per-Task
 * attempts track publication progress; the coordination attempt reaches a
 * terminal state directly from `pending` on failure).
 *
 * # Arc 2 hand-off (T9A-05)
 *
 * The VETOED path is INTENTIONALLY NOT handled here — arc 2 owns terminalizing
 * ALL attempts (N per-Task + the occurrence-level coordination) consistently
 * on the vetoed path. Arc 1 leaves the vetoed coordination attempt at
 * `pending` (the vetoed branch of `publishScheduledOccurrence` calls
 * `markOccurrenceRejectedWithClient` directly, NOT this helper). Arc 2 will
 * extend the vetoed path to terminalize the coordination attempt as `vetoed`
 * (matrix allows `pending → vetoed`).
 */
function terminalRejectOccurrenceWithCoordination(
  db: TaskPublicationDbClient,
  occurrence: ScheduledOccurrenceRow,
  args: {
    /** Compact occurrence failure detail (stamped on the occurrence ROW). */
    occurrenceResult: OccurrenceResultJson;
    /** Coordination attempt's terminal state. */
    coordinationFinalState: "rejected_validation" | "batch_rejected";
    /** Coordination attempt's terminal outcome string. */
    coordinationTerminalOutcome: string;
    /** Coordination attempt's terminal detail (audit / status surface). */
    coordinationTerminalResult: AttemptTerminalResult;
  },
): ScheduledOccurrenceRow {
  return db.transaction((tx) => {
    // 1. Terminalize the coordination attempt (when linked). Skipped when
    //    `attemptId` is null (defensive — pre-T9A-03 occurrence rows that
    //    predate the link). The matrix allows `pending → rejected_validation
    //    | batch_rejected` directly (no checkpoint required for failure
    //    terminals from `pending`).
    if (occurrence.attemptId !== null) {
      const completion = completeAttemptWithClient(tx, occurrence.attemptId, {
        finalState: args.coordinationFinalState,
        terminalOutcome: args.coordinationTerminalOutcome,
        terminalResult: args.coordinationTerminalResult,
      });
      // Expected outcomes:
      //   - `completed` (typical) — this call installed the terminal.
      //   - `no_op` (idempotent replay) — a prior terminalization won; the
      //     authoritative terminal row is returned UNCHANGED. Continue with
      //     the occurrence rejection (the occurrence ROW must still advance
      //     to `rejected` for consistency).
      //   - `rejected_transition` — illegal pair. The coordination attempt
      //     is at an unexpected state (e.g. `published_pending_observation`
      //     from a prior participant run that crashed before completing).
      //     This is a data anomaly — surface it as a thrown error so the
      //     scheduler's outer try/catch logs the inconsistency. The
      //     occurrence stays `publishing` (the rejection did NOT run); T9B
      //     recovery reconciles.
      if (completion.outcome === "rejected_transition") {
        throw new Error(
          `publishScheduledOccurrence: coordination attempt "${occurrence.attemptId}" refused the terminal ${args.coordinationFinalState} transition (fromState: ${completion.fromState}) on the ${args.coordinationTerminalOutcome} path — data anomaly. The occurrence stays "publishing" for T9B recovery.`,
        );
      }
    }
    // 2. Mark the occurrence ROW rejected (the authoritative state
    //    transition — terminal-lock, retires the lease). The rejection +
    //    coordination-attempt terminalization (when run) commit atomically.
    const rejected = markOccurrenceRejectedWithClient(tx, occurrence.id, {
      result: args.occurrenceResult,
    });
    return rejected.outcome === "not_found" ? occurrence : rejected.occurrence;
  });
}

export function publishScheduledOccurrence(
  input: PublishScheduledOccurrenceInput,
): PublishScheduledOccurrenceOutcome {
  const db = getDb();

  // ----- 1. RESERVED → PUBLISHING + ACQUIRE LEASE -------------------------
  // The fused CAS: the FIRST worker to transition wins the lease. Losers
  // get `already_publishing` (a concurrent worker owns it) and MUST NOT
  // proceed. Terminal occurrences refuse (`illegal_source_state`).
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
  // `transitioned` — this worker owns the lease; proceed.
  const occurrence: ScheduledOccurrenceRow = publishing.occurrence;

  // Re-read through the root client so the snapshot reflects the lease
  // transition (Phase-1 carries the post-transition row; this is a
  // belt-and-suspenders re-read for clarity).
  const currentOccurrence = getOccurrenceWithClient(db, occurrence.id) ?? occurrence;

  // ----- 2. READ THE LIVE SCHEDULE ----------------------------------------
  // The schedule row provides templateId, missionTitle/Description/Priority/
  // Labels, timezone, habitatId. The occurrence carries only the schedule
  // id (plain text) + the reservation-time snapshot. The schedule_missing
  // branch is terminal (occurrence `rejected`) — there is no publication
  // basis without a schedule.
  const schedule = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, currentOccurrence.scheduledTaskId))
    .get();
  if (!schedule) {
    // Terminal: the schedule row vanished. T9A-03: terminalize the
    // coordination attempt as `batch_rejected` (aggregate-level data
    // anomaly) + mark the occurrence rejected, atomically.
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

  // ----- 3. PRE-CHECK: SCHEDULE CONFIG GUARD (Q5 layer 1) -----------------
  // Diff the live schedule config to the reservation snapshot. A mismatch is
  // a schedule edit → resumable `schedule_guard_mismatch` (the occurrence
  // stays `publishing`; T9B recovers). The in-tx re-check (layer 2) inside
  // the participant catches the microsecond-window race.
  const drifted = diffScheduleConfig(
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
  // buildTokenContext's `runCount + 1`, where the legacy runCount was the
  // PRE-advance value = the occurrence's stored ordinal). The schedule's
  // timezone drives {{date}}.
  const tokenContext = {
    runCount: currentOccurrence.ordinal + 1,
    timezone: schedule.timezone ?? "UTC",
  };
  const resolvedTitle = substituteTokens(schedule.missionTitle, tokenContext);
  const resolvedDescription = substituteTokens(schedule.missionDescription, tokenContext);

  // ----- 5. PREPARE -------------------------------------------------------
  // The schedule's templateId drives the aggregate. A null templateId is a
  // config error (the inline `createMissionFromSchedule` path is a separate
  // non-aggregate legacy concern; T9A's scope is the templateId path). The
  // preparation's PURE validation surfaces `rejected_validation` for a
  // missing template / missing column / workflow-variable failure.
  if (!schedule.templateId) {
    // T9A-03: terminalize the coordination attempt as `rejected_validation`
    // (canonical/scope failure) + mark the occurrence rejected, atomically.
    const templateNotSetMessage = `Schedule "${schedule.id}" has no templateId; the scheduled-occurrence publisher requires a template (the inline createMissionFromSchedule path is a separate legacy concern).`;
    const validationErrors: PublicationError[] = [
      {
        field: "templateId",
        code: "template_not_set",
        message: "Schedule has no templateId.",
      },
    ];
    const rejectedRow = terminalRejectOccurrenceWithCoordination(db, currentOccurrence, {
      occurrenceResult: { reason: "template_not_set", message: templateNotSetMessage },
      coordinationFinalState: "rejected_validation",
      coordinationTerminalOutcome: "rejected_validation",
      coordinationTerminalResult: {
        outcome: "rejected_validation",
        attemptId: currentOccurrence.attemptId ?? undefined,
        errors: validationErrors,
      },
    });
    return {
      outcome: "rejected_validation",
      occurrence: rejectedRow,
      errors: validationErrors,
    };
  }

  const actor: AuditActorRef = { type: "system", id: SCHEDULE_ACTOR_ID };
  const causalContext: CausalContext = {
    root: { type: OCCURRENCE_CAUSAL_ROOT_TYPE, id: currentOccurrence.id },
  };
  const prepareCtx: PrepareTemplateAggregateContext = {
    actor,
    auditSource: SCHEDULE_AUDIT_SOURCE,
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
    // Terminal rejection — NO governance, NO publish, NO occurrence-state
    // transition via the milestone-1 publisher. T9A-03: terminalize the
    // coordination attempt as `rejected_validation` (canonical/scope
    // failure detected by preparation) + mark the occurrence rejected,
    // atomically.
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
  // own attempt set). The fingerprint covers the RENDERED payload (token-
  // substituted title/description) + templateId + occurrenceId. Same-
  // occurrence retry with the same rendered content replays; a schedule
  // edit that changed the rendered title produces a different fingerprint
  // → `rejected_fingerprint` (forces a new key set — typically a new
  // occurrence).
  const requestFingerprint = computeOccurrenceFingerprint({
    occurrenceId: currentOccurrence.id,
    templateId: schedule.templateId,
    resolvedTitle,
    resolvedDescription,
    priority: schedule.missionPriority,
    labels: schedule.missionLabels,
  });

  const attemptIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    // Per-Task attempt key: stable across (template, task index). Same
    // occurrence + same template + same slot → same key → replay.
    const attemptKey = `${schedule.templateId}-${i}`;
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

    // 6a. Fingerprint mismatch → deterministic rejection.
    if (reservation.outcome === "rejected_fingerprint") {
      // Resumable-ish: the rendered payload differs. The occurrence stays
      // `publishing` — the scheduler should re-reserve a new occurrence
      // (the schedule-revision guard usually catches this earlier). Mark
      // rejected for a clean terminal state (the occurrence cannot
      // publish under this key set; T9B recovery would also fail the
      // fingerprint check).
      //
      // Decision: terminal rejection. The fingerprint mismatch indicates
      // the reservation-time payload differs from the publication-time
      // payload — the occurrence's basis is inconsistent. T9B recovery
      // under the same keys is impossible (the fingerprint would keep
      // mismatching). Mark rejected + return.
      //
      // T9A-03: terminalize the coordination attempt as `batch_rejected`
      // (aggregate-level config drift — the rendered payload changed under
      // the same key set) + mark the occurrence rejected, atomically.
      // NOTE: the per-Task attempt that returned `rejected_fingerprint` is
      // NOT mutated by `reserveAttemptWithClient` (the reservation primitive
      // returns the stored attempt read-only on fingerprint mismatch); its
      // own state stays `pending`. Arc 2 (T9A-05) will terminalize ALL
      // reserved attempts on terminal rejection; arc 1 owns only the
      // occurrence-level coordination attempt.
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
    //     terminal result verbatim. The prior publication under this key
    //     set terminally resolved; the occurrence state is consistent with
    //     that resolution (terminal occurrences refuse the reserved →
    //     publishing transition above, so this branch is reached only when
    //     the occurrence is `publishing` from a partial-recovery state —
    //     e.g. a prior worker crashed mid-recovery). NO governance, NO
    //     publish, NO side effect.
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
    //     set; the adapter does NOT re-publish. Surface as `replayed`
    //     carrying the recovering state — T11 refines the reconstruction
    //     if it needs the committed Mission + Tasks (read back from the
    //     durable envelope rows).
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
    //     publication. The milestone-1 publisher's pre-tx governance +
    //     in-tx publication are idempotent.
    attemptIds.push(attempt.id);
  }

  // ----- 7. PUBLISH (atomic, inside one caller-owned tx) -----------------
  // The occurrence-record participant composes the `publishing → published`
  // transition + Mission linkage into the SAME tx as the aggregate (Mission
  // + Tasks + Workflow + usage). A participant throw (incl. the in-tx
  // ScheduleGuardMismatch sentinel) rolls back the whole aggregate — zero
  // orphan Mission / partial Workflow / partial occurrence-state transition.
  // T9A-03: the participant also advances the occurrence-level coordination
  // attempt `pending → published_pending_observation → created` in-tx.
  const participants = buildOccurrenceRecordParticipant(
    currentOccurrence.id,
    currentOccurrence.scheduleRevision,
    currentOccurrence.attemptId,
  );

  let publishOutcome;
  try {
    publishOutcome = publishTemplateAggregateWithClient(db, {
      attemptIds,
      prepared: aggregate,
      participants,
    });
  } catch (err) {
    // Map the in-tx schedule-guard sentinel to the closed outcome. The tx
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
    // Infrastructure failure — propagate as a retryable runtime error. The
    // whole aggregate rolled back; the occurrence stays `publishing` with
    // the lease held (T9B recovers).
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
        workflow: publishOutcome.workflow,
      };
    }

    case "vetoed": {
      // Terminal governance refusal. The tx never opened (governance runs
      // before the tx in the milestone-1 publisher); nothing committed.
      // Mark the occurrence rejected with the veto details + return.
      //
      // *** T9A-03 / T9A-05 ARC 2 HAND-OFF ***
      // Arc 1 (this fix) LEAVES the occurrence-level coordination attempt at
      // `pending` on the vetoed path. Arc 2 (T9A-05) owns terminalizing ALL
      // reserved attempts consistently on the vetoed path:
      //   - The N per-Task attempts (reserved at step 6 above) → terminal
      //     `vetoed` (matrix allows `pending → vetoed`).
      //   - The occurrence-level coordination attempt (`currentOccurrence.attemptId`)
      //     → terminal `vetoed` (same matrix edge).
      // When arc 2 wires the terminalization, replace this direct
      // `markOccurrenceRejectedWithClient` call with the
      // `terminalRejectOccurrenceWithCoordination` helper using
      // `coordinationFinalState: "vetoed"` (the helper's type would need
      // widening to include `vetoed`).
      const rejected = markOccurrenceRejectedWithClient(db, currentOccurrence.id, {
        result: {
          reason: "vetoed",
          taskIndex: publishOutcome.taskIndex,
          veto: publishOutcome.veto,
        },
      });
      const rejectedRow =
        rejected.outcome === "not_found" ? currentOccurrence : rejected.occurrence;
      return {
        outcome: "vetoed",
        occurrence: rejectedRow,
        taskIndex: publishOutcome.taskIndex,
        veto: publishOutcome.veto,
      };
    }

    case "guard_mismatch": {
      // RESUMABLE — per-Task guard drift at publish time. The tx rolled
      // back; the per-Task attempts stay `pending` / resumable. The
      // occurrence STAYS `publishing` + lease held (NOT released — Q4).
      // T9B recovers; the scheduler (T11) may also re-drive immediately.
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
