/**
 * Template Aggregate Publication Preparation — PURE preparation of the
 * complete Mission + Tasks + Workflow + usage-mutation aggregate proposal
 * (T9A Milestone 1, Phase 1).
 *
 * Decomposes the legacy {@link applyTemplate} write path
 * (`repositories/template.ts:403`) by extracting its read/compute logic into a
 * PURE, validate-then-return preparation function. This function performs ALL
 * the reads and computation that the legacy path did OUTSIDE and at the TOP of
 * its transaction, plus the workflow-definition build that the legacy path did
 * INSIDE its transaction via {@link instantiateWorkflow} — but performs NO
 * writes and emits NO effects. It returns the complete prepared aggregate so
 * Phase 2's atomic publisher (`publishTemplateAggregateWithClient`) can commit
 * it inside a single caller-owned transaction with the kernel publication
 * primitives (`governTaskPublication` + `publishTaskWithClient`).
 *
 * ## Purity contract (load-bearing — mirrors `prepareTaskPublication`)
 *
 *   - Read-only. No `db.transaction`, no `insert`/`update`/`delete`. Allocates
 *     prospective UUIDs but persists nothing.
 *   - Validation DECISIONS never throw — returns
 *     `{ outcome: "rejected_validation"; errors }` carrying every collected
 *     {@link PublicationError}. Infrastructure failures (a repository throw)
 *     propagate as retryable runtime errors and are NOT collapsed into the
 *     validation result.
 *
 * ## Dormant
 *
 * No production caller switches to this path yet. Legacy `applyTemplate` stays
 * byte-identical and active. This function is additive and ships behind the
 * `ORCY_CREATION_PUBLICATION_ENABLED` cutover flag (Phase 2 wires consumption).
 *
 * ## Field mapping (TaskTemplateEntry → CanonicalTaskPublicationProposal)
 *
 * The kernel's canonical proposal shape EXCLUDES execution-history fields
 * (`status`, `order`) — those are tx-owned. The template entry's
 * `initialStatus` and `order` are carried separately in
 * {@link PreparedTemplateTask.templateEntryMetadata} so Phase 2 can apply them
 * via a post-publish in-tx update after `publishTaskWithClient` returns (the
 * kernel allocates `pending` status and `max(order)+1` itself). Variable
 * substitution is applied to each task's `title`/`description` UPFRONT so the
 * proposals carry the FINAL substituted values the legacy path would have
 * written (the legacy path inserted raw then updated with substituted values).
 *
 * See: T9A ticket (Milestone 1 — active scope), the Story 2 handoff, and the
 * kernel API surface in `taskPublicationPreparation.ts`.
 */
import { v4 as uuid } from "uuid";
import type {
  AuditActorRef,
  AuditSource,
  AutomationCondition,
  CausalContext,
  GateType,
  JoinMode,
  MissionStatus,
  TaskPriority,
  TaskStatus,
  WorkflowFailureHandlerConfig,
  WorkflowTemplateDefinition,
} from "@orcy/shared";
import { eq, max } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { columns, missions, missionTemplates } from "../db/schema/index.js";
import type { TaskTemplateEntry } from "../models/index.js";
import {
  TERMINAL_TASK_STATUSES,
  getTemplateById,
  substituteFailureHandler,
  substituteTemplateVariables,
} from "../repositories/template.js";
import type { ApplyTemplateOverrides } from "../repositories/template.js";
import type {
  CanonicalTaskPublicationProposal,
  PublicationError,
  PublicationGuard,
} from "./taskPublicationPreparation.js";
import { PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER } from "./taskPublicationPreparation.js";

// ---------------------------------------------------------------------------
// Closed enums / leaf types (mirror the kernel preparation boundary)
// ---------------------------------------------------------------------------

/**
 * The causal-root type for a template-aggregate publication. The root
 * identifies the originating template application — Phase 2 may override the
 * root when a richer origin (scheduled occurrence, triage cluster) drives the
 * publication through the participant seam.
 */
export const TEMPLATE_AGGREGATE_CAUSAL_ROOT_TYPE = "mission_template";

// ---------------------------------------------------------------------------
// Prepared-aggregate return types
// ---------------------------------------------------------------------------

/**
 * The prospective Mission row data — everything Phase 2 needs to
 * `tx.insert(missions).values({...})` as the first write inside the aggregate
 * publication transaction. Timestamps (`createdAt`/`updatedAt`) and `version`
 * are stamped inside the tx; this shape carries only the resolved content.
 */
export interface ProspectiveMissionData {
  missionId: string;
  habitatId: string;
  columnId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  displayOrder: number;
  /** Attribution actor id flowing to the Mission row's `createdBy`. */
  createdBy: string;
}

/**
 * One prepared Task in the aggregate — a canonical proposal consumable by
 * `governTaskPublication` + `publishTaskWithClient`, its optimistic
 * publication guard, and the template-entry-specific fields the kernel
 * proposal shape excludes (carried separately so Phase 2 can apply them).
 */
export interface PreparedTemplateTask {
  /** Canonical proposal (kernel shape) — consumable by the publication kernel. */
  proposal: CanonicalTaskPublicationProposal;
  /** Per-Task optimistic publication guard snapshot (prospective Mission). */
  guard: PublicationGuard;
  /**
   * Template-entry fields the kernel proposal EXCLUDES (execution history /
   * tx-owned). Phase 2 applies these inside the aggregate tx via a post-publish
   * `tx.update(tasks)` if they differ from the kernel's defaults.
   */
  templateEntryMetadata: {
    /** `entry.initialStatus ?? "pending"`. The kernel writes `pending`; override if different. */
    initialStatus: TaskStatus;
    /** `entry.order ?? index`. The kernel allocates `max(order)+1`; override if the template pins a specific order. */
    order: number;
  };
}

/**
 * A resolved workflow gate — all data Phase 2 needs to
 * `tx.insert(taskWorkflowGates).values({...})`. The gate id and the
 * timestamp-based satisfaction fields (`satisfiedAt`, `satisfiedByEventId`) are
 * stamped inside the tx from {@link isPreSatisfied}; the `recoveryDepth` is
 * always 0 for a fresh publication.
 */
export interface PreparedWorkflowGate {
  missionId: string;
  habitatId: string;
  upstreamTaskId: string;
  downstreamTaskId: string;
  gateType: GateType;
  /** Substituted matchConfig with per-task `failureHandlerOverride` merged in (or null). */
  matchConfig: Record<string, unknown> | null;
  condition: AutomationCondition | null;
  /** Pre-satisfaction decision (upstream entry's initialStatus is terminal). Phase 2 stamps the rest. */
  isPreSatisfied: boolean;
  recoveryDepth: number;
}

/**
 * The resolved Workflow definition — all data Phase 2 needs to
 * `tx.insert(workflows).values({...})` plus the gate rows. Null when the
 * template has no `workflowTemplate` definition.
 */
export interface PreparedWorkflowDefinition {
  workflowId: string;
  missionId: string;
  habitatId: string;
  resolvedVariables: Record<string, string>;
  /** Join specs keyed by TASK ID (resolved from task keys at prep time). */
  joinSpecs: Record<string, { mode: JoinMode; n?: number }>;
  /** Substituted failure handler (or null when the workflow defines none). */
  failureHandler: WorkflowFailureHandlerConfig | null;
  gates: PreparedWorkflowGate[];
}

/**
 * Usage-count mutation descriptor — Phase 2 does
 * `tx.update(missionTemplates).set({ usageCount: sql\`${missionTemplates.usageCount} + 1\`})`
 * inside the aggregate tx. Carries the template id + the snapshot for the
 * aggregate guard to re-verify.
 */
export interface UsageMutationDescriptor {
  templateId: string;
}

/**
 * Aggregate-level publication guard — captures the mutable state whose change
 * between preparation and publication would invalidate the prepared proposal.
 * Phase 2 re-verifies template existence + column existence inside the
 * aggregate tx before any write. The per-Task guards (on each
 * {@link PreparedTemplateTask}) are PROSPECTIVE: they snapshot the
 * not-yet-inserted Mission (version 1, status `"not_started"`).
 */
export interface TemplateAggregatePublicationGuard {
  templateId: string;
  /** Template usageCount snapshot at prep time (informational; the tx re-verifies existence). */
  templateUsageCount: number;
  habitatId: string;
  /** The resolved first column id (re-verified inside the tx). */
  columnId: string;
  /** Computed `max(displayOrder)+1` at prep time (Phase 2 may recompute inside the tx). */
  computedDisplayOrder: number;
}

/**
 * The complete prepared template aggregate — the success-branch payload.
 *
 * Phase 2's `publishTemplateAggregateWithClient(db, {attemptId, prepared,
 * guard, participants?})` consumes this in order: insert Mission → govern all
 * Tasks (batch) → loop `publishTaskWithClient` per Task (check outcome; throw
 * on denial → full-aggregate rollback) → apply per-Task `templateEntryMetadata`
 * overrides → instantiate Workflow (row + gates) → mutate usage →
 * `participants?(db, ctx)`.
 */
export interface PreparedTemplateAggregate {
  mission: ProspectiveMissionData;
  tasks: PreparedTemplateTask[];
  workflow: PreparedWorkflowDefinition | null;
  usageMutation: UsageMutationDescriptor;
  guard: TemplateAggregatePublicationGuard;
}

/**
 * Closed preparation result. Mirrors `prepareTaskPublication`'s
 * `PrepareTaskResult` pattern: validation decisions return
 * `rejected_validation`; infrastructure failures propagate as throws.
 */
export type PrepareTemplateAggregateResult =
  | { outcome: "prepared"; aggregate: PreparedTemplateAggregate }
  | { outcome: "rejected_validation"; errors: PublicationError[] };

// ---------------------------------------------------------------------------
// Input context
// ---------------------------------------------------------------------------

/**
 * Provenance + attribution context for the preparation. The caller (Phase 2's
 * publisher, or the eventual origin adapters) supplies the actor identity and
 * audit channel. `actor.id` flows to the Mission row's `createdBy` (matching
 * legacy `applyTemplate`'s `createdBy ?? "system"` param) and to each Task
 * proposal's `actor.id` (which the kernel stamps on the Task row).
 */
export interface PrepareTemplateAggregateContext {
  actor: AuditActorRef;
  auditSource: AuditSource;
  /**
   * Optional causal context. Defaults to a root anchored at the template
   * application: `{ root: { type: "mission_template", id: templateId } }`.
   * Origin adapters (triage, scheduler) may supply a richer chain.
   */
  causalContext?: CausalContext;
}

// ---------------------------------------------------------------------------
// Internal helpers (PURE; each pushes errors, never throws)
// ---------------------------------------------------------------------------

/**
 * Resolve workflow template variables from caller overrides + declared
 * defaults, collecting a `missing_required_variable` error for each required
 * variable the caller did not provide. Mirrors `instantiateWorkflow`'s
 * resolution loop but collects errors instead of throwing.
 *
 * Returns the resolved variable map (caller/default values merged).
 */
function resolveWorkflowVariables(
  wfDef: WorkflowTemplateDefinition,
  callerVariables: Record<string, string>,
  errors: PublicationError[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const vdef of wfDef.variables ?? []) {
    const callerVal = callerVariables[vdef.key];
    const defaultVal = vdef.default;
    if (callerVal !== undefined) {
      resolved[vdef.key] = callerVal;
    } else if (defaultVal !== undefined) {
      resolved[vdef.key] = defaultVal;
    } else if (vdef.required) {
      errors.push({
        field: "variables",
        code: "missing_required_variable",
        message: `Required template variable "${vdef.key}" was not provided.`,
      });
    }
  }
  return resolved;
}

/**
 * Build the task-key → prospective-task-id + task-key → entry maps, collecting
 * a `duplicate_task_key` error for each collision. Mirrors
 * `instantiateWorkflow`'s key-resolution loop but collects errors instead of
 * throwing. Auto-generates `task_{i+1}` keys for entries without an explicit
 * `key` (matching the legacy behavior).
 */
function buildTaskKeyMaps(
  tasksTemplate: TaskTemplateEntry[],
  taskIds: string[],
  errors: PublicationError[],
): { keyToTaskId: Map<string, string>; keyToEntry: Map<string, TaskTemplateEntry> } {
  const keyToTaskId = new Map<string, string>();
  const keyToEntry = new Map<string, TaskTemplateEntry>();
  for (let i = 0; i < tasksTemplate.length; i++) {
    const entry = tasksTemplate[i];
    const tid = taskIds[i];
    const key = entry.key ?? `task_${i + 1}`;
    if (keyToTaskId.has(key)) {
      errors.push({
        field: "tasksTemplate",
        code: "duplicate_task_key",
        message: `Duplicate task key "${key}" in template.`,
      });
      continue;
    }
    keyToTaskId.set(key, tid);
    keyToEntry.set(key, entry);
  }
  return { keyToTaskId, keyToEntry };
}

/**
 * Resolve join specs from task-key keys to task-id keys, collecting an
 * `unknown_join_spec_key` error for each spec referencing a missing key.
 * Mirrors `instantiateWorkflow`'s join-spec resolution but collects errors.
 */
function resolveJoinSpecs(
  wfDef: WorkflowTemplateDefinition,
  keyToTaskId: Map<string, string>,
  errors: PublicationError[],
): Record<string, { mode: JoinMode; n?: number }> {
  const resolved: Record<string, { mode: JoinMode; n?: number }> = {};
  for (const [taskKey, spec] of Object.entries(wfDef.joinSpecs ?? {})) {
    const tid = keyToTaskId.get(taskKey);
    if (!tid) {
      errors.push({
        field: "workflowTemplate.joinSpecs",
        code: "unknown_join_spec_key",
        message: `Join spec references unknown task key "${taskKey}".`,
      });
      continue;
    }
    resolved[tid] = spec;
  }
  return resolved;
}

/**
 * Build the resolved gate list from the workflow template's gate definitions,
 * applying variable substitution to `matchConfig.subjectContains` and merging
 * per-task `failureHandlerOverride`. Collects `unknown_gate_upstream_key` /
 * `unknown_gate_downstream_key` errors instead of throwing. Computes
 * `isPreSatisfied` from the upstream entry's `initialStatus` (terminal status
 * pre-satisfies — matching the legacy in-tx read of the just-inserted upstream
 * task).
 */
function buildResolvedGates(
  wfDef: WorkflowTemplateDefinition,
  keyToTaskId: Map<string, string>,
  keyToEntry: Map<string, TaskTemplateEntry>,
  missionId: string,
  habitatId: string,
  substitute: (text: string | undefined | null) => string | undefined,
  errors: PublicationError[],
): PreparedWorkflowGate[] {
  const gates: PreparedWorkflowGate[] = [];
  for (const gate of wfDef.gates) {
    const upstreamTaskId = keyToTaskId.get(gate.upstreamTaskKey);
    const downstreamTaskId = keyToTaskId.get(gate.downstreamTaskKey);
    if (!upstreamTaskId) {
      errors.push({
        field: "workflowTemplate.gates",
        code: "unknown_gate_upstream_key",
        message: `Gate references unknown upstream task key "${gate.upstreamTaskKey}".`,
      });
      continue;
    }
    if (!downstreamTaskId) {
      errors.push({
        field: "workflowTemplate.gates",
        code: "unknown_gate_downstream_key",
        message: `Gate references unknown downstream task key "${gate.downstreamTaskKey}".`,
      });
      continue;
    }

    let matchConfig = gate.matchConfig as Record<string, unknown> | undefined;
    if (matchConfig) {
      matchConfig = { ...matchConfig };
      if (typeof matchConfig.subjectContains === "string") {
        const substituted = substitute(matchConfig.subjectContains);
        if (substituted !== undefined) matchConfig.subjectContains = substituted;
      }
    }

    const upstreamEntry = keyToEntry.get(gate.upstreamTaskKey);
    if (upstreamEntry && upstreamEntry.failureHandlerOverride !== undefined) {
      const override = upstreamEntry.failureHandlerOverride
        ? substituteFailureHandler(upstreamEntry.failureHandlerOverride, substitute)
        : null;
      matchConfig = { ...matchConfig, failureHandlerOverride: override };
    }

    const upstreamInitialStatus: TaskStatus = upstreamEntry?.initialStatus ?? "pending";
    const isPreSatisfied = (TERMINAL_TASK_STATUSES as readonly string[]).includes(
      upstreamInitialStatus,
    );

    gates.push({
      missionId,
      habitatId,
      upstreamTaskId,
      downstreamTaskId,
      gateType: gate.gateType,
      matchConfig: matchConfig ?? null,
      condition: gate.condition ?? null,
      isPreSatisfied,
      recoveryDepth: 0,
    });
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate, canonicalize, and capture publication guards for the COMPLETE
 * template aggregate (one prospective Mission + N prospective Tasks + optional
 * Workflow + usage mutation). PURE: performs only read-only validation against
 * the template/column/mission repositories, allocates prospective UUIDs, and
 * returns either a prepared aggregate or a collected list of validation errors.
 *
 * Validation DECISIONS never throw — a `rejected_validation` result is
 * returned for template/column/provenance/workflow-template failures.
 * Infrastructure failures (a repository throw) propagate as retryable runtime
 * errors and are NOT collapsed into the validation result (mirrors
 * `prepareTaskPublication`).
 *
 * Each per-Task {@link PreparedTemplateTask.proposal} is in the EXACT shape
 * `prepareTaskPublication` produces, so Phase 2's `governTaskPublication` +
 * `publishTaskWithClient` consume each one without translation. The
 * prospective Mission is NOT inserted by this function — Phase 2 inserts it
 * first inside the aggregate tx, which means the per-Task guards are
 * PROSPECTIVE (snapshotting the not-yet-inserted Mission at version 1, status
 * `"not_started"`). See {@link PreparedTemplateTask.guard}.
 *
 * DORMANT: no production caller switches to this path. Legacy `applyTemplate`
 * stays byte-identical and active.
 *
 * @param templateId  The mission template to instantiate.
 * @param habitatId   The authoritative Habitat the aggregate is scoped to.
 * @param overrides   Caller overrides for the Mission's title/description/priority/labels + workflow variables.
 * @param ctx         Provenance + attribution context (actor, auditSource, optional causalContext).
 * @returns `{ outcome: "prepared"; aggregate }` or `{ outcome: "rejected_validation"; errors }`.
 */
export function prepareTemplateAggregate(
  templateId: string,
  habitatId: string,
  overrides: ApplyTemplateOverrides | undefined,
  ctx: PrepareTemplateAggregateContext,
): PrepareTemplateAggregateResult {
  const errors: PublicationError[] = [];

  // --- provenance presence (field-shaped; collected) ---
  if (!ctx.actor || typeof ctx.actor !== "object" || typeof ctx.actor.type !== "string") {
    errors.push({
      field: "actor",
      code: "invalid_actor",
      message: "ctx.actor must be an AuditActorRef with a `type` discriminator.",
    });
  }
  if (typeof ctx.auditSource !== "string" || ctx.auditSource.length === 0) {
    errors.push({
      field: "auditSource",
      code: "invalid_audit_source",
      message: "ctx.auditSource must be a non-empty AuditSource string.",
    });
  }

  // --- template existence ---
  const template = getTemplateById(templateId);
  if (!template) {
    errors.push({
      field: "templateId",
      code: "template_not_found",
      message: `No mission template exists with id "${templateId}".`,
    });
    // Without a template there is nothing more to validate or compute — the
    // downstream reads (column resolution, workflow build) all depend on it.
    // Return collected errors (which include the template_not_found + any
    // provenance errors surfaced above). This is the validate-then-return
    // contract: never throw for a validation decision.
    return { outcome: "rejected_validation", errors };
  }

  const db = getDb();

  // --- column resolution (mirrors applyTemplate's outside-tx read) ---
  const columnId = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(columns.order)
    .all()[0]?.id;
  if (!columnId) {
    errors.push({
      field: "habitatId",
      code: "habitat_has_no_columns",
      message: `Habitat "${habitatId}" has no columns; cannot place the aggregate.`,
    });
  }

  // --- displayOrder computation (mirrors applyTemplate's outside-tx read) ---
  let displayOrder = 0;
  if (columnId) {
    const maxOrder = db
      .select({ value: max(missions.displayOrder) })
      .from(missions)
      .where(eq(missions.columnId, columnId))
      .get();
    displayOrder = (maxOrder?.value ?? -1) + 1;
  }

  // --- template usageCount snapshot (for the aggregate guard) ---
  const templateUsageCount = template.usageCount ?? 0;

  // --- workflow-template validation + variable resolution (collected) ---
  const tasksTemplate = template.tasksTemplate ?? [];
  const wfDef = template.workflowTemplate ?? null;
  const callerVariables = overrides?.variables ?? {};

  // Resolve workflow variables FIRST (the substitution function depends on
  // them). When no workflow template exists, variables are empty and
  // substitution is a no-op — matching the legacy path where
  // `instantiateWorkflow` is never called and task titles/descriptions stay
  // raw.
  const resolvedVariables = wfDef ? resolveWorkflowVariables(wfDef, callerVariables, errors) : {};
  const substitute = (text: string | undefined | null): string | undefined =>
    substituteTemplateVariables(text, resolvedVariables);

  // --- allocate prospective IDs ---
  const missionId = uuid();
  const taskIds = tasksTemplate.map(() => uuid());
  const workflowId = wfDef ? uuid() : null;

  // --- build task-key maps (collected duplicate-key errors) ---
  const { keyToTaskId, keyToEntry } = buildTaskKeyMaps(tasksTemplate, taskIds, errors);

  // --- resolve join specs (collected unknown-key errors) ---
  const resolvedJoinSpecs = wfDef ? resolveJoinSpecs(wfDef, keyToTaskId, errors) : {};

  // --- build resolved gates (collected unknown-key errors + substitution) ---
  const resolvedGates = wfDef
    ? buildResolvedGates(wfDef, keyToTaskId, keyToEntry, missionId, habitatId, substitute, errors)
    : [];

  // --- any collected error → rejected_validation (never throws) ---
  if (errors.length > 0) {
    return { outcome: "rejected_validation", errors };
  }

  // --- resolve the workflow-level failure handler (with substitution) ---
  let resolvedFailureHandler: WorkflowFailureHandlerConfig | null = null;
  if (wfDef?.failureHandler) {
    resolvedFailureHandler = substituteFailureHandler(wfDef.failureHandler, substitute);
  }

  // --- build the prospective Mission data ---
  const actorId = ctx.actor.id ?? null;
  const createdBy = actorId ?? "system";
  const prospectiveMission: ProspectiveMissionData = {
    missionId,
    habitatId,
    columnId: columnId!,
    title: overrides?.title ?? template.titlePattern,
    description: overrides?.description ?? template.descriptionPattern,
    priority: overrides?.priority ?? template.priority,
    labels: overrides?.labels ?? template.labels,
    displayOrder,
    createdBy,
  };

  // --- build the per-Task canonical proposals + guards ---
  // The prospective Mission snapshot stamped on every per-Task guard. This is
  // PROSPECTIVE: the Mission does not exist at prep time. Phase 2 inserts the
  // Mission BEFORE re-verifying these guards inside the aggregate tx, so the
  // snapshot matches what the tx will observe post-Mission-insert (version 1,
  // status "not_started", zero dependencies).
  const prospectiveMissionStatus: MissionStatus = "not_started";
  const prospectiveMissionVersion = 1;

  const causalContext: CausalContext = ctx.causalContext ?? {
    root: { type: TEMPLATE_AGGREGATE_CAUSAL_ROOT_TYPE, id: templateId },
  };

  const preparedTasks: PreparedTemplateTask[] = tasksTemplate.map((entry, i) => {
    const prospectiveTaskId = taskIds[i];
    // Apply variable substitution to the title/description UPFRONT. The legacy
    // path inserted raw values then updated them via `instantiateWorkflow`; the
    // kernel writes the proposal's title/description directly, so the proposals
    // MUST carry the substituted (final) values to preserve legacy output.
    const substitutedTitle = substitute(entry.title) ?? entry.title;
    const substitutedDescription =
      entry.description !== undefined
        ? (substitute(entry.description) ?? entry.description)
        : undefined;

    const proposal: CanonicalTaskPublicationProposal = {
      prospectiveTaskId,
      habitatId,
      targetMissionId: missionId,
      title: substitutedTitle,
      description: substitutedDescription ?? "",
      priority: entry.priority ?? "medium",
      // Legacy applyTemplate hardcodes labels: [] on every task — the template
      // entry has no labels field. The kernel proposal requires the field.
      labels: [],
      requiredDomain: entry.requiredDomain ?? null,
      requiredCapabilities: entry.requiredCapabilities ?? [],
      estimatedMinutes: entry.estimatedMinutes ?? null,
      // Templates do not author subtasks, dependencies, or assignments.
      subtasks: [],
      selectedDependencies: [],
      requestedAssigneeId: null,
      cloneSourceTaskId: null,
      actor: ctx.actor,
      auditSource: ctx.auditSource,
      causalContext,
      initialEventAction: "created",
    };

    const guard: PublicationGuard = {
      missionId,
      missionVersion: prospectiveMissionVersion,
      missionStatus: prospectiveMissionStatus,
      habitatId,
      dependencies: [],
      interceptorEnrollmentFingerprint: PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
    };

    return {
      proposal,
      guard,
      templateEntryMetadata: {
        initialStatus: entry.initialStatus ?? "pending",
        order: entry.order ?? i,
      },
    };
  });

  // --- build the prepared workflow definition (or null) ---
  const preparedWorkflow: PreparedWorkflowDefinition | null = wfDef
    ? {
        workflowId: workflowId!,
        missionId,
        habitatId,
        resolvedVariables,
        joinSpecs: resolvedJoinSpecs,
        failureHandler: resolvedFailureHandler,
        gates: resolvedGates,
      }
    : null;

  // --- assemble the aggregate ---
  const aggregate: PreparedTemplateAggregate = {
    mission: prospectiveMission,
    tasks: preparedTasks,
    workflow: preparedWorkflow,
    usageMutation: { templateId },
    guard: {
      templateId,
      templateUsageCount,
      habitatId,
      columnId: columnId!,
      computedDisplayOrder: displayOrder,
    },
  };

  return { outcome: "prepared", aggregate };
}
