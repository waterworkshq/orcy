/**
 * Canonical Task Publication Governance — prospective `taskCreated`
 * interceptor governance + decision-ledger reuse (T3B Phase 2).
 *
 * This is the "Governance adapter" boundary from the Task Creation and Clone
 * Technical Plan § "Governing boundaries":
 *
 *   Governance adapter — Freeze runtime admission and record reusable
 *   per-interceptor decisions against the final prospective proposal. MUST
 *   NOT: Require a persisted Task, rerun an identical decision, or let batch
 *   order change policy.
 *
 * Phase 2 is DORMANT: no production origin calls {@link governTaskPublication}
 * yet. It sits alongside the ADR-0039 managed plugin-invocation runtime (the
 * synchronous hot path every task transition uses) but reaches it ONLY through
 * the additive seam exported from `pluginManager.ts` —
 * {@link snapshotEnrolledPreInterceptors},
 * {@link makePreInterceptorTargetForGovernance}, and
 * {@link invokePreInterceptorForGovernance}. It does NOT modify
 * `runPreInterceptors`, `TransitionRef`, `InterceptorHandler`, or any runtime
 * internal.
 *
 * What this module does (in order, per the Technical Plan § "Governance-decision
 * ledger" and § "Optimistic publication guard"):
 *
 *   1. FREEZE BATCH ADMISSION before evaluating any Task: the enrolled
 *      `taskCreated` pre-interceptor list in priority order, each entry's
 *      contribution version, enrollment/configuration revision, and quarantine
 *      admission. A fault in one Task CANNOT alter admission for later Tasks in
 *      the SAME batch (the freeze is per-batch; quarantine updates from a
 *      Task's runtime faults still apply to LATER PUBLICATIONS — the runtime
 *      keeps incrementing counters, the frozen snapshot is what gates THIS
 *      batch).
 *   2. OVERWRITE the Phase-1 `interceptorEnrollmentFingerprint` sentinel on
 *      every Task's {@link PublicationGuard} with the real enrollment/config
 *      fingerprint computed from the frozen snapshot. No governed guard may
 *      carry `PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER` after this step.
 *   3. For EACH valid batch Task (in input order): iterate the frozen enrolled
 *      interceptors in priority order. For each (Task, interceptor): compute
 *      the deterministic governance fingerprint, look up a matching durable
 *      decision in the ledger, and either REUSE it (no new Plugin Run, no
 *      quarantine effect) or INVOKE the interceptor through the runtime +
 *      RECORD `allow|explicit_veto|failure_veto` + pluginRunId + diagnostics.
 *   4. FIRST-VETO-PER-TASK short-circuit: the first vetoing interceptor for a
 *      Task is that Task's decisive outcome; remaining interceptors for THAT
 *      Task are not invoked and not recorded. Every VALID batch Task is still
 *      evaluated so the batch result carries each Task's decisive outcome.
 *
 * See: Task Creation and Clone Technical Plan § "Prospective interceptor
 * contract", § "Governance-decision ledger", § "Optimistic publication guard";
 * ADR-0039 Q1 (bounded fail-closed), Q9 (canonical contribution identity),
 * Q13 (telemetry failure contract).
 */
import { createHash } from "node:crypto";
import type { InterceptorEvent, PluginCapabilityName } from "@orcy/shared";
import type { TransitionContext } from "./tasks/transition-emitter.js";
import type { InterceptorRegistryEntry } from "../plugins/contributionAdapters.js";
import type { PreVetoDecision } from "../plugins/invocationRuntime.js";
import {
  snapshotEnrolledPreInterceptors,
  makePreInterceptorTargetForGovernance,
  invokePreInterceptorForGovernance,
} from "../plugins/pluginManager.js";
import {
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type CanonicalTaskPublicationProposal,
  type PublicationGuard,
} from "./taskPublicationPreparation.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import {
  findGovernanceDecisionWithClient,
  recordGovernanceDecisionWithClient,
  type GovernanceDecisionRow,
  type GovernanceDecisionKind,
  type GovernanceDiagnostics,
} from "../repositories/taskPublicationGovernance.js";

// ---------------------------------------------------------------------------
// The governed event (Phase 2 owns taskCreated; the type is closed for now)
// ---------------------------------------------------------------------------

/** The governed event is always `taskCreated` in Phase 2. */
export const GOVERNED_EVENT: InterceptorEvent = "taskCreated";

// ---------------------------------------------------------------------------
// Deliverable 1 — ProspectiveTaskCreatedTransition + frozen-batch snapshot
// ---------------------------------------------------------------------------

/**
 * The discriminated PROSPECTIVE taskCreated transition (Technical Plan §
 * "Prospective interceptor contract"). This is NOT a type-widening of the
 * shared `TransitionRef` — it is a distinct governance-side type that reaches
 * the enrolled pre-handler via `TransitionContext.metadata` with
 * `context.task` absent (no Task exists yet).
 *
 * The same prospective Task ID reaches the runtime via the `taskId` slot of
 * the `PreVetoRequest` (passed by `invokePreInterceptorForGovernance`). A
 * handler that cares about prospective reads `context.metadata`; the runtime
 * contract is unchanged.
 */
export interface ProspectiveTaskCreatedTransition {
  /** Discriminator — always `"taskCreated"`. */
  action: "taskCreated";
  /** Discriminator — always `"prospective"` (no persisted Task exists). */
  state: "prospective";
  /** The prospective Task ID allocated before governance; becomes final on commit. */
  prospectiveTaskId: string;
  /** The attempt this governance pass records decisions against. */
  attemptId: string;
  /** The authoritative Habitat whose enrollment was frozen. */
  habitatId: string;
  /** The canonical prepared proposal being governed. */
  proposal: CanonicalTaskPublicationProposal;
}

/**
 * The frozen contribution snapshot for ONE enrolled interceptor. Captured at
 * freeze time so a re-preparation that sees a changed contribution
 * (re-registered plugin with different `priority`, `requires`, or `timeoutMs`)
 * produces a different fingerprint → a new decision revision.
 *
 * `LifecycleInterceptorContribution` has no explicit `version` field; the
 * contribution shape itself is the version. This snapshot captures the fields
 * that identify the contribution's governance-relevant behavior.
 */
export interface FrozenContributionSnapshot {
  interceptorId: string;
  phase: "pre" | "post";
  event: InterceptorEvent;
  priority: number;
  requires: PluginCapabilityName[];
  timeoutMs?: number;
}

/**
 * ONE enrolled interceptor's frozen admission record. Part of the per-batch
 * {@link FrozenBatchAdmissionSnapshot}.
 *
 * The {@link entry} field carries the LIVE registry entry (handler reference)
 * used at invocation time. It is NOT part of the fingerprint — the fingerprint
 * projects ONLY the identity fields above it. Holding the handler in the
 * per-batch in-memory snapshot means THIS batch invokes exactly the code
 * registered at freeze time (a re-registered plugin mid-batch does not change
 * what THIS batch invokes — the frozen-admission invariant).
 */
export interface FrozenEnrolledInterceptor {
  pluginId: string;
  /** Kind-local interceptorId (`contribution.interceptorId`). */
  contributionId: string;
  /**
   * The canonical kind-safe contribution key (ADR-0039 Q9):
   * `canonicalContributionKey({ contributionKind: "lifecycleInterceptor",
   * pluginId, contributionId: interceptorId, phase: "pre", event: "taskCreated" })`.
   * This is the `interceptorKey` the decision ledger records.
   */
  interceptorKey: string;
  /** Frozen priority (lower runs first — ADR-0014 ordering). */
  priority: number;
  /** The contribution version snapshot. */
  contributionSnapshot: FrozenContributionSnapshot;
  /**
   * Whether the contribution was quarantined at freeze time. Captured so the
   * fingerprint reflects the admission state the Task was evaluated against.
   * The runtime STILL increments quarantine counters during the batch; this
   * snapshot is what the FINGERPRINT covers.
   */
  quarantinedAtFreeze: boolean;
  /**
   * The live registry entry (handler + full contribution) used at invocation
   * time. NOT part of the fingerprint payload — the fingerprint projects only
   * the identity fields above. Holding the handler reference in the per-batch
   * in-memory snapshot means THIS batch invokes exactly the code registered at
   * freeze time, which is the frozen-admission invariant.
   */
  entry: InterceptorRegistryEntry;
}

/**
 * The per-batch frozen runtime-admission snapshot (Technical Plan §
 * "Governance-decision ledger" — "Batch publication freezes interceptor order,
 * enrollment/configuration, and quarantine admission before evaluating Tasks").
 *
 * Captured BEFORE evaluating any Task so a fault in one Task CANNOT alter
 * admission for later Tasks in the SAME batch. The freeze is PER-BATCH:
 * quarantine updates from a Task's runtime faults DO apply to LATER
 * PUBLICATIONS (the runtime keeps incrementing counters); the frozen snapshot
 * is what gates the rest of THIS batch's evaluation + what the fingerprint
 * covers.
 */
export interface FrozenBatchAdmissionSnapshot {
  /** The governed event (always `"taskCreated"` in Phase 2). */
  event: InterceptorEvent;
  /** The habitat whose enrollment/config was frozen. */
  habitatId: string;
  /**
   * The enrolled pre-interceptor entries in FROZEN priority order. This is a
   * per-batch copy — registry mutations after the freeze do not affect it.
   */
  enrolled: ReadonlyArray<FrozenEnrolledInterceptor>;
  /**
   * The enrollment/configuration fingerprint — a deterministic hash over the
   * enrolled set + each contribution's identity. This is what overwrites the
   * Phase-1 `PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER` sentinel on every
   * governed guard.
   */
  enrollmentFingerprint: string;
}

// ---------------------------------------------------------------------------
// Deliverable 2 — Governance fingerprint (deterministic serializer)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serializer — sorts object keys recursively and joins
 * arrays in given order. The output is byte-stable for the same logical
 * payload regardless of object key insertion order. Mirrors the
 * `stableStringify` approach in `middleware/idempotency.ts`.
 *
 * Callers pass already-sorted arrays for set-valued fields (labels, requires,
 * the enrolled list) so the fingerprint is stable across batch reordering too.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical stable-string serialization. */
function stableHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Projects a canonical proposal into the governance-relevant fields for the
 * fingerprint. Arrays of unordered items (labels, requiredCapabilities) are
 * SORTED so the fingerprint is invariant under set-reordering. Execution
 * history is excluded by the Phase-1 type; provenance (actor/auditSource/
 * causalContext/initialEventAction) is INCLUDED because it is part of the
 * governed identity (a clone vs a create of the same work-definition is a
 * different governance context).
 */
function proposalForFingerprint(p: CanonicalTaskPublicationProposal): unknown {
  return {
    prospectiveTaskId: p.prospectiveTaskId,
    habitatId: p.habitatId,
    targetMissionId: p.targetMissionId,
    title: p.title,
    description: p.description,
    priority: p.priority,
    labels: [...p.labels].sort(),
    requiredDomain: p.requiredDomain,
    requiredCapabilities: [...p.requiredCapabilities].sort(),
    estimatedMinutes: p.estimatedMinutes,
    subtasks: p.subtasks
      .map((s) => ({ title: s.title, order: s.order, assigneeId: s.assigneeId }))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    selectedDependencies: p.selectedDependencies.map((d) => d.dependsOnId).sort(),
    requestedAssigneeId: p.requestedAssigneeId,
    cloneSourceTaskId: p.cloneSourceTaskId,
    actor: p.actor,
    auditSource: p.auditSource,
    causalContext: p.causalContext,
    initialEventAction: p.initialEventAction,
  };
}

/**
 * Computes the enrollment/configuration fingerprint for a frozen batch — a
 * deterministic hash over the governed event, the habitat, and the enrolled
 * interceptor set with each contribution's identity + quarantine-admission
 * state.
 *
 * This is the value that OVERWRITES the Phase-1
 * `PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER` sentinel on every governed
 * guard. A guard still carrying the placeholder MUST NOT be authorized to
 * commit (Phase 3 enforces; Phase 2 ensures it is never left on a governed
 * guard).
 *
 * The enrolled list is sorted by `interceptorKey` (not priority) so the
 * fingerprint is stable under batch-reordering and registry insertion-order
 * drift. Priority ORDER still drives evaluation (first-veto); the fingerprint
 * captures identity + admission state, not evaluation order.
 */
export function computeEnrollmentFingerprint(snapshot: {
  event: InterceptorEvent;
  habitatId: string;
  enrolled: ReadonlyArray<FrozenEnrolledInterceptor>;
}): string {
  const payload = {
    event: snapshot.event,
    habitatId: snapshot.habitatId,
    enrolled: [...snapshot.enrolled]
      .map((e) => ({
        interceptorKey: e.interceptorKey,
        priority: e.priority,
        contributionSnapshot: e.contributionSnapshot,
        quarantinedAtFreeze: e.quarantinedAtFreeze,
      }))
      .sort((a, b) => a.interceptorKey.localeCompare(b.interceptorKey)),
  };
  return "enrollment:" + stableHash(payload);
}

/**
 * Computes the deterministic governance fingerprint for ONE
 * (prospective Task, interceptor) pair against the frozen batch-admission
 * snapshot. The fingerprint covers (Technical Plan § "Governance-decision
 * ledger"):
 *
 *   1. The canonical proposal (the Task's work-definition + provenance).
 *   2. The governance-relevant Mission/Habitat/dependency context from the
 *      Phase-1 {@link PublicationGuard} (mission identity/version/status,
 *      habitat, dependency-graph state).
 *   3. The interceptor contribution/version (the contributionSnapshot +
 *      canonicalKey for THIS interceptor).
 *   4. The enrollment/configuration revision (the batch-wide
 *      enrollmentFingerprint).
 *   5. The frozen runtime-admission snapshot (the full enrolled list's
 *      contributionSnapshots + quarantine admission).
 *
 * Determinism: the serializer uses {@link stableStringify} (sorted keys at
 * every level) + SHA-256. The same inputs ALWAYS produce the same fingerprint,
 * stable across retries and batch reordering. A genuinely changed proposal,
 * guard, contribution, enrollment, or admission state produces a DIFFERENT
 * fingerprint → a new decision revision under the still-pending attempt.
 */
export function computeGovernanceFingerprint(input: {
  proposal: CanonicalTaskPublicationProposal;
  guard: PublicationGuard;
  interceptor: FrozenEnrolledInterceptor;
  frozenAdmission: FrozenBatchAdmissionSnapshot;
}): string {
  const payload = {
    proposal: proposalForFingerprint(input.proposal),
    guard: {
      missionId: input.guard.missionId,
      missionVersion: input.guard.missionVersion,
      missionStatus: input.guard.missionStatus,
      habitatId: input.guard.habitatId,
      dependencies: input.guard.dependencies
        .map((d) => ({ taskId: d.taskId, version: d.version, status: d.status }))
        .sort((a, b) => a.taskId.localeCompare(b.taskId)),
    },
    interceptor: {
      interceptorKey: input.interceptor.interceptorKey,
      contributionSnapshot: input.interceptor.contributionSnapshot,
    },
    enrollmentFingerprint: input.frozenAdmission.enrollmentFingerprint,
    admission: [...input.frozenAdmission.enrolled]
      .map((e) => ({
        interceptorKey: e.interceptorKey,
        priority: e.priority,
        contributionSnapshot: e.contributionSnapshot,
        quarantinedAtFreeze: e.quarantinedAtFreeze,
      }))
      .sort((a, b) => a.interceptorKey.localeCompare(b.interceptorKey)),
  };
  return "gov:" + stableHash(payload);
}

// ---------------------------------------------------------------------------
// Deliverable 3 — per-Task / batch result types
// ---------------------------------------------------------------------------

/**
 * One decision recorded (or reused) against the ledger for a single
 * (Task, interceptor) pair. Carries the ledger row + a `reused` flag so the
 * caller can assert the reuse invariant (a reused decision created no new
 * Plugin Run).
 */
export interface RecordedGovernanceDecision {
  interceptorKey: string;
  decision: GovernanceDecisionKind;
  pluginRunId: string | null;
  diagnostics: GovernanceDiagnostics | null;
  /** True when the decision was REUSED from the ledger (no new Plugin Run). */
  reused: boolean;
}

/** The decisive outcome for one governed Task. */
export type GovernedTaskResult =
  | {
      prospectiveTaskId: string;
      outcome: "allowed";
      /** Every enrolled interceptor allowed (in frozen priority order). */
      decisions: RecordedGovernanceDecision[];
    }
  | {
      prospectiveTaskId: string;
      outcome: "vetoed";
      /** The first vetoing interceptor (the decisive veto for THIS Task). */
      veto: {
        interceptorKey: string;
        decision: Extract<GovernanceDecisionKind, "explicit_veto" | "failure_veto">;
        reason: string;
        pluginRunId: string | null;
      };
      /** Allow decisions recorded BEFORE the first veto short-circuited. */
      priorAllowDecisions: RecordedGovernanceDecision[];
    };

/** The batch governance result — each Task's decisive outcome + the freeze. */
export interface GovernanceBatchResult {
  /** Per-Task decisive outcome, in input order. */
  results: GovernedTaskResult[];
  /** The frozen batch-admission snapshot captured before evaluating any Task. */
  frozenAdmission: FrozenBatchAdmissionSnapshot;
}

// ---------------------------------------------------------------------------
// Deliverable 4+5+6 — governTaskPublication (frozen admission, ledger reuse,
//                     first-veto-per-Task, batch collection)
// ---------------------------------------------------------------------------

/** Input for {@link governTaskPublication}. */
export interface GovernTaskPublicationInput {
  /** The attempt this governance pass records decisions against. */
  attemptId: string;
  /**
   * The prepared proposals + guards from Phase 1 (one per Task in the batch).
   * Phase 2 governs EVERY valid batch Task so the batch result carries each
   * Task's decisive outcome. A Task whose preparation `rejected_validation`
   * never reaches governance.
   *
   * All tasks MUST share one `proposal.habitatId` — enrollment is
   * habitat-scoped and the freeze is per-habitat. Cross-habitat batches
   * (habitat import) are a later ticket and will call governance
   * per-habitat.
   */
  tasks: Array<{
    proposal: CanonicalTaskPublicationProposal;
    /** MUTATED IN PLACE: the sentinel is overwritten with the real fingerprint. */
    guard: PublicationGuard;
  }>;
  /**
   * The db client for the decision ledger. NOT the publication tx — decisions
   * persist across publication retries under the same pending attempt so
   * re-preparation can reuse them. Each decision insert is its own atomic
   * write; the caller does NOT wrap governance in a tx.
   */
  db: TaskPublicationDbClient;
}

/**
 * Builds a {@link FrozenEnrolledInterceptor} from a live registry entry +
 * quarantine state. Pure projection — the freeze captures identity +
 * admission state, not the handler reference (the handler is reached at
 * invocation time via `makePreInterceptorTargetForGovernance`).
 */
function freezeInterceptorEntry(
  entry: InterceptorRegistryEntry,
  quarantinedAtFreeze: boolean,
): FrozenEnrolledInterceptor {
  return {
    pluginId: entry.pluginId,
    contributionId: entry.contribution.interceptorId,
    interceptorKey: entry.canonicalKey,
    priority: entry.contribution.priority,
    contributionSnapshot: {
      interceptorId: entry.contribution.interceptorId,
      phase: entry.contribution.phase,
      event: entry.contribution.event,
      priority: entry.contribution.priority,
      requires: [...entry.contribution.requires],
      ...(entry.contribution.timeoutMs !== undefined
        ? { timeoutMs: entry.contribution.timeoutMs }
        : {}),
    },
    quarantinedAtFreeze,
    // The live registry entry (handler + full contribution). Used at
    // invocation time; NOT part of the fingerprint. Holding it in the
    // per-batch in-memory snapshot freezes the implementation THIS batch
    // invokes (a re-registered plugin mid-batch does not change THIS batch).
    entry,
  };
}

/**
 * Builds the prospective {@link TransitionContext} that reaches the enrolled
 * pre-handler. `context.task` is ABSENT (no Task exists yet). The prospective
 * proposal/attemptId markers travel in `context.metadata` so a handler that
 * cares about prospective can read them; the runtime contract is unchanged.
 */
function makeProspectiveTransitionContext(
  transition: ProspectiveTaskCreatedTransition,
): TransitionContext {
  return {
    newStatus: "pending",
    metadata: {
      prospective: true,
      prospectiveTaskId: transition.prospectiveTaskId,
      attemptId: transition.attemptId,
      habitatId: transition.habitatId,
      missionId: transition.proposal.targetMissionId,
      title: transition.proposal.title,
      proposal: proposalForMetadata(transition.proposal),
    },
  };
}

/**
 * Projects the proposal into the metadata payload carried by the prospective
 * TransitionContext. This is the governance-relevant view a pre-handler reads
 * to make a veto decision. Mirrors {@link proposalForFingerprint} but without
 * the sorting (metadata is for human/plugin consumption, not hashing).
 */
function proposalForMetadata(p: CanonicalTaskPublicationProposal): unknown {
  return {
    prospectiveTaskId: p.prospectiveTaskId,
    habitatId: p.habitatId,
    targetMissionId: p.targetMissionId,
    title: p.title,
    description: p.description,
    priority: p.priority,
    labels: p.labels,
    requiredDomain: p.requiredDomain,
    requiredCapabilities: p.requiredCapabilities,
    estimatedMinutes: p.estimatedMinutes,
    subtasks: p.subtasks,
    selectedDependencies: p.selectedDependencies,
    requestedAssigneeId: p.requestedAssigneeId,
    cloneSourceTaskId: p.cloneSourceTaskId,
    initialEventAction: p.initialEventAction,
  };
}

/**
 * Maps an ADR-0039 {@link PreVetoDecision} to the governance-ledger decision
 * kind + diagnostics. The runtime owns classification (bounded fail-closed —
 * Q1); this is a pure projection.
 */
function mapPreVetoToGovernanceDecision(preVeto: PreVetoDecision): {
  decision: GovernanceDecisionKind;
  pluginRunId: string | null;
  diagnostics: GovernanceDiagnostics;
} {
  if (preVeto.decision === "allow") {
    return {
      decision: "allow",
      pluginRunId: preVeto.runId,
      diagnostics: {
        startFailed: preVeto.startFailed,
        finishFailed: preVeto.finishFailed,
      },
    };
  }
  // veto — explicit or failure
  const reason = preVeto.message;
  const diagnostics: GovernanceDiagnostics = {
    reason,
    startFailed: preVeto.startFailed,
    finishFailed: preVeto.finishFailed,
    vetoReason: preVeto.vetoReason,
    ...(preVeto.vetoReason === "explicit" && preVeto.details !== undefined
      ? { details: preVeto.details }
      : {}),
  };
  return {
    decision: preVeto.vetoReason === "explicit" ? "explicit_veto" : "failure_veto",
    pluginRunId: preVeto.runId,
    diagnostics,
  };
}

/**
 * FREEZE BATCH ADMISSION: snapshots the enrolled `taskCreated` pre-interceptors
 * for the habitat in priority order and computes the enrollment/config
 * fingerprint. Called ONCE per batch, BEFORE evaluating any Task.
 *
 * Quarantine admission is captured per-entry via the exported
 * `clearQuarantine`-managed set indirectly — the governance module does NOT
 * reach into the private `quarantineSet`; instead the runtime's
 * `isQuarantined` check at invocation time is authoritative. The fingerprint
 * captures the enrollment/configuration identity; per-batch quarantine state
 * is reflected at invocation time by the runtime (a quarantined interceptor
 * the runtime skips → `allow` decision → recorded). This keeps the freeze
 * aligned with the live runtime authority without duplicating the quarantine
 * set.
 */
function freezeBatchAdmission(habitatId: string): FrozenBatchAdmissionSnapshot {
  const enrolled = snapshotEnrolledPreInterceptors(GOVERNED_EVENT, habitatId);
  const frozenEnrolled: FrozenEnrolledInterceptor[] = enrolled.map((entry) =>
    freezeInterceptorEntry(entry, false),
  );
  const enrollmentFingerprint = computeEnrollmentFingerprint({
    event: GOVERNED_EVENT,
    habitatId,
    enrolled: frozenEnrolled,
  });
  return {
    event: GOVERNED_EVENT,
    habitatId,
    enrolled: frozenEnrolled,
    enrollmentFingerprint,
  };
}

/**
 * DORMANT entry point — governs one batch of prepared Task proposals through
 * the prospective `taskCreated` pre-interceptors.
 *
 * Flow (Technical Plan § "Governance-decision ledger"):
 *   1. FREEZE batch admission (enrolled `taskCreated` interceptors in priority
 *      order + enrollment/config fingerprint) BEFORE evaluating any Task.
 *   2. OVERWRITE the Phase-1 `interceptorEnrollmentFingerprint` sentinel on
 *      every Task's guard with the real enrollment/config fingerprint.
 *   3. For EACH Task (input order): iterate frozen enrolled interceptors in
 *      priority order. Compute the governance fingerprint. Ledger HIT → REUSE
 *      (no new Plugin Run). MISS → invoke through the runtime + RECORD. First
 *      veto short-circuits THAT Task; remaining interceptors for that Task are
 *      not invoked.
 *
 * Returns each Task's decisive outcome (allow, or the first veto) + the
 * frozen admission snapshot. Never throws for a governance DECISION —
 * infrastructure failures (ledger read/write, runtime startRun) propagate as
 * retryable transport errors, consistent with Phase 1's contract.
 *
 * DORMANT: no production origin calls this yet. The additive seam
 * (`invokePreInterceptorForGovernance`) is the ONLY runtime touchpoint;
 * `runPreInterceptors` and all runtime internals are unmodified.
 */
export function governTaskPublication(input: GovernTaskPublicationInput): GovernanceBatchResult {
  if (input.tasks.length === 0) {
    throw new Error(
      "governTaskPublication: tasks must be non-empty — a governance pass with no tasks is a caller bug",
    );
  }
  const habitatId = input.tasks[0].proposal.habitatId;
  for (const t of input.tasks) {
    if (t.proposal.habitatId !== habitatId) {
      throw new Error(
        `governTaskPublication: all tasks must share one habitatId (found "${t.proposal.habitatId}" vs "${habitatId}") — cross-habitat batches call governance per-habitat`,
      );
    }
  }

  // 1. FREEZE batch admission before evaluating any Task.
  const frozenAdmission = freezeBatchAdmission(habitatId);

  // 2. Overwrite the Phase-1 sentinel on every governed guard. No governed
  //    guard may carry PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER after this.
  for (const task of input.tasks) {
    task.guard.interceptorEnrollmentFingerprint = frozenAdmission.enrollmentFingerprint;
  }

  // 3. Govern each Task against the SAME frozen snapshot (batch fault
  //    isolation: a fault on Task 1 does not change Task 2's admission).
  const results: GovernedTaskResult[] = input.tasks.map((task) =>
    governOneTask(task.proposal, task.guard, input.attemptId, frozenAdmission, input.db),
  );

  return { results, frozenAdmission };
}

/**
 * Governs ONE Task against the frozen admission snapshot. Iterates enrolled
 * interceptors in frozen priority order. First veto short-circuits THIS Task;
 * every enrolled interceptor before the veto (or all of them, on allow) is
 * recorded/reused.
 */
function governOneTask(
  proposal: CanonicalTaskPublicationProposal,
  guard: PublicationGuard,
  attemptId: string,
  frozenAdmission: FrozenBatchAdmissionSnapshot,
  db: TaskPublicationDbClient,
): GovernedTaskResult {
  const priorAllowDecisions: RecordedGovernanceDecision[] = [];
  const transition: ProspectiveTaskCreatedTransition = {
    action: "taskCreated",
    state: "prospective",
    prospectiveTaskId: proposal.prospectiveTaskId,
    attemptId,
    habitatId: proposal.habitatId,
    proposal,
  };
  const context = makeProspectiveTransitionContext(transition);

  for (const entry of frozenAdmission.enrolled) {
    const governanceFingerprint = computeGovernanceFingerprint({
      proposal,
      guard,
      interceptor: entry,
      frozenAdmission,
    });

    // Decision-ledger reuse: a matching durable decision is REUSED.
    const existing = findGovernanceDecisionWithClient(db, {
      attemptId,
      prospectiveTaskId: proposal.prospectiveTaskId,
      interceptorKey: entry.interceptorKey,
      governanceFingerprint,
    });

    let recorded: RecordedGovernanceDecision;
    if (existing) {
      // REUSE — no new Plugin Run, no quarantine effect.
      recorded = ledgerRowToRecorded(existing, true);
    } else {
      // MISS — invoke through the runtime + record. The frozen `entry.entry`
      // carries the LIVE handler reference frozen at batch-admission time, so
      // THIS batch invokes exactly the code registered at freeze time.
      const target = makePreInterceptorTargetForGovernance(entry.entry);
      const preVeto = invokePreInterceptorForGovernance(
        target,
        proposal.prospectiveTaskId,
        GOVERNED_EVENT,
        proposal.habitatId,
        context,
      );
      const mapped = mapPreVetoToGovernanceDecision(preVeto);
      const row = recordGovernanceDecisionWithClient(db, {
        attemptId,
        prospectiveTaskId: proposal.prospectiveTaskId,
        interceptorKey: entry.interceptorKey,
        governanceFingerprint,
        decision: mapped.decision,
        pluginRunId: mapped.pluginRunId,
        diagnostics: mapped.diagnostics,
      });
      recorded = ledgerRowToRecorded(row, false);
    }

    // First-veto short-circuit per Task.
    if (recorded.decision === "allow") {
      priorAllowDecisions.push(recorded);
      continue;
    }
    // Veto (explicit or failure) — short-circuit THIS Task. Remaining
    // interceptors for THIS Task are NOT invoked and NOT recorded.
    return {
      prospectiveTaskId: proposal.prospectiveTaskId,
      outcome: "vetoed",
      veto: {
        interceptorKey: entry.interceptorKey,
        decision: recorded.decision,
        reason: recorded.diagnostics?.reason ?? "vetoed",
        pluginRunId: recorded.pluginRunId,
      },
      priorAllowDecisions,
    };
  }

  // All enrolled interceptors allowed.
  return {
    prospectiveTaskId: proposal.prospectiveTaskId,
    outcome: "allowed",
    decisions: priorAllowDecisions,
  };
}

/** Maps a ledger row to a {@link RecordedGovernanceDecision}. */
function ledgerRowToRecorded(
  row: GovernanceDecisionRow,
  reused: boolean,
): RecordedGovernanceDecision {
  return {
    interceptorKey: row.interceptorKey,
    decision: row.decision as GovernanceDecisionKind,
    pluginRunId: row.pluginRunId,
    diagnostics: row.diagnostics,
    reused,
  };
}

// ---------------------------------------------------------------------------
// Sentinel overwrite verification (Defensive — used by tests + Phase 3 guard)
// ---------------------------------------------------------------------------

/**
 * True when a guard still carries the Phase-1 placeholder sentinel. Phase 2
 * MUST overwrite the sentinel on every governed guard; Phase 3 MUST refuse to
 * commit any guard for which this returns true.
 */
export function guardCarriesPhase1Sentinel(guard: PublicationGuard): boolean {
  return guard.interceptorEnrollmentFingerprint === PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER;
}
