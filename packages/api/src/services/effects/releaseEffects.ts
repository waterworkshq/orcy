/**
 * Daemon worker contract — the release act-tx (REC-05, N3).
 *
 * The SEPARATE release seam: it is its own `BEGIN IMMEDIATE` transaction
 * with its own in-tx revalidation and must NEVER be routed through the
 * plain repo `taskStateMachine.releaseTask` path (that path has no receipts,
 * no event-in-tx ownership, and clears the provenance pointer it would need
 * to set). One transaction owns, atomically:
 *   1. the epoch revalidation — same B1 discipline as the fail act-tx: the
 *      row's stored token must equal the PRE-IMAGE's conveyed epoch (the
 *      session's execution token — never a mutation-time fresh read);
 *   2. the CAS release write `status IN ('claimed','in_progress') → 'pending'`,
 *      `assignedAgentId=NULL`, token cleared, `last_release_event_id=:eventId`;
 *   3. the `released` event row in-tx, stamped with the winning row's token;
 *   4. receipts for EXACTLY `{workflow_gates, failure_context}` (the closed
 *      census — `NOTIFY_TASK_EVENT_ACTIONS` excludes `released` so no
 *      detector/skill consumer exists, and `ACTION_EFFECTS.released` has no
 *      `triggerRetry` so no ladder receipt exists) with the causal snapshot
 *      carrying `action: "released"`.
 *
 * Post-commit the caller runs ONLY the non-required mask
 * (`emitTransitionNonRequired`) + the eager deliverer pass — the shared
 * postlude, no new framework.
 *
 * Refusal (status moved / epoch moved / task gone) returns `null` with ZERO
 * release-bundle writes — the caller's branch logic decides what that means
 * (`no_op_epoch_mismatch` / `no_op_task_terminal`); there is deliberately NO
 * failover to another seam.
 */
import { getDb } from "../../db/index.js";
import { tasks, taskEvents, taskWorkflowGates, workflows } from "../../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as taskRepo from "../../repositories/task.js";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import { insertReceipt, type EffectDbClient } from "../../repositories/effectReceipts.js";
import type { Task } from "../../models/index.js";

/** The two required consumers enqueued per `released` event (closed census). */
export const RELEASED_EFFECT_CONSUMERS = ["workflow_gates", "failure_context"] as const;

export interface ReleaseWithEffectsResult {
  task: Task;
  eventId: string;
}

/**
 * The act-tx. Returns the released task + the stamped event id, or `null` on
 * any refusal (zero release-bundle writes).
 */
export function releaseTaskWithEffects(input: {
  taskId: string;
  /** Durable system provenance — the recovery drive is the sole caller. */
  actorId: string;
  reason: string;
  /**
   * Pre-tx pre-image whose `executionToken` is the INTENDED epoch (the
   * session's conveyed token — never re-fetched from current task state).
   * A task re-claimed under a new epoch refuses with zero writes; both-NULL
   * is the accepted legacy degradation (the drive's legacy gate no-ops long
   * before reaching here in practice).
   */
  preImage: Task;
}): ReleaseWithEffectsResult | null {
  const { taskId, actorId, reason, preImage } = input;
  const db = getDb();
  const now = new Date().toISOString();
  const eventId = uuid();
  const receiptBase = uuid();

  return db.transaction(
    (tx) => {
      // Freeze habitat at the AUTHORITATIVE in-tx read — a missing habitat is
      // a REFUSAL (zero bundle writes), mirroring the fail act-tx.
      const habitatId = taskRepo.getHabitatIdForTask(taskId);
      if (!habitatId) return null;

      // ── 1. Epoch revalidation (B1 discipline, intended-epoch) ────────────
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | { status: string; executionToken: string | null; assignedAgentId: string | null }
        | undefined;
      if (!row) return null;
      if (row.status !== "claimed" && row.status !== "in_progress") return null;
      if ((row.executionToken ?? null) !== (preImage.executionToken ?? null)) return null;

      // ── 2. CAS release write + the release-provenance pointer ────────────
      tx.update(tasks)
        .set({
          assignedAgentId: null,
          status: "pending",
          claimedAt: null,
          startedAt: null,
          executionToken: null,
          lastReleaseEventId: eventId,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(and(eq(tasks.id, taskId), sql`${tasks.status} IN ('claimed', 'in_progress')`))
        .run();
      // Cross-backend CAS verification: the re-read status is the authority
      // (sql.js run() carries no changes); a mismatch aborts by throwing.
      const verify = tx
        .select({ status: tasks.status, ptr: tasks.lastReleaseEventId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();
      if (!verify || verify.status !== "pending" || verify.ptr !== eventId) {
        throw new Error("release_actx_cas_lost");
      }

      // ── 3. The stamped `released` event row (in-tx, epoch token) ─────────
      createEventWithClient(tx, {
        id: eventId,
        taskId,
        actorType: "system",
        actorId,
        action: "released",
        fromStatus: row.status as never,
        toStatus: "pending" as never,
        metadata: { reason },
      });
      tx.update(taskEvents)
        .set({ executionToken: row.executionToken ?? null })
        .where(eq(taskEvents.id, eventId))
        .run();

      // ── 4. Receipts — exactly the two required consumers ─────────────────
      const snapshot: Record<string, unknown> = {
        taskId,
        action: "released",
        habitatId,
        missionId: preImage.missionId,
        taskTitle: preImage.title,
        actorType: "system",
        actorId,
        reason,
        statusAtFailure: preImage.status,
        retryCount: preImage.retryCount ?? 0,
        rejectionReason: preImage.rejectionReason ?? null,
        retryPolicy: preImage.retryPolicy ?? null,
        assignedAgentIdAtFailure: preImage.assignedAgentId ?? null,
        executionToken: row.executionToken ?? null,
        frozenOnFailGateIds: freezeOnFailGateIds(tx, taskId),
        releasedAt: now,
      };
      for (let i = 0; i < RELEASED_EFFECT_CONSUMERS.length; i++) {
        insertReceipt({
          id: `${receiptBase}-${i}`,
          subjectType: "task_event",
          subjectId: eventId,
          habitatId,
          taskId,
          consumer: RELEASED_EFFECT_CONSUMERS[i],
          state: "pending",
          causalSnapshot: snapshot,
          createdAt: now,
          tx,
        });
      }

      const released = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | Task
        | undefined;
      if (!released) return null;
      return { task: released, eventId };
    },
    { behavior: "immediate" },
  );
}

/**
 * Freezes the `on_fail` gate id list for the releasing task — the T2 C1
 * pattern, shared verbatim with the failure act-tx: the failure_context
 * consumer's eligibility predicate queries these ids DIRECTLY for
 * `satisfied_by_event_id = :releaseEventId`, so historical capture survives
 * even after the release fence has been superseded by a successor claim.
 */
function freezeOnFailGateIds(tx: EffectDbClient, taskId: string): string[] {
  // Same query and active-workflow-at-act-time semantics as the fail act-tx's
  // freeze (T2 C1); duplicated here deliberately so the two act-txes stay
  // independent provenance streams with no private-helper coupling.
  const rows = tx
    .select({ id: taskWorkflowGates.id })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.upstreamTaskId, taskId),
        eq(taskWorkflowGates.gateType, "on_fail"),
        eq(workflows.status, "active"),
      ),
    )
    .all();
  return rows.map((r) => r.id);
}
