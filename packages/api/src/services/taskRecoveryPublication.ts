/**
 * Workflow-Recovery Task Publication Adapter (T8A-pre Phase 1 — DORMANT).
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for the Workflow-Recovery origin (the `on_fail` gate's spawned recovery
 * Task). This is the dormant replacement for the legacy raw-insert path
 * (`workflowService.ts:471 createRecoveryTask` + the failure-handler's
 * separate gate/linkage/failure-context writes at `spawnRecoveryForGate`
 * L262-367). It ships ALONGSIDE the legacy path and is exercised ONLY by tests
 * until the global cutover (T11) swaps the failure handler onto it.
 *
 * # Why a new adapter (not an extension of `publishTaskCreation`)
 *
 * `publishTaskCreation` is the documented *interactive* origin adapter
 * (UI/REST/MCP): client-supplied attempt key, human/agent actor, REST/MCP
 * audit source, and NO `participants?` passthrough. The Recovery origin
 * differs structurally on every axis:
 *
 *   - **Provenance is system-constructed.** The actor is the workflow-Recovery
 *     system identity (`workflow-recovery`), the source is `"workflow"` (a
 *     valid `AuditSource`; there is no `"workflow_recovery"` enum value), and
 *     the causal root is the Recovery run (`workflow_recovery:<runId>`).
 *   - **Attempt identity is server-derived** from the Recovery run + action
 *     (the Origin Migration Matrix row: "Automation/plugin/recovery → the
 *     originating run plus action index/identity") — NOT a client-supplied
 *     retry key.
 *   - **The C2 atomic participant seam is the defining feature.** The gate
 *     insertion + `recoveryTaskId` linkage + failure-context record commit in
 *     the SAME transaction as the Recovery Task — eliminating the crash window
 *     that today leaves an unlinked Recovery Task (legacy `spawnRecoveryForGate`
 *     performs these as 5 separate non-atomic steps AFTER the raw insert).
 *
 * Both adapters compose the SAME kernel chain (reserve → prepare → govern →
 * publish) using the SAME kernel functions; DRY is preserved at the
 * composition level. Extending `publishTaskCreation` with `participants?`
 * would couple the interactive adapter to Recovery's atomicity contract and
 * leak Recovery-domain linkage fields into the interactive input type.
 *
 * # First-time history + governance (gap-audit O3 correction)
 *
 * The legacy `createRecoveryTask` calls `taskCrudRepo.createTask` directly —
 * NO `created` Lifecycle Event, NO prospective governance, NO service-layer
 * traversal. The Recovery Task produced by THIS adapter gets all three FOR THE
 * FIRST TIME, inherited from the kernel:
 *
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
 *   1. RESERVE the attempt (server-derived `(source, sourceScope, attemptKey)`
 *      + canonical request fingerprint) via {@link reserveAttemptWithClient}.
 *   2. PREPARE via {@link prepareTaskPublication} (PURE). On
 *      `rejected_validation` → terminalize + return.
 *   3. GOVERN via {@link governTaskPublication}. On a decisive veto →
 *      terminalize + return `vetoed` (the visible blocked outcome).
 *   4. PUBLISH via `db.transaction((tx) => publishTaskWithClient(tx, ...))`
 *      with the C2 linkage {@link ParticipantWriter}. Pass `reservation`
 *      ONLY when the assignment intent is targeted (the handler's
 *     `agentSelector.assignedAgentId`).
 *
 * # C2 atomic participants (the crash-window elimination)
 *
 * The three linkage writes the legacy failure handler performed as separate
 * non-atomic steps AFTER the raw insert move INTO the participant so they
 * commit in the SAME tx as the Recovery Task:
 *
 *   1. **Insert the next-depth `on_fail` gate** (`taskWorkflowGates` row with
 *      `upstreamTaskId = recoveryTask.id`, `recoveryDepth = gate.depth + 1`).
 *      The new gate's upstream is the RECOVERY task so it fires only if the
 *      recovery itself fails (enabling recovery-of-recovery chains).
 *   2. **Link the original gate** (`taskWorkflowGates.recoveryTaskId =
 *      recoveryTask.id`) — the idempotency marker that prevents re-spawning.
 *   3. **Link the failure-context** (`failureContexts.recoveryTaskId =
 *      recoveryTask.id`) when a failure-context row exists — the denormalized
 *      convenience field the recovery agent consumes.
 *
 * A participant throw (or any write failure inside it) rolls back the whole
 * aggregate (Task + event + subtasks + dependencies + gate + linkage +
 * failure-context). The crash window is eliminated: either the full linkage
 * commits with the Recovery Task, or nothing does.
 *
 * # Visible blocked outcome (not a swallowed null)
 *
 * The legacy path swallows every error → `null` (`createRecoveryTask` catch,
 * `spawnRecoveryForGate` catch). This adapter returns a TYPED result for every
 * expected publication decision. The `vetoed` branch is the visible blocked
 * outcome the failure handler (T11) translates into the Recovery run's
 * blocked/unrecoverable state + retry action. Infrastructure failures still
 * propagate as retryable throws (the attempt stays resumable under the same
 * key).
 *
 * DORMANT: no production failure-handler call routes through this adapter
 * yet. Legacy `createRecoveryTask` + `spawnRecoveryForGate` stay the active
 * production path until T11.
 *
 * See: Task Creation and Clone Technical Plan § "Origin Migration Matrix";
 * Story-2 implementation-context § "Story 1 kernel API surface" + § "Shared
 * contracts"; gap-audit O3; cold-critique C2.
 */
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext } from "@orcy/shared";
import { getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
  taskWorkflowGates,
  failureContexts,
} from "../db/schema/index.js";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
  type PublicationError,
} from "./taskPublicationPreparation.js";
import { governTaskPublication } from "./taskPublicationGovernance.js";
import {
  publishTaskWithClient,
  type ParticipantWriter,
  type CommittedPublication,
} from "./taskPublicationCoordinator.js";
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
 * The Recovery publication result envelope.
 *
 * Structurally identical to {@link TaskCreationPublicationResult}: every branch
 * is an origin-neutral publication outcome. The Recovery-domain mapping:
 *
 *   - `created` (recovering) — the Recovery Task committed; the dispatcher +
 *     assignment coordinator advance it. The failure handler (T11) surfaces
 *     this as the Recovery run's "spawned" state.
 *   - `vetoed` — **the visible blocked outcome.** A governance interceptor
 *     refused the Recovery Task. The failure handler translates this into the
 *     Recovery run's blocked/unrecoverable state + a retry action (NOT the
 *     swallowed `null` the legacy path returns on every error).
 *   - `rejected_validation` — the rendered template produced an invalid Task
 *     (e.g. empty title after substitution). Terminal; the handler surfaces a
 *     configuration error.
 *   - `replayed` — a same-`(runId, actionKey)` retry hit a terminal attempt;
 *     the stored terminal result is returned verbatim (no re-run).
 *   - `guard_mismatch` / `governance_denied` — resumable; the handler retries
 *     under the SAME key.
 *   - `rejected_fingerprint` — the rendered template changed under the same
 *     key; the handler uses a new key.
 */
export type RecoveryTaskPublicationResult = TaskCreationPublicationResult;

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The C2 atomic linkage descriptor — the three writes that commit in the SAME
 * transaction as the Recovery Task via the {@link ParticipantWriter} seam.
 *
 * Each field mirrors an EXACT write the legacy failure handler
 * (`spawnRecoveryForGate` L321-347) performed as a separate non-atomic step
 * AFTER the raw insert. Moving them into the participant eliminates the crash
 * window: either the full linkage commits with the Recovery Task, or nothing
 * does.
 */
export interface RecoveryLinkage {
  /**
   * The id of the ORIGINAL `on_fail` gate that fired. The participant stamps
   * this gate's `recoveryTaskId` with the new Recovery Task's id — the
   * idempotency marker that prevents re-spawning for the same gate.
   */
  gateId: string;
  /** The workflow the gate belongs to (carried to the next-depth gate). */
  workflowId: string;
  /**
   * The Habitat the gate belongs to. The `tasks` table has no `habitatId`
   * column (habitat is inferred via the Mission), so the participant reads it
   * from the linkage descriptor — the caller has it on the gate object.
   */
  habitatId: string;
  /**
   * The Mission the gate belongs to. Carried to the next-depth gate row. The
   * `tasks` row carries `missionId` too, but the gate's Mission is the
   * authoritative scope for the gate row and is carried here for faithfulness
   * to the legacy `spawnRecoveryForGate` insert (which read it from the gate).
   */
  missionId: string;
  /** The gate's downstream Task — mirrored on the next-depth gate. */
  downstreamTaskId: string;
  /** The ORIGINAL gate's `recoveryDepth`. The next-depth gate is `+1`. */
  recoveryDepth: number;
  /**
   * Optional: the failure-context row id built by `handleFailureCapture`
   * BEFORE the recovery spawn. When present, the participant links it
   * (`failureContexts.recoveryTaskId = recoveryTask.id`). Absent when no
   * failure-context was built (e.g. the action does not map to a failure
   * kind) — no linkage write occurs.
   */
  failureContextId?: string;
}

/**
 * Input for {@link publishRecoveryTask} — the Workflow-Recovery publication
 * command.
 *
 * # Server-constructed provenance
 *
 * The caller (the future T11 failure-handler wiring) supplies the Recovery-run
 * identity (`runId`, `actionKey`) and the rendered work definition. The adapter
 * constructs `actor` (`workflow-recovery`), `auditSource` (`"workflow"`), and
 * `causalContext` (`{ root: { type: "workflow_recovery", id: runId } }`) from
 * these — the input does NOT expose `actor`, `auditSource`, `causalContext`,
 * or `prospectiveTaskId` fields. Untrusted callers cannot assert privileged
 * Recovery-run or actor identities.
 *
 * # Attempt identity is server-derived
 *
 * The attempt key derives deterministically from `(runId, actionKey)` (the
 * Origin Migration Matrix row). Same-run/action replay cannot create twice
 * (the reservation replays the terminal outcome); a different action under
 * the same run creates a distinct attempt.
 *
 * # The caller resolves the template BEFORE calling
 *
 * The adapter is origin-neutral about template rendering. The caller
 * substitutes the failure-handler's `recoveryTaskTemplate` variables
 * (`{{failedTaskId}}`, `{{failedTaskTitle}}`, etc.) via `substituteTemplate`
 * and passes the rendered `title`/`description` + the handler's
 * `agentSelector.requiredCapabilities`/`requiredDomain`/`assignedAgentId`.
 */
export interface PublishRecoveryTaskInput {
  // --- server-constructed run identity (attempt key derives from these) ---
  /**
   * The Recovery-run identity. Becomes the causal-root id
   * (`workflow_recovery:<runId>`) and the attempt-reservation scope
   * (`sourceScopeId`). Typically the gate id or a dedicated Recovery-run id —
   * whatever the failure handler treats as the stable run identifier.
   */
  runId: string;
  /**
   * The action identity within the Recovery run (an action index or label).
   * Combined with `runId` to derive the deterministic attempt key. A different
   * action under the same run creates a distinct attempt (no collision).
   */
  actionKey: string;

  // --- target scope (the failed Task's Habitat + Mission) ---
  habitatId: string;
  /**
   * The failed Task's Mission — the Recovery Task's target. Carried into the
   * canonical proposal; the kernel's target-Mission scope check enforces it is
   * active + in the right Habitat.
   */
  targetMissionId: string;

  // --- rendered work definition (caller substitutes the template first) ---
  title: string;
  description?: string;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];

  // --- assignment intent (the handler's agentSelector) ---
  /**
   * `targeted` when the handler's `agentSelector.assignedAgentId` is present
   * (the Recovery Task is reserved for that agent); `auto` otherwise. For
   * `targeted`, {@link targetedAssignmentDeadline} is REQUIRED (the coordinator
   * owns no deadline configuration).
   */
  assignment: AssignmentIntent;
  /**
   * Bounded recovery deadline for a targeted assignment. REQUIRED when
   * `assignment.kind === "targeted"`; IGNORED when `kind === "auto"`.
   */
  targetedAssignmentDeadline?: string;

  // --- C2 atomic linkage (the participant seam body) ---
  /**
   * The three linkage writes that commit atomically with the Recovery Task via
   * the {@link ParticipantWriter} seam. See {@link RecoveryLinkage}.
   */
  linkage: RecoveryLinkage;
}

// ---------------------------------------------------------------------------
// Internal constants + provenance
// ---------------------------------------------------------------------------

/**
 * The system actor identity for a Workflow-Recovery publication.
 *
 * Preserves the legacy `createdBy: "workflow-recovery"` as structured
 * provenance — the {@link AuditActorRef} carries it with `type: "system"`.
 * Untrusted callers cannot assert this; the adapter stamps it.
 */
const RECOVERY_ACTOR_ID = "workflow-recovery";

/**
 * The origin channel for a Workflow-Recovery publication.
 *
 * `"workflow"` is the valid `AuditSource` enum value (there is no
 * `"workflow_recovery"` in `AUDIT_SOURCES`). It matches the legacy
 * notification `sourceType: "workflow"` + the audit projection
 * `source: "workflow"`. The adapter stamps it; the input does not expose
 * `auditSource`.
 */
const RECOVERY_AUDIT_SOURCE: AuditSource = "workflow";

/**
 * The causal-root type for a Workflow-Recovery publication.
 *
 * The root id is the Recovery {@link PublishRecoveryTaskInput.runId}. A fresh
 * root per Recovery run — no inherited hops (the Recovery run is itself the
 * originating action, not a chained continuation). See CausalContext § "root
 * is the originating action: ... workflow recovery run".
 */
const RECOVERY_CAUSAL_ROOT_TYPE = "workflow_recovery";

/**
 * Default targeted-assignment reservation window when the caller omits
 * {@link PublishRecoveryTaskInput.targetedAssignmentDeadline}.
 *
 * Mirrors the interactive adapter's default. The reservation deadline is
 * caller-supplied (the coordinator owns no deadline configuration); the
 * failure handler (T11) resolves it from app/config.
 */
// Config-backed via ORCY_ASSIGNMENT_DEADLINE_MS (see creationPublicationCutover.ts).

// ---------------------------------------------------------------------------
// C2 atomic participant (the ONLY domain-extension point usage)
// ---------------------------------------------------------------------------

/**
 * Builds the C2 atomic linkage participant — the three writes that commit in
 * the SAME publication transaction as the Recovery Task.
 *
 * This is the faithful translation of the legacy `spawnRecoveryForGate`
 * L321-347 writes INTO the {@link ParticipantWriter} seam. Each write moves
 * from a separate non-atomic `getDb()` step to an in-tx write on the passed
 * client; a throw at ANY of the three rolls back the whole aggregate (Task +
 * event + subtasks + dependencies + gate + linkage + failure-context).
 *
 * Exported so the C2 atomicity guardrail can exercise each write boundary in
 * isolation (failure-injection at the participant gate-insert / gate-update /
 * failure-context-update boundaries proves zero unlinked Recovery Tasks). The
 * adapter composes this internally; production callers never reference it.
 *
 * @param linkage the C2 linkage descriptor (see {@link RecoveryLinkage}).
 * @returns the {@link ParticipantWriter} the adapter passes to
 *   `publishTaskWithClient`.
 */
export function buildRecoveryLinkageParticipant(linkage: RecoveryLinkage): ParticipantWriter {
  return (db, ctx) => {
    const recoveryTaskId = ctx.task.id;

    // 1. Insert the next-depth on_fail gate. The new gate's upstream is the
    //    RECOVERY task (so it only fires if the recovery itself fails, enabling
    //    recovery-of-recovery chains rather than re-firing on every repeat of
    //    the original failure event). The downstream mirrors the original
    //    gate's downstream so a successful recovery also unblocks the same
    //    downstream task (consistent with F4 redemption semantics).
    //
    //    Mirrors legacy `spawnRecoveryForGate` L321-335 exactly, except the
    //    write targets the tx client `db` (not `getDb()`).
    db.insert(taskWorkflowGates)
      .values({
        id: cryptoRandomUuid(),
        workflowId: linkage.workflowId,
        missionId: linkage.missionId,
        habitatId: linkage.habitatId,
        upstreamTaskId: recoveryTaskId,
        downstreamTaskId: linkage.downstreamTaskId,
        gateType: "on_fail",
        matchConfig: null,
        condition: null,
        satisfied: false,
        recoveryDepth: linkage.recoveryDepth + 1,
      })
      .run();

    // 2. Link the original gate back to the spawned recovery task. This is a
    //    COMPARE-AND-SET claim: `WHERE recovery_task_id IS NULL` ensures
    //    exactly one attempt can win the gate (cold-review #2 M1). Two
    //    distinct Recovery attempts for the same gate (different runIds →
    //    different attempt keys) race here; the loser's CAS matches zero rows
    //    → throw inside the participant → the whole publication aggregate
    //    rolls back (no Task, no event, no next-depth gate, no linkage). The
    //    losing attempt's failure handler surfaces the gate-already-linked
    //    rejection cleanly.
    //
    //    `SELECT changes() AS n` is the kernel's portable CAS-classification
    //    pattern (same as `completeAttemptWithClient`,
    //    `consumeAssignmentReservationWithClient`, etc.).
    db.update(taskWorkflowGates)
      .set({ recoveryTaskId })
      .where(
        and(eq(taskWorkflowGates.id, linkage.gateId), isNull(taskWorkflowGates.recoveryTaskId)),
      )
      .run();
    const gateCasAffected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    if (gateCasAffected === 0) {
      throw new Error(
        `buildRecoveryLinkageParticipant: gate ${linkage.gateId} is already linked to another Recovery Task; ` +
          `the publication aggregate rolls back (CAS loser).`,
      );
    }

    // 3. Link the failure context (if one was just built) to the recovery
    //    task. The failure-context row is built by `handleFailureCapture`
    //    BEFORE the recovery spawn; this participant write updates its
    //    denormalized `recoveryTaskId` field. Skipped when no failure-context
    //    exists (the action did not map to a failure kind) — the conditional
    //    `if (ctx)` guard from legacy L344-347.
    //
    //    The legacy path called `failureContextService.linkRecoveryTask` which
    //    routes through `failureContextRepo.updateFailureContext` → `getDb()`.
    //    That escapes the publication tx, so the participant writes the update
    //    directly on the tx client to preserve atomicity. A failure-context
    //    row is a plain UPDATE on `failureContexts` by id — no service-layer
    //    logic is bypassed (the repo's `updateFailureContext` is itself a
    //    thin partial-update wrapper).
    if (linkage.failureContextId) {
      db.update(failureContexts)
        .set({ recoveryTaskId })
        .where(eq(failureContexts.id, linkage.failureContextId))
        .run();
    }
  };
}

/**
 * Generates a UUID for the next-depth gate row.
 *
 * Uses the same `crypto.randomUUID()` surface as the legacy
 * `spawnRecoveryForGate` insert (`crypto.randomUUID()`), isolated here so the
 * participant body reads as pure data-over-effect.
 */
function cryptoRandomUuid(): string {
  // node:crypto.randomUUID is available on the global `crypto` in Node ≥ 19.
  // The legacy path uses `crypto.randomUUID()` from the node import; this
  // wrapper keeps the participant portable.
  return (
    (globalThis as { crypto?: { randomUUID: () => string } }).crypto?.randomUUID() ??
    `gate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for a Recovery publication.
 *
 * The fingerprint covers the RENDERED work definition + target + assignment +
 * the linkage gate (so a same-gate retry with the same rendered template
 * replays; a template or handler-config change produces a different fingerprint
 * → `rejected_fingerprint` on the same key, forcing the handler to use a new
 * key). It EXCLUDES provenance (actor/source/runId) — the run identity is the
 * reservation scope, not the payload.
 *
 * Deterministic: object keys sorted recursively; unordered arrays
 * (requiredCapabilities) sorted before hashing. Mirrors the interactive
 * adapter's `computeRequestFingerprint` shape.
 */
function computeRecoveryFingerprint(input: PublishRecoveryTaskInput): string {
  const payload = {
    targetMissionId: input.targetMissionId,
    title: input.title,
    description: input.description ?? "",
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: [...(input.requiredCapabilities ?? [])].sort(),
    assignment:
      input.assignment.kind === "auto"
        ? { kind: "auto" }
        : { kind: "targeted", agentId: input.assignment.agentId },
    // The linkage gate is part of the payload identity — a same-key retry that
    // changes which gate is being linked is a different publication.
    linkageGateId: input.linkage.gateId,
    linkageDownstreamTaskId: input.linkage.downstreamTaskId,
  };
  return "recovery:" + stableHash(stableStringify(payload));
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
 * UPDATE is atomic on `getDb()`). Mirrors the interactive adapter.
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the kernel chain for a Workflow-Recovery Task publication.
 *
 * The caller (the future T11 failure-handler wiring, DORMANT until then)
 * supplies the Recovery-run identity, the target scope (the failed Task's
 * Habitat + Mission), the rendered work definition (template already
 * substituted), the assignment intent, and the C2 linkage descriptor. The
 * adapter:
 *   1. resolves server-constructed provenance (system actor, `"workflow"`
 *      source, `workflow_recovery:<runId>` causal root);
 *   2. derives the deterministic attempt key from `(runId, actionKey)`;
 *   3. reserves the attempt;
 *   4. prepares the canonical proposal (PURE validation);
 *   5. governs it through the prospective `taskCreated` interceptors;
 *   6. publishes atomically inside one transaction WITH the C2 linkage
 *      participant (gate insert + original-gate link + failure-context link);
 *   7. maps the outcome to the shared {@link RecoveryTaskPublicationResult}.
 *
 * # Visible blocked outcome
 *
 * NEVER returns `null` (the legacy path's swallowed error). Every expected
 * publication decision is a typed result branch. The `vetoed` branch is the
 * visible blocked outcome the failure handler translates into the Recovery
 * run's blocked/unrecoverable state + retry action. Infrastructure failures
 * (a repository throw) propagate as retryable runtime errors; the attempt
 * stays in whatever non-terminal state it reached, resumable under the same
 * key.
 *
 * DORMANT: no production caller until T11.
 */
export function publishRecoveryTask(
  input: PublishRecoveryTaskInput,
): RecoveryTaskPublicationResult {
  const db = getDb();

  // ----- 0. Input validation + provenance resolution (server-constructed) ----
  if (input.runId.trim().length === 0) {
    throw new Error("publishRecoveryTask: runId must be a non-empty string");
  }
  if (input.actionKey.trim().length === 0) {
    throw new Error("publishRecoveryTask: actionKey must be a non-empty string");
  }
  if (input.assignment.kind === "targeted") {
    if (input.assignment.agentId.trim().length === 0) {
      throw new Error(
        "publishRecoveryTask: assignment.kind === 'targeted' requires a non-empty agentId",
      );
    }
    if (input.targetedAssignmentDeadline === undefined) {
      throw new Error(
        "publishRecoveryTask: assignment.kind === 'targeted' requires targetedAssignmentDeadline " +
          "(the configured reservation window). Pass an ISO timestamp from app/config.",
      );
    }
  }

  // Server-constructed provenance — untrusted callers cannot assert these.
  const actor: AuditActorRef = { type: "system", id: RECOVERY_ACTOR_ID };
  const auditSource: AuditSource = RECOVERY_AUDIT_SOURCE;
  const causalContext: CausalContext = {
    root: { type: RECOVERY_CAUSAL_ROOT_TYPE, id: input.runId },
  };

  const requestedAssigneeId =
    input.assignment.kind === "targeted" ? input.assignment.agentId : null;

  // The attempt identity is server-derived from the Recovery run + action
  // (Origin Migration Matrix: "the originating run plus action index/identity").
  // Same-run/action replay hits the same reservation key → replays the stored
  // terminal outcome (no duplicate Task). A different action under the same
  // run creates a distinct attempt.
  const attemptKey = input.actionKey;
  const requestFingerprint = computeRecoveryFingerprint(input);

  // ----- 1. RESERVE the attempt --------------------------------------------
  const reservation = reserveAttemptWithClient(db, {
    source: auditSource,
    sourceScopeKind: "recovery_run",
    sourceScopeId: input.runId,
    attemptKey,
    requestFingerprint,
    publicationKind: "create",
    habitatId: input.habitatId,
    actorType: "system",
    actorId: RECOVERY_ACTOR_ID,
    causalContext,
  });

  // 1a. Fingerprint mismatch → deterministic rejection (the rendered template
  //     or handler config changed under the same key). The handler must use a
  //     new key.
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
  //     idempotent-retry guardrail for the failure handler: a same-`(runId,
  //     actionKey)` retry after a terminal outcome replays without re-running
  //     the publication side effects.
  if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
    const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
      outcome: attempt.terminalOutcome ?? attempt.state,
    };
    return { outcome: "replayed", attemptId: attempt.id, terminal };
  }

  // 1c. REPLAY of a RECOVERING attempt (post-publish, pre-terminalization).
  //     The aggregate already committed; the adapter does NOT re-publish. The
  //     dispatcher + assignment coordinator advance the checkpoint; the
  //     terminal `created` surfaces via same-key replay once they settle.
  //
  //     A re-read of the committed publication from the envelope row confirms
  //     something committed; if the data is anomalous the adapter falls
  //     through to the resume path (the prepare step re-validates).
  if (
    attempt.state === "published_pending_observation" ||
    attempt.state === "published_pending_assignment"
  ) {
    // Read the committed publication off the durable envelope row.
    const committed = readCommittedRecoveryPublication(db, attempt.id);
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

  // ----- 2. PREPARE (PURE validation + canonicalization) -------------------
  const prepareInput: PrepareTaskPublicationInput = {
    habitatId: input.habitatId,
    targetMissionId: input.targetMissionId,
    title: input.title,
    description: input.description,
    requiredDomain: input.requiredDomain,
    requiredCapabilities: input.requiredCapabilities,
    requestedAssigneeId,
    actor,
    auditSource,
    causalContext,
    initialEventAction: "created",
  };

  const prepared = prepareTaskPublication(prepareInput);

  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish. Persist the terminal
    // result so a same-key retry replays it.
    const terminal: AttemptTerminalResult = {
      outcome: "rejected_validation",
      attemptId: attempt.id,
      errors: prepared.errors,
    };
    terminalizeDomainRejection(attempt.id, "rejected_validation", terminal);
    return { outcome: "rejected_validation", attemptId: attempt.id, errors: prepared.errors };
  }

  // ----- 3. GOVERN (prospective taskCreated interceptors) ------------------
  // The Recovery Task gets prospective governance FOR THE FIRST TIME (the
  // legacy raw-insert path bypassed governance entirely). A governance veto
  // is the visible blocked outcome the failure handler surfaces.
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

  // ----- 4. PUBLISH (atomic, inside one transaction) -----------------------
  // The C2 linkage participant composes the gate insert + original-gate link +
  // failure-context link into the SAME tx as the Recovery Task. A participant
  // throw rolls back the whole aggregate — the crash window is eliminated.
  const reservationDirective =
    input.assignment.kind === "targeted"
      ? {
          deadline:
            input.targetedAssignmentDeadline ??
            new Date(Date.now() + getDefaultAssignmentDeadlineMs()).toISOString(),
        }
      : undefined;

  const participants = buildRecoveryLinkageParticipant(input.linkage);

  let publishOutcome: ReturnType<typeof publishTaskWithClient>;
  db.transaction((tx) => {
    publishOutcome = publishTaskWithClient(tx, {
      attemptId: attempt.id,
      proposal: prepared.proposal,
      guard: prepared.guard,
      participants,
      ...(reservationDirective ? { reservation: reservationDirective } : {}),
    });
  });
  // (db.transaction is synchronous in better-sqlite3 / sql.js; publishOutcome
  // is assigned inside the callback before the call returns.)

  // 4a. Guard drift between prepare and publish → resumable. The attempt
  //     stays `pending`; the handler retries under the SAME key.
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

  // 4c. Published — the Recovery Task aggregate committed WITH its C2 linkage
  //     (gate + original-gate link + failure-context link). The attempt is at
  //     `published_pending_observation` (RECOVERING, not terminal): the
  //     dispatcher advances observation, then the assignment coordinator
  //     resolves a targeted reservation. The failure handler surfaces this as
  //     the Recovery run's "spawned" state.
  return {
    outcome: "created",
    attemptId: attempt.id,
    publication: publishOutcome!.publication,
    recovering: true,
    recoveringState: "published_pending_observation",
  };
}

// ---------------------------------------------------------------------------
// Recovering-replay re-read (reconstructs the committed publication)
// ---------------------------------------------------------------------------

/**
 * Re-reads a committed Recovery publication from the durable envelope row tied
 * to an attempt.
 *
 * Used on the recovering-replay path (same-key retry hits an attempt at
 * `published_pending_observation` or `published_pending_assignment`): the
 * aggregate already committed inside the publication transaction, so the
 * adapter does NOT re-publish — it reconstructs the {@link CommittedPublication}
 * from the rows the coordinator wrote (keyed by `attemptId` on the envelope +
 * reservation rows).
 *
 * Mirrors the interactive adapter's `readCommittedPublication` (the re-read
 * shape is origin-neutral).
 */
function readCommittedRecoveryPublication(
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
    // The checkpoint transition is already durable on the attempt row; the
    // recovering-replay caller reads `recoveringState` from the adapter result.
    checkpoint: { outcome: "transitioned" as const, attempt: { id: attemptId } as never },
  } as CommittedPublication;
}
