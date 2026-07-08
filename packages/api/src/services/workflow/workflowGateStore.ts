import { getDb } from "../../db/index.js";
import { workflows, taskWorkflowGates } from "../../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import type { AutomationCondition } from "../../models/index.js";

type WorkflowGateRecord = {
  id: string;
  workflowId: string;
  missionId: string;
  habitatId: string;
  upstreamTaskId: string;
  downstreamTaskId: string;
  gateType: string;
  satisfied: boolean;
  matchConfig: Record<string, unknown> | null;
  condition: AutomationCondition | null;
  recoveryTaskId: string | null;
  recoveryDepth: number;
};

type GateSatisfactionResult =
  | { status: "satisfied"; satisfiedAt: string }
  | { status: "already_satisfied" };

type ManualGateSatisfactionResult =
  | { status: "satisfied"; gate: WorkflowGateRecord; satisfiedAt: string }
  | { status: "already_satisfied"; gate: WorkflowGateRecord }
  | { status: "not_found"; gateId: string }
  | { status: "wrong_gate_type"; gate: WorkflowGateRecord };

const gateProjection = {
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
};

export const workflowGateStore = {
  findActiveLifecycleGates(
    taskId: string,
    gateType: "on_complete" | "on_approve" | "on_fail",
  ): WorkflowGateRecord[] {
    const db = getDb();
    return db
      .select(gateProjection)
      .from(taskWorkflowGates)
      .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
      .where(
        and(
          eq(taskWorkflowGates.upstreamTaskId, taskId),
          eq(taskWorkflowGates.gateType, gateType),
          eq(workflows.status, "active"),
        ),
      )
      .all();
  },

  findActiveSignalGates(habitatId: string): WorkflowGateRecord[] {
    const db = getDb();
    return db
      .select(gateProjection)
      .from(taskWorkflowGates)
      .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
      .where(
        and(
          eq(taskWorkflowGates.gateType, "on_signal"),
          eq(taskWorkflowGates.habitatId, habitatId),
          eq(taskWorkflowGates.satisfied, false),
          eq(workflows.status, "active"),
        ),
      )
      .all();
  },

  findActiveAutomationGates(habitatId: string): WorkflowGateRecord[] {
    const db = getDb();
    return db
      .select(gateProjection)
      .from(taskWorkflowGates)
      .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
      .where(
        and(
          eq(taskWorkflowGates.gateType, "on_automation"),
          eq(taskWorkflowGates.habitatId, habitatId),
          eq(taskWorkflowGates.satisfied, false),
          eq(workflows.status, "active"),
        ),
      )
      .all();
  },

  satisfyGateIfUnsatisfied(
    gate: WorkflowGateRecord,
    eventId?: string | null,
  ): GateSatisfactionResult {
    const db = getDb();
    const now = new Date().toISOString();
    const runResult = db
      .update(taskWorkflowGates)
      .set({
        satisfied: true,
        satisfiedAt: now,
        ...(eventId ? { satisfiedByEventId: eventId } : {}),
      })
      .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
      .run();
    const changes = (runResult as { changes?: number } | undefined)?.changes;
    if (changes === undefined || changes > 0) {
      return { status: "satisfied", satisfiedAt: now };
    }
    return { status: "already_satisfied" };
  },

  satisfyManualGateIfEligible(gateId: string): ManualGateSatisfactionResult {
    const db = getDb();
    const gate = db
      .select(gateProjection)
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gateId))
      .get() as WorkflowGateRecord | undefined;
    if (!gate) return { status: "not_found", gateId };
    if (gate.gateType !== "on_manual") return { status: "wrong_gate_type", gate };

    const now = new Date().toISOString();
    const runResult = db
      .update(taskWorkflowGates)
      .set({ satisfied: true, satisfiedAt: now })
      .where(and(eq(taskWorkflowGates.id, gateId), eq(taskWorkflowGates.satisfied, false)))
      .run();
    const changes = (runResult as { changes?: number } | undefined)?.changes;
    if (changes === undefined || changes > 0) {
      return { status: "satisfied", gate, satisfiedAt: now };
    }
    return { status: "already_satisfied", gate };
  },
};
