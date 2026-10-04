/**
 * Workflow-Recovery Task Publication Adapter.
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for the Workflow-Recovery origin (the `on_fail` gate's spawned recovery
 * Task). Called by the `RecoveryCoordinator` (boot-only reconciliation pass
 * over durable `task_recovery_handoffs` rows). ADR-0042 documents the
 * fail-closed atomicity contract governing this path.
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
 *     that today leaves an unlinked Recovery Task (the pre-deepening
 *     path performed these as separate non-atomic steps; the C2
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
 * The pre-deepening path swallowed every error → `null`. This adapter returns a TYPED result for every
 * expected publication decision. The `vetoed` branch is the visible blocked
 * outcome the failure handler (T11) translates into the Recovery run's
 * blocked/unrecoverable state + retry action. Infrastructure failures still
 * propagate as retryable throws (the attempt stays resumable under the same
 * key).
 *
 * Replaced the pre-deepening spawn path in
 * the failure handler; live since the Task-creation cutover (T11) landed in
 * v0.32.0.
 *
 * See: Task Creation and Clone Technical Plan § "Origin Migration Matrix";
 * Story-2 implementation-context § "Story 1 kernel API surface" + § "Shared
 * contracts"; gap-audit O3; cold-critique C2.
 */
import { and, eq, sql } from "drizzle-orm";
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
  taskCreationAttempts,
  taskWorkflowGates,
  failureContexts,
  missions,
  workflows,
} from "../db/schema/index.js";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
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
import { stableStringify, stableHash } from "@orcy/shared";

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

    // ----- 0. Preimage + scope prechecks (INSIDE the publication tx, BEFORE
    //      the first gate INSERT / pointer UPDATE / context UPDATE).
    //
    //      The ORIGINAL gate is selected by exact id and its persisted
    //      Workflow/current Mission/Habitat plus both endpoint Tasks must
    //      satisfy the Mission-scoped invariant; the linkage descriptor must
    //      match that persisted original (W/M/H/D/depth); the original
    //      recovery pointer must still be null; the new Recovery Task's
    //      PERSISTED row (not the ctx.task snapshot) must belong to the same
    //      Mission; and a non-null optional Failure Context must exist with
    //      failedTaskId === the captured exact original upstream U and a
    //      null-or-this-Q pointer. The exact original upstream U is captured
    //      as part of the preimage so the final statements cannot silently
    //      adopt a changed upstream U2. Captured context Habitat/Workflow is
    //      historical — it is deliberately NOT compared to the current M/H.
    const original = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, linkage.gateId))
      .get();
    if (!original) {
      throw new Error(
        `buildRecoveryLinkageParticipant: original gate ${linkage.gateId} does not exist; refusing Recovery linkage`,
      );
    }
    const selectedUpstreamTaskId = original.upstreamTaskId;

    if (
      original.workflowId !== linkage.workflowId ||
      original.missionId !== linkage.missionId ||
      original.habitatId !== linkage.habitatId ||
      original.downstreamTaskId !== linkage.downstreamTaskId ||
      original.recoveryDepth !== linkage.recoveryDepth
    ) {
      throw new Error(
        `buildRecoveryLinkageParticipant: linkage descriptor does not match persisted original gate ${linkage.gateId} (W/M/H/D/depth mismatch); refusing Recovery linkage`,
      );
    }

    const scopeMission = db
      .select({ id: missions.id, habitatId: missions.habitatId })
      .from(missions)
      .where(eq(missions.id, linkage.missionId))
      .get();
    if (!scopeMission || scopeMission.habitatId !== linkage.habitatId) {
      throw new Error(
        `buildRecoveryLinkageParticipant: Mission ${linkage.missionId} does not persist in Habitat ${linkage.habitatId}; refusing Recovery linkage`,
      );
    }

    const scopeWorkflow = db
      .select({ missionId: workflows.missionId, habitatId: workflows.habitatId })
      .from(workflows)
      .where(eq(workflows.id, linkage.workflowId))
      .get();
    if (
      !scopeWorkflow ||
      scopeWorkflow.missionId !== linkage.missionId ||
      scopeWorkflow.habitatId !== linkage.habitatId
    ) {
      throw new Error(
        `buildRecoveryLinkageParticipant: Workflow ${linkage.workflowId} does not persist naming Mission ${linkage.missionId}/Habitat ${linkage.habitatId}; refusing Recovery linkage`,
      );
    }

    for (const [label, taskId] of [
      ["original upstream", selectedUpstreamTaskId],
      ["original downstream", linkage.downstreamTaskId],
      ["new recovery Task", recoveryTaskId],
    ] as const) {
      const persisted = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.missionId, linkage.missionId)))
        .get();
      if (!persisted) {
        throw new Error(
          `buildRecoveryLinkageParticipant: ${label} ${taskId} does not persist in Mission ${linkage.missionId}; refusing Recovery linkage`,
        );
      }
    }

    if (original.recoveryTaskId !== null) {
      throw new Error(
        `buildRecoveryLinkageParticipant: gate ${linkage.gateId} already links Recovery Task ${original.recoveryTaskId}; refusing re-linkage`,
      );
    }

    // Supplied-but-empty context IDs are NOT absence (an empty exact ID has no
    // matching row) — only undefined/null is a legitimately absent context; a
    // supplied "" flows into the precheck/final predicates and refuses there.
    const hasContextId = linkage.failureContextId != null;
    if (linkage.failureContextId != null) {
      const contextRow = db
        .select({
          failedTaskId: failureContexts.failedTaskId,
          recoveryTaskId: failureContexts.recoveryTaskId,
        })
        .from(failureContexts)
        .where(eq(failureContexts.id, linkage.failureContextId))
        .get();
      if (!contextRow || contextRow.failedTaskId !== selectedUpstreamTaskId) {
        throw new Error(
          `buildRecoveryLinkageParticipant: failure context ${linkage.failureContextId} is missing or its failedTaskId is not the original upstream ${selectedUpstreamTaskId}; refusing Recovery linkage`,
        );
      }
      if (contextRow.recoveryTaskId !== null && contextRow.recoveryTaskId !== recoveryTaskId) {
        throw new Error(
          `buildRecoveryLinkageParticipant: failure context ${linkage.failureContextId} already links Recovery Task ${contextRow.recoveryTaskId}; refusing Recovery linkage`,
        );
      }
    }

    // ----- 1. FINAL conditional next-depth on_fail gate INSERT. The new
    //      gate's upstream is the RECOVERY task (so it only fires if the
    //      recovery itself fails, enabling recovery-of-recovery chains) and
    //      its downstream mirrors the original gate's downstream (a
    //      successful recovery unblocks the same downstream Task). The
    //      statement repeats the required scope/preimage predicates —
    //      including the still-null original pointer and the optional
    //      context subject/pointer — so a drift between precheck and this
    //      write is a zero-match that throws and rolls back the whole
    //      publication aggregate.
    const nextGateId = cryptoRandomUuid();
    const contextPredicate = hasContextId
      ? sql` AND EXISTS (
            SELECT 1 FROM failure_contexts fc
            WHERE fc.id = ${linkage.failureContextId}
              AND fc.failed_task_id = ${selectedUpstreamTaskId}
              AND (fc.recovery_task_id IS NULL OR fc.recovery_task_id = ${recoveryTaskId})
          )`
      : sql``;
    db.get(sql`
      INSERT INTO task_workflow_gates (
        id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id,
        gate_type, match_config, condition, satisfied, recovery_task_id, recovery_depth
      )
      SELECT
        ${nextGateId}, ${linkage.workflowId}, ${linkage.missionId}, ${linkage.habitatId},
        ${recoveryTaskId}, ${linkage.downstreamTaskId}, 'on_fail', NULL, NULL, 0, NULL,
        ${linkage.recoveryDepth + 1}
      FROM task_workflow_gates g
      JOIN workflows w ON w.id = g.workflow_id AND w.id = ${linkage.workflowId}
        AND w.mission_id = ${linkage.missionId} AND w.habitat_id = ${linkage.habitatId}
      JOIN missions m ON m.id = g.mission_id AND m.id = ${linkage.missionId} AND m.habitat_id = ${linkage.habitatId}
      WHERE g.id = ${linkage.gateId}
        AND g.workflow_id = ${linkage.workflowId}
        AND g.mission_id = ${linkage.missionId}
        AND g.habitat_id = ${linkage.habitatId}
        AND g.upstream_task_id = ${selectedUpstreamTaskId}
        AND g.downstream_task_id = ${linkage.downstreamTaskId}
        AND g.recovery_depth = ${linkage.recoveryDepth}
        AND g.recovery_task_id IS NULL
        AND EXISTS (SELECT 1 FROM tasks tu WHERE tu.id = g.upstream_task_id AND tu.mission_id = ${linkage.missionId})
        AND EXISTS (SELECT 1 FROM tasks tq WHERE tq.id = ${recoveryTaskId} AND tq.mission_id = ${linkage.missionId})
        AND EXISTS (SELECT 1 FROM tasks td WHERE td.id = ${linkage.downstreamTaskId} AND td.mission_id = ${linkage.missionId})
        AND EXISTS (SELECT 1 FROM habitats hh WHERE hh.id = ${linkage.habitatId})
        ${contextPredicate}
      RETURNING id
    `);
    const nextGateAffected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    if (nextGateAffected !== 1) {
      throw new Error(
        `buildRecoveryLinkageParticipant: next-depth gate insert matched no rows — the original gate/scope/Q/context preimage drifted before the final statement; the publication aggregate rolls back`,
      );
    }

    // ----- 2. Link the ORIGINAL gate back to the spawned Recovery Task.
    //      COMPARE-AND-SET carrying the FULL selected preimage (id + W/M/H +
    //      original upstream U + downstream D + depth) and requiring the
    //      still-null pointer: exactly one attempt can win. Two distinct
    //      Recovery attempts for the same gate race here; the loser matches
    //      zero rows → throw inside the participant → the whole publication
    //      aggregate rolls back (no Task, no event, no next-depth gate, no
    //      linkage). Alongside the gate scalars it repeats the whole
    //      statement-time containment: the persisted Workflow's Mission/
    //      Habitat, each endpoint and the new Q Task's Mission, AND the
    //      selected Mission M still persisting in the selected Habitat H
    //      (with H existing) — so a Mission reparented into another valid
    //      Habitat after the next-gate INSERT cannot be adopted here even
    //      though every scalar and every Task membership still equals M.
    //      The immediate same-client `SELECT changes() AS n` (the kernel's
    //      portable CAS-classification pattern) proves the single matched
    //      row on both drivers — never `.run().changes` (boolean under
    //      sql.js) and never the RETURNING projection (a truthy empty object
    //      under sql.js on a zero-match).
    db.get<{ id: string }>(sql`
      UPDATE task_workflow_gates
      SET recovery_task_id = ${recoveryTaskId}
      WHERE id = ${linkage.gateId}
        AND workflow_id = ${linkage.workflowId}
        AND mission_id = ${linkage.missionId}
        AND habitat_id = ${linkage.habitatId}
        AND upstream_task_id = ${selectedUpstreamTaskId}
        AND downstream_task_id = ${linkage.downstreamTaskId}
        AND recovery_depth = ${linkage.recoveryDepth}
        AND recovery_task_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM workflows w2
          WHERE w2.id = ${linkage.workflowId}
            AND w2.id = workflow_id
            AND w2.mission_id = ${linkage.missionId}
            AND w2.habitat_id = ${linkage.habitatId}
        )
        AND EXISTS (SELECT 1 FROM tasks tu2 WHERE tu2.id = upstream_task_id AND tu2.mission_id = ${linkage.missionId})
        AND EXISTS (SELECT 1 FROM tasks td2 WHERE td2.id = downstream_task_id AND td2.mission_id = ${linkage.missionId})
        AND EXISTS (SELECT 1 FROM tasks tq2 WHERE tq2.id = ${recoveryTaskId} AND tq2.mission_id = ${linkage.missionId})
        AND EXISTS (
          SELECT 1
          FROM missions m2
          WHERE m2.id = ${linkage.missionId}
            AND m2.habitat_id = ${linkage.habitatId}
            AND EXISTS (SELECT 1 FROM habitats h2 WHERE h2.id = m2.habitat_id)
        )
      RETURNING id
    `);
    const gateCasAffected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    if (gateCasAffected !== 1) {
      throw new Error(
        `buildRecoveryLinkageParticipant: gate ${linkage.gateId} lost its recovery-pointer CAS (already linked, or scope/preimage drifted); the publication aggregate rolls back`,
      );
    }

    // ----- 3. Link the optional Failure Context to the Recovery Task. The
    //      final UPDATE repeats the subject pair (context id + selected
    //      original upstream U) and admits only a null-or-this-Q pointer; an
    //      unrelated existing pointer is a linkage conflict, not silent
    //      success (and not a stolen overwrite). SQLite `changes()` counts
    //      every WHERE-matched row (including a same-Q idempotent re-write),
    //      so the exact-one check holds on the same-Q match too. A no-match
    //      on either driver throws and rolls back the aggregate. Null
    //      optional context remains legitimate: no linkage write occurs.
    if (hasContextId) {
      db.get<{ id: string }>(sql`
        UPDATE failure_contexts
        SET recovery_task_id = ${recoveryTaskId}
        WHERE id = ${linkage.failureContextId}
          AND failed_task_id = ${selectedUpstreamTaskId}
          AND (recovery_task_id IS NULL OR recovery_task_id = ${recoveryTaskId})
        RETURNING id
      `);
      const contextLinkAffected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
      if (contextLinkAffected !== 1) {
        throw new Error(
          `buildRecoveryLinkageParticipant: failure-context link for ${linkage.failureContextId} matched no rows (missing/foreign subject or a different pointer); the publication aggregate rolls back`,
        );
      }
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
    requiredCapabilities: [...(input.requiredCapabilities ?? [])].toSorted(),
    assignment:
      input.assignment.kind === "auto"
        ? { kind: "auto" }
        : { kind: "targeted", agentId: input.assignment.agentId },
    // The linkage gate is part of the payload identity — a same-key retry that
    // changes which gate is being linked is a different publication.
    linkageGateId: input.linkage.gateId,
    linkageDownstreamTaskId: input.linkage.downstreamTaskId,
    linkageWorkflowId: input.linkage.workflowId,
    linkageRecoveryDepth: input.linkage.recoveryDepth,
    linkageFailureContextId: input.linkage.failureContextId ?? null,
    targetedAssignmentDeadline: input.targetedAssignmentDeadline ?? null,
  };
  return "recovery:" + stableHash(stableStringify(payload));
}

/** Deterministic JSON serializer — sorted object keys, stable array order. */
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
 * The caller (the future T11 failure-handler wiring)
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

  const attemptRow = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  if (!attemptRow) return null;

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
    checkpoint: { outcome: "transitioned" as const, attempt: attemptRow },
  };
}
