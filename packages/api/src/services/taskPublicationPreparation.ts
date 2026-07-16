/**
 * Canonical Task Publication Preparation — PURE validation + canonicalization
 * (T3B Phase 1).
 *
 * This is the preparation-service boundary from the Task Creation and Clone
 * Technical Plan § "Governing boundaries":
 *
 *   Preparation service — Canonicalize the complete proposal, allocate
 *   prospective IDs, validate scope and graph integrity, and capture
 *   publication guards. MUST NOT: Write domain rows or emit observable
 *   effects.
 *
 * Phase 1 is DORMANT and PURE: no production origin calls
 * {@link prepareTaskPublication} yet, and the function performs only read-only
 * validation against the existing mission/habitat/dependency repositories. It
 * allocates a prospective Task ID, canonicalizes the proposal, and captures a
 * {@link PublicationGuard} snapshot that the publication transaction later
 * re-verifies (Phase 3). It writes nothing and emits nothing.
 *
 * Validation contract (load-bearing):
 *   - ALL actionable field errors are collected into one `rejected_validation`
 *     result — never first-only. The caller surfaces every correctable defect
 *     in one round-trip.
 *   - Validation DECISIONS never throw. The function returns
 *     `{ outcome: "rejected_validation"; errors }` for every field, scope, or
 *     graph failure. Infrastructure failures (a repository throw) propagate —
 *     they are retryable transport/runtime failures, not domain rejections.
 *   - Repository Task models are NOT accepted as input. They carry
 *     execution-history fields no creator may set; passing one is rejected
 *     with a typed `forbidden_execution_history_field` error rather than
 *     silently stripped (the caller must project to the allowed shape).
 *
 * Out of scope (owned by later phases):
 *   - The prospective interceptor transition + decision ledger (Phase 2). The
 *     {@link PublicationGuard.interceptorEnrollmentFingerprint} field is
 *     captured here as a Phase-1 sentinel; Phase 2 computes the real
 *     enrollment/configuration fingerprint when it owns the prospective
 *     `taskCreated` transition.
 *   - Guard re-verify inside the publication tx (Phase 3).
 *   - Attempt-binding, Task/event insertion, origin adapters.
 *
 * See: Task Creation and Clone Technical Plan § "Canonical Task proposal",
 * § "Validation phases", § "Optimistic publication guard".
 */
import { v4 as uuid } from "uuid";
import type {
  AuditActorRef,
  AuditSource,
  MissionStatus,
  TaskPriority,
  TaskStatus,
} from "@orcy/shared";
import type { CausalContext } from "../repositories/taskPublication.js";
import { getMissionById } from "../repositories/mission.js";
import { getHabitatById } from "../repositories/habitat.js";
import { wouldCreateTaskCycle } from "../repositories/dependency.js";
import { getTasksByIds } from "../repositories/taskQueries.js";

// ---------------------------------------------------------------------------
// Sentinel: Phase-1 interceptor-enrollment fingerprint placeholder
// ---------------------------------------------------------------------------

/**
 * Deterministic sentinel placed in
 * {@link PublicationGuard.interceptorEnrollmentFingerprint} during Phase 1.
 *
 * Phase 1 owns ONLY canonical preparation — it has no access to the plugin
 * enrollment/configuration state that the prospective `taskCreated`
 * transition (Phase 2) freezes, so it cannot compute a meaningful
 * enrollment fingerprint. The sentinel is non-empty so the guard field is
 * always present and re-verify logic (Phase 3) can detect the placeholder
 * explicitly.
 *
 * Phase 2 MUST overwrite this with the real enrollment/configuration
 * fingerprint computed from the frozen runtime-admission snapshot before the
 * guard is re-verified inside the publication transaction. Until then, a guard
 * carrying this sentinel cannot authorize a real publication commit.
 */
export const PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER =
  "phase1:interceptor-enrollment-not-captured";

// ---------------------------------------------------------------------------
// Closed enums / leaf types
// ---------------------------------------------------------------------------

/** The initial Lifecycle Event action for the publication. */
export type InitialEventAction = "created" | "cloned";

/**
 * Mission lifecycle states that ACCEPT new Task publication.
 *
 * `done` and `failed` are terminal — a terminal Mission rejects new Task
 * publication. See Technical Plan § "Active Mission and scope rules".
 */
export const ACTIVE_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  "not_started",
  "in_progress",
  "review",
]);

/**
 * Closed set of Task fields that constitute execution history. A creator may
 * NOT establish any of these — they are produced by the Task lifecycle, not
 * authored at publication time. Passing an input object that carries any of
 * these keys (e.g. a repository Task model) is rejected with
 * `forbidden_execution_history_field`.
 *
 * `version`, `createdAt`, `updatedAt`, `createdBy`, and `creationIntegrity`
 * are included because they are server/tx-owned: the publication transaction
 * stamps them, not the origin adapter.
 */
export const EXECUTION_HISTORY_FIELDS = [
  "status",
  "claimedAt",
  "startedAt",
  "submittedAt",
  "completedAt",
  "rejectedCount",
  "rejectionReason",
  "result",
  "artifacts",
  "retryCount",
  "nextRetryAt",
  "actualMinutes",
  "cycleTimeMinutes",
  "leadTimeMinutes",
  "estimationAccuracy",
  "delegatedToAgentId",
  "remoteAssignedParticipantId",
  "version",
  "createdAt",
  "updatedAt",
  "createdBy",
  "creationIntegrity",
  "order",
] as const;

/** The four priority levels a creator may set on a Task proposal. */
const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set(["low", "medium", "high", "critical"]);

// ---------------------------------------------------------------------------
// Input / proposal / guard / error types (Deliverable 1)
// ---------------------------------------------------------------------------

/**
 * A selected task-to-task dependency edge in a publication proposal.
 *
 * The prospective Task depends on {@link dependsOnId}. The referenced Task
 * must exist, belong to the same Habitat, and the edge must not introduce a
 * cycle or self-reference. Cross-Habitat dependencies (a separate UI concept
 * surfaced via `crossHabitatDependsOn`) are not selected-dependency edges and
 * are not expressible here.
 */
export interface SelectedDependency {
  dependsOnId: string;
}

/**
 * A creator-authored subtask in a publication proposal.
 *
 * Carries only editable fields — no `id`, no `completed`, no `createdAt`. The
 * publication transaction allocates the subtask identity and stamps execution
 * state. `assigneeId` is an intentional editable field (a creator may
 * pre-assign a subtask to an agent).
 */
export interface EditableSubtask {
  title: string;
  order?: number;
  assigneeId?: string | null;
}

/**
 * Restricted origin input for {@link prepareTaskPublication}.
 *
 * This is the UNTRUSTED work input translated by the origin adapter into the
 * canonical shape. It EXCLUDES execution-history fields; any object carrying
 * a key in {@link EXECUTION_HISTORY_FIELDS} (e.g. a repository `Task` model)
 * is rejected with `forbidden_execution_history_field`.
 *
 * Provenance fields (`actor`, `auditSource`, `causalContext`) are
 * server-constructed by the origin adapter; untrusted callers cannot assert
 * privileged run or actor identities. The Technical Plan § "Provenance and
 * Automation Cycle Safety" defines the trust boundary.
 *
 * `prospectiveTaskId` is OPTIONAL: when omitted the preparation service
 * allocates a fresh UUID. An origin MAY supply one for deterministic identity
 * (clone provenance, batch-order blocks, schedule occurrences). When supplied
 * it must be a non-empty string; it is validated for self-reference against
 * the selected dependencies.
 */
export interface PrepareTaskPublicationInput {
  // --- target scope (the authoritative Habitat + final target Mission) ---
  habitatId: string;
  targetMissionId: string;

  // --- work definition (normalized into the proposal) ---
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  estimatedMinutes?: number | null;

  // --- editable aggregate ---
  subtasks?: EditableSubtask[];
  selectedDependencies?: SelectedDependency[];
  requestedAssigneeId?: string | null;

  // --- origin refs ---
  /** Clone source Task reference; required when `initialEventAction === "cloned"`. */
  cloneSourceTaskId?: string;

  // --- provenance (server-constructed; never trusted from an untrusted caller) ---
  actor: AuditActorRef;
  auditSource: AuditSource;
  causalContext: CausalContext;
  initialEventAction: InitialEventAction;

  // --- deterministic identity (optional override; default = allocated UUID) ---
  prospectiveTaskId?: string;
}

/**
 * The canonical prepared Task proposal — the output of successful preparation.
 *
 * Carries a prospective Task ID allocated BEFORE governance, the resolved
 * final target Mission + Habitat, normalized work-definition fields, the
 * editable aggregate (subtasks + selected dependencies), origin refs,
 * immutable provenance, and the initial-event action.
 *
 * EXCLUDES execution history: no `status`, no timestamps beyond the
 * provenance chain, no `version`, no `order` (the publication tx allocates
 * `order` inside the transaction). Repository Task models are deliberately
 * not isomorphic with this type — they carry fields no creator may set.
 *
 * See Technical Plan § "Canonical Task proposal".
 */
export interface CanonicalTaskPublicationProposal {
  // --- identity ---
  /** Prospective Task ID allocated before governance; becomes final on commit. */
  prospectiveTaskId: string;

  // --- target scope (final, resolved) ---
  habitatId: string;
  targetMissionId: string;

  // --- work definition (normalized: defaults applied, types tightened) ---
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  requiredDomain: string | null;
  requiredCapabilities: string[];
  estimatedMinutes: number | null;

  // --- editable aggregate ---
  subtasks: EditableSubtask[];
  selectedDependencies: SelectedDependency[];
  requestedAssigneeId: string | null;

  // --- origin refs ---
  /** Clone source Task reference, or `null` for a non-clone publication. */
  cloneSourceTaskId: string | null;

  // --- provenance (immutable after preparation) ---
  actor: AuditActorRef;
  auditSource: AuditSource;
  causalContext: CausalContext;
  initialEventAction: InitialEventAction;
}

/**
 * Snapshot of the mutable state whose change would invalidate publication.
 *
 * The publication transaction (Phase 3) re-reads and verifies this guard
 * BEFORE inserting anything. A mismatch rolls back without publication and
 * repeats preparation under the same pending attempt, reusing matching
 * governance decisions. A changed governance fingerprint records a new
 * auditable decision revision.
 *
 * Clone source version is INTENTIONALLY ABSENT: once clone preparation
 * initializes the form, user edits are authoritative. Only the final target
 * Mission, selected dependencies, and edited proposal are revalidated. See
 * Technical Plan § "Optimistic publication guard".
 *
 * NOTE: {@link interceptorEnrollmentFingerprint} is captured as a Phase-1
 * sentinel ({@link PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER}) because Phase
 * 1 owns only canonical preparation. Phase 2 computes the real
 * enrollment/configuration fingerprint when it owns the prospective
 * `taskCreated` transition and overwrites this field before re-verify.
 */
export interface PublicationGuard {
  // --- target Mission identity + version ---
  missionId: string;
  missionVersion: number;
  missionStatus: MissionStatus;

  // --- Habitat ---
  habitatId: string;

  // --- dependency-graph state (the depended-on tasks' ids + versions/status) ---
  dependencies: Array<{
    taskId: string;
    version: number;
    status: TaskStatus;
  }>;

  // --- interceptor enrollment/configuration fingerprint (Phase 2 fills) ---
  interceptorEnrollmentFingerprint: string;
}

/**
 * A single actionable validation error collected during preparation.
 *
 * `field` locates the defect (dotted path for nested fields, or the scope
 * token for mission/dependency-graph failures). `code` is the stable
 * machine-readable reason; `message` is human-readable.
 */
export interface PublicationError {
  field: string;
  code: string;
  message: string;
}

/**
 * Closed preparation result.
 *
 * Never throws for a validation decision — returns `rejected_validation`
 * carrying every collected {@link PublicationError}. Infrastructure failures
 * (a repository throw) propagate as retryable runtime errors; they are NOT
 * domain rejections and must not be collapsed into this result.
 */
export type PrepareTaskResult =
  | { outcome: "prepared"; proposal: CanonicalTaskPublicationProposal; guard: PublicationGuard }
  | { outcome: "rejected_validation"; errors: PublicationError[] };

// ---------------------------------------------------------------------------
// Internal helpers (field validators — each pushes errors, never throws)
// ---------------------------------------------------------------------------

/** True when `v` is a non-empty string after trimming. */
function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when `v` is an array of strings (possibly empty). */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Rejects input objects carrying any execution-history key. Returns the list
 * of offending field names so the error message names every forbidden field
 * the caller tried to set.
 *
 * This is the gate that rejects repository `Task` models: they carry `status`,
 * `version`, `createdAt`, etc. — fields no creator may establish. Stripping
 * would silently mask caller bugs; the Technical Plan explicitly forbids
 * repository models as publication commands, so we reject with a typed error.
 */
function findForbiddenExecutionHistoryFields(input: object): string[] {
  const present: string[] = [];
  for (const field of EXECUTION_HISTORY_FIELDS) {
    if (field in input) present.push(field);
  }
  return present;
}

/**
 * Field-level validation. Collects EVERY actionable defect into `errors`;
 * never throws and never short-circuits on the first failure. The caller
 * surfaces all correctable fields in one round-trip.
 *
 * Provenance presence (`actor`/`auditSource`/`causalContext`) and
 * `initialEventAction` shape are validated here because they are field-shaped
 * input, not scope state.
 */
function collectFieldErrors(input: PrepareTaskPublicationInput): PublicationError[] {
  const errors: PublicationError[] = [];

  // --- execution-history contamination (rejects repository Task models) ---
  const forbidden = findForbiddenExecutionHistoryFields(input as object);
  for (const field of forbidden) {
    errors.push({
      field,
      code: "forbidden_execution_history_field",
      message: `Field "${field}" is execution history / tx-owned and may not be set by a creator. Project the input to the allowed PrepareTaskPublicationInput shape.`,
    });
  }

  // --- title ---
  if (!isNonEmpty(input.title)) {
    errors.push({
      field: "title",
      code: "missing_title",
      message: "A Task proposal must carry a non-empty title.",
    });
  }

  // --- priority ---
  if (input.priority !== undefined && !VALID_PRIORITIES.has(input.priority)) {
    errors.push({
      field: "priority",
      code: "invalid_priority",
      message: `Priority must be one of low|medium|high|critical; received "${String(input.priority)}".`,
    });
  }

  // --- labels ---
  if (input.labels !== undefined && !isStringArray(input.labels)) {
    errors.push({
      field: "labels",
      code: "invalid_labels_shape",
      message: "labels must be an array of strings.",
    });
  }

  // --- requiredCapabilities ---
  if (input.requiredCapabilities !== undefined && !isStringArray(input.requiredCapabilities)) {
    errors.push({
      field: "requiredCapabilities",
      code: "invalid_required_capabilities_shape",
      message: "requiredCapabilities must be an array of strings.",
    });
  }

  // --- requiredDomain ---
  if (input.requiredDomain !== undefined && input.requiredDomain !== null) {
    if (typeof input.requiredDomain !== "string") {
      errors.push({
        field: "requiredDomain",
        code: "invalid_required_domain_shape",
        message: "requiredDomain must be a string or null.",
      });
    } else if (input.requiredDomain.trim().length === 0) {
      errors.push({
        field: "requiredDomain",
        code: "empty_required_domain",
        message: "requiredDomain, when provided, must be a non-empty string (use null to clear).",
      });
    }
  }

  // --- estimatedMinutes ---
  if (
    input.estimatedMinutes !== undefined &&
    input.estimatedMinutes !== null &&
    (typeof input.estimatedMinutes !== "number" ||
      !Number.isInteger(input.estimatedMinutes) ||
      input.estimatedMinutes < 0)
  ) {
    errors.push({
      field: "estimatedMinutes",
      code: "invalid_estimated_minutes",
      message: "estimatedMinutes must be a non-negative integer (or null).",
    });
  }

  // --- initialEventAction ---
  if (input.initialEventAction !== "created" && input.initialEventAction !== "cloned") {
    errors.push({
      field: "initialEventAction",
      code: "invalid_initial_event_action",
      message: `initialEventAction must be "created" or "cloned"; received "${String(input.initialEventAction)}".`,
    });
  }

  // --- cloneSourceTaskId required for cloned publications ---
  if (input.initialEventAction === "cloned" && !isNonEmpty(input.cloneSourceTaskId)) {
    errors.push({
      field: "cloneSourceTaskId",
      code: "missing_clone_source",
      message: 'A "cloned" publication must reference its clone source Task via cloneSourceTaskId.',
    });
  }

  // --- provenance presence ---
  if (
    !input.actor ||
    typeof input.actor !== "object" ||
    typeof input.actor.type !== "string"
  ) {
    errors.push({
      field: "actor",
      code: "invalid_actor",
      message: "actor must be an AuditActorRef with a `type` discriminator.",
    });
  }
  if (typeof input.auditSource !== "string" || input.auditSource.length === 0) {
    errors.push({
      field: "auditSource",
      code: "invalid_audit_source",
      message: "auditSource must be a non-empty AuditSource string.",
    });
  }
  if (
    !input.causalContext ||
    typeof input.causalContext !== "object" ||
    !input.causalContext.root ||
    typeof input.causalContext.root.type !== "string" ||
    typeof input.causalContext.root.id !== "string"
  ) {
    errors.push({
      field: "causalContext",
      code: "invalid_causal_context",
      message: "causalContext must carry a `root: { type, id }` (CausalContext).",
    });
  }

  // --- prospectiveTaskId (optional override; must be non-empty when supplied) ---
  if (
    input.prospectiveTaskId !== undefined &&
    (typeof input.prospectiveTaskId !== "string" || input.prospectiveTaskId.trim().length === 0)
  ) {
    errors.push({
      field: "prospectiveTaskId",
      code: "invalid_prospective_task_id",
      message: "prospectiveTaskId, when supplied, must be a non-empty string.",
    });
  }

  // --- subtasks ---
  if (input.subtasks !== undefined) {
    if (!Array.isArray(input.subtasks)) {
      errors.push({
        field: "subtasks",
        code: "invalid_subtasks_shape",
        message: "subtasks must be an array of EditableSubtask.",
      });
    } else {
      input.subtasks.forEach((st, i) => {
        if (!st || typeof st !== "object") {
          errors.push({
            field: `subtasks[${i}]`,
            code: "invalid_subtask_shape",
            message: `subtasks[${i}] must be an EditableSubtask object.`,
          });
          return;
        }
        if (!isNonEmpty(st.title)) {
          errors.push({
            field: `subtasks[${i}].title`,
            code: "missing_subtask_title",
            message: `subtasks[${i}].title must be a non-empty string.`,
          });
        }
        if (
          st.order !== undefined &&
          (typeof st.order !== "number" || !Number.isInteger(st.order) || st.order < 0)
        ) {
          errors.push({
            field: `subtasks[${i}].order`,
            code: "invalid_subtask_order",
            message: `subtasks[${i}].order must be a non-negative integer.`,
          });
        }
      });
    }
  }

  // --- selectedDependencies (field shape; existence/scope/cycle checked later) ---
  if (input.selectedDependencies !== undefined) {
    if (!Array.isArray(input.selectedDependencies)) {
      errors.push({
        field: "selectedDependencies",
        code: "invalid_selected_dependencies_shape",
        message: "selectedDependencies must be an array of { dependsOnId: string }.",
      });
    } else {
      input.selectedDependencies.forEach((dep, i) => {
        if (!dep || typeof dep !== "object" || !isNonEmpty(dep.dependsOnId)) {
          errors.push({
            field: `selectedDependencies[${i}].dependsOnId`,
            code: "invalid_dependency_shape",
            message: `selectedDependencies[${i}].dependsOnId must be a non-empty string.`,
          });
        }
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Canonicalization (pure; runs only after ALL field + scope validation passes)
// ---------------------------------------------------------------------------

/** Normalizes the validated input into the canonical proposal shape. */
function canonicalize(
  input: PrepareTaskPublicationInput,
  prospectiveTaskId: string,
): CanonicalTaskPublicationProposal {
  return {
    prospectiveTaskId,
    habitatId: input.habitatId,
    targetMissionId: input.targetMissionId,
    title: input.title.trim(),
    description: input.description?.trim() ?? "",
    priority: input.priority ?? "medium",
    labels: input.labels ?? [],
    requiredDomain:
      input.requiredDomain === undefined ? null : input.requiredDomain === null ? null : input.requiredDomain,
    requiredCapabilities: input.requiredCapabilities ?? [],
    estimatedMinutes:
      input.estimatedMinutes === undefined ? null : input.estimatedMinutes,
    subtasks: (input.subtasks ?? []).map((st, i) => ({
      title: st.title.trim(),
      order: st.order ?? i,
      assigneeId: st.assigneeId ?? null,
    })),
    selectedDependencies: (input.selectedDependencies ?? []).map((d) => ({
      dependsOnId: d.dependsOnId,
    })),
    requestedAssigneeId:
      input.requestedAssigneeId === undefined ? null : input.requestedAssigneeId,
    cloneSourceTaskId: isNonEmpty(input.cloneSourceTaskId) ? input.cloneSourceTaskId! : null,
    actor: input.actor,
    auditSource: input.auditSource,
    causalContext: input.causalContext,
    initialEventAction: input.initialEventAction,
  };
}

// ---------------------------------------------------------------------------
// Public API (Deliverable 2)
// ---------------------------------------------------------------------------

/**
 * Validate, canonicalize, and capture a publication guard for one Task
 * proposal. PURE: performs only read-only validation against the existing
 * mission/habitat/dependency repositories, allocates a prospective Task ID,
 * and returns either a prepared proposal + guard or a collected list of
 * validation errors.
 *
 * Validation DECISIONS never throw — a `rejected_validation` result is
 * returned for every field, scope, or graph failure. Infrastructure failures
 * (a repository throw) propagate as retryable runtime errors and are NOT
 * collapsed into the validation result.
 *
 * Validation collects ALL actionable field errors in one result (not
 * first-only). Scope/graph checks (mission active, habitat consistency,
 * dependency integrity) run after field validation so a single round-trip
 * can surface every correctable defect plus every scope failure together.
 *
 * @see CanonicalTaskPublicationProposal — the prepared proposal shape.
 * @see PublicationGuard — the mutable-state snapshot Phase 3 re-verifies.
 */
export function prepareTaskPublication(
  input: PrepareTaskPublicationInput,
): PrepareTaskResult {
  const errors: PublicationError[] = [];

  // 1. Field validation (collected, never short-circuited).
  errors.push(...collectFieldErrors(input));

  // 2. Active-Mission + Habitat-consistency validation.
  //    Reuses getMissionById / getHabitatById (read-only).
  const mission = getMissionById(input.targetMissionId);
  if (!mission) {
    errors.push({
      field: "targetMissionId",
      code: "mission_not_found",
      message: `No Mission exists with id "${input.targetMissionId}".`,
    });
  } else {
    // Habitat existence (the authoritative Habitat the caller claims).
    const habitat = getHabitatById(input.habitatId);
    if (!habitat) {
      errors.push({
        field: "habitatId",
        code: "habitat_not_found",
        message: `No Habitat exists with id "${input.habitatId}".`,
      });
    } else if (mission.habitatId !== input.habitatId) {
      errors.push({
        field: "targetMissionId",
        code: "cross_habitat_mission",
        message: `Mission "${mission.id}" belongs to Habitat "${mission.habitatId}", not the authoritative Habitat "${input.habitatId}".`,
      });
    }

    if (mission.isArchived) {
      errors.push({
        field: "targetMissionId",
        code: "mission_archived",
        message: `Mission "${mission.id}" is archived and does not accept new Task publication.`,
      });
    }

    if (!ACTIVE_MISSION_STATUSES.has(mission.status)) {
      errors.push({
        field: "targetMissionId",
        code: "mission_inactive",
        message: `Mission "${mission.id}" has terminal status "${mission.status}"; only not_started|in_progress|review accept new Tasks.`,
      });
    }
  }

  // 3. Dependency-graph integrity (existence, scope, self-ref, dup, cycle).
  //    Reuses getTasksByIds + wouldCreateTaskCycle (read-only).
  const prospectiveTaskId = isNonEmpty(input.prospectiveTaskId)
    ? input.prospectiveTaskId
    : uuid();

  const selectedDeps = input.selectedDependencies ?? [];
  if (selectedDeps.length > 0) {
    // 3a. Self-reference (the Phase-1 cycle-class rejection — a new task with
    //     only outgoing edges cannot otherwise form a topological cycle, so
    //     self-reference is the meaningful cycle case here).
    for (const dep of selectedDeps) {
      if (dep.dependsOnId === prospectiveTaskId) {
        errors.push({
          field: "selectedDependencies",
          code: "self_dependency",
          message: `A Task cannot depend on itself (prospectiveTaskId "${prospectiveTaskId}" appears in selectedDependencies).`,
        });
      }
    }

    // 3b. Duplicate selected deps.
    const seen = new Set<string>();
    for (const dep of selectedDeps) {
      if (seen.has(dep.dependsOnId)) {
        errors.push({
          field: "selectedDependencies",
          code: "duplicate_dependency",
          message: `Dependency "${dep.dependsOnId}" is selected more than once.`,
        });
      }
      seen.add(dep.dependsOnId);
    }

    // 3c. Existence + scope (same-Habitat as the authoritative Habitat).
    const depIds = [...new Set(selectedDeps.map((d) => d.dependsOnId))];
    const depTasks = getTasksByIds(depIds);
    const depById = new Map(depTasks.map((t) => [t.id, t]));
    for (const depId of depIds) {
      const depTask = depById.get(depId);
      if (!depTask) {
        errors.push({
          field: "selectedDependencies",
          code: "dangling_dependency",
          message: `Selected dependency "${depId}" does not reference an existing Task.`,
        });
        continue;
      }
      // Resolve the dep task's Habitat via its Mission and enforce same-scope.
      // (taskDependencies is same-graph only; cross-Habitat deps are a
      // separate UI concept and not expressible as selectedDependencies.)
      const depMission = getMissionById(depTask.missionId);
      if (!depMission || depMission.habitatId !== input.habitatId) {
        errors.push({
          field: "selectedDependencies",
          code: "cross_habitat_dependency",
          message: `Selected dependency "${depId}" is not in Habitat "${input.habitatId}" and cannot be depended on.`,
        });
      }
    }

    // 3d. Cycle detection via the established helper. For a brand-new
    //     prospective task with only outgoing edges this is currently always
    //     false (nothing in the existing graph points at the prospective ID),
    //     but the primitive is the correct one and becomes load-bearing in
    //     batch / re-verify contexts (Phase 3).
    for (const depId of depIds) {
      if (wouldCreateTaskCycle(prospectiveTaskId, depId)) {
        errors.push({
          field: "selectedDependencies",
          code: "circular_dependency",
          message: `Adding dependency on "${depId}" would create a circular dependency.`,
        });
      }
    }
  }

  // 4. Any collected error → rejected_validation (never throws).
  if (errors.length > 0) {
    return { outcome: "rejected_validation", errors };
  }

  // 5. Canonicalize + capture the optimistic publication guard.
  //    Mission is non-null here (no mission_not_found error collected).
  const proposal = canonicalize(input, prospectiveTaskId);
  const resolvedMission = mission!;

  // The depended-on tasks' id + version + status snapshot. The publication tx
  // re-verifies these (Phase 3): if a depended-on task's version/status
  // changed between preparation and commit, the guard mismatches and the
  // attempt re-prepares under the same pending key.
  const dependencySnapshots = (input.selectedDependencies ?? []).map((d) => {
    const t = getTasksByIds([d.dependsOnId])[0];
    return { taskId: t.id, version: t.version, status: t.status };
  });

  const guard: PublicationGuard = {
    missionId: resolvedMission.id,
    missionVersion: resolvedMission.version,
    missionStatus: resolvedMission.status,
    habitatId: input.habitatId,
    dependencies: dependencySnapshots,
    // Phase-1 sentinel: Phase 2 overwrites with the real enrollment/config
    // fingerprint when it owns the prospective taskCreated transition.
    interceptorEnrollmentFingerprint: PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  };

  return { outcome: "prepared", proposal, guard };
}
