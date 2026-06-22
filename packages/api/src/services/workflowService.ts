import { getDb } from "../db/index.js";
import { workflows, taskWorkflowGates, failureContexts } from "../db/schema/index.js";
import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { onTransition } from "./tasks/transition-emitter.js";
import * as pulseService from "./pulseService.js";
import { evaluateCondition } from "./automationEvaluator.js";
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as failureContextService from "./failureContextService.js";
import { enqueueNotification } from "./notificationCommandService.js";
import { emitTaskAuditEvent, emitMissionAuditEvent } from "./auditEventEmitter.js";
import type { Pulse } from "../repositories/pulse.js";
import type {
  WorkflowTemplateDefinition,
  WorkflowFailureHandlerConfig,
  SignalMatch,
  AutomationCondition,
} from "../models/index.js";

export { areAllWorkflowGatesSatisfied };

let initialized = false;

type ConditionTrigger = {
  habitatId: string;
  targetType: "task" | "mission" | "agent" | "sprint" | "habitat" | "none";
  targetId: string | null;
  eventId?: string | null;
  payload?: Record<string, unknown>;
};

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
}): void {
  const gateType = actionToGateType(opts.action);
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

  const db = getDb();
  const gates = db
    .select({
      id: taskWorkflowGates.id,
      workflowId: taskWorkflowGates.workflowId,
      missionId: taskWorkflowGates.missionId,
      habitatId: taskWorkflowGates.habitatId,
      downstreamTaskId: taskWorkflowGates.downstreamTaskId,
      satisfied: taskWorkflowGates.satisfied,
      recoveryDepth: taskWorkflowGates.recoveryDepth,
      recoveryTaskId: taskWorkflowGates.recoveryTaskId,
      matchConfig: taskWorkflowGates.matchConfig,
      condition: taskWorkflowGates.condition,
    })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.upstreamTaskId, opts.taskId),
        eq(taskWorkflowGates.gateType, gateType),
        eq(workflows.status, "active"),
      ),
    )
    .all();

  if (gates.length === 0) return;

  const now = new Date().toISOString();
  const newlySatisfied: (typeof gates)[number][] = [];
  for (const gate of gates) {
    if (gate.satisfied) continue;
    try {
      if (
        gate.condition &&
        !gateConditionMatches(gate.condition, {
          habitatId: opts.habitatId,
          targetType: "task",
          targetId: opts.taskId,
          payload: {
            action: opts.action,
            actorType: opts.actorType,
            actorId: opts.actorId,
            oldStatus: opts.oldStatus,
            newStatus: opts.newStatus,
            metadata: opts.metadata,
          },
        })
      )
        continue;
      db.update(taskWorkflowGates)
        .set({ satisfied: true, satisfiedAt: now })
        .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
        .run();
      newlySatisfied.push(gate);
      emitWorkflowTaskAudit(gate.downstreamTaskId, "workflow_gate_satisfied", {
        gateId: gate.id,
        workflowId: gate.workflowId,
        upstreamTaskId: opts.taskId,
        downstreamTaskId: gate.downstreamTaskId,
        gateType,
        triggeredBy: opts.action,
      });
    } catch (err) {
      logger.error({ err, gateId: gate.id }, "Failed to satisfy workflow gate");
      emitWorkflowTaskAudit(gate.downstreamTaskId, "workflow_evaluation_error", {
        gateId: gate.id,
        workflowId: gate.workflowId,
        error: err instanceof Error ? err.message : String(err),
        phase: "gate_satisfaction",
      });
    }
  }

  if (newlySatisfied.length > 0 && gateType === "on_fail") {
    handleFailureCapture(opts);
    for (const gate of newlySatisfied) {
      try {
        spawnRecoveryForGate(gate, opts);
      } catch (err) {
        logger.error({ err, gateId: gate.id }, "Failed to spawn recovery task");
      }
    }
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

function spawnRecoveryForGate(
  gate: {
    id: string;
    workflowId: string;
    missionId: string;
    habitatId: string;
    downstreamTaskId: string;
    recoveryDepth: number;
    recoveryTaskId: string | null;
    matchConfig: Record<string, unknown> | null;
  },
  opts: { taskId: string; action: string; metadata?: Record<string, unknown> },
): void {
  if (gate.recoveryTaskId) {
    // Recovery already spawned for this gate — idempotent skip.
    return;
  }

  const effectiveHandler = resolveEffectiveFailureHandler(gate);
  if (effectiveHandler === null) return;

  if (gate.recoveryDepth >= MAX_RECOVERY_DEPTH) {
    logger.warn(
      { gateId: gate.id, recoveryDepth: gate.recoveryDepth, taskId: opts.taskId },
      "Recovery depth cap reached; not spawning a deeper recovery task",
    );
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
    return;
  }

  const failedTask = taskCrudRepo.getTaskById(opts.taskId);
  if (!failedTask) {
    logger.warn(
      { gateId: gate.id, taskId: opts.taskId },
      "Failed task missing during recovery spawn",
    );
    return;
  }

  const recoveryTask = createRecoveryTask(failedTask, effectiveHandler, opts);
  if (!recoveryTask) return;

  const db = getDb();
  try {
    // Create the next-depth on_fail gate. The new gate's upstream is the RECOVERY task
    // (so it only fires if the recovery itself fails, enabling recovery-of-recovery chains
    // rather than re-firing on every repeat of the original failure event). The downstream
    // mirrors the original gate's downstream so a successful recovery also unblocks the same
    // downstream task (consistent with F4 redemption semantics).
    db.insert(taskWorkflowGates)
      .values({
        id: crypto.randomUUID(),
        workflowId: gate.workflowId,
        missionId: gate.missionId,
        habitatId: gate.habitatId,
        upstreamTaskId: recoveryTask.id,
        downstreamTaskId: gate.downstreamTaskId,
        gateType: "on_fail",
        matchConfig: null,
        condition: null,
        satisfied: false,
        recoveryDepth: gate.recoveryDepth + 1,
      })
      .run();

    // Link the original gate back to the spawned recovery task (idempotency marker).
    db.update(taskWorkflowGates)
      .set({ recoveryTaskId: recoveryTask.id })
      .where(eq(taskWorkflowGates.id, gate.id))
      .run();

    // Link the failure context (if one was just built) to the recovery task.
    const ctx = failureContextService.getFailureContext(failedTask.id);
    if (ctx) {
      failureContextService.linkRecoveryTask(ctx.id, recoveryTask.id);
    }

    // Emit the recovery-started notification (also projects to audit via the
    // notification-to-audit projection with source="workflow").
    emitRecoveryNotification(
      gate.habitatId,
      "workflow.recovery_started",
      `Recovery task spawned for: ${failedTask.title}`,
      {
        gateId: gate.id,
        failedTaskId: failedTask.id,
        recoveryTaskId: recoveryTask.id,
        recoveryDepth: gate.recoveryDepth + 1,
      },
    );
  } catch (err) {
    logger.error(
      { err, gateId: gate.id, recoveryTaskId: recoveryTask.id },
      "Failed to wire recovery task gate linkage",
    );
  }
}

/** Maximum `recoveryDepth` allowed before recovery spawning is suppressed; gates at this depth fire but do not spawn deeper recoveries (two-attempts cap). */
export const MAX_RECOVERY_DEPTH = 2;

/** Emits a workflow recovery notification event (and corresponding audit via the notification-to-audit projection) with a consistent shape. */
function emitRecoveryNotification(
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

function resolveEffectiveFailureHandler(gate: {
  matchConfig: Record<string, unknown> | null;
  workflowId: string;
}): WorkflowFailureHandlerConfig | null {
  // Per-gate override lives in matchConfig.{failureHandlerOverride}:
  //   - present and null -> explicit disable (returns null)
  //   - present and an object -> use that handler
  //   - absent (no key) -> fall back to workflow-level failureHandler
  const matchConfig = gate.matchConfig as {
    failureHandlerOverride?: WorkflowFailureHandlerConfig | null;
  } | null;
  if (matchConfig && Object.prototype.hasOwnProperty.call(matchConfig, "failureHandlerOverride")) {
    return matchConfig.failureHandlerOverride ?? null;
  }

  const db = getDb();
  const workflow = db
    .select({ failureHandler: workflows.failureHandler })
    .from(workflows)
    .where(eq(workflows.id, gate.workflowId))
    .get();
  return (workflow?.failureHandler as WorkflowFailureHandlerConfig | null) ?? null;
}

function createRecoveryTask(
  failedTask: {
    id: string;
    missionId: string;
    title: string;
    rejectionReason: string | null;
    assignedAgentId: string | null;
  },
  handler: WorkflowFailureHandlerConfig,
  opts: { action: string; metadata?: Record<string, unknown> },
): { id: string } | null {
  const variables = collectSubstitutionVariables(failedTask, opts);

  const template = handler.recoveryTaskTemplate;
  const title = substituteTemplate(template.title, variables);
  const description = template.description
    ? substituteTemplate(template.description, variables)
    : "";

  try {
    const recoveryTask = taskCrudRepo.createTask({
      missionId: failedTask.missionId,
      title,
      description,
      requiredCapabilities: handler.agentSelector?.requiredCapabilities,
      requiredDomain: handler.agentSelector?.requiredDomain ?? null,
      createdBy: "workflow-recovery",
    });

    // Apply explicit agent assignment after creation (createTask has no assignedAgentId param).
    if (handler.agentSelector?.assignedAgentId) {
      taskCrudRepo.updateTask(recoveryTask.id, {
        assignedAgentId: handler.agentSelector.assignedAgentId,
      });
    }

    return recoveryTask;
  } catch (err) {
    logger.error({ err, failedTaskId: failedTask.id }, "Failed to create recovery task row");
    return null;
  }
}

function collectSubstitutionVariables(
  failedTask: {
    id: string;
    title: string;
    rejectionReason: string | null;
    assignedAgentId: string | null;
  },
  opts: { action: string; metadata?: Record<string, unknown> },
): Record<string, string> {
  const failedAgentId = failedTask.assignedAgentId ?? "";
  let failedAgentName = "";
  if (failedAgentId) {
    const agent = agentRepo.getAgentById(failedAgentId);
    failedAgentName = agent?.name ?? "";
  }

  const failureReason =
    (opts.metadata?.["reason"] as string | undefined) ??
    (opts.metadata?.["rejectionReason"] as string | undefined) ??
    failedTask.rejectionReason ??
    "";

  return {
    failedTaskId: failedTask.id,
    failedTaskTitle: failedTask.title,
    failureReason,
    failedAgentId,
    failedAgentName,
  };
}

/** Substitutes `{{key}}` placeholders in `text` with values from `vars`, leaving unknown keys intact as empty strings. */
export function substituteTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function actionToGateType(action: string): GateType | null {
  switch (action) {
    case "completed":
      return "on_complete";
    case "approved":
      return "on_approve";
    case "failed":
    case "rejected":
    case "released":
      return "on_fail";
    default:
      return null;
  }
}

type GateType = "on_complete" | "on_approve" | "on_fail";

function handlePulseCreated(pulse: Pulse): void {
  const db = getDb();
  const gates = db
    .select({
      id: taskWorkflowGates.id,
      satisfied: taskWorkflowGates.satisfied,
      upstreamTaskId: taskWorkflowGates.upstreamTaskId,
      downstreamTaskId: taskWorkflowGates.downstreamTaskId,
      workflowId: taskWorkflowGates.workflowId,
      missionId: taskWorkflowGates.missionId,
      matchConfig: taskWorkflowGates.matchConfig,
      condition: taskWorkflowGates.condition,
    })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.gateType, "on_signal"),
        eq(taskWorkflowGates.habitatId, pulse.habitatId),
        eq(taskWorkflowGates.satisfied, false),
        eq(workflows.status, "active"),
      ),
    )
    .all();

  if (gates.length === 0) return;

  const now = new Date().toISOString();
  for (const gate of gates) {
    if (gate.satisfied) continue;
    try {
      const match = readSignalMatch(gate.matchConfig);
      if (!match) continue;
      if (!signalMatchEqualsPulse(match, pulse, gate)) continue;
      if (
        gate.condition &&
        !gateConditionMatches(gate.condition, {
          habitatId: pulse.habitatId,
          targetType: pulse.taskId ? "task" : pulse.missionId ? "mission" : "none",
          targetId: pulse.taskId ?? pulse.missionId,
          eventId: pulse.id,
          payload: {
            signalType: pulse.signalType,
            subject: pulse.subject,
            metadata: pulse.metadata,
          },
        })
      )
        continue;
      db.update(taskWorkflowGates)
        .set({
          satisfied: true,
          satisfiedAt: now,
          satisfiedByEventId: pulse.id,
        })
        .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
        .run();
      emitWorkflowTaskAudit(gate.downstreamTaskId, "workflow_gate_satisfied", {
        gateId: gate.id,
        workflowId: gate.workflowId,
        upstreamTaskId: gate.upstreamTaskId,
        downstreamTaskId: gate.downstreamTaskId,
        gateType: "on_signal",
        triggeredBy: "pulse",
        pulseId: pulse.id,
      });
    } catch (err) {
      logger.error({ err, gateId: gate.id }, "Failed to evaluate on_signal gate");
      emitWorkflowTaskAudit(gate.downstreamTaskId, "workflow_evaluation_error", {
        gateId: gate.id,
        workflowId: gate.workflowId,
        error: err instanceof Error ? err.message : String(err),
        phase: "signal_gate_evaluation",
      });
    }
  }
}

function readSignalMatch(raw: Record<string, unknown> | null | undefined): SignalMatch | null {
  if (!raw) return null;
  if (typeof raw["signalType"] !== "string") return null;
  return {
    signalType: raw["signalType"] as SignalMatch["signalType"],
    experience: raw["experience"] as SignalMatch["experience"],
    subjectContains: raw["subjectContains"] as SignalMatch["subjectContains"],
    matchScope: raw["matchScope"] as SignalMatch["matchScope"],
  };
}

function signalMatchEqualsPulse(
  match: SignalMatch,
  pulse: Pulse,
  gate: { upstreamTaskId: string; missionId: string },
): boolean {
  if (match.signalType !== pulse.signalType) return false;

  if (match.experience !== undefined) {
    if (pulse.metadata?.["experience"] !== match.experience) return false;
  }

  if (match.subjectContains !== undefined) {
    const subject = pulse.subject.toLowerCase();
    const needle = match.subjectContains.toLowerCase();
    if (!subject.includes(needle)) return false;
  }

  const scope = match.matchScope ?? "task";
  return pulseMatchesScope(pulse, gate, scope);
}

function pulseMatchesScope(
  pulse: Pulse,
  gate: { upstreamTaskId: string; missionId: string },
  scope: "task" | "mission" | "either",
): boolean {
  switch (scope) {
    case "task":
      return pulse.taskId === gate.upstreamTaskId;
    case "mission":
      return pulse.missionId !== null && pulse.missionId === gate.missionId;
    case "either":
      return (
        pulse.taskId === gate.upstreamTaskId ||
        (pulse.missionId !== null && pulse.missionId === gate.missionId)
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
  const db = getDb();
  const gate = db.select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, gateId)).get();
  if (!gate) return false;
  if (gate.gateType !== "on_manual") return false;

  const now = new Date().toISOString();
  db.update(taskWorkflowGates)
    .set({ satisfied: true, satisfiedAt: now })
    .where(and(eq(taskWorkflowGates.id, gateId), eq(taskWorkflowGates.satisfied, false)))
    .run();

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
