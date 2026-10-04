/**
 * Served-route projection for ORDINARY Workflow readers (ADR-0052).
 *
 * Internal Workflow services, repositories, gate advancement, capture/recovery
 * and the frozen handoff handler keep returning full rows. This module is the
 * only place the served wire shape is narrowed, and it does so by CONSTRUCTING a
 * fixed three-field record from named columns — never by spreading, serializing
 * and deleting, traversing arbitrary JSON, or falling back to the raw response.
 *
 * Omitted on purpose: every id (gate, workflow, mission, habitat, opposite
 * endpoint, recovery), `matchConfig`/`condition`, timestamps, actor/provenance
 * and recovery depth. Disclosed on purpose: that context exists, its array
 * direction, gate count, gate type and persisted satisfaction, plus the selected
 * active Workflow's status and version. This is restriction, not anonymity.
 */
import type { taskWorkflowGates, workflows } from "../db/schema/index.js";

type GateRow = typeof taskWorkflowGates.$inferSelect;
type WorkflowRow = typeof workflows.$inferSelect;

/** The exact per-gate record every ordinary served Workflow reader returns. */
export interface RestrictedGate {
  gateType: NonNullable<GateRow["gateType"]>;
  satisfied: boolean;
  restricted: true;
}

/** The exact per-Workflow record the shared Mission reader returns. */
export interface RestrictedWorkflow {
  status: WorkflowRow["status"];
  version: number;
}

export function restrictGate(gate: GateRow): RestrictedGate {
  return { gateType: gate.gateType, satisfied: gate.satisfied, restricted: true };
}

export function restrictGates(gates: GateRow[]): RestrictedGate[] {
  return gates.map(restrictGate);
}

/**
 * Projects a Task's selected gate arrays, preserving direction, count, order and
 * satisfaction exactly as selected. A satisfied or detached-workflow gate is
 * still a gate: this never converts a real context into a false empty or
 * false-unblocked result, and it never filters hidden references.
 */
export function restrictTaskWorkflowContext(context: {
  upstream: GateRow[];
  downstream: GateRow[];
}): { upstream: RestrictedGate[]; downstream: RestrictedGate[] } {
  return {
    upstream: restrictGates(context.upstream),
    downstream: restrictGates(context.downstream),
  };
}

/** Projects the selected active Workflow to its status and version only. */
export function restrictWorkflow(workflow: WorkflowRow): RestrictedWorkflow {
  return { status: workflow.status, version: workflow.version };
}
