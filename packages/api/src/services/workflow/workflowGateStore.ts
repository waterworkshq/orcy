import { getDb } from "../../db/index.js";
import { workflows, taskWorkflowGates } from "../../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import type { AutomationCondition } from "../../models/index.js";

export type WorkflowGateRecord = {
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
  findGateById(gateId: string): WorkflowGateRecord | null {
    const db = getDb();
    return (
      (db
        .select(gateProjection)
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.id, gateId))
        .get() as WorkflowGateRecord | undefined) ?? null
    );
  },

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

};
