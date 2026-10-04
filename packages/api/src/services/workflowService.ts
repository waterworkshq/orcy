import { getDb } from "../db/index.js";
import {
  workflows,
  taskWorkflowGates,
  failureContexts,
  missions,
  tasks,
} from "../db/schema/index.js";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { badRequest, conflict } from "../errors.js";
import {
  insertWorkflowWithinMissionScope,
  insertWorkflowGateWithinMissionScope,
  WorkflowScopeMissError,
} from "../repositories/workflowIntegrity.js";
import { onTransition } from "./tasks/transition-emitter.js";
import * as pulseService from "./pulseService.js";
import { onAutomationRunCompleted } from "./automationExecutor.js";
import { evaluateCondition } from "./automationEvaluator.js";
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import * as failureContextService from "./failureContextService.js";
import { emitMissionAuditEvent } from "./auditEventEmitter.js";
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
  resolveEffectiveFailureHandlerWithClient,
  type AdvancementResult,
  type GateTrigger,
} from "./workflow/workflowGateAdvancer.js";
import { runRecoveryReconciliationPass } from "./workflow/recoveryCoordinator.js";
import { emitRecoveryNotification } from "./workflow/recoveryNotifications.js";

export { emitRecoveryNotification, substituteTemplate } from "./workflow/recoveryNotifications.js";

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

/**
 * T2 — the receipt-path workflow_gates consumer evaluates conditions through
 * the SAME checker the live `notifyTransition` seam uses (byte-for-byte
 * condition semantics, single owner).
 */
export function lifecycleGateConditionMatches(
  condition: AutomationCondition,
  trigger: ConditionTrigger,
): boolean {
  return gateConditionMatches(condition, trigger);
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
      gate.recoveryDepth >= MAX_RECOVERY_DEPTH &&
      resolveEffectiveFailureHandlerWithClient(getDb(), gate) !== null
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

  for (const ctx of contexts) {
    try {
      redeemOneContext(ctx);
    } catch (err) {
      logger.error(
        { err, contextId: ctx.id, failedTaskId: ctx.failedTaskId },
        "Failed to redeem failure context",
      );
    }
  }
}

function redeemOneContext(ctx: { id: string; failedTaskId: string; habitatId: string }): void {
  const db = getDb();
  // Satisfy every unsatisfied on_complete / on_approve gate upstream of the
  // original failed task. Eligibility stays in this adapter; the advancement
  // module owns the guarded write, audit, and satisfiedByEventId stamp.
  const gates = db
    .select({
      id: taskWorkflowGates.id,
      workflowId: taskWorkflowGates.workflowId,
      missionId: taskWorkflowGates.missionId,
      habitatId: taskWorkflowGates.habitatId,
      upstreamTaskId: taskWorkflowGates.upstreamTaskId,
      downstreamTaskId: taskWorkflowGates.downstreamTaskId,
      gateType: taskWorkflowGates.gateType,
      satisfied: taskWorkflowGates.satisfied,
      matchConfig: taskWorkflowGates.matchConfig,
      condition: taskWorkflowGates.condition,
      recoveryTaskId: taskWorkflowGates.recoveryTaskId,
      recoveryDepth: taskWorkflowGates.recoveryDepth,
    })
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

  const decisions = gates.map((gate) => ({ status: "satisfy" as const, gate }));
  const results = advanceGates(decisions, {
    kind: "recovery_redemption",
    eventId: ctx.id,
    contextId: ctx.id,
  });
  logAdvancementWriteErrors(results);

  // A failed per-gate transaction leaves that gate unsatisfied. Keep the
  // context unresolved so the next redemption attempt can retry it.
  const allGatesAdvanced = results.every(
    (result) => result.status === "satisfied" || result.status === "already_satisfied",
  );
  if (!allGatesAdvanced) return;

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

/**
 * Whole-input prevalidation for {@link attachWorkflow}: the SELECTED exact
 * Mission must persist in the supplied Habitat, and EVERY explicit endpoint
 * pair must be an existing Task of that Mission. Any miss — missing node,
 * foreign-Mission node (same or different Habitat), or a supplied Habitat
 * inconsistent with the selected Mission — is the single generic validity
 * refusal 400 VALIDATION_ERROR `Invalid workflow nodes` (no foreign
 * details). This is input validity, not object membership; the selected
 * Mission's 404 stays route-owned.
 */
function validateAttachScopeAndNodes(
  missionId: string,
  habitatId: string,
  gates: WorkflowTemplateDefinition["gates"],
): void {
  const db = getDb();

  const mission = db
    .select({ id: missions.id, habitatId: missions.habitatId })
    .from(missions)
    .where(eq(missions.id, missionId))
    .get();
  if (!mission || mission.habitatId !== habitatId) {
    throw badRequest("Invalid workflow nodes");
  }

  const endpointIds = new Set<string>();
  for (const gate of gates) {
    endpointIds.add(gate.upstreamTaskKey);
    endpointIds.add(gate.downstreamTaskKey);
  }
  const persisted = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.missionId, missionId), inArray(tasks.id, [...endpointIds])))
    .all();
  const valid = new Set(persisted.map((row) => row.id));
  for (const gate of gates) {
    if (!valid.has(gate.upstreamTaskKey) || !valid.has(gate.downstreamTaskKey)) {
      throw badRequest("Invalid workflow nodes");
    }
  }
}

/**
 * Attaches a workflow DAG to a mission: the Workflow row and ALL gate rows
 * commit in one own synchronous transaction of conditional scoped inserts
 * (see `repositories/workflowIntegrity.ts`). The whole bundle is validated
 * before the first write; a zero-match at any final statement after
 * prevalidation means the persisted scope drifted mid-attach and surfaces
 * as 409 CONFLICT `Workflow context changed` with the bundle rolled back.
 * The best-effort `workflow_attached` audit is emitted only after a
 * successful commit.
 */
export function attachWorkflow(
  missionId: string,
  habitatId: string,
  definition: WorkflowTemplateDefinition,
  variables: Record<string, string>,
  createdBy: string,
): string {
  const db = getDb();
  const workflowId = crypto.randomUUID();
  const now = new Date().toISOString();

  validateAttachScopeAndNodes(missionId, habitatId, definition.gates);

  try {
    db.transaction((tx) => {
      insertWorkflowWithinMissionScope(tx, {
        id: workflowId,
        missionId,
        habitatId,
        resolvedVariables: variables,
        failureHandler: definition.failureHandler ?? null,
        joinSpecs: definition.joinSpecs ?? null,
        createdBy,
        createdAt: now,
      });

      for (const gate of definition.gates) {
        insertWorkflowGateWithinMissionScope(tx, {
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
          satisfiedAt: null,
          satisfiedByEventId: null,
          recoveryTaskId: null,
          recoveryDepth: 0,
        });
      }
    });
  } catch (err) {
    if (err instanceof WorkflowScopeMissError) {
      // Post-precheck statement-time drift: the persisted selected scope
      // changed between validation and a final conditional write. The
      // transaction rolled the whole bundle back — no partial attach.
      throw conflict("Workflow context changed");
    }
    throw err;
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
export function manualUnblockGate(gateId: string, unblockerId: string): boolean {
  const gate = workflowGateStore.findGateById(gateId);
  if (!gate || gate.gateType !== "on_manual") return false;

  // Manual unblock has no external trigger event. The preallocated id is both
  // the trigger event id and the audit row's own id (self-referential causal id).
  const auditEventId = crypto.randomUUID();
  const [result] = advanceGates([{ status: "satisfy", gate }], {
    kind: "manual",
    eventId: auditEventId,
    unblockerId,
  });

  if (result.status === "satisfied" || result.status === "already_satisfied") return true;

  if (result.status === "write_error" || result.status === "evaluation_error") {
    logger.error(
      {
        error: result.error,
        gateId: result.gateId,
        triggerKind: result.triggerKind,
        triggerEventId: result.triggerEventId,
        status: result.status,
      },
      "Manual workflow gate unblock failed",
    );
  }
  return false;
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
