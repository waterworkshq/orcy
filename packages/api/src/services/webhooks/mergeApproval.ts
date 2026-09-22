import { getDb } from "../../db/index.js";
import * as taskRepo from "../../repositories/task.js";
import * as eventRepo from "../../repositories/event.js";
import { emitTransition } from "../tasks/transition-emitter.js";
import { notifyTaskEvent } from "../tasks/task-lifecycle.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { logger } from "../../lib/logger.js";
import type { Task, TaskEvent } from "../../models/index.js";

/**
 * Sanitized provenance carried on the merge-approval event row and the
 * post-commit effect contexts — the same set for both, nothing else crosses.
 * `repo` is display metadata (full_name / path_with_namespace), never an
 * authority: the authority was the signature→habitat→allowlist binding that
 * ran before this helper was reached.
 */
export interface MergeApprovalProvenance {
  provider: "github" | "gitlab";
  repo: string;
  prNumber: number;
}

export type MergeApprovalOutcome =
  | { outcome: "approved"; task: Task; event: TaskEvent; oldStatus: string }
  | { outcome: "no_op"; status: string };

/**
 * Merge-as-approval (REC-06 C4, addendum-2 pins): composes the repo task
 * approval and its audit event in ONE `BEGIN IMMEDIATE` transaction.
 *
 * In-transaction order:
 * 1. Winning preimage read (status/version) — the handler's earlier read is
 *    advisory only; `oldStatus` for the emitted effects comes from HERE.
 * 2. Status gate: anything other than `submitted` is a duplicate/no-op that
 *    returns with ZERO writes (no event, no version bump, no effects).
 * 3. The existing strict single-status CAS `taskRepo.approveTask` (WHERE
 *    status = 'submitted'), joined to this transaction through the shared
 *    single connection — concurrent duplicate deliveries serialize on the
 *    IMMEDIATE write lock; the loser's CAS matches zero rows and returns null.
 * 4. `eventRepo.createEvent` in the SAME transaction — an insert failure
 *    throws and rolls back the approval write.
 *
 * Post-commit, only on the committed transition, exactly once:
 * `emitTransition(existingEventId)` (full effect mask: SSE, watchers,
 * dependency unblock, mission recalc, pulses, transition hooks) then
 * `runPostInterceptors` (ADR-0014 post seam) then the task-event hook bus —
 * all with the SAME sanitized provenance/system actor as the event row.
 * These effects are best-effort and in-process: a crash between the commit
 * and the emission loses the effect mask but never the audited state; repeat
 * deliveries of an already-approved task return before emission (no retry,
 * no duplicate effects). This is service-parity with the canonical approve
 * path's documented crash window — no durability or exactly-once claim.
 */
export function approveTaskForMergedPR(params: {
  taskId: string;
  habitatId: string;
  provenance: MergeApprovalProvenance;
}): MergeApprovalOutcome {
  const db = getDb();
  const actorId = `${params.provenance.provider}-webhook`;
  const metadata: Record<string, unknown> = { ...params.provenance, autoApproved: true };

  const result = db.transaction(
    () => {
      const preimage = taskRepo.getTaskById(params.taskId);
      if (!preimage) return { outcome: "no_op" as const, status: "missing" };
      if (preimage.status !== "submitted") {
        return { outcome: "no_op" as const, status: preimage.status };
      }

      const task = taskRepo.approveTask(params.taskId);
      if (!task) return { outcome: "no_op" as const, status: "lost_race" };

      const event = eventRepo.createEvent({
        taskId: params.taskId,
        actorType: "system",
        actorId,
        action: "approved",
        fromStatus: "submitted",
        toStatus: "approved",
        metadata,
      });

      return { outcome: "approved" as const, task, event, oldStatus: preimage.status };
    },
    { behavior: "immediate" },
  );

  if (result.outcome !== "approved") return result;

  const context = {
    actorType: "system" as const,
    actorId,
    oldStatus: result.oldStatus,
    newStatus: "approved" as const,
    metadata,
    task: result.task,
    existingEventId: result.event.id,
  };

  try {
    emitTransition(params.taskId, "approved", params.habitatId, context);
    pluginManager.runPostInterceptors(params.taskId, "taskApproved", params.habitatId, context);
    if (params.habitatId) {
      notifyTaskEvent({
        habitatId: params.habitatId,
        taskId: params.taskId,
        event: "approved",
        actorType: "system",
        actorId,
      });
    }
  } catch (err) {
    logger.warn(
      { err, taskId: params.taskId },
      "Merge-approval post-commit effects failed (audited state is committed)",
    );
  }

  return result;
}
