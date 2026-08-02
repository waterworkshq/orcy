import { getDb } from "../db/index.js";
import { workflows, taskWorkflowGates, failureContexts } from "../db/schema/index.js";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { onTransition } from "./tasks/transition-emitter.js";
import * as pulseService from "./pulseService.js";
import { onAutomationRunCompleted } from "./automationExecutor.js";
import { evaluateCondition } from "./automationEvaluator.js";
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import * as failureContextService from "./failureContextService.js";
import { enqueueNotification } from "./notificationCommandService.js";
import { emitTaskAuditEvent, emitMissionAuditEvent } from "./auditEventEmitter.js";
import type { Pulse } from "../repositories/pulse.js";
import type {
  WorkflowTemplateDefinition,
  WorkflowFailureHandlerConfig,
  AutomationCondition,
} from "../models/index.js";

import { workflowGateStore } from "./workflow/workflowGateStore.js";
import { workflowGateEvaluator } from "./workflow/workflowGateEvaluator.js";
import type { ConditionTrigger } from "./workflow/workflowGateEvaluator.js";
import {
  advanceGates,
  MAX_RECOVERY_DEPTH,
  type AdvancementResult,
  type GateTrigger,
} from "./workflow/workflowGateAdvancer.js";
import { runRecoveryReconciliationPass } from "./workflow/recoveryCoordinator.js";

export { areAllWorkflowGatesSatisfied };
export { MAX_RECOVERY_DEPTH };

let initialized = false;

function gateConditionMatches(condition: AutomationCondition, trigger: ConditionTrigger): boolean {
  const ctx = buildEvaluationContext(
    buildTriggerContext({
      triggerType: "workflow_gate",
      triggerEventId: trigger.eventId ?? null,
      habitatId: trigger.habitatId,
      targetType: trigger.targetType,
      targetId: trigger.targetId,
      payload: trigger.payload,
    }),
  );
  return evaluateCondition(condition, ctx).matched;
}

/** Registers the workflowService subscriber on the transition emitter; call once at server startup from index.ts. */
export function initWorkflowService(): void {
  if (initialized) return;
  initialized = true;

  onTransition((opts) => {
    try {
      handleTransition(opts);
    } catch (err) {
      logger.error(
        { err, taskId: opts.taskId, action: opts.action },
        "Workflow service subscriber error",
      );
    }
  });

  pulseService.onPulseCreated((pulse) => {
    try {
      handlePulseCreated(pulse);
    } catch (err) {
      logger.error(
        { err, pulseId: pulse.id, signalType: pulse.signalType },
        "Workflow service pulse subscriber error",
      );
    }
  });

  onAutomationRunCompleted((opts) => {
    try {
      handleAutomationRunCompleted(opts);
    } catch (err) {
      logger.error(
        { err, runId: opts.run.id, ruleId: opts.rule.id },
        "Workflow service automation subscriber error",
      );
    }
  });
}

function handleTransition(opts: {
  taskId: string;
  action: string;
  habitatId: string;
  actorType?: string;
  actorId?: string;
  oldStatus?: string;
  newStatus?: string;
  metadata?: Record<string, unknown>;
  /** Forwarded Task Event id from the `notifyTransition` seam (WG-2); absent for non-event-creating actions. */
  eventId?: string;
}): void {
  const gateType = workflowGateEvaluator.actionToGateType(opts.action);
  if (!gateType) return;

  // F4 redemption runs BEFORE the gate-satisfaction loop because a recovery task
  // typically has no on_approve/on_complete gates of its own — the early return
  // when no gates match would otherwise skip redemption entirely. Redemption is
  // independent of this task's own gate satisfaction.
  if (gateType === "on_complete" || gateType === "on_approve") {
    try {
      handleRedemptionIfNeeded(opts);
    } catch (err) {
      logger.error({ err, taskId: opts.taskId, action: opts.action }, "Redemption hook error");
    }
  }

  const gates = workflowGateStore.findActiveLifecycleGates(opts.taskId, gateType);

  if (gates.length === 0) return;

  const decisions = workflowGateEvaluator.evaluateLifecycleTrigger(
    gates,
    opts,
    gateConditionMatches,
  );

  // Defensive guard: the five gate-mapped actions always create a Task Event
  // (verified: completed/approved/failed/rejected/released all emitEvent=true),
  // and the seam forwards its id. If absent, skip advancement — no synthetic
  // fallback id is ever constructed.
  const eventId = opts.eventId;
  if (!eventId) {
    logger.warn(
      { taskId: opts.taskId, action: opts.action },
      "Lifecycle gate trigger missing forwarded transition eventId; skipping advanceGates",
    );
    return;
  }

  const trigger: GateTrigger = {
    kind: "lifecycle",
    eventId,
    action: opts.action,
    actorType: opts.actorType ?? "",
    actorId: opts.actorId ?? "",
  };
  const results = advanceGates(decisions, trigger);
  logAdvancementWriteErrors(results);

  // Trigger-specific follow-up: failure capture + recovery spawn for the gates
  // THIS call advanced to `satisfied`. A `write_error`/`already_satisfied` result
  // never triggers spawn (the gate did not advance this call).
  if (gateType !== "on_fail") return;
  const newlySatisfiedOnFail: typeof gates = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "satisfied") {
      newlySatisfiedOnFail.push(decisions[i].gate);
    }
  }
  if (newlySatisfiedOnFail.length === 0) return;

  // Depth-capped gates never receive a durable handoff, so the lifecycle
  // adapter owns the unrecoverable notification for this newly satisfied
  // outcome. Zip the positional advancement results back to the evaluator's
  // full gate records to preserve the exact gate depth/action payload.
  for (let i = 0; i < results.length; i++) {
    const gate = decisions[i]?.gate;
    if (
      results[i]?.status === "satisfied" &&
      gate?.gateType === "on_fail" &&
      gate.recoveryDepth >= MAX_RECOVERY_DEPTH
    ) {
      emitRecoveryNotification(
        gate.habitatId,
        "workflow.recovery_unrecoverable",
        "Recovery depth cap reached",
        {
          gateId: gate.id,
          failedTaskId: opts.taskId,
          recoveryDepth: gate.recoveryDepth,
          action: opts.action,
        },
      );
    }
  }

  handleFailureCapture(opts);
  try {
    // The handoff was committed atomically with gate satisfaction. Reconcile
    // immediately so the normal path does not wait for the next boot; the
    // coordinator still owns the spawn and always uses the frozen payload.
    runRecoveryReconciliationPass();
  } catch (err) {
    logger.error(
      { err, taskId: opts.taskId, gateCount: newlySatisfiedOnFail.length },
      "Failed to reconcile workflow recovery handoffs",
    );
  }
}

function handleRedemptionIfNeeded(opts: {
  taskId: string;
  action: string;
  habitatId: string;
}): void {
  const db = getDb();
  // Find unresolved failure contexts where THIS task is the spawned recovery task.
  // Per the F2+F3 gate-orientation deviation, redemption linkage is via
  // failureContexts.recoveryTaskId (direct reference), NOT via gate edges.
  const contexts = db
    .select({
      id: failureContexts.id,
      failedTaskId: failureContexts.failedTaskId,
      habitatId: failureContexts.habitatId,
    })
    .from(failureContexts)
    .where(and(eq(failureContexts.recoveryTaskId, opts.taskId), isNull(failureContexts.resolvedAt)))
    .all();

  if (contexts.length === 0) return;

  const now = new Date().toISOString();
  for (const ctx of contexts) {
    try {
      redeemOneContext(ctx, now);
    } catch (err) {
      logger.error(
        { err, contextId: ctx.id, failedTaskId: ctx.failedTaskId },
        "Failed to redeem failure context",
      );
    }
  }
}

function redeemOneContext(
  ctx: { id: string; failedTaskId: string; habitatId: string },
  now: string,
): void {
  const db = getDb();
  // Satisfy every unsatisfied on_complete / on_approve gate upstream of the
  // original failed task. Idempotent at SQL level via WHERE satisfied = false.
  const gates = db
    .select({ id: taskWorkflowGates.id })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.upstreamTaskId, ctx.failedTaskId),
        inArray(taskWorkflowGates.gateType, ["on_complete", "on_approve"]),
        eq(taskWorkflowGates.satisfied, false),
        eq(workflows.status, "active"),
      ),
    )
    .all();

  for (const gate of gates) {
    db.update(taskWorkflowGates)
      .set({ satisfied: true, satisfiedAt: now })
      .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
      .run();
  }

  // Resolve the failure context so re-firing approved/completed is a no-op.
  failureContextService.resolveFailureContext(ctx.id, "redeemed");

  emitRecoveryNotification(
    ctx.habitatId,
    "workflow.recovery_succeeded",
    "Recovery redeemed original failure",
    {
      contextId: ctx.id,
      failedTaskId: ctx.failedTaskId,
      gatesSatisfied: gates.length,
    },
  );
}

function handleFailureCapture(opts: {
  taskId: string;
  action: string;
  metadata?: Record<string, unknown>;
}): void {
  const failureKind = failureContextService.actionToFailureKind(opts.action);
  if (!failureKind) return;
  try {
    const failureReason =
      (opts.metadata?.["reason"] as string | undefined) ??
      (opts.metadata?.["rejectionReason"] as string | undefined) ??
      "";
    failureContextService.buildFailureContext(opts.taskId, failureKind, { failureReason });
  } catch (err) {
    logger.error({ err, taskId: opts.taskId }, "Failed to build failure context");
  }
}

/** Emits a workflow recovery notification event (and corresponding audit via the notification-to-audit projection) with a consistent shape. */
export function emitRecoveryNotification(
  habitatId: string,
  eventType:
    | "workflow.recovery_started"
    | "workflow.recovery_succeeded"
    | "workflow.recovery_unrecoverable",
  title: string,
  payload: Record<string, unknown>,
): void {
  try {
    enqueueNotification({
      habitatId,
      eventType,
      sourceType: "workflow",
      targetType: "task",
      targetId:
        (payload.recoveryTaskId as string | undefined) ??
        (payload.failedTaskId as string | undefined),
      severity: eventType === "workflow.recovery_succeeded" ? "info" : "warning",
      title,
      payload,
      createdByType: "system",
      createdById: "workflow-service",
    });
  } catch (err) {
    logger.error({ err, eventType, habitatId }, "Failed to emit workflow recovery notification");
  }
}

/** Emits an audit-only workflow task event (no notification counterpart) with `source: "workflow"`. */
function emitWorkflowTaskAudit(
  taskId: string,
  action: "workflow_gate_satisfied" | "workflow_gate_unblocked" | "workflow_evaluation_error",
  payload: Record<string, unknown>,
): void {
  try {
    emitTaskAuditEvent({
      taskId,
      actorType: "system",
      actorId: "workflow-service",
      action,
      metadata: {
        audit: { source: "workflow" },
        ...payload,
      },
    });
  } catch (err) {
    logger.error({ err, taskId, action }, "Failed to emit workflow task audit event");
  }
}

/** Emits an audit-only workflow mission event (no notification counterpart) with `source: "workflow"`. */
function emitWorkflowMissionAudit(
  missionId: string,
  action: "workflow_attached" | "workflow_detached",
  payload: Record<string, unknown>,
): void {
  try {
    emitMissionAuditEvent({
      missionId,
      actorType: "system",
      actorId: "workflow-service",
      action,
      metadata: {
        audit: { source: "workflow" },
        ...payload,
      },
    });
  } catch (err) {
    logger.error({ err, missionId, action }, "Failed to emit workflow mission audit event");
  }
}

/** Substitutes `{{key}}` placeholders in `text` with values from `vars`, leaving unknown keys intact as empty strings. */
export function substituteTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function handlePulseCreated(pulse: Pulse): void {
  const gates = workflowGateStore.findActiveSignalGates(pulse.habitatId);

  if (gates.length === 0) return;

  const decisions = workflowGateEvaluator.evaluatePulseTrigger(gates, pulse, gateConditionMatches);
  // advanceGates owns the per-gate tx (satisfy + audit + recovery handoff), the
  // audit-action vocabulary, and the structured result. Pulse has no follow-up.
  const results = advanceGates(decisions, { kind: "pulse", eventId: pulse.id });
  logAdvancementWriteErrors(results);
}

function handleAutomationRunCompleted(opts: {
  run: { id: string; targetType: string | null; targetId: string | null };
  rule: { id: string };
  outcome: string;
  habitatId: string;
}): void {
  const gates = workflowGateStore.findActiveAutomationGates(opts.habitatId);

  if (gates.length === 0) return;

  const decisions = workflowGateEvaluator.evaluateAutomationTrigger(gates, opts);
  // advanceGates owns the per-gate tx (satisfy + audit + recovery handoff), the
  // audit-action vocabulary, and the structured result. Automation has no follow-up.
  const results = advanceGates(decisions, {
    kind: "automation",
    eventId: opts.run.id,
    ruleId: opts.rule.id,
  });
  logAdvancementWriteErrors(results);
}

/** Adapter-owned operator visibility for per-gate advancement write failures. */
function logAdvancementWriteErrors(results: AdvancementResult[]): void {
  for (const result of results) {
    if (result.status !== "write_error") continue;
    logger.error(
      {
        error: result.error,
        gateId: result.gateId,
        triggerKind: result.triggerKind,
        triggerEventId: result.triggerEventId,
      },
      "Workflow gate advancement write failed",
    );
  }
}

/** Attaches a workflow DAG to a mission, creating the workflow row and all gate rows from the template definition. */
export function attachWorkflow(
  missionId: string,
  habitatId: string,
  definition: WorkflowTemplateDefinition,
  variables: Record<string, string>,
  createdBy: string,
): string {
  const db = getDb();
  const workflowId = crypto.randomUUID();

  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      resolvedVariables: variables,
      failureHandler: definition.failureHandler ?? null,
      joinSpecs: definition.joinSpecs ?? null,
      status: "active",
      createdBy,
    })
    .run();

  for (const gate of definition.gates) {
    db.insert(taskWorkflowGates)
      .values({
        id: crypto.randomUUID(),
        workflowId,
        missionId,
        habitatId,
        upstreamTaskId: gate.upstreamTaskKey,
        downstreamTaskId: gate.downstreamTaskKey,
        gateType: gate.gateType,
        matchConfig: (gate.matchConfig as Record<string, unknown>) ?? null,
        condition: gate.condition ?? null,
        satisfied: false,
        recoveryDepth: 0,
      })
      .run();
  }

  emitWorkflowMissionAudit(missionId, "workflow_attached", {
    workflowId,
    habitatId,
    gateCount: definition.gates.length,
    createdBy,
  });

  return workflowId;
}

/** Detaches a workflow by setting status to detached; gates stop enforcing immediately. Emits a `workflow_detached` audit event. */
export function detachWorkflow(workflowId: string, detachedBy: string): void {
  const db = getDb();
  const existing = db
    .select({ missionId: workflows.missionId })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
  const now = new Date().toISOString();
  db.update(workflows)
    .set({
      status: "detached",
      detachedAt: now,
      detachedBy,
      version: sql`${workflows.version} + 1`,
    })
    .where(and(eq(workflows.id, workflowId), eq(workflows.status, "active")))
    .run();

  if (existing) {
    emitWorkflowMissionAudit(existing.missionId, "workflow_detached", {
      workflowId,
      detachedBy,
    });
  }
}

/** Returns the active workflow for a mission, or null if none attached. */
export function getWorkflowForMission(missionId: string): typeof workflows.$inferSelect | null {
  const db = getDb();
  return (
    db
      .select()
      .from(workflows)
      .where(and(eq(workflows.missionId, missionId), eq(workflows.status, "active")))
      .get() ?? null
  );
}

/** Returns all gates and their current satisfied states for a workflow DAG. */
export function getWorkflowShape(workflowId: string): Array<typeof taskWorkflowGates.$inferSelect> {
  const db = getDb();
  return db
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.workflowId, workflowId))
    .all();
}

/** Returns the upstream and downstream workflow gates for a single task. */
export function getTaskWorkflowContext(taskId: string): {
  upstream: Array<typeof taskWorkflowGates.$inferSelect>;
  downstream: Array<typeof taskWorkflowGates.$inferSelect>;
} {
  const db = getDb();
  const upstream = db
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.downstreamTaskId, taskId))
    .all();
  const downstream = db
    .select()
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.upstreamTaskId, taskId))
    .all();
  return { upstream, downstream };
}

/** Manually satisfies an on_manual gate, typically called by an admin via the unblock endpoint. Emits a `workflow_gate_unblocked` audit event. */
export function manualUnblockGate(gateId: string, _unblockerId: string): boolean {
  const result = workflowGateStore.satisfyManualGateIfEligible(gateId);
  if (result.status === "not_found" || result.status === "wrong_gate_type") return false;

  const gate = result.gate;
  emitWorkflowTaskAudit(gate.downstreamTaskId, "workflow_gate_unblocked", {
    gateId: gate.id,
    workflowId: gate.workflowId,
    upstreamTaskId: gate.upstreamTaskId,
    downstreamTaskId: gate.downstreamTaskId,
    unblockedBy: _unblockerId,
  });

  return true;
}

/** Returns the workflow row by id (any status), or null when missing. */
export function getWorkflowById(workflowId: string): typeof workflows.$inferSelect | null {
  const db = getDb();
  return db.select().from(workflows).where(eq(workflows.id, workflowId)).get() ?? null;
}

/** Outcome of an OCC-protected update; `mismatch` carries the current version for the 409 response body. */
export type UpdateWorkflowOutcome =
  | { ok: true; workflow: typeof workflows.$inferSelect }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "version_mismatch"; currentVersion: number };

/**
 * Applies an OCC-protected update to a workflow's mutable config fields (`failureHandler`, `joinSpecs`).
 * Gate-row changes are NOT supported in v0.20 — detach and re-attach to restructure the DAG. Returns
 * `version_mismatch` when `expectedVersion` does not match the persisted `workflows.version`.
 */
export function updateWorkflow(
  workflowId: string,
  updates: {
    failureHandler?: WorkflowFailureHandlerConfig | null;
    joinSpecs?: Record<string, { mode: "all_of" | "any_of" | "n_of"; n?: number }> | null;
  },
  expectedVersion: number,
): UpdateWorkflowOutcome {
  const db = getDb();
  const existing = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.version !== expectedVersion) {
    return { ok: false, reason: "version_mismatch", currentVersion: existing.version };
  }

  const set: Record<string, unknown> = { version: sql`${workflows.version} + 1` };
  if (updates.failureHandler !== undefined) set.failureHandler = updates.failureHandler;
  if (updates.joinSpecs !== undefined) set.joinSpecs = updates.joinSpecs;

  db.update(workflows).set(set).where(eq(workflows.id, workflowId)).run();

  const updated = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  return { ok: true, workflow: updated! };
}

/** Returns every failure-context row attached to a workflow (resolved or not), newest first. */
export function getFailureContextsForWorkflow(
  workflowId: string,
): Array<typeof failureContexts.$inferSelect> {
  const db = getDb();
  return db
    .select()
    .from(failureContexts)
    .where(eq(failureContexts.workflowId, workflowId))
    .orderBy(sql`${failureContexts.failedAt} DESC`)
    .all();
}
