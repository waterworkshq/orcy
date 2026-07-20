/**
 * subtasks domain handler — Task checklist items.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-subtask shape: `sourceId`, `taskSourceId`, `title`, `order`,
 *     `completed`, `assigneeId` are well-formed.
 *   - `taskSourceId` is a non-empty string (the reference SHAPE; resolution
 *     against the tasks domain happens in resolveReferences via the idMap).
 *   - `order` is a non-negative integer.
 *
 * # prepare
 *
 * Allocates one prospective server ID per subtask into the idMap.
 *
 * # resolveReferences
 *
 * Rewrites each subtask's `taskSourceId` → the task's server ID (from the
 * idMap, populated by the tasks handler's prepare).
 *
 * @see packages/api/src/services/importManifest/types.ts for SubtaskPortable.
 */
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
import { createSubtaskWithClient } from "../../../repositories/taskPublication.js";
import type { TaskPublicationDbClient } from "../../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

export interface ValidatedSubtask {
  sourceId: string;
  taskSourceId: string;
  title: string;
  order: number;
  completed: boolean;
  assigneeId: string | null;
}

export interface ValidatedSubtasks {
  subtasks: ValidatedSubtask[];
}

export interface PreparedSubtask {
  sourceId: string;
  /** The prospective server-side subtask id (allocated in prepare). */
  subtaskServerId: string;
  /** The source Task's sourceId (rewritten to a server id in resolveReferences). */
  taskSourceId: string;
  /** The resolved Task server id (null until resolveReferences runs). */
  taskServerId: string | null;
  title: string;
  order: number;
  completed: boolean;
  assigneeId: string | null;
}

export interface PreparedSubtasks {
  subtasks: PreparedSubtask[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateSubtasks(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedSubtasks> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError("subtasks", "invalid_envelope_data", "subtasks envelope data must be an array", {
        actual: typeof raw,
      }),
    ]);
  }

  const validated: ValidatedSubtask[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["subtasks", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError("subtasks", "invalid_subtask_shape", `subtasks[${i}] must be a plain object`, {
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
          "subtasks",
          "invalid_source_id",
          `subtasks[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.taskSourceId !== "string" || e.taskSourceId.length === 0) {
      errs.push(
        domainError(
          "subtasks",
          "invalid_task_source_id",
          `subtasks[${i}].taskSourceId must be a non-empty string`,
          { actual: typeof e.taskSourceId, fieldPath: [...fieldPathBase, "taskSourceId"] },
        ),
      );
    }

    if (typeof e.title !== "string" || e.title.length === 0) {
      errs.push(
        domainError(
          "subtasks",
          "invalid_title",
          `subtasks[${i}].title must be a non-empty string`,
          { actual: typeof e.title, fieldPath: [...fieldPathBase, "title"] },
        ),
      );
    }

    if (!Number.isInteger(e.order) || (e.order as number) < 0) {
      errs.push(
        domainError(
          "subtasks",
          "invalid_order",
          `subtasks[${i}].order must be a non-negative integer`,
          { actual: e.order, fieldPath: [...fieldPathBase, "order"] },
        ),
      );
    }

    if (typeof e.completed !== "boolean") {
      errs.push(
        domainError("subtasks", "invalid_completed", `subtasks[${i}].completed must be a boolean`, {
          actual: typeof e.completed,
          fieldPath: [...fieldPathBase, "completed"],
        }),
      );
    }

    if (
      e.assigneeId !== null &&
      (typeof e.assigneeId !== "string" || (e.assigneeId as string).length === 0)
    ) {
      errs.push(
        domainError(
          "subtasks",
          "invalid_assignee_id",
          `subtasks[${i}].assigneeId must be a non-empty string or null`,
          { actual: typeof e.assigneeId, fieldPath: [...fieldPathBase, "assigneeId"] },
        ),
      );
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    validated.push({
      sourceId: e.sourceId as string,
      taskSourceId: e.taskSourceId as string,
      title: e.title as string,
      order: e.order as number,
      completed: e.completed as boolean,
      assigneeId: (e.assigneeId ?? null) as string | null,
    });
  });

  if (errors.length > 0) return validationErr(errors);
  return validationOk({ subtasks: validated });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareSubtasks(
  validated: ValidatedSubtasks,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedSubtasks {
  const subtasks: PreparedSubtask[] = validated.subtasks.map((s) => {
    const subtaskServerId = allocateServerId(idMap, s.sourceId);
    return {
      sourceId: s.sourceId,
      subtaskServerId,
      taskSourceId: s.taskSourceId,
      taskServerId: null,
      title: s.title,
      order: s.order,
      completed: s.completed,
      assigneeId: s.assigneeId,
    };
  });
  return { subtasks };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite taskSourceId → taskServerId)
// ---------------------------------------------------------------------------

export function resolveSubtasksReferences(
  prepared: PreparedSubtasks,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedSubtasks> {
  const errors: DomainError[] = [];
  const resolvedSubtasks: PreparedSubtask[] = prepared.subtasks.map((s) => {
    const taskServerId = idMap.sourceToServer.get(s.taskSourceId);
    if (taskServerId === undefined) {
      errors.push(
        domainError(
          "subtasks",
          "unresolved_task_source_id",
          `subtask '${s.sourceId}' references unknown taskSourceId '${s.taskSourceId}'`,
          { sourceId: s.sourceId, actual: s.taskSourceId },
        ),
      );
      return { ...s, taskServerId: null };
    }
    return { ...s, taskServerId };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ subtasks: resolvedSubtasks });
}

// ---------------------------------------------------------------------------
// Apply (T10B M1 — caller-owned tx; uses the tx-aware `createSubtaskWithClient`)
// ---------------------------------------------------------------------------

/**
 * Writes the subtask rows for `mode:"new"` imports via the tx-aware
 * {@link createSubtaskWithClient} primitive (lives in `taskPublication.ts`).
 *
 * # Why a `*WithClient` primitive (vs raw `tx.insert`)
 *
 * `createSubtaskWithClient` is the existing publication-domain primitive
 * that mirrors `taskPublication.ts`'s additive seam convention: it accepts
 * a caller-supplied `TaskPublicationDbClient` so the subtask commit shares
 * the orchestrator's tx. Reusing it here means the subtask path inherits
 * the same error wrapping (`repositoryCreateError` → `AppError`) and the
 * same cross-backend portable pattern (sql.js + better-sqlite3) that the
 * kernel-subtask path uses — no handler-specific fork of the insert logic.
 *
 * # M1 scope (the `new` path)
 *
 * For `mode:"new"`, every prepared subtask gets one INSERT. M2's
 * `mode:"replacement"` in-place logic is layered here: `replace` does
 * scoped-delete-before-INSERT, `preserve` is a no-op. M1 throws if it sees
 * `mode:"replacement"`.
 *
 * # Caller-owned tx (load-bearing)
 *
 * The underlying `createSubtaskWithClient` NEVER calls `getDb()` — it
 * operates on the passed client only. Subtasks compose inside the
 * orchestrator's transaction; an exception rolls the whole aggregate back.
 */
export function applySubtasks(
  tx: TaskPublicationDbClient,
  prepared: PreparedSubtasks,
  ctx: ApplyContext,
): AppliedDomain {
  if (ctx.mode === "replacement") {
    throw new Error(
      "subtasks.apply: mode:'replacement' in-place logic is M2's scope; M1 ships the mode:'new' INSERT path only",
    );
  }

  const committedServerIds: string[] = [];
  for (const s of prepared.subtasks) {
    const taskServerId = s.taskServerId;
    if (taskServerId === null) {
      throw new Error(
        `subtasks.apply: subtask '${s.sourceId}' has unresolved taskServerId — resolveReferences did not run or failed`,
      );
    }
    const row = createSubtaskWithClient(tx, {
      taskId: taskServerId,
      title: s.title,
      order: s.order,
      completed: s.completed,
      assigneeId: s.assigneeId ?? undefined,
    });
    committedServerIds.push(row.id);
  }

  return {
    domain: "subtasks",
    mode: "new",
    committedServerIds,
    inserted: committedServerIds.length,
  };
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const subtasksHandler: DomainHandler<ValidatedSubtasks, PreparedSubtasks> = {
  domainName: "subtasks",
  validate: validateSubtasks,
  prepare: prepareSubtasks,
  resolveReferences: resolveSubtasksReferences,
  apply: applySubtasks,
};
