/**
 * tasks domain handler — the unit of work.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-task shape: `sourceId`, `missionSourceId`, `title`, `description`,
 *     `priority`, `requiredDomain`, `requiredCapabilities` are well-formed.
 *   - `missionSourceId` is a non-empty string (the reference SHAPE; resolution
 *     against the missions domain happens in resolveReferences via the idMap).
 *   - `priority` ∈ {low, medium, high, critical}.
 *   - `requiredCapabilities` is an array of strings.
 *   - FORBIDDEN execution-state fields are ABSENT (C4 defensive re-verify).
 *     The legacy adapter (M2) strips these; the handler is the second-layer
 *     guard. Forbidden: `status`, `result`, `artifacts`, `assignedAgentId`,
 *     `rejectedCount`, `rejectionReason`, retry fields, `createdBy`, `order`,
 *     `createdAt`, `updatedAt`, `claimedAt`, `completedAt`.
 *
 * # prepare
 *
 * Allocates one prospective server ID per task into the idMap.
 *
 * # resolveReferences
 *
 * Rewrites each task's `missionSourceId` → the mission's server ID (from the
 * idMap, populated by the missions handler's prepare).
 *
 * @see packages/api/src/services/importManifest/types.ts for TaskPortable.
 * @see T10A ticket § "Forbidden-field absorption (C4 correction)".
 */
import type { TaskPriority } from "@orcy/shared";
import type { DomainEnvelope } from "../types.js";
import type {
  AppliedDomain,
  ApplyContext,
  DomainError,
  DomainHandler,
  DomainValidationResult,
  IdentityMap,
  ManifestContext,
  ReferenceResolution,
} from "../domainHandler.js";
import {
  allocateServerId,
  domainError,
  resolutionErr,
  resolutionOk,
  validationErr,
  validationOk,
} from "../domainHandler.js";
import type { TaskPublicationDbClient } from "../../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

const PRIORITIES = new Set<TaskPriority>(["low", "medium", "high", "critical"]);

/**
 * Fields that MUST NOT appear on a v3 Task payload (per the C4 absorption
 * table). The legacy adapter (M2) strips these; the handler is the
 * second-layer guard (defensive — never silently carry forbidden material).
 *
 * Execution state is NOT portable: a Task's `status`, `result`, `artifacts`,
 * agent assignments, and retry state are all RESET to pending/default on
 * every imported Task (the plan's "execution state resets" rule).
 */
const FORBIDDEN_TASK_FIELDS = [
  "status",
  "result",
  "artifacts",
  "assignedAgentId",
  "rejectedCount",
  "rejectionReason",
  "retryCount",
  "retryHistory",
  "lastRetryAt",
  "claimedAt",
  "completedAt",
  "createdBy",
  "order",
  "createdAt",
  "updatedAt",
  "id",
] as const;

export interface ValidatedTask {
  sourceId: string;
  missionSourceId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  requiredDomain: string | null;
  requiredCapabilities: string[];
}

export interface ValidatedTasks {
  tasks: ValidatedTask[];
}

export interface PreparedTask {
  sourceId: string;
  /** The prospective server-side task id (allocated in prepare). */
  taskServerId: string;
  /** The source Mission's sourceId (rewritten to a server id in resolveReferences). */
  missionSourceId: string;
  /** The resolved Mission server id (null until resolveReferences runs). */
  missionServerId: string | null;
  title: string;
  description: string;
  priority: TaskPriority;
  requiredDomain: string | null;
  requiredCapabilities: string[];
}

export interface PreparedTasks {
  tasks: PreparedTask[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateTasks(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedTasks> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError("tasks", "invalid_envelope_data", "tasks envelope data must be an array", {
        actual: typeof raw,
      }),
    ]);
  }

  const validated: ValidatedTask[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["tasks", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError("tasks", "invalid_task_shape", `tasks[${i}] must be a plain object`, {
          actual: entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry,
          fieldPath: fieldPathBase,
        }),
      );
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.sourceId !== "string" || e.sourceId.length === 0) {
      errs.push(
        domainError(
          "tasks",
          "invalid_source_id",
          `tasks[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.missionSourceId !== "string" || e.missionSourceId.length === 0) {
      errs.push(
        domainError(
          "tasks",
          "invalid_mission_source_id",
          `tasks[${i}].missionSourceId must be a non-empty string`,
          { actual: typeof e.missionSourceId, fieldPath: [...fieldPathBase, "missionSourceId"] },
        ),
      );
    }

    if (typeof e.title !== "string" || e.title.length === 0) {
      errs.push(
        domainError("tasks", "invalid_title", `tasks[${i}].title must be a non-empty string`, {
          actual: typeof e.title,
          fieldPath: [...fieldPathBase, "title"],
        }),
      );
    }

    if (typeof e.description !== "string") {
      errs.push(
        domainError("tasks", "invalid_description", `tasks[${i}].description must be a string`, {
          actual: typeof e.description,
          fieldPath: [...fieldPathBase, "description"],
        }),
      );
    }

    if (typeof e.priority !== "string" || !PRIORITIES.has(e.priority as TaskPriority)) {
      errs.push(
        domainError(
          "tasks",
          "invalid_priority",
          `tasks[${i}].priority must be one of low | medium | high | critical`,
          {
            actual: e.priority,
            expected: "low | medium | high | critical",
            fieldPath: [...fieldPathBase, "priority"],
          },
        ),
      );
    }

    if (e.requiredDomain !== null && typeof e.requiredDomain !== "string") {
      errs.push(
        domainError(
          "tasks",
          "invalid_required_domain",
          `tasks[${i}].requiredDomain must be a string or null`,
          { actual: typeof e.requiredDomain, fieldPath: [...fieldPathBase, "requiredDomain"] },
        ),
      );
    }

    if (
      !Array.isArray(e.requiredCapabilities) ||
      e.requiredCapabilities.some((c) => typeof c !== "string")
    ) {
      errs.push(
        domainError(
          "tasks",
          "invalid_required_capabilities",
          `tasks[${i}].requiredCapabilities must be an array of strings`,
          {
            actual: Array.isArray(e.requiredCapabilities)
              ? "array with non-string elements"
              : typeof e.requiredCapabilities,
            fieldPath: [...fieldPathBase, "requiredCapabilities"],
          },
        ),
      );
    }

    // C4 forbidden-field absence (defensive re-verify).
    for (const forbidden of FORBIDDEN_TASK_FIELDS) {
      if (e[forbidden] !== undefined) {
        errs.push(
          domainError(
            "tasks",
            "forbidden_field_present",
            `forbidden field '${forbidden}' must not appear on task (C4 absorption: execution state resets — the adapter should have stripped it)`,
            { fieldPath: [...fieldPathBase, forbidden] },
          ),
        );
      }
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    validated.push({
      sourceId: e.sourceId as string,
      missionSourceId: e.missionSourceId as string,
      title: e.title as string,
      description: e.description as string,
      priority: e.priority as TaskPriority,
      requiredDomain: (e.requiredDomain ?? null) as string | null,
      requiredCapabilities: e.requiredCapabilities as string[],
    });
  });

  if (errors.length > 0) return validationErr(errors);
  return validationOk({ tasks: validated });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareTasks(
  validated: ValidatedTasks,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedTasks {
  const tasks: PreparedTask[] = validated.tasks.map((t) => {
    const taskServerId = allocateServerId(idMap, t.sourceId);
    return {
      sourceId: t.sourceId,
      taskServerId,
      missionSourceId: t.missionSourceId,
      missionServerId: null,
      title: t.title,
      description: t.description,
      priority: t.priority,
      requiredDomain: t.requiredDomain,
      requiredCapabilities: t.requiredCapabilities,
    };
  });
  return { tasks };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite missionSourceId → missionServerId)
// ---------------------------------------------------------------------------

export function resolveTasksReferences(
  prepared: PreparedTasks,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedTasks> {
  const errors: DomainError[] = [];
  const resolvedTasks: PreparedTask[] = prepared.tasks.map((t) => {
    const missionServerId = idMap.sourceToServer.get(t.missionSourceId);
    if (missionServerId === undefined) {
      errors.push(
        domainError(
          "tasks",
          "unresolved_mission_source_id",
          `task '${t.title}' (sourceId '${t.sourceId}') references unknown missionSourceId '${t.missionSourceId}'`,
          { sourceId: t.sourceId, actual: t.missionSourceId },
        ),
      );
      return { ...t, missionServerId: null };
    }
    return { ...t, missionServerId };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ tasks: resolvedTasks });
}

// ---------------------------------------------------------------------------
// Apply (T10B M1 — STUB; the kernel composition is M2's orchestrator scope)
// ---------------------------------------------------------------------------

/**
 * Tasks go through `publishTaskWithClient` (the kernel — Story 1's
 * composition primitive), NOT a direct `tx.insert(tasks)`. The kernel
 * handles the per-Task atomic publication: synthetic initial `created`
 * event, dispatch plan, governance decision, envelope, observation +
 * assignment gates, the `creationIntegrity: POST_CUTOVER` stamp, the
 * `creationObservationStateForTaskWithClient` claim gate — none of which
 * is reachable from a raw `tx.insert(tasks).values(...)`.
 *
 * # Why this is a STUB
 *
 * M1 ships the {@link DomainHandler.apply} slot uniform across all 8
 * handlers so the M2 orchestrator's per-domain iteration is uniform — it
 * does NOT special-case `tasks`. The M2 orchestrator OVERRIDES the tasks
 * path: instead of calling `tasksHandler.apply(tx, prepared, ctx)`, it
 * composes `publishTaskWithClient(tx, {attemptId, proposal, guard,
 * ...})` per Task inside its own tx, after the import-attempt record
 * reservation. The stub's job is to make the wrong caller loud:
 * invoking this in production / tests is an integration bug —
 * tasks compose via the kernel, not via the handler interface.
 *
 * # Throws always (M1 contract)
 *
 * The stub throws unconditionally when called. A passing test would mean
 * the orchestrator is correctly skipping the handler for tasks (the
 * intended path); a thrown error here is the safety net for the case
 * where a future M2 refactor accidentally delegates to
 * `tasksHandler.apply`.
 */
export function applyTasks(
  _tx: TaskPublicationDbClient,
  _prepared: PreparedTasks,
  _ctx: ApplyContext,
): AppliedDomain {
  throw new Error(
    "tasks.apply is a STUB in M1 — tasks compose through publishTaskWithClient (the kernel) inside the M2 orchestrator, not through DomainHandler.apply. If you reached this stub, a caller is incorrectly delegating to tasksHandler.apply.",
  );
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const tasksHandler: DomainHandler<ValidatedTasks, PreparedTasks> = {
  domainName: "tasks",
  validate: validateTasks,
  prepare: prepareTasks,
  resolveReferences: resolveTasksReferences,
  apply: applyTasks,
};
