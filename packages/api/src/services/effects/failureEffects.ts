/**
 * T2 — the failure act-tx (authority-and-effects contract §C1, rev 6).
 *
 * One `BEGIN IMMEDIATE` transaction owns, atomically:
 *   1. the epoch revalidation (B1): the act-tx fails the epoch whose pre-image
 *      was validated pre-tx — `status='in_progress'` AND `execution_token`
 *      equals the PRE-TX pre-image's token (both-NULL is the accepted legacy
 *      degradation; E1→E2 and NULL→minted refuse with ZERO failure-bundle
 *      writes; agent actors additionally require `assignedAgentId===actorId`);
 *   2. the service-width CAS fail write (`in_progress → failed`, token
 *      cleared, `last_failure_event_id` pointer set — §B.0);
 *   3. the `failed` event row, stamped with the epoch's token (immutable);
 *   4. the five required-effect receipts + the FROZEN detector target list
 *      (receipt-owned from birth — B3: no instant exists where the event is
 *      unowned), with the immutable causal snapshot (retryCount, rejection
 *      reason, habitat/mission, frozen on_fail gate ids for C1);
 *   5. S-1: a zero-child `detector_dispatch` receipt is born `delivered`.
 *
 * Post-commit, the caller runs ONLY the non-required effect mask
 * (`emitTransitionNonRequired`) — required effects flow exclusively through
 * receipt consumers; `notifyTransition`/`notifyTaskEvent` never fire for the
 * restored slice.
 */
import { getDb } from "../../db/index.js";
import { tasks, taskEvents, taskWorkflowGates, workflows } from "../../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as taskRepo from "../../repositories/task.js";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import {
  insertReceipt,
  insertTarget,
  type EffectDbClient,
} from "../../repositories/effectReceipts.js";
import * as pluginEnrollmentRepo from "../../repositories/pluginEnrollment.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import type { Task } from "../../models/index.js";
import { ExecutionEpochMismatchError } from "../../errors.js";

/** The five required consumers enqueued per failed event (F2 census). */
export const REQUIRED_EFFECT_CONSUMERS = [
  "workflow_gates",
  "failure_context",
  "retry_ladder",
  "detector_dispatch",
  "skill_ingestion",
] as const;

export interface FrozenDetectorTarget {
  pluginId: string;
  contributionId: string;
}

/**
 * Freezes the detector target set for a habitat at act time: every ENABLED
 * `signalDetector` enrollment whose loaded registry entry declares
 * `detects: "taskEvent"`. Enrollment changes after the event never widen the
 * set (post-enrollment plugins are invisible to this event).
 */
export function enumerateFrozenDetectorTargets(habitatId: string): FrozenDetectorTarget[] {
  const enrollments = pluginEnrollmentRepo
    .listEnabledByHabitat(habitatId)
    .filter((e) => e.contributionKind === "signalDetector");
  const frozen: FrozenDetectorTarget[] = [];
  for (const enrollment of enrollments) {
    const entry = pluginManager.getDetectorEntry(
      `${enrollment.pluginId}:${enrollment.contributionId}`,
    );
    if (!entry || entry.contribution.detects !== "taskEvent") continue;
    frozen.push({ pluginId: enrollment.pluginId, contributionId: enrollment.contributionId });
  }
  return frozen;
}

/**
 * The frozen `on_fail` gate id list for the failing task (C1): the
 * failure_context consumer's eligibility predicate queries these ids DIRECTLY
 * for `satisfied_by_event_id = :eventId` — never an active-workflow view, so
 * a detach between satisfaction and the delayed capture cannot erase proof.
 * Freezing itself mirrors the live seam (`findActiveLifecycleGates`: active
 * workflows only, at act time).
 */
function freezeOnFailGateIds(tx: EffectDbClient, taskId: string): string[] {
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

export interface FailWithEffectsResult {
  task: Task;
  eventId: string;
}

/**
 * The act-tx. Returns the failed task + the stamped event id, or `null` on
 * any refusal (F5: zero failure-bundle writes; the pre-tx guard's own
 * bookkeeping is preserved by the caller's unchanged guard order).
 */
export function failTaskWithEffects(input: {
  taskId: string;
  actorId: string;
  actorType: "agent" | "system";
  reason: string;
  /** Pre-tx pre-image captured by the caller AFTER its guards ran. */
  preImage: Task;
  /**
   * Epoch-mutation guard (agent wire): the CLIENT's expected execution epoch.
   * When present, the epoch comparison is the legacy-allowing disjunction —
   * a legacy-NULL row allows even if the client sent a token, and a tokened
   * row demands equality (missing/null/mismatch → typed
   * {@link ExecutionEpochMismatchError} refusal, zero failure-bundle writes).
   * When `undefined` (system/worker path), the STRONGER internal
   * intended-epoch semantics apply unchanged: the act-tx validates the epoch
   * whose pre-image was validated pre-tx (row token === pre-image token).
   *
   * In BOTH paths the stamped `failed` event and the causal snapshot carry
   * the ACTUAL winning row's token (never the client's value — a client
   * token is never stamped over a legacy NULL).
   */
  expectedExecutionToken?: string | null;
}): FailWithEffectsResult | null {
  const { taskId, actorId, actorType, reason, preImage, expectedExecutionToken } = input;
  const db = getDb();
  const now = new Date().toISOString();
  const eventId = uuid();
  const receiptBase = uuid();

  return db.transaction(
    (tx) => {
      // Freeze habitat + target set at the AUTHORITATIVE in-tx read (not a
      // pre-tx enumeration): a missing habitat is a REFUSAL (zero bundle
      // writes) — never receipts stamped with an empty habitat scope.
      const habitatId = taskRepo.getHabitatIdForTask(taskId);
      if (!habitatId) return null;
      const frozenTargets = enumerateFrozenDetectorTargets(habitatId);
      // ── 1. Epoch revalidation (B1) ────────────────────────────────────────
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | { status: string; executionToken: string | null; assignedAgentId: string | null }
        | undefined;
      if (!row) return null;
      // Agent wire: the legacy-allowing disjunction (typed refusal on a
      // tokened row without the client's matching token). Worker/system:
      // the pre-image-bound intended-epoch comparison, unchanged.
      const tokenOk =
        expectedExecutionToken !== undefined
          ? row.executionToken === null || row.executionToken === expectedExecutionToken
          : (row.executionToken ?? null) === (preImage.executionToken ?? null);
      const assignmentOk = actorType === "system" || row.assignedAgentId === actorId;
      if (row.status !== "in_progress" || !assignmentOk) {
        // Refusal: rollback (nothing written yet), zero failure-bundle writes,
        // task untouched under its current epoch.
        return null;
      }
      if (!tokenOk) {
        if (expectedExecutionToken !== undefined) {
          throw new ExecutionEpochMismatchError();
        }
        // Worker path keeps its null-refusal contract (intended-epoch loss).
        return null;
      }

      // ── 2. Service-width CAS fail write + §B.0 pointer ────────────────────
      // The epoch disjunction joins the write predicate itself when the agent
      // wire activated the guard (atomic backstop of the B1 re-read).
      tx.update(tasks)
        .set({
          status: "failed",
          assignedAgentId: null,
          completedAt: now,
          executionToken: null,
          lastFailureEventId: eventId,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.status, "in_progress"),
            ...(expectedExecutionToken !== undefined
              ? [
                  sql`(${tasks.executionToken} IS NULL OR ${tasks.executionToken} = ${expectedExecutionToken})`,
                ]
              : []),
          ),
        )
        .run();
      // Cross-backend CAS verification (sql.js run() returns `true`, not
      // {changes}): the re-read status is the authority. The epoch re-read
      // above already serialized this writer inside the IMMEDIATE tx, so a
      // mismatch here is a defense-in-depth abort — throw to roll back.
      const verify = tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();
      if (!verify || verify.status !== "failed") {
        throw new Error("fail_actx_cas_lost");
      }

      // ── 3. The stamped `failed` event row (immutable, epoch token) ────────
      // The stamp carries the ACTUAL winning row's token (`row`, the in-tx
      // authoritative read) — never the client's presented value, which must
      // not be stamped over a legacy NULL (spurious manufactured mismatch).
      createEventWithClient(tx, {
        id: eventId,
        taskId,
        actorType,
        actorId,
        action: "failed",
        fromStatus: preImage.status as never,
        toStatus: "failed" as never,
        metadata: { reason },
      });
      tx.update(taskEvents)
        .set({ executionToken: row.executionToken ?? null })
        .where(eq(taskEvents.id, eventId))
        .run();

      // ── 4. Receipts + frozen target list (owned from birth, B3) ───────────
      const gateIds = freezeOnFailGateIds(tx, taskId);
      const snapshot: Record<string, unknown> = {
        taskId,
        habitatId,
        missionId: preImage.missionId,
        taskTitle: preImage.title,
        actorType,
        actorId,
        reason,
        statusAtFailure: preImage.status,
        retryCount: preImage.retryCount ?? 0,
        rejectionReason: preImage.rejectionReason ?? null,
        retryPolicy: preImage.retryPolicy ?? null,
        assignedAgentIdAtFailure: preImage.assignedAgentId ?? null,
        executionToken: row.executionToken ?? null,
        frozenOnFailGateIds: gateIds,
        failedAt: now,
      };

      for (let i = 0; i < REQUIRED_EFFECT_CONSUMERS.length; i++) {
        const consumer = REQUIRED_EFFECT_CONSUMERS[i];
        const receiptId = `${receiptBase}-${i}`;
        const zeroChild = consumer === "detector_dispatch" && frozenTargets.length === 0;
        insertReceipt({
          id: receiptId,
          subjectType: "task_event",
          subjectId: eventId,
          habitatId,
          taskId,
          consumer,
          // S-1: zero frozen children → born delivered (vacuous all-complete).
          state: zeroChild ? "delivered" : "pending",
          deliveredAt: zeroChild ? now : undefined,
          causalSnapshot: snapshot,
          createdAt: now,
          tx,
        });
        if (consumer === "detector_dispatch") {
          for (const target of frozenTargets) {
            insertTarget({
              receiptId,
              habitatId,
              pluginId: target.pluginId,
              contributionId: target.contributionId,
              createdAt: now,
              tx,
            });
          }
        }
      }

      const failed = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as Task | undefined;
      if (!failed) return null;
      return { task: failed, eventId };
    },
    { behavior: "immediate" },
  );
}
