/**
 * T2 — the boot-owned effect-receipt deliverer (authority-and-effects
 * contract §C2/C6/F1, ticket rev 6).
 *
 * One interval pass over the receipt outbox:
 *
 *   - expiry sweep first (cap-exhausted rows with expired leases dead-letter;
 *     a live unexpired lease is never touched by another actor — B4);
 *   - receipts: eligibility BEFORE reservation (B5/R-1 — an ineligible row is
 *     never written, never reserved, burns no attempt), then the fenced
 *     id-scoped reservation, then the consumer, then the fenced ack;
 *   - frozen detector targets: per-target reservation → one run row lifetime
 *     (event-keyed dispatch unit, B2) → runtime adoption → the dual-fenced
 *     composer tx (B6) or a fenced failure/dead-letter.
 *
 * Every guarded seam opens `BEGIN IMMEDIATE` (C2). Error representation is
 * fixed allowlisted codes only — never a raw handler message in persistence
 * or logs (B7). Worker lifetime mirrors the accepted notification worker: a
 * pass started under an older generation stops claiming; `stop()` drains
 * bounded before closeDb.
 */
import { getDb } from "../../db/index.js";
import {
  tasks,
  taskWorkflowGates,
  pluginRuns,
  missions,
  effectReceiptTargets,
} from "../../db/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import * as receiptRepo from "../../repositories/effectReceipts.js";
import {
  classifyEffectError,
  encodeDispatchKey,
  EFFECT_RECEIPT_LEASE_SECONDS,
  type EffectErrorCode,
} from "../../repositories/effectReceipts.js";
import * as runRepo from "../../repositories/pluginRun.js";
import * as pulseRepo from "../../repositories/pulse.js";
import { broadcastPulse } from "../pulseService.js";
import { createEventWithClient } from "../../repositories/events/event-crud.js";
import { workflowGateStore } from "../workflow/workflowGateStore.js";
import { workflowGateEvaluator } from "../workflow/workflowGateEvaluator.js";
import { advanceGates } from "../workflow/workflowGateAdvancer.js";
import { lifecycleGateConditionMatches } from "../workflowService.js";
import * as retryService from "../retryService.js";
import * as failureContextService from "../failureContextService.js";
import * as habitatSkillService from "../habitatSkillService.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { emitTransitionNonRequired } from "../tasks/transition-emitter.js";
import { logger } from "../../lib/logger.js";
import type { EffectReceiptRow, EffectReceiptTargetRow } from "../../db/schema/index.js";
import type { RetryPolicy } from "@orcy/shared";

const DELIVERER_TICK_MS = 5_000;
const STOP_DRAIN_BOUND_MS = 35_000;
const ERROR_CODE_PREFIX = "effect_delivery";

let workerInterval: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const inFlightUnits = new Set<Promise<void>>();

export interface PassOpts {
  now?: string;
  owner?: string;
}

/**
 * Starts the deliverer (interval-only start; the first pass fires one tick
 * later, by which time initDb() has completed). Boot-owned production worker.
 */
export function startEffectDeliverer(intervalMs: number = DELIVERER_TICK_MS): void {
  if (workerInterval) return;
  generation += 1;
  workerInterval = setInterval(() => {
    void runOwnedPass().catch(() => {
      logger.error(
        { errorCode: `${ERROR_CODE_PREFIX}_tick_failed` },
        "Effect deliverer tick failed",
      );
    });
  }, intervalMs);
}

/**
 * Stops the deliverer: no new ticks, no new claims from superseded
 * generations, and every in-flight unit is owned — resolves after their
 * fenced outcome writes landed or the bounded drain window elapsed. Await
 * before closeDb so teardown never races outcome writes.
 */
export async function stopEffectDeliverer(): Promise<void> {
  generation += 1;
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  const pending = [...inFlightUnits];
  if (pending.length === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_DRAIN_BOUND_MS);
    void Promise.allSettled(pending).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Eager drain hook: the act-tx schedules a pass on the next macrotask. Only
 * armed while the deliverer is RUNNING (boot owns the worker); a stopped
 * deliverer's reconciliation is the boot pass, so units under test never
 * leak timers past teardown.
 */
export function requestEffectDeliveryPass(): void {
  if (workerInterval === null) return;
  setTimeout(() => {
    void runOwnedPass().catch(() => {
      logger.error(
        { errorCode: `${ERROR_CODE_PREFIX}_drain_failed` },
        "Effect deliverer eager pass failed",
      );
    });
  }, 0);
}

async function runOwnedPass(): Promise<void> {
  await processEffectReceipts();
}

/** One deliverer pass (exported for tests and boot reconciliation). */
export async function processEffectReceipts(opts: PassOpts = {}): Promise<void> {
  const passGeneration = generation;
  const now = opts.now ?? new Date().toISOString();
  const owner = opts.owner ?? `effect-deliverer:${passGeneration}`;

  try {
    receiptRepo.sweepExpiredCapRows(now);
  } catch (err) {
    logger.error(
      { errorCode: `${ERROR_CODE_PREFIX}_sweep_failed` },
      "Effect receipt expiry sweep failed",
    );
  }

  const launched: Promise<void>[] = [];

  for (const receipt of receiptRepo.listPendingReceipts()) {
    if (passGeneration !== generation) break;
    if (!receiptEligible(receipt, now)) continue;
    const reservation = receiptRepo.reserveReceipt(receipt.id, owner, now);
    if (!reservation.acquired || reservation.fence === null) continue;
    const unit = runReceiptUnit(receipt, reservation.fence, reservation.attempt, now).finally(
      () => {},
    );
    launched.push(unit);
    inFlightUnits.add(unit);
    void unit.catch(() => {}).finally(() => inFlightUnits.delete(unit));
  }

  for (const target of receiptRepo.listPendingTargets()) {
    if (passGeneration !== generation) break;
    const reservation = receiptRepo.reserveTarget(target.id, owner, now);
    if (!reservation.acquired || reservation.fence === null) continue;
    const unit = runTargetUnit(target, reservation.fence, reservation.attempt, now);
    launched.push(unit);
    inFlightUnits.add(unit);
    void unit.catch(() => {}).finally(() => inFlightUnits.delete(unit));
  }

  await Promise.allSettled(launched);
}

/**
 * B5/R-1 eligibility — read-only, pre-reservation, zero cost. Barrier waits
 * (sibling dependencies) can never exhaust anyone's attempt budget; the
 * parent `detector_dispatch` receipt is derived (never reserved, never
 * leased — its transitions occur in the child terminal tx).
 */
export function receiptEligible(receipt: EffectReceiptRow, _now: string): boolean {
  switch (receipt.consumer) {
    case "workflow_gates":
    case "skill_ingestion":
      return true;
    case "failure_context": {
      const gates = receiptRepo.siblingReceiptState(receipt.subjectId, "workflow_gates");
      return gates === "delivered" || gates === "dead_letter";
    }
    case "retry_ladder": {
      const gates = receiptRepo.siblingReceiptState(receipt.subjectId, "workflow_gates");
      if (gates !== "delivered" && gates !== "dead_letter") return false;
      const context = receiptRepo.siblingReceiptState(receipt.subjectId, "failure_context");
      return context === "delivered" || context === "dead_letter";
    }
    case "detector_dispatch":
      // Derived aggregate — budget lives on the targets. Never reserved here.
      return false;
    case "pulse_workflow_gates":
    case "pulse_skill_ingest":
      return true;
    default:
      return false;
  }
}

async function runReceiptUnit(
  receipt: EffectReceiptRow,
  fence: string,
  attempt: number,
  now: string,
): Promise<void> {
  let outcome: "delivered" | "superseded" | EffectErrorCode;
  // R-1: the retry consumer's ACK and attempt-history row commit INSIDE its
  // compose transaction — the outer dispatcher never re-acks it (there is no
  // post-commit/pre-ack window to crash into).
  let ackedInTx = false;
  try {
    switch (receipt.consumer) {
      case "workflow_gates":
        outcome = await deliverWorkflowGates(receipt, now);
        break;
      case "failure_context":
        outcome = deliverFailureContext(receipt);
        break;
      case "retry_ladder": {
        const retry = deliverRetryLadder(receipt, fence, attempt, now);
        outcome = retry.outcome;
        ackedInTx = retry.ackedInTx;
        break;
      }
      case "skill_ingestion":
        outcome = deliverSkillIngestion(receipt);
        break;
      case "pulse_workflow_gates":
        outcome = deliverPulseWorkflowGates(receipt);
        break;
      case "pulse_skill_ingest":
        outcome = deliverPulseSkillIngest(receipt);
        break;
      default:
        outcome = "consumer_threw";
    }
  } catch (err) {
    // B7: fixed code only — the raw consumer error is never captured or logged.
    outcome = classifyEffectError(err instanceof Error ? err.message : String(err));
  }

  if (outcome === "delivered" || outcome === "superseded") {
    if (ackedInTx) return; // already committed with the operational bundle
    const acked = receiptRepo.ackReceiptDelivered(receipt.id, fence, now);
    if (acked) {
      receiptRepo.recordAttempt(receipt.id, null, attempt, outcome, now);
    }
    return;
  }
  const failed = receiptRepo.failReceiptFenced(receipt.id, fence, attempt, outcome, now);
  if (failed !== "lost_fence") {
    receiptRepo.recordAttempt(receipt.id, null, attempt, outcome, now);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// workflow_gates consumer — guarded (IMMEDIATE) satisfaction + pointer fence
// ─────────────────────────────────────────────────────────────────────────────

async function deliverWorkflowGates(
  receipt: EffectReceiptRow,
  now: string,
): Promise<"delivered" | "superseded" | EffectErrorCode> {
  const snapshot = (receipt.causalSnapshot ?? {}) as Record<string, unknown>;
  const taskId = snapshot.taskId as string;
  const eventId = receipt.subjectId;
  const db = getDb();
  let anyAdvanced = false;
  try {
    const outcome = db.transaction(
      (tx) => {
        // In-tx pointer fence (C6): if a newer epoch's failure owns the
        // pointer, this event's gates are history — ack superseded.
        const row = tx
          .select({ lastFailureEventId: tasks.lastFailureEventId })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get();
        if (!row || row.lastFailureEventId !== eventId) {
          return "superseded" as const;
        }

        const gates = workflowGateStore.findActiveLifecycleGates(taskId, "on_fail");
        if (gates.length === 0) return "delivered" as const;

        const triggerOpts = {
          taskId,
          action: "failed",
          habitatId: receipt.habitatId,
          actorType: snapshot.actorType as string,
          actorId: snapshot.actorId as string,
          oldStatus: snapshot.statusAtFailure as string,
          newStatus: "failed",
          metadata: { reason: snapshot.reason },
        };
        const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(
          gates,
          triggerOpts,
          lifecycleGateConditionMatches,
        );
        const results = advanceGates(
          decisions,
          {
            kind: "lifecycle",
            eventId,
            action: "failed",
            actorType: triggerOpts.actorType,
            actorId: triggerOpts.actorId,
          },
          { immediate: true },
        );
        for (const result of results) {
          if (result.status === "write_error") return "write_error" as const;
          if (result.status === "satisfied") anyAdvanced = true;
        }
        return "delivered" as const;
      },
      { behavior: "immediate" },
    );
    return outcome;
  } finally {
    // Eager recovery reconciliation — ONLY when this delivery actually
    // advanced a gate (a handoff may have committed with the satisfaction).
    // Outside the guarded tx; failures here never un-satisfy a gate.
    if (anyAdvanced) {
    try {
      const { runRecoveryReconciliationPass } = await import("../workflow/recoveryCoordinator.js");
      runRecoveryReconciliationPass();
    } catch {
      logger.error(
        { errorCode: `${ERROR_CODE_PREFIX}_reconcile_failed` },
        "Post-advancement recovery reconciliation failed",
      );
    }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// failure_context consumer — R-1 barrier → C1 stamp predicate → exactly-once
// ─────────────────────────────────────────────────────────────────────────────

function deliverFailureContext(receipt: EffectReceiptRow): "delivered" | EffectErrorCode {
  const snapshot = (receipt.causalSnapshot ?? {}) as Record<string, unknown>;
  const eventId = receipt.subjectId;
  const gateIds = (snapshot.frozenOnFailGateIds as string[] | undefined) ?? [];

  // C1: capture iff ≥1 frozen on_fail gate carries the durable, event-bound
  // outcome `satisfied_by_event_id = :eventId`. Direct frozen-id query — never
  // an active-workflow view (detach-proof).
  if (gateIds.length > 0) {
    const stamped = getDb()
      .select({ id: taskWorkflowGates.id })
      .from(taskWorkflowGates)
      .where(
        and(
          inArray(taskWorkflowGates.id, gateIds),
          eq(taskWorkflowGates.satisfiedByEventId, eventId),
        ),
      )
      .get();
    if (stamped) {
      try {
        failureContextService.buildFailureContext(snapshot.taskId as string, "lifecycle_failed", {
          failureReason: (snapshot.reason as string) ?? "",
          sourceEventId: eventId,
        });
      } catch (err) {
        // Same-event replay hits the source_event_id partial unique — that is
        // exactly-once, not a failure.
        if (!isUniqueViolation(err)) return "write_error";
      }
    }
  }
  // Zero stamped gates (or dead-lettered gates receipt with zero stamps): no
  // capture — the honest outcome. Either way the receipt is delivered.
  return "delivered";
}

function isUniqueViolation(err: unknown): boolean {
  // Cross-backend (sql.js lacks name/code): message-regex on the error and
  // any drizzle-wrapped cause (MEMORY: inspect .cause.message).
  const messages = [
    (err as Error | undefined)?.message,
    ((err as { cause?: unknown } | undefined)?.cause as Error | undefined)?.message,
  ];
  return messages.some((m) => typeof m === "string" && /UNIQUE constraint failed/i.test(m));
}

// ─────────────────────────────────────────────────────────────────────────────
// retry_ladder consumer — single-tx ETA semantics (R-2/C3)
// ─────────────────────────────────────────────────────────────────────────────

function deliverRetryLadder(
  receipt: EffectReceiptRow,
  fence: string,
  attempt: number,
  now: string,
): { outcome: "delivered" | "superseded" | EffectErrorCode; ackedInTx: boolean } {
  const snapshot = (receipt.causalSnapshot ?? {}) as Record<string, unknown>;
  const taskId = snapshot.taskId as string;
  const eventId = receipt.subjectId;

  // Policy math on the immutable SNAPSHOT (never the current row).
  const pseudoTask = {
    id: taskId,
    retryCount: (snapshot.retryCount as number) ?? 0,
    rejectionReason: (snapshot.rejectionReason as string) ?? null,
    retryPolicy: (snapshot.retryPolicy as RetryPolicy | null) ?? null,
  } as Parameters<typeof retryService.getEffectivePolicy>[0];
  const policy = retryService.getEffectivePolicy(pseudoTask);

  // No policy: nothing to schedule or escalate — no operational bundle, the
  // plain fenced ack in the dispatcher is coherent (nothing existed to lose).
  if (!policy) return { outcome: "delivered", ackedInTx: false };
  const shouldRetry = retryService.shouldRetry(pseudoTask, policy);

  const db = getDb();
  const followUpEventId = uuid();
  try {
    const outcome = db.transaction(
      (tx) => {
        if (shouldRetry) {
          // In-tx pointer fence FIRST (read inside the IMMEDIATE tx): a newer
          // epoch owning the pointer means this event's arming is superseded.
          const guardRow = tx
            .select({ status: tasks.status, ptr: tasks.lastFailureEventId })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .get();
          if (!guardRow || guardRow.status !== "failed" || guardRow.ptr !== eventId) {
            return { outcome: "superseded" as const, ackedInTx: false };
          }
          // ETA is computed inside THIS compose tx (anchored at the arming
          // attempt; no durable pre-anchor, no delivery payload — R-2). The
          // task write, follow-up event row, and receipt ack commit together
          // (single-tx ETA; no post-commit/pre-ack window exists).
          const backoffSeconds = retryService.calculateBackoff(policy, pseudoTask.retryCount);
          const eta = new Date(new Date(now).getTime() + backoffSeconds * 1000).toISOString();
          tx.update(tasks).set({ nextRetryAt: eta }).where(eq(tasks.id, taskId)).run();
          const verify = tx
            .select({ nextRetryAt: tasks.nextRetryAt })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .get();
          if (!verify || verify.nextRetryAt !== eta) {
            return { outcome: "write_error" as const, ackedInTx: false };
          }
          createEventWithClient(tx, {
            id: followUpEventId,
            taskId,
            actorType: "system",
            actorId: "retry-service",
            action: "retry_scheduled",
            metadata: { nextRetryAt: eta, retryCount: pseudoTask.retryCount, backoffSeconds },
          });
          // R-1: the ACK + attempt-history row join the SAME commit as the
          // guarded task write and the follow-up event — the final fence
          // (ackReceiptDelivered's exact RETURNING CAS on our lease token)
          // decides the ENTIRE bundle: a lost fence rolls back everything.
          const acked = receiptRepo.ackReceiptDelivered(receipt.id, fence, now, tx);
          if (!acked) return { outcome: "write_error" as const, ackedInTx: false };
          receiptRepo.recordAttempt(receipt.id, null, attempt, "delivered", now, tx);
          emitRetryFollowUpPostCommit(taskId, followUpEventId, {
            action: "retry_scheduled",
            nextRetryAt: eta,
            retryCount: pseudoTask.retryCount,
            backoffSeconds,
          });
          return { outcome: "delivered" as const, ackedInTx: true };
        }
        if (policy.escalateToHuman) {
          const guardRow = tx
            .select({ status: tasks.status, ptr: tasks.lastFailureEventId })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .get();
          if (!guardRow || guardRow.status !== "failed" || guardRow.ptr !== eventId) {
            return { outcome: "superseded" as const, ackedInTx: false };
          }
          tx.update(tasks)
            .set({ assignedAgentId: null, nextRetryAt: null, executionToken: null })
            .where(eq(tasks.id, taskId))
            .run();
          createEventWithClient(tx, {
            id: followUpEventId,
            taskId,
            actorType: "system",
            actorId: "retry-service",
            action: "escalated",
            metadata: {
              retryCount: pseudoTask.retryCount,
              maxRetries: policy.maxRetries,
              rejectionReason: pseudoTask.rejectionReason,
            },
          });
          const acked = receiptRepo.ackReceiptDelivered(receipt.id, fence, now, tx);
          if (!acked) return { outcome: "write_error" as const, ackedInTx: false };
          receiptRepo.recordAttempt(receipt.id, null, attempt, "delivered", now, tx);
          emitRetryFollowUpPostCommit(taskId, followUpEventId, {
            action: "escalated",
            nextRetryAt: null,
            retryCount: pseudoTask.retryCount,
          });
          return { outcome: "delivered" as const, ackedInTx: true };
        }
        // No escalation configured and retries exhausted-by-policy: nothing
        // to write — coherent plain ack in the dispatcher.
        return { outcome: "delivered" as const, ackedInTx: false };
      },
      { behavior: "immediate" },
    );
    return outcome;
  } catch {
    return { outcome: "write_error", ackedInTx: false };
  }
}

/**
 * Post-commit non-required emit for the composed retry/escalation event —
 * scheduled on a microtask so it runs strictly AFTER the compose tx commits.
 * A pre-commit rollback means the event row never existed; the scheduled
 * emit still fires but only projects non-required effects (it never writes an
 * event), so a rolled-back compose leaves nothing behind.
 */
function emitRetryFollowUpPostCommit(
  taskId: string,
  eventId: string,
  ctx: {
    action: "retry_scheduled" | "escalated";
    nextRetryAt: string | null;
    retryCount: number;
    backoffSeconds?: number;
  },
): void {
  queueMicrotask(() => {
    try {
      emitTransitionNonRequired(taskId, ctx.action, findHabitatId(taskId), {
        actorType: "system",
        actorId: "retry-service",
        existingEventId: eventId,
        retryCount: ctx.retryCount,
        nextRetryAt: ctx.nextRetryAt ?? undefined,
        backoffSeconds: ctx.backoffSeconds,
        metadata: { nextRetryAt: ctx.nextRetryAt, retryCount: ctx.retryCount },
      });
    } catch {
      logger.error(
        { taskId, errorCode: `${ERROR_CODE_PREFIX}_retry_emit_failed` },
        "Post-commit retry transition emit failed",
      );
    }
  });
}

function findHabitatId(taskId: string): string {
  const row = getDb()
    .select({ habitatId: missions.habitatId })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(tasks.id, taskId))
    .get();
  return row?.habitatId ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// skill_ingestion consumer — act-time snapshot read
// ─────────────────────────────────────────────────────────────────────────────

function deliverSkillIngestion(receipt: EffectReceiptRow): "delivered" | EffectErrorCode {
  const snapshot = (receipt.causalSnapshot ?? {}) as Record<string, unknown>;
  habitatSkillService.ingestFromTaskEvent({
    habitatId: receipt.habitatId,
    eventType: "failed",
    taskTitle: (snapshot.taskTitle as string) ?? "",
    reason: (snapshot.reason as string) ?? undefined,
    taskId: snapshot.taskId as string,
    associatedAgentId: (snapshot.assignedAgentIdAtFailure as string) ?? undefined,
  });
  return "delivered";
}

// ─────────────────────────────────────────────────────────────────────────────
// pulse consumers (per-pulse effect intents, §F1)
// ─────────────────────────────────────────────────────────────────────────────

function deliverPulseWorkflowGates(receipt: EffectReceiptRow): "delivered" | EffectErrorCode {
  const pulse = pulseRepo.getPulseById(receipt.subjectId);
  if (!pulse) return "delivered"; // pulse gone: honest no-op
  const gates = workflowGateStore.findActiveSignalGates(pulse.habitatId);
  if (gates.length === 0) return "delivered";
  const decisions = workflowGateEvaluator.evaluatePulseTrigger(
    gates,
    pulse as never,
    lifecycleGateConditionMatches as never,
  );
  const results = advanceGates(
    decisions,
    { kind: "pulse", eventId: pulse.id },
    { immediate: true },
  );
  for (const result of results) {
    if (result.status === "write_error") return "write_error";
  }
  return "delivered";
}

function deliverPulseSkillIngest(receipt: EffectReceiptRow): "delivered" | EffectErrorCode {
  const pulse = pulseRepo.getPulseById(receipt.subjectId);
  if (!pulse || !pulse.habitatId) return "delivered";
  habitatSkillService.ingestFromPulse({
    habitatId: pulse.habitatId,
    signalType: pulse.signalType,
    subject: pulse.subject,
    body: pulse.body,
    pulseId: pulse.id,
    fromType: pulse.fromType,
    fromId: pulse.fromId,
  });
  return "delivered";
}

// ─────────────────────────────────────────────────────────────────────────────
// detector dispatch — per-target units, one run-row lifetime, composer tx
// ─────────────────────────────────────────────────────────────────────────────

async function runTargetUnit(
  target: EffectReceiptTargetRow,
  fence: string,
  attempt: number,
  now: string,
): Promise<void> {
  let outcome: "delivered" | EffectErrorCode;
  try {
    outcome = await dispatchDetectorTargetUnit(target, fence, now);
  } catch (err) {
    outcome = classifyEffectError(err instanceof Error ? err.message : String(err));
  }

  const db = getDb();
  if (outcome === "delivered" || outcome === "plugin_removed_or_disabled") {
    // An authorized skip (plugin removed/disabled after freeze) is a DELIVERY
    // with a visible fixed code — admin-visible, not a failure.
    db.transaction((tx) => {
      const acked = receiptRepo.ackTargetDeliveredAndDeriveParent(target.id, fence, now, tx);
      if (acked) {
        if (outcome === "plugin_removed_or_disabled") {
          tx.update(effectReceiptTargets)
            .set({ lastErrorCode: outcome })
            .where(eq(effectReceiptTargets.id, target.id))
            .run();
        }
        receiptRepo.recordAttempt(target.receiptId, target.id, attempt, "delivered", now, tx);
      }
    });
    return;
  }
  db.transaction((tx) => {
    const failed = receiptRepo.failTargetFenced(
      target.id,
      fence,
      attempt,
      outcome,
      now,
      tx,
      // Dead-letter with a live run row terminalizes it in the SAME tx (B6).
      (t) => terminalizeRunForTarget(t, target, now),
    );
    if (failed !== "lost_fence") {
      receiptRepo.recordAttempt(target.receiptId, target.id, attempt, outcome, now, tx);
    }
  });
}

function terminalizeRunForTarget(
  tx: ReturnType<typeof getDb>,
  target: EffectReceiptTargetRow,
  now: string,
): void {
  const receipt = receiptRepo.getReceiptById(target.receiptId);
  if (!receipt) return;
  const dispatchKey = encodeDispatchKey(receipt.subjectId, target.pluginId, target.contributionId);
  const run = runRepo.getRunByDispatchKey(dispatchKey);
  if (!run || run.status !== "running") return;
  tx.update(pluginRuns)
    .set({ status: "failed", error: "outcome_unrecovered", finishedAt: now })
    .where(and(eq(pluginRuns.id, run.id), eq(pluginRuns.status, "running")))
    .run();
}

async function dispatchDetectorTargetUnit(
  target: EffectReceiptTargetRow,
  targetFence: string,
  now: string,
): Promise<"delivered" | EffectErrorCode> {
  const receipt = receiptRepo.getReceiptById(target.receiptId);
  if (!receipt) return "delivered";
  const eventId = receipt.subjectId;
  const dispatchKey = encodeDispatchKey(eventId, target.pluginId, target.contributionId);
  const entry = pluginManager.getDetectorEntry(`${target.pluginId}:${target.contributionId}`);

  // Plugin removed or disabled after freeze: authorized skip — terminal run
  // row with the fixed code, target delivered, admin-visible.
  if (!entry) {
    const runId = uuid();
    const existing = runRepo.getRunByDispatchKey(dispatchKey);
    if (!existing) {
      runRepo.insertRunForEffectDelivery({
        id: runId,
        habitatId: target.habitatId,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        triggerEventId: eventId,
        triggerType: "taskEvent",
        dispatchKey,
        leaseToken: targetFence,
        leaseExpiresAt: leaseExpiry(now),
      });
      finishSkippedRun(dispatchKey, "plugin_removed_or_disabled");
    } else if (existing.status === "running") {
      finishSkippedRun(dispatchKey, "plugin_removed_or_disabled");
    }
    return "plugin_removed_or_disabled";
  }

  // One run row per (event, target) lifetime: first attempt inserts; every
  // later attempt re-drives the SAME row under a fresh lease generation.
  let run = runRepo.getRunByDispatchKey(dispatchKey);
  let runLeaseToken = uuid();
  const expiry = leaseExpiry(now);
  if (!run) {
    run = runRepo.insertRunForEffectDelivery({
      id: uuid(),
      habitatId: target.habitatId,
      pluginId: target.pluginId,
      contributionId: target.contributionId,
      triggerEventId: eventId,
      triggerType: "taskEvent",
      dispatchKey,
      leaseToken: runLeaseToken,
      leaseExpiresAt: expiry,
    });
  } else if (run.signalsCommittedAt) {
    // Marker-set stranded run (honest recovery for abnormal states): the
    // signals already committed; the handler is NEVER re-invoked; complete
    // the target and stamp the run terminal outcome_unrecovered.
    getDb().transaction((tx) => {
      tx.update(pluginRuns)
        .set({ status: "failed", error: "outcome_unrecovered", finishedAt: now })
        .where(and(eq(pluginRuns.id, run!.id), eq(pluginRuns.status, "running")))
        .run();
    });
    return "delivered";
  } else {
    runLeaseToken = uuid();
    runRepo.redriveRunForEffectDelivery({
      id: run.id,
      leaseToken: runLeaseToken,
      leaseExpiresAt: expiry,
    });
  }
  const runId = run.id;

  const outcome = await pluginManager.invokeDetectorForEffectDelivery({
    pluginId: target.pluginId,
    contributionId: target.contributionId,
    adoptedRun: run,
    runLeaseToken: runLeaseToken,
    targetHabitatId: target.habitatId,
    composeOutput: (signals) =>
      composeDetectorOutput({
        signals,
        runId,
        runLeaseToken,
        runLeaseExpiresAt: expiry,
        targetId: target.id,
        targetFence,
        target,
        now,
      }),
  });

  switch (outcome.kind) {
    case "composed":
      return "delivered";
    case "rate_limited":
      return "rate_limited";
    case "start_failed":
      return "start_failed";
    case "recovery_deferred":
      return "recovery_deferred";
    case "handler_failed":
      return "consumer_threw";
    default:
      return "consumer_threw";
  }
}

function finishSkippedRun(dispatchKey: string, code: EffectErrorCode): void {
  const run = runRepo.getRunByDispatchKey(dispatchKey);
  if (!run) return;
  runRepo.finishRunLeaseFenced({
    id: run.id,
    leaseToken: run.leaseToken ?? "",
    status: "skipped",
    error: code,
  });
}

function leaseExpiry(now: string): string {
  return new Date(new Date(now).getTime() + EFFECT_RECEIPT_LEASE_SECONDS * 1000).toISOString();
}

/**
 * B6 composer — ONE `BEGIN IMMEDIATE` tx predicated on BOTH fences: the
 * owning target row `state='pending'` + exact target lease token, AND the run
 * row `id + lease_token + unexpired + running`. Either half failing rolls
 * back marker + signal batch + pulse intents + run finish + target ack
 * entirely — no output can commit into a non-active unit, and no marker is
 * ever regenerated. Per-pulse effect intents (`pulse_workflow_gates`,
 * `pulse_skill_ingest`) compose with the batch (§F1); `onPulseCreated` hooks
 * never fire on this path (no hook loop) — the intents are the sole delivery
 * channel. `broadcastPulse` fires post-commit.
 */
export async function composeDetectorOutput(input: {
  signals: import("@orcy/shared").DetectedSignalInput[];
  runId: string;
  runLeaseToken: string;
  runLeaseExpiresAt: string;
  targetId: string;
  targetFence: string;
  target: EffectReceiptTargetRow;
  now: string;
}): Promise<"composed" | "abort"> {
  const db = getDb();
  const committedPulses: pulseRepo.Pulse[] = [];
  try {
    db.transaction(
      (tx) => {
        const stampMarker = (): void => {
          tx.update(pluginRuns)
            .set({ signalsCommittedAt: input.now })
            .where(
              and(
                eq(pluginRuns.id, input.runId),
                eq(pluginRuns.leaseToken, input.runLeaseToken),
                eq(pluginRuns.status, "running"),
                sql`${pluginRuns.leaseExpiresAt} > ${input.now}`,
              ),
            )
            .run();
          // Cross-backend verification: the marker landed iff the row now
          // carries it under OUR token (sql.js run() carries no changes).
          const guardRow = tx
            .select({ marker: pluginRuns.signalsCommittedAt, token: pluginRuns.leaseToken })
            .from(pluginRuns)
            .where(eq(pluginRuns.id, input.runId))
            .get();
          if (
            !guardRow ||
            guardRow.marker !== input.now ||
            guardRow.token !== input.runLeaseToken
          ) {
            throw new Error("compose_fence_lost");
          }
        };
        if (input.signals.length === 0) {
          // Marker-only compose: dual fence still applies.
          stampMarker();
        } else {
          for (const s of input.signals) {
            stampMarker();

            const merged: Record<string, unknown> = {
              ...s.metadata,
              detected: true,
              detector: input.target.pluginId,
              detectorRunId: input.runId,
            };
            const pulse = pulseRepo.createPulseWithClient(tx, {
              habitatId: input.target.habitatId,
              scope: s.missionId !== undefined ? "mission" : "habitat",
              fromType: "system",
              fromId: input.target.pluginId,
              signalType: "detected",
              subject: s.subject,
              ...(s.body !== undefined ? { body: s.body } : {}),
              ...(s.taskId !== undefined ? { taskId: s.taskId } : {}),
              ...(s.missionId !== undefined ? { missionId: s.missionId } : {}),
              ...(s.replyToId !== undefined ? { replyToId: s.replyToId } : {}),
              metadata: merged,
              isAuto: true,
            });
            committedPulses.push(pulse);

            // §F1 — per-pulse effect intents compose with the batch.
            receiptRepo.insertReceipt({
              subjectType: "pulse",
              subjectId: pulse.id,
              habitatId: input.target.habitatId,
              consumer: "pulse_workflow_gates",
              createdAt: input.now,
              tx,
            });
            receiptRepo.insertReceipt({
              subjectType: "pulse",
              subjectId: pulse.id,
              habitatId: input.target.habitatId,
              consumer: "pulse_skill_ingest",
              createdAt: input.now,
              tx,
            });
          }
        }

        // Run finishes succeeded only inside the same tx (BLOCKER 1 ordering:
        // signals committed before the run is marked succeeded).
        tx.update(pluginRuns)
          .set({
            status: "succeeded",
            signalsEmitted: input.signals.length,
            finishedAt: input.now,
          })
          .where(
            and(
              eq(pluginRuns.id, input.runId),
              eq(pluginRuns.leaseToken, input.runLeaseToken),
              eq(pluginRuns.status, "running"),
            ),
          )
          .run();
        const finishRow = tx
          .select({ status: pluginRuns.status })
          .from(pluginRuns)
          .where(eq(pluginRuns.id, input.runId))
          .get();
        if (finishRow?.status !== "succeeded") throw new Error("compose_fence_lost");

        // Target ack + derived parent recompute — same tx (S-2 fencing).
        const acked = receiptRepo.ackTargetDeliveredAndDeriveParent(
          input.targetId,
          input.targetFence,
          input.now,
          tx,
        );
        if (!acked) throw new Error("compose_fence_lost");
      },
      { behavior: "immediate" },
    );
  } catch {
    committedPulses.length = 0;
    return "abort";
  }

  // Post-commit ONLY: SSE broadcast for every committed pulse (hooks are
  // deliberately not fired on the composed path — the intents own delivery).
  for (const pulse of committedPulses) {
    try {
      broadcastPulse(pulse);
    } catch {
      logger.error(
        { pulseId: pulse.id, errorCode: `${ERROR_CODE_PREFIX}_broadcast_failed` },
        "Committed pulse broadcast failed",
      );
    }
  }
  return "composed";
}
