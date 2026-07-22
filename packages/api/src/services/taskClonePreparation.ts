/**
 * Clone Preparation — read-only allowlisted DTO (T7 Phase 1 — DORMANT).
 *
 * Clone is a prepare-edit-publish journey, NOT immediate Task creation (Core
 * Flows § "Editable Clone Preparation and Publication"). Opening the clone
 * form creates NOTHING — no attempt, no Task, no event. This function is the
 * "Prepare" step: it reads the source Task's CURRENT work definition and
 * returns an allowlisted {@link ClonePreparation} DTO that prefills the
 * shared Task composer in clone mode.
 *
 * The DTO is constructed by EXPLICIT ALLOWLIST SELECTION — it selects the
 * reusable work-definition fields, RESET Subtasks, and dependency suggestions.
 * It NEVER serializes a Task and removes forbidden fields (the Technical Plan
 * § "Read-only preparation API" explicitly rejects that). Execution history
 * (status, assignee, results, artifacts, comments, watchers, reviewers,
 * approvals, effort, retries, failures, Lifecycle Events, timestamps) is
 * structurally absent — the type carries no field for it.
 *
 * Authorization (Core Flows § "Target Mission"): the caller must have read
 * access to the source Task's Habitat. This is enforced at the route layer
 * (P2 — `humanAuth`/`agentAuth` preHandler + Habitat scoping), mirroring the
 * existing task-read authorization. The service resolves the source's Habitat
 * read-only; it performs NO write and reserves NO attempt.
 *
 * DORMANT: no production route calls this until P2/T11. Legacy `cloneTask`
 * (`services/tasks/task-crud.ts:79`) stays the active immediate-copy path.
 *
 * See: Core Flows § "Editable Clone Preparation and Publication"; Technical
 * Plan § "Clone Prepare/Edit/Publish" → "Read-only preparation API".
 */
import type { TaskPriority } from "@orcy/shared";
import { getTaskById } from "../repositories/taskCrud.js";
import { getMissionById } from "../repositories/mission.js";
import { getSubtasksByTaskId } from "../repositories/subtask.js";
import { getTaskDependencies } from "../repositories/dependency.js";

// ---------------------------------------------------------------------------
// DTO types — constructed by allowlist selection (no execution-history fields)
// ---------------------------------------------------------------------------

/**
 * A Subtask in the clone-preparation DTO — RESET to incomplete + unassigned.
 *
 * Carries ONLY the editable work-structure fields (`title`, `order`). The
 * source Subtask's `id`, `completed`, `assigneeId`, and timestamps are
 * deliberately absent: copied Subtasks are editable, removable, addable, and
 * reorderable, and they reset to incomplete + unassigned (Core Flows §
 * "Prefilled content"). The publication transaction allocates fresh Subtask
 * identity and stamps execution state.
 */
export interface ClonePreparationSubtask {
  title: string;
  order: number;
}

/**
 * A directional dependency edge suggested (NOT selected) by clone preparation.
 *
 * Mirrors the source Task's OUTGOING dependency edges (what the source
 * depends on). These appear as OPTIONAL suggestions — the user must
 * explicitly select them in the composer, and Orcy revalidates the final
 * dependency graph before publication (Core Flows § "Prefilled content").
 * The {@link dependsOnId} references an existing Task in the source's
 * Habitat; it is revalidated at publication time.
 */
export interface CloneDependencySuggestion {
  dependsOnId: string;
}

/**
 * Provenance + scope reference to the clone source.
 *
 * The source Task + Mission + Habitat references needed for:
 *   - provenance (the `cloned` Lifecycle Event links to the source Task);
 *   - same-Habitat enforcement (the clone target Mission must be in
 *     {@link habitatId});
 *   - re-reading on reopen (cancelling discards; reopening reads latest).
 */
export interface CloneSourceReference {
  taskId: string;
  missionId: string;
  habitatId: string;
}

/**
 * The allowlisted clone-preparation DTO — the output of a successful prepare.
 *
 * Carries ONLY reusable work-definition fields, RESET Subtasks, UNSELECTED
 * dependency suggestions, the source Mission as the default target, and
 * source references for provenance + same-Habitat enforcement. It contains
 * NO execution-history field — the type itself is the allowlist (a forbidden
 * field cannot be expressed on it). See Core Flows § "Prefilled content".
 */
export interface ClonePreparation {
  // --- source references (provenance + same-Habitat enforcement) ---
  source: CloneSourceReference;

  // --- default target Mission (the source Mission; user may choose another
  //     active Mission in the same Habitat) ---
  defaultTargetMissionId: string;

  // --- reusable work-definition fields (allowlist-selected from the source) ---
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  requiredDomain: string | null;
  requiredCapabilities: string[];
  estimatedMinutes: number | null;

  // --- RESET Subtasks (incomplete + unassigned; editable/removable/addable/
  //     reorderable). Copy the work STRUCTURE, not the execution state. ---
  subtasks: ClonePreparationSubtask[];

  // --- UNSELECTED directional dependency suggestions (the user must
  //     explicitly select; revalidated at publication). ---
  dependencySuggestions: CloneDependencySuggestion[];
}

/**
 * Closed preparation result. Never throws for a domain decision — a missing
 * source returns `{ outcome: "not_found" }`. Infrastructure failures (a
 * repository throw) propagate as retryable runtime errors.
 */
export type PrepareCloneResult =
  | { outcome: "prepared"; preparation: ClonePreparation }
  | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the source Task's current work definition and returns an
 * allowlisted {@link ClonePreparation} DTO for the clone composer.
 *
 * PURE / READ-ONLY: performs only reads against the task/mission/subtask/
 * dependency repositories. It creates NO attempt, NO Task, NO event, NO
 * reservation — opening the clone form creates nothing (Core Flows §
 * "Prepare" rule 3). Cancelling discards the in-memory clone; reopening
 * calls this again against the source's latest details.
 *
 * The DTO is constructed by selecting reusable fields from the source —
 * NOT by serializing a Task and stripping forbidden fields. Subtasks are
 * RESET to incomplete + unassigned; dependencies are UNSELECTED suggestions.
 *
 * Authorization (read access to the source's Habitat) is enforced at the
 * route layer (P2), mirroring task-read authorization. This service resolves
 * the source's Habitat read-only.
 *
 * @param sourceTaskId  the Task to clone from.
 * @returns `{ outcome: "prepared"; preparation }` on success, or
 *          `{ outcome: "not_found" }` when the source Task or its Mission
 *          does not exist.
 */
export function prepareClonePublication(sourceTaskId: string): PrepareCloneResult {
  // 1. Source Task existence.
  const sourceTask = getTaskById(sourceTaskId);
  if (!sourceTask) return { outcome: "not_found" };

  // 2. Source Mission → Habitat (for the default target + same-Habitat rule).
  const sourceMission = getMissionById(sourceTask.missionId);
  if (!sourceMission) return { outcome: "not_found" };

  // 3. RESET Subtasks — select ONLY title + order. The source's `completed`,
  //    `assigneeId`, `id`, and timestamps are NOT carried: copied Subtasks
  //    reset to incomplete + unassigned and are editable/removable/addable/
  //    reorderable. Preserve the source ordering.
  const subtasks: ClonePreparationSubtask[] = getSubtasksByTaskId(sourceTaskId).map((s) => ({
    title: s.title,
    order: s.order,
  }));

  // 4. UNSELECTED dependency suggestions — the source's OUTGOING edges (what
  //    the source depends on). These are suggestions only; the user must
  //    explicitly select them and they are revalidated at publication.
  const dependencySuggestions: CloneDependencySuggestion[] = getTaskDependencies(
    sourceTaskId,
  ).dependsOn.map((d) => ({ dependsOnId: d.taskId }));

  // 5. Construct the DTO by ALLOWLIST SELECTION. Each field below is
  //    explicitly chosen from the source Task — execution-history fields
  //    (status, assignedAgentId, results, artifacts, timestamps, version,
  //    order, creationIntegrity, etc.) are structurally absent because they
  //    are not on the {@link ClonePreparation} type. This is NOT a
  //    serialize-then-remove: the type IS the allowlist.
  const preparation: ClonePreparation = {
    source: {
      taskId: sourceTask.id,
      missionId: sourceMission.id,
      habitatId: sourceMission.habitatId,
    },
    defaultTargetMissionId: sourceMission.id,
    title: sourceTask.title,
    description: sourceTask.description,
    priority: sourceTask.priority,
    labels: sourceTask.labels,
    requiredDomain: sourceTask.requiredDomain,
    requiredCapabilities: sourceTask.requiredCapabilities,
    estimatedMinutes: sourceTask.estimatedMinutes,
    subtasks,
    dependencySuggestions,
  };

  return { outcome: "prepared", preparation };
}
