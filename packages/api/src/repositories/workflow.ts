import { getDb } from "../db/index.js";
import { taskWorkflowGates, workflows } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import type { JoinMode } from "../models/index.js";

/** Per-downstream-task join configuration extracted from a workflow's joinSpecs column. */
export type JoinConfig = { mode: JoinMode; n?: number };

/** Evaluates whether the count of satisfied gates meets the join-mode threshold for a downstream task. */
export function evaluateJoin(
  totalGates: number,
  satisfiedGates: number,
  config: JoinConfig,
): boolean {
  switch (config.mode) {
    case "all_of":
      return satisfiedGates === totalGates;
    case "any_of":
      return satisfiedGates >= 1;
    case "n_of":
      return satisfiedGates >= (config.n ?? 1);
  }
}

/** Given a downstream task, returns true when all active-workflow gates are satisfied per the task's join spec; returns true when no gates exist (backwards compat).
 * Only original gates (recoveryDepth = 0) participate in the claim-blocking check; recovery-spawned gates (recoveryDepth > 0) are spawn triggers that detect recovery failure, not claim constraints. */
export function areAllWorkflowGatesSatisfied(taskId: string): boolean {
  const db = getDb();

  const gates = db
    .select({
      satisfied: taskWorkflowGates.satisfied,
      workflowId: taskWorkflowGates.workflowId,
    })
    .from(taskWorkflowGates)
    .innerJoin(workflows, eq(taskWorkflowGates.workflowId, workflows.id))
    .where(
      and(
        eq(taskWorkflowGates.downstreamTaskId, taskId),
        eq(workflows.status, "active"),
        eq(taskWorkflowGates.recoveryDepth, 0),
      ),
    )
    .all();

  if (gates.length === 0) return true;

  const workflowId = gates[0].workflowId;
  const workflow = db
    .select({ joinSpecs: workflows.joinSpecs })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();

  const joinConfig: JoinConfig = workflow?.joinSpecs?.[taskId] ?? { mode: "all_of" };
  const satisfiedCount = gates.filter((g) => g.satisfied).length;

  return evaluateJoin(gates.length, satisfiedCount, joinConfig);
}
