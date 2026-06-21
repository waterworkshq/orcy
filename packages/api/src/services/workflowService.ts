import { getDb } from "../db/index.js";
import { workflows, taskWorkflowGates } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { onTransition } from "./tasks/transition-emitter.js";
import * as pulseService from "./pulseService.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import type { Pulse } from "../repositories/pulse.js";
import type { WorkflowTemplateDefinition, SignalMatch } from "../models/index.js";

export { areAllWorkflowGatesSatisfied };

let initialized = false;

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

function handleTransition(opts: { taskId: string; action: string; habitatId: string }): void {
  const gateType = actionToGateType(opts.action);
  if (!gateType) return;

  const db = getDb();
  const gates = db
    .select({ id: taskWorkflowGates.id, satisfied: taskWorkflowGates.satisfied })
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
  for (const gate of gates) {
    if (gate.satisfied) continue;
    try {
      db.update(taskWorkflowGates)
        .set({ satisfied: true, satisfiedAt: now })
        .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
        .run();
    } catch (err) {
      logger.error({ err, gateId: gate.id }, "Failed to satisfy workflow gate");
    }
  }
}

function actionToGateType(action: string): "on_complete" | "on_approve" | null {
  switch (action) {
    case "completed":
      return "on_complete";
    case "approved":
      return "on_approve";
    default:
      return null;
  }
}

function handlePulseCreated(pulse: Pulse): void {
  const db = getDb();
  const gates = db
    .select({
      id: taskWorkflowGates.id,
      satisfied: taskWorkflowGates.satisfied,
      upstreamTaskId: taskWorkflowGates.upstreamTaskId,
      missionId: taskWorkflowGates.missionId,
      matchConfig: taskWorkflowGates.matchConfig,
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
      db.update(taskWorkflowGates)
        .set({
          satisfied: true,
          satisfiedAt: now,
          satisfiedByEventId: pulse.id,
        })
        .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
        .run();
    } catch (err) {
      logger.error({ err, gateId: gate.id }, "Failed to evaluate on_signal gate");
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

  return workflowId;
}

/** Detaches a workflow by setting status to detached; gates stop enforcing immediately. */
export function detachWorkflow(workflowId: string, detachedBy: string): void {
  const db = getDb();
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

/** Manually satisfies an on_manual gate, typically called by an admin via the unblock endpoint. */
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
  return true;
}
