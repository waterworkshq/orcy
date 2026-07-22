/**
 * Blocker-Clearance Task Publication Adapter (T8A-pre Phase 2 — DORMANT).
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for the blocker-clearance origin (the auto-created "Clear Blocker: …" Task
 * spawned when a `blocker` signal pulse is posted). This is the dormant
 * replacement for the legacy `pulseService.ts:232 createBlockerClearanceTask`
 * path. It ships ALONGSIDE the legacy path and is exercised ONLY by tests
 * until the global cutover (T11) swaps the pulse service onto it.
 *
 * # Why a new adapter (not an extension of `publishTaskCreation`)
 *
 * `publishTaskCreation` is the *interactive* origin adapter (UI/REST/MCP):
 * client-supplied attempt key, human/agent actor, REST/MCP audit source. The
 * blocker-clearance origin differs structurally on every axis:
 *
 *   - **Provenance is system-constructed.** The actor is the blocker-clearance
 *     system identity, the source is `"system"` (a valid `AuditSource`; there
 *     is no `"blocker"` enum value — the legacy path stamps `createdBy:
 *     "system"`), and the causal root is the blocker pulse
 *     (`blocker_pulse:<pulseId>`).
 *   - **Attempt identity is server-derived** from the pulse (the Origin
 *     Migration Matrix row: "the originating run plus action index/identity" —
 *     for blocker, the pulse id IS the run, and the single clearance action is
 *     the action) — NOT a client-supplied retry key. Same-pulse replay cannot
 *     create twice (the reservation replays the terminal outcome).
 *   - **C1 habitat-scoped rejection is the defining behavior.** A
 *     habitat-scoped blocker pulse has NO target Mission — the legacy path
 *     forwards the `habitatId` as `missionId` (a data-integrity bug, gap-audit
 *     O2 + cold-critique C1). This adapter detects habitat scope at the
 *     boundary and returns a typed `rejected_no_target_mission` result WITHOUT
 *     entering the kernel chain — NO Task is created, NO attempt is reserved.
 *     The caller surfaces the rejection as a visible pulse (the signal remains;
 *     the replacement path is an Automation Rule or manual creation under an
 *     explicit Mission).
 *
 * Both adapters compose the SAME kernel chain (reserve → prepare → govern →
 * publish) using the SAME kernel functions; DRY is preserved at the
 * composition level. Extending `publishTaskCreation` with a habitat-scope
 * short-circuit + system-origin provenance would couple the interactive
 * adapter to blocker-clearance's C1 boundary and leak pulse-domain fields into
 * the interactive input type.
 *
 * # First-time history + governance (gap-audit O2 correction)
 *
 * The legacy `createBlockerClearanceTask` calls `taskService.createTask` — the
 * "best-behaved" system origin (O2: it already traverses the service layer, so
 * the `created` Lifecycle Event + pre-interceptors DO fire). But it carries
 * NO stable attempt identity (a re-posted blocker pulse can create duplicate
 * clearance Tasks) and NO structured provenance (just description text +
 * `createdBy: "system"`). The clearance Task produced by THIS adapter gets all
 * three FOR THE FIRST TIME via the kernel:
 *
 *   - **Stable attempt identity** — `(source="system", sourceScopeKind=
 *     "blocker_pulse", sourceScopeId=<pulseId>, attemptKey="clearance")`.
 *     Same-pulse replay hits the same reservation key → replays the terminal
 *     outcome (no duplicate Task).
 *   - **`created` Lifecycle Event** — `publishTaskWithClient` always creates
 *     exactly one initial event (`proposal.initialEventAction = "created"`).
 *   - **`creationIntegrity: POST_CUTOVER`** — stamped automatically by the
 *     coordinator (engages the claim gates).
 *   - **Prospective governance** — `governTaskPublication` runs the enrolled
 *     `taskCreated` interceptors; a veto rolls back the whole aggregate and
 *     surfaces as a typed `vetoed` result (the visible blocked outcome).
 *
 * # Composition (Technical Plan § "Shared Publication Contract")
 *
 *   0. C1 SCOPE CHECK — if the blocker is habitat-scoped → return
 *      `rejected_no_target_mission` (NO attempt reserved, NO Task created).
 *   1. RESERVE the attempt (server-derived `(source, sourceScope, attemptKey)`
 *      + canonical request fingerprint) via {@link reserveAttemptWithClient}.
 *   2. PREPARE via {@link prepareTaskPublication} (PURE). On
 *      `rejected_validation` → terminalize + return.
 *   3. GOVERN via {@link governTaskPublication}. On a decisive veto →
 *      terminalize + return `vetoed` (the visible blocked outcome).
 *   4. PUBLISH via `db.transaction((tx) => publishTaskWithClient(tx, ...))`.
 *      Pass `reservation` ONLY when the assignment intent is targeted.
 *
 * # No participant (simpler than Recovery)
 *
 * The legacy path performs TWO non-atomic writes: `taskService.createTask`
 * (the Task insert, via the service layer) + `pulseRepo.updateLinkedTask`
 * (stamps `pulse.linkedTaskId = task.id`). The Recovery adapter (P1) moved its
 * 5 linkage writes into a C2 atomic participant to eliminate a crash window
 * that left unlinked Recovery Tasks. Blocker-clearance carries only the ONE
 * pulse-link write, and the adapter already persists the pulse id as the
 * causal root on the committed envelope — the pulse↔Task relationship is
 * durable in provenance and recoverable without the denormalized
 * `pulse.linkedTaskId` field. Per the ticket's guidance ("investigate whether
 * atomicity is needed. If not, no participant — simpler than Recovery"), P2
 * ships NO participant. The T11 wiring may add a `participants?(db, ctx)` seam
 * (or a post-publish `updateLinkedTask` call) if the cutover needs the
 * denormalized field; the adapter's publication contract does not depend on
 * it.
 *
 * # Visible outcome (not a hidden boolean)
 *
 * The legacy path swallows every error → `null` (`createBlockerClearanceTask`
 * catch, pulseService L263-268), and the route collapses the result into a
 * single `blockerTaskCreated: boolean` that CANNOT distinguish "boundary
 * rejected (no target Mission)" from "creation failed". This adapter returns a
 * TYPED result for every expected publication decision. The C1
 * `rejected_no_target_mission` branch is the visible signal the pulse service
 * (T11) surfaces as a rejected-clearance pulse (the signal remains; the
 * replacement path is an Automation Rule or manual creation). The `vetoed`
 * branch is the visible blocked outcome. Infrastructure failures still
 * propagate as retryable throws (the attempt stays resumable under the same
 * key).
 *
 * DORMANT: no production pulse-service call routes through this adapter yet.
 * Legacy `createBlockerClearanceTask` + its two callers
 * (`postMissionPulseSignal` / `postHabitatPulseSignal`) stay the active
 * production path until T11.
 *
 * See: Task Creation and Clone Technical Plan § "Origin Migration Matrix";
 * Story-2 implementation-context § "Story 1 kernel API surface"; gap-audit O2;
 * cold-critique C1.
 */
import { createHash } from "node:crypto";
import type { AuditActorRef, AuditSource, CausalContext, TaskPriority } from "@orcy/shared";
import { getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
} from "./taskPublicationPreparation.js";
import { governTaskPublication } from "./taskPublicationGovernance.js";
import { publishTaskWithClient, type CommittedPublication } from "./taskPublicationCoordinator.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  completeAttemptWithClient,
  TERMINAL_ATTEMPT_STATES,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import type { TaskCreationPublicationResult, AssignmentIntent } from "./taskCreationPublication.js";
import { getDefaultAssignmentDeadlineMs } from "../config/creationPublicationCutover.js";

// ---------------------------------------------------------------------------
// Re-exports (the result envelope + assignment intent are origin-neutral)
// ---------------------------------------------------------------------------

/**
 * Re-exports the assignment-intent union from the interactive adapter. The
 * shape is origin-neutral (auto vs targeted) — both origins resolve the
 * configured reservation deadline the same way.
 */
export type { AssignmentIntent };

/**
 * The blocker-clearance publication result envelope.
 *
 * Extends {@link TaskCreationPublicationResult} with ONE origin-specific
 * branch: the C1 habitat-scoped rejection. Every other branch is the shared
 * origin-neutral publication outcome. The blocker-domain mapping:
 *
 *   - `rejected_no_target_mission` — **the C1 boundary rejection.** A
 *     habitat-scoped blocker pulse has no valid target Mission; the adapter
 *     refuses to create a Task under an invalid `missionId` (correcting the
 *     legacy data-integrity bug where `habitatId` was forwarded as `missionId`).
 *     NO attempt is reserved; NO Task is created. The pulse service (T11)
 *     surfaces this as a visible rejected-clearance pulse (the signal remains;
 *     the replacement path is an Automation Rule or manual creation under an
 *     explicit Mission). This is NOT hidden behind `blockerTaskCreated: false`
 *     — it is a typed, truthful signal.
 *   - `created` (recovering) — the clearance Task committed; the dispatcher +
 *     assignment coordinator advance it. The pulse service surfaces this as
 *     the linked clearance Task.
 *   - `vetoed` — **the visible blocked outcome.** A governance interceptor
 *     refused the clearance Task. The pulse service surfaces this as a
 *     blocked-clearance pulse + retry action.
 *   - `rejected_validation` — the rendered clearance title/description was
 *     invalid (e.g. empty subject after trimming). Terminal.
 *   - `replayed` — a same-pulse retry hit a terminal attempt; the stored
 *     terminal result is returned verbatim (no re-run).
 *   - `guard_mismatch` / `governance_denied` — resumable; the pulse service
 *     retries under the SAME key.
 *   - `rejected_fingerprint` — the rendered clearance payload changed under
 *     the same key; the pulse service uses a new key.
 */
export type BlockerClearancePublicationResult =
  | TaskCreationPublicationResult
  | {
      /**
       * The C1 boundary rejection: a habitat-scoped blocker pulse has no valid
       * target Mission, so the adapter creates NO Task and reserves NO attempt.
       */
      outcome: "rejected_no_target_mission";
      /** The pulse that was rejected (carried so the caller can surface it). */
      pulseId: string;
      /** The Habitat the pulse was scoped to. */
      habitatId: string;
      /**
       * Stable, surfaced reason the caller shows on the pulse. Not hidden
       * behind a boolean — a typed, truthful rejection signal.
       */
      reason: string;
    };

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The blocker-clearance scope discriminator — the C1 boundary signal.
 *
 * Mirrors the legacy `isHabitatScope` boolean on `createBlockerClearanceTask`
 * (pulseService.ts:233-236): the trusted pulse service already knows whether
 * it is posting a mission-scoped pulse (`postMissionPulseSignal`) or a
 * habitat-scoped pulse (`postHabitatPulseSignal`). The adapter trusts this
 * discriminator rather than re-deriving scope from the `parentId` (which is
 * the legacy data-integrity bug — `habitatId` was passed as `missionId`).
 *
 *   - `{ kind: "mission"; missionId }` — the blocker is mission-scoped; the
 *     clearance Task targets that Mission and migrates through the full
 *     publication chain.
 *   - `{ kind: "habitat" }` — the blocker is habitat-scoped (no target
 *     Mission); the adapter returns `rejected_no_target_mission` WITHOUT
 *     entering the kernel chain (C1).
 */
export type BlockerClearanceScope = { kind: "mission"; missionId: string } | { kind: "habitat" };

/**
 * Input for {@link publishBlockerClearanceTask} — the blocker-clearance
 * publication command.
 *
 * # Server-constructed provenance
 *
 * The caller (the future T11 pulse-service wiring) supplies the pulse identity
 * + content. The adapter constructs `actor` (system), `auditSource`
 * (`"system"`), and `causalContext` (`{ root: { type: "blocker_pulse", id:
 * pulseId } }`) from these — the input does NOT expose `actor`, `auditSource`,
 * `causalContext`, or `prospectiveTaskId` fields. Untrusted callers cannot
 * assert privileged pulse or actor identities.
 *
 * # Attempt identity is server-derived
 *
 * The attempt key derives deterministically from the pulse id (the Origin
 * Migration Matrix row: "the originating run plus action index/identity" — for
 * blocker, the pulse id IS the run, and the single clearance action is the
 * action). Same-pulse replay cannot create twice (the reservation replays the
 * terminal outcome).
 *
 * # The adapter constructs the clearance Task shape
 *
 * The clearance title (`"Clear Blocker: <subject>"`) + description (the
 * blocker body + source-signal reference + optional blocked-task reference)
 * are constructed by the adapter from the pulse fields — preserving the legacy
 * `createBlockerClearanceTask` (pulseService.ts:239-250) construction exactly.
 * The caller does NOT pass a rendered title/description; it passes the raw
 * pulse content and the adapter owns the clearance-task template. The priority
 * (`"high"`) + label (`"blocker-clearance"`) are likewise adapter-owned.
 */
export interface PublishBlockerClearanceTaskInput {
  // --- server-constructed pulse identity (attempt key derives from these) ---
  /**
   * The blocker pulse id. Becomes the causal-root id
   * (`blocker_pulse:<pulseId>`) and the attempt-reservation scope
   * (`sourceScopeId`). One blocker pulse produces at most one clearance Task.
   */
  pulseId: string;
  /**
   * The Habitat the pulse was posted to. The authoritative Habitat for the
   * publication chain; the kernel's same-Habitat Mission check enforces the
   * target Mission (when mission-scoped) belongs to it.
   */
  habitatId: string;
  /**
   * The clearance scope — the C1 boundary signal. See
   * {@link BlockerClearanceScope}.
   */
  scope: BlockerClearanceScope;

  // --- pulse content (the adapter constructs the clearance Task shape) ---
  /** The blocker pulse subject — becomes the clearance Task title suffix. */
  pulseSubject: string;
  /** The blocker pulse body — included in the clearance Task description. */
  pulseBody?: string;
  /**
   * Optional: the Task the blocker is blocking (mission-scoped pulses may
   * reference a Task). Included in the clearance Task description. Ignored for
   * habitat-scoped pulses (the C1 rejection short-circuits before this is
   * read).
   */
  blockedTaskId?: string;

  // --- assignment intent ---
  /**
   * `targeted` when the clearance Task should be reserved for a specific agent
   * (e.g. the blocker's `toAgentId`); `auto` otherwise. For `targeted`,
   * {@link targetedAssignmentDeadline} is REQUIRED (the coordinator owns no
   * deadline configuration).
   */
  assignment: AssignmentIntent;
  /**
   * Bounded recovery deadline for a targeted assignment. REQUIRED when
   * `assignment.kind === "targeted"`; IGNORED when `kind === "auto"`.
   */
  targetedAssignmentDeadline?: string;
}

// ---------------------------------------------------------------------------
// Internal constants + provenance
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a blocker-clearance publication.
 *
 * Preserves the legacy `createdBy: "system"` (pulseService.ts:258) as
 * structured provenance — the {@link AuditActorRef} carries it with
 * `type: "system"`. The adapter stamps it; untrusted callers cannot assert
 * this. The id is the more descriptive `"blocker-clearance"` (vs the legacy
 * generic `"system"`) for observability — the structure (`{type: "system",
 * id: …}`) is what makes it structured provenance, replacing the legacy bare
 * string.
 */
const BLOCKER_ACTOR_ID = "blocker-clearance";

/**
 * The origin channel for a blocker-clearance publication.
 *
 * `"system"` is the valid `AuditSource` enum value that matches the legacy
 * origin (the clearance Task is auto-created by the system in response to a
 * blocker pulse; there is no `"blocker"` source in `AUDIT_SOURCES`). It is
 * more faithful than `"workflow"` (which the Recovery adapter uses because the
 * legacy Recovery sourceType was `"workflow"`) — the blocker path has no
 * workflow association. The adapter stamps it; the input does not expose
 * `auditSource`.
 */
const BLOCKER_AUDIT_SOURCE: AuditSource = "system";

/**
 * The causal-root type for a blocker-clearance publication.
 *
 * The root id is the blocker {@link PublishBlockerClearanceTaskInput.pulseId}.
 * A fresh root per pulse — no inherited hops (the pulse is itself the
 * originating action). See the ticket § "Server-constructed provenance":
 * `{root:{type:"blocker_pulse", id:<pulseId>}}`.
 */
const BLOCKER_CAUSAL_ROOT_TYPE = "blocker_pulse";

/**
 * The single action kind a blocker pulse produces: one clearance Task per
 * pulse. Combined with {@link PublishBlockerClearanceTaskInput.pulseId} as the
 * `sourceScopeId`, this forms the stable attempt key — same-pulse replay hits
 * the same `(source, sourceScopeKind, sourceScopeId, attemptKey)` reservation
 * and replays the terminal outcome.
 */
const BLOCKER_CLEARANCE_ATTEMPT_KEY = "clearance";

/**
 * The clearance Task priority — preserves the legacy `priority: "high"`
 * (pulseService.ts:256). A blocker-clearance Task is always high-priority;
 * the caller does not override this.
 */
const BLOCKER_CLEARANCE_PRIORITY: TaskPriority = "high";

/**
 * The clearance Task label — preserves the legacy `labels: ["blocker-clearance"]`
 * (pulseService.ts:257). Carries the clearance origin on the Task row for
 * filtering + observability; the caller does not override this.
 */
const BLOCKER_CLEARANCE_LABEL = "blocker-clearance";

/**
 * The stable reason the C1 rejection carries. Surfaced on the pulse so the
 * replacement path (Automation Rule / manual creation under an explicit
 * Mission) is discoverable. Not a validation error — a design boundary.
 */
const REJECTED_NO_TARGET_MISSION_REASON =
  "Habitat-scoped blocker pulses do not target a Mission; no clearance Task is auto-created. " +
  "Use an Automation Rule or create a Task manually under an explicit Mission.";

/**
 * Default targeted-assignment reservation window when the caller omits
 * {@link PublishBlockerClearanceTaskInput.targetedAssignmentDeadline}.
 *
 * Mirrors the interactive adapter's default. The reservation deadline is
 * caller-supplied (the coordinator owns no deadline configuration); the pulse
 * service (T11) resolves it from app/config.
 */
// Config-backed via ORCY_ASSIGNMENT_DEADLINE_MS (see creationPublicationCutover.ts).

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Renders the clearance Task title from the pulse subject — preserves the
 * legacy `"Clear Blocker: ${pulse.subject}"` (pulseService.ts:254).
 */
function renderClearanceTitle(pulseSubject: string): string {
  return `Clear Blocker: ${pulseSubject}`;
}

/**
 * Renders the clearance Task description from the pulse content — preserves
 * the legacy description-line construction (pulseService.ts:239-250). The
 * source-signal line carries the pulse id (the durable provenance link the
 * caller can follow to the pulse); the blocked-task line is included when the
 * blocker references a specific Task.
 */
function renderClearanceDescription(input: PublishBlockerClearanceTaskInput): string {
  const lines = [
    "Auto-generated blocker clearance task.",
    "",
    `Blocker: ${input.pulseBody ?? ""}`,
    "",
    `Source signal: ${input.pulseId}`,
  ];
  if (input.blockedTaskId) {
    lines.push(`Blocked task: ${input.blockedTaskId}`);
  }
  return lines.join("\n");
}

/**
 * Computes the canonical request fingerprint for a blocker-clearance
 * publication.
 *
 * The fingerprint covers the RENDERED clearance payload + target Mission +
 * assignment intent (so a same-pulse retry with the same pulse content
 * replays; a pulse edit or target change produces a different fingerprint →
 * `rejected_fingerprint` on the same key, forcing a new key). It EXCLUDES
 * provenance (actor/source/pulseId) — the pulse id is the reservation scope,
 * not the payload.
 *
 * Deterministic: object keys sorted recursively; unordered arrays
 * (requiredCapabilities) sorted before hashing. Mirrors the interactive +
 * Recovery adapters' `computeRequestFingerprint` shape.
 */
function computeBlockerFingerprint(input: PublishBlockerClearanceTaskInput): string {
  // Only mission-scoped publications reach the fingerprint (habitat-scoped
  // short-circuits at the C1 boundary before reserving). The target Mission
  // is therefore always present here.
  const targetMissionId = input.scope.kind === "mission" ? input.scope.missionId : "";
  const payload = {
    targetMissionId,
    title: renderClearanceTitle(input.pulseSubject),
    description: renderClearanceDescription(input),
    priority: BLOCKER_CLEARANCE_PRIORITY,
    labels: [BLOCKER_CLEARANCE_LABEL],
    assignment:
      input.assignment.kind === "auto"
        ? { kind: "auto" }
        : { kind: "targeted", agentId: input.assignment.agentId },
  };
  return "blocker:" + stableHash(stableStringify(payload));
}

/** Deterministic JSON serializer — sorted object keys, stable array order. */
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
 * Terminalizes a `pending` attempt with a domain rejection and returns the
 * matching adapter result. Runs in its own short transaction (the single CAS
 * UPDATE is atomic on `getDb()`). Mirrors the interactive + Recovery adapters.
 */
function terminalizeDomainRejection(
  attemptId: string,
  finalState: "rejected_validation" | "vetoed",
  terminal: AttemptTerminalResult,
): void {
  completeAttemptWithClient(getDb(), attemptId, {
    terminalOutcome: finalState,
    terminalResult: terminal,
    finalState,
  });
}

// ---------------------------------------------------------------------------
// Recovering-replay re-read (reconstructs the committed publication)
// ---------------------------------------------------------------------------

/**
 * Re-reads a committed blocker-clearance publication from the durable envelope
 * row tied to an attempt.
 *
 * Used on the recovering-replay path (same-pulse retry hits an attempt at
 * `published_pending_observation` or `published_pending_assignment`): the
 * aggregate already committed inside the publication transaction, so the
 * adapter does NOT re-publish — it reconstructs the {@link CommittedPublication}
 * from the rows the coordinator wrote (keyed by `attemptId` on the envelope +
 * reservation rows).
 *
 * Mirrors the interactive + Recovery adapters' `readCommittedPublication`.
 */
function readCommittedBlockerPublication(
  db: TaskPublicationDbClient,
  attemptId: string,
): CommittedPublication | null {
  const envelope = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.attemptId, attemptId))
    .all()[0];
  if (!envelope) return null;

  const task = db.select().from(tasks).where(eq(tasks.id, envelope.taskId)).all()[0];
  if (!task) return null;

  const event =
    db.select().from(taskEvents).where(eq(taskEvents.id, envelope.eventId)).all()[0] ?? null;
  const subtasks = db.select().from(taskSubtasks).where(eq(taskSubtasks.taskId, task.id)).all();
  const dependencies = db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, task.id))
    .all();
  const dispatchTargets = db
    .select()
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.eventId, envelope.eventId))
    .all();
  const reservation =
    db
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.attemptId, attemptId))
      .all()[0] ?? null;

  return {
    task,
    event,
    subtasks,
    dependencies,
    envelope,
    dispatchTargets,
    reservation,
    recalculationMarker: { missionId: task.missionId, reason: "task_published" },
    checkpoint: { outcome: "transitioned" as const, attempt: { id: attemptId } as never },
  } as CommittedPublication;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the kernel chain for a blocker-clearance Task publication.
 *
 * The caller (the future T11 pulse-service wiring, DORMANT until then) supplies
 * the blocker pulse identity + content, the clearance scope (mission vs
 * habitat), and the assignment intent. The adapter:
 *   0. **C1 scope check** — if habitat-scoped, returns `rejected_no_target_mission`
 *      WITHOUT reserving an attempt or creating a Task (the defining behavior);
 *   1. resolves server-constructed provenance (system actor, `"system"` source,
 *      `blocker_pulse:<pulseId>` causal root);
 *   2. derives the deterministic attempt key from the pulse id;
 *   3. renders the clearance Task title/description from the pulse content
 *      (preserving the legacy `createBlockerClearanceTask` template);
 *   4. reserves the attempt;
 *   5. prepares the canonical proposal (PURE validation);
 *   6. governs it through the prospective `taskCreated` interceptors;
 *   7. publishes atomically inside one transaction;
 *   8. maps the outcome to the shared {@link BlockerClearancePublicationResult}.
 *
 * # Visible outcome
 *
 * NEVER returns `null` (the legacy path's swallowed error) and NEVER hides the
 * C1 boundary rejection behind a boolean. Every expected publication decision
 * is a typed result branch. The `rejected_no_target_mission` branch is the C1
 * signal the pulse service surfaces as a rejected-clearance pulse; the
 * `vetoed` branch is the visible blocked outcome. Infrastructure failures (a
 * repository throw) propagate as retryable runtime errors; the attempt stays
 * in whatever non-terminal state it reached, resumable under the same key.
 *
 * DORMANT: no production pulse-service caller until T11.
 */
export function publishBlockerClearanceTask(
  input: PublishBlockerClearanceTaskInput,
): BlockerClearancePublicationResult {
  const db = getDb();

  // ----- 0. C1 BOUNDARY: habitat-scoped rejection --------------------------
  // A habitat-scoped blocker pulse has NO valid target Mission. The legacy
  // path forwards the `habitatId` as `missionId` (a data-integrity bug —
  // gap-audit O2 + cold-critique C1). This adapter corrects it at the
  // boundary: NO attempt reserved, NO Task created. The signal remains as a
  // visible pulse; the replacement path is an Automation Rule or manual
  // creation under an explicit Mission.
  //
  // The rejection is a typed result — NOT hidden behind `blockerTaskCreated:
  // false` (the legacy boolean cannot distinguish "boundary rejected" from
  // "creation failed"). The caller surfaces it truthfully.
  //
  // Runs BEFORE field validation (cold-review #2 N3): a habitat-scoped pulse
  // should immediately reject without evaluating irrelevant fields (empty
  // subject, targeted-agent, deadline). The scope is the primary gate.
  if (input.scope.kind === "habitat") {
    return {
      outcome: "rejected_no_target_mission",
      pulseId: input.pulseId,
      habitatId: input.habitatId,
      reason: REJECTED_NO_TARGET_MISSION_REASON,
    };
  }

  // ----- 0a. Input validation ----------------------------------------------
  // Field-level validation runs AFTER the scope gate so a habitat-scoped pulse
  // with irrelevant-field anomalies still produces the scope rejection (not a
  // validation error the caller would mistake for a fixable field bug).
  if (input.pulseId.trim().length === 0) {
    throw new Error("publishBlockerClearanceTask: pulseId must be a non-empty string");
  }
  if (input.pulseSubject.trim().length === 0) {
    throw new Error("publishBlockerClearanceTask: pulseSubject must be a non-empty string");
  }
  if (input.assignment.kind === "targeted") {
    if (input.assignment.agentId.trim().length === 0) {
      throw new Error(
        "publishBlockerClearanceTask: assignment.kind === 'targeted' requires a non-empty agentId",
      );
    }
  }

  // Mission-scoped — the clearance Task targets this Mission.
  const targetMissionId = input.scope.missionId;

  // ----- 0b. Server-constructed provenance ----------------------------------
  // Untrusted callers cannot assert these. The actor id preserves the legacy
  // system-origin identity (more descriptive than the bare "system" string for
  // observability); the source is the faithful enum value; the causal root is
  // a fresh root per pulse (no inherited hops).
  const actor: AuditActorRef = { type: "system", id: BLOCKER_ACTOR_ID };
  const auditSource: AuditSource = BLOCKER_AUDIT_SOURCE;
  const causalContext: CausalContext = {
    root: { type: BLOCKER_CAUSAL_ROOT_TYPE, id: input.pulseId },
  };

  const requestedAssigneeId =
    input.assignment.kind === "targeted" ? input.assignment.agentId : null;

  // The attempt identity is server-derived from the pulse (Origin Migration
  // Matrix: "the originating run plus action index/identity"). The pulse id is
  // the run (sourceScopeId); the single clearance action is the action
  // (attemptKey). Same-pulse replay hits the same reservation key → replays
  // the stored terminal outcome (no duplicate Task).
  const requestFingerprint = computeBlockerFingerprint(input);

  // ----- 1. RESERVE the attempt ---------------------------------------------
  const reservation = reserveAttemptWithClient(db, {
    source: auditSource,
    sourceScopeKind: "blocker_pulse",
    sourceScopeId: input.pulseId,
    attemptKey: BLOCKER_CLEARANCE_ATTEMPT_KEY,
    requestFingerprint,
    publicationKind: "create",
    habitatId: input.habitatId,
    actorType: "system",
    actorId: BLOCKER_ACTOR_ID,
    causalContext,
  });

  // 1a. Fingerprint mismatch → deterministic rejection (the pulse content or
  //     target changed under the same key). The caller must use a new key.
  if (reservation.outcome === "rejected_fingerprint") {
    return {
      outcome: "rejected_fingerprint",
      attemptId: reservation.attempt.id,
      reservedFingerprint: reservation.reservedFingerprint,
    };
  }

  const attempt = reservation.attempt;

  // 1b. REPLAY of a TERMINAL attempt → return the stored terminal result
  //     verbatim. NO governance, NO publish, NO side effect runs. This is the
  //     idempotent-retry guardrail for the pulse service: a same-pulse retry
  //     after a terminal outcome replays without re-running the publication
  //     side effects.
  if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
    const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
      outcome: attempt.terminalOutcome ?? attempt.state,
    };
    return { outcome: "replayed", attemptId: attempt.id, terminal };
  }

  // 1c. REPLAY of a RECOVERING attempt (post-publish, pre-terminalization).
  //     The aggregate already committed; the adapter does NOT re-publish. The
  //     dispatcher + assignment coordinator advance the checkpoint; the
  //     terminal `created` surfaces via same-pulse replay once they settle.
  if (
    attempt.state === "published_pending_observation" ||
    attempt.state === "published_pending_assignment"
  ) {
    const committed = readCommittedBlockerPublication(db, attempt.id);
    if (committed) {
      return {
        outcome: "created",
        attemptId: attempt.id,
        publication: committed,
        recovering: true,
        recoveringState: attempt.state as
          | "published_pending_observation"
          | "published_pending_assignment",
      };
    }
    // Data anomaly — fall through to the resume path (defensive).
  }

  // 1d. FRESH or PENDING-RESUME attempt → run the prepare → govern → publish
  //     chain under this key. The chain is idempotent because the governance
  //     decision ledger reuses matching decisions and the publication tx
  //     refuses to advance a non-pending attempt.

  // ----- 2. PREPARE (PURE validation + canonicalization) --------------------
  // The clearance title/description are RENDERED here (preserving the legacy
  // `createBlockerClearanceTask` template). The priority + label are
  // adapter-owned constants (a clearance Task is always high-priority +
  // labeled `blocker-clearance`).
  const prepareInput: PrepareTaskPublicationInput = {
    habitatId: input.habitatId,
    targetMissionId,
    title: renderClearanceTitle(input.pulseSubject),
    description: renderClearanceDescription(input),
    priority: BLOCKER_CLEARANCE_PRIORITY,
    labels: [BLOCKER_CLEARANCE_LABEL],
    requestedAssigneeId,
    actor,
    auditSource,
    causalContext,
    initialEventAction: "created",
  };

  const prepared = prepareTaskPublication(prepareInput);

  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish. Persist the terminal
    // result so a same-pulse retry replays it.
    const terminal: AttemptTerminalResult = {
      outcome: "rejected_validation",
      attemptId: attempt.id,
      errors: prepared.errors,
    };
    terminalizeDomainRejection(attempt.id, "rejected_validation", terminal);
    return { outcome: "rejected_validation", attemptId: attempt.id, errors: prepared.errors };
  }

  // ----- 3. GOVERN (prospective taskCreated interceptors) -------------------
  // The clearance Task gets prospective governance. The legacy service-layer
  // path already fired pre-interceptors (O2 — "best-behaved" system origin),
  // but this is the first time the prospective governance DECISION is recorded
  // in the durable ledger + tied to the attempt. A governance veto is the
  // visible blocked outcome the pulse service surfaces.
  const governance = governTaskPublication({
    attemptId: attempt.id,
    tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
    db,
  });

  const governed = governance.results[0];
  if (governed.outcome === "vetoed") {
    // Terminal governance refusal — NO publish. Persist + return the typed
    // blocked outcome (NOT the swallowed null the legacy path returns).
    const terminal: AttemptTerminalResult = {
      outcome: "vetoed",
      attemptId: attempt.id,
      veto: {
        interceptorKey: governed.veto.interceptorKey,
        decision: governed.veto.decision,
        reason: governed.veto.reason,
        pluginRunId: governed.veto.pluginRunId,
      },
    };
    terminalizeDomainRejection(attempt.id, "vetoed", terminal);
    return {
      outcome: "vetoed",
      attemptId: attempt.id,
      veto: {
        interceptorKey: governed.veto.interceptorKey,
        reason: governed.veto.reason,
        pluginRunId: governed.veto.pluginRunId,
      },
    };
  }

  // ----- 4. PUBLISH (atomic, inside one transaction) ------------------------
  // No participant (P2 keeps it simpler than Recovery — the pulse↔Task link is
  // durable in provenance via the causal root; the T11 wiring adds the
  // denormalized `pulse.linkedTaskId` field if needed). Pass reservation ONLY
  // for a targeted intent.
  const reservationDirective =
    input.assignment.kind === "targeted"
      ? {
          deadline:
            input.targetedAssignmentDeadline ??
            new Date(Date.now() + getDefaultAssignmentDeadlineMs()).toISOString(),
        }
      : undefined;

  let publishOutcome: ReturnType<typeof publishTaskWithClient>;
  db.transaction((tx) => {
    publishOutcome = publishTaskWithClient(tx, {
      attemptId: attempt.id,
      proposal: prepared.proposal,
      guard: prepared.guard,
      ...(reservationDirective ? { reservation: reservationDirective } : {}),
    });
  });
  // (db.transaction is synchronous in better-sqlite3 / sql.js; publishOutcome
  // is assigned inside the callback before the call returns.)

  // 4a. Guard drift between prepare and publish → resumable. The attempt
  //     stays `pending`; the pulse service retries under the SAME key.
  if (publishOutcome!.outcome === "guard_mismatch") {
    return {
      outcome: "guard_mismatch",
      attemptId: attempt.id,
      reasons: publishOutcome!.reasons,
    };
  }

  // 4b. Stale governance decision at commit → resumable. Re-govern under the
  //     same key on retry.
  if (publishOutcome!.outcome === "governance_denied") {
    return {
      outcome: "governance_denied",
      attemptId: attempt.id,
      kind: publishOutcome!.kind,
      reason: publishOutcome!.reason,
      ...(publishOutcome!.interceptorKey !== undefined
        ? { interceptorKey: publishOutcome!.interceptorKey }
        : {}),
    };
  }

  // 4c. Published — the clearance Task aggregate committed. The attempt is at
  //     `published_pending_observation` (RECOVERING, not terminal): the
  //     dispatcher advances observation, then the assignment coordinator
  //     resolves a targeted reservation. The pulse service surfaces this as
  //     the linked clearance Task.
  return {
    outcome: "created",
    attemptId: attempt.id,
    publication: publishOutcome!.publication,
    recovering: true,
    recoveringState: "published_pending_observation",
  };
}
