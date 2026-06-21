import type {
  GateType,
  JoinMode,
  WorkflowTemplateDefinition,
  WorkflowTemplateGate,
  TaskTemplateEntry,
  ExperienceCategory,
} from "../../types/index.js";

/** Gate types selectable in the v0.20 editor; `on_automation` is deferred to v0.20.1. */
export const SELECTABLE_GATE_TYPES: GateType[] = [
  "on_complete",
  "on_approve",
  "on_signal",
  "on_manual",
  "on_fail",
];

/** All six gate types including the deferred `on_automation` (shown disabled in dropdown). */
export const ALL_GATE_TYPES: GateType[] = [...SELECTABLE_GATE_TYPES, "on_automation"];

/** Human-readable labels for each gate type. */
export const GATE_TYPE_LABELS: Record<GateType, string> = {
  on_complete: "On Complete",
  on_approve: "On Approve",
  on_signal: "On Signal",
  on_automation: "On Automation (v0.20.1)",
  on_manual: "On Manual",
  on_fail: "On Fail",
};

/** Signal type options for `on_signal` match config. */
export const SIGNAL_TYPE_OPTIONS = [
  "blocker",
  "context",
  "finding",
  "handoff",
  "question",
  "success",
  "experience",
] as const;

/** The seven experience categories for signal match filtering. */
export const EXPERIENCE_CATEGORY_OPTIONS: ExperienceCategory[] = [
  "stuck",
  "confused",
  "backtrack",
  "surprised",
  "ambiguous",
  "sidetracked",
  "smooth",
];

/** Match scope options for signal/automation gates. */
export const MATCH_SCOPE_OPTIONS = ["task", "mission", "either"] as const;

/** Join mode options for per-task join specs. */
export const JOIN_MODE_OPTIONS: JoinMode[] = ["all_of", "any_of", "n_of"];

/** Resolves the effective key for a task, auto-generating `task_N` when absent. */
export function resolveTaskKey(task: TaskTemplateEntry, index: number): string {
  return task.key ?? `task_${index + 1}`;
}

/** Resolved task option for dropdown rendering, pairing each task's key with a display label. */
export interface TaskOption {
  key: string;
  label: string;
}

/** Builds a sorted list of task key/label pairs for gate dropdowns, auto-generating missing keys. */
export function resolveTaskOptions(tasks: TaskTemplateEntry[]): TaskOption[] {
  return tasks.map((task, index) => {
    const key = resolveTaskKey(task, index);
    const title = task.title || "(untitled)";
    return { key, label: `${key} — ${title}` };
  });
}

/** Counts upstream gates targeting a given task key. */
export function countUpstreamGates(taskKey: string, gates: WorkflowTemplateGate[]): number {
  return gates.filter((g) => g.downstreamTaskKey === taskKey).length;
}

/** A single validation message produced by `validateWorkflow`. */
export interface ValidationMessage {
  severity: "error" | "warning";
  text: string;
}

/** Detects cycles in the gate graph via DFS, returning the first cycle path found or null. */
export function detectCycle(gates: WorkflowTemplateGate[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const gate of gates) {
    const neighbors = adj.get(gate.upstreamTaskKey) ?? [];
    neighbors.push(gate.downstreamTaskKey);
    adj.set(gate.upstreamTaskKey, neighbors);
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        const cycle = dfs(neighbor);
        if (cycle) return cycle;
      } else if (recursionStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        return [...path.slice(cycleStart), neighbor];
      }
    }

    path.pop();
    recursionStack.delete(node);
    return null;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }

  return null;
}

/** Validates a workflow definition against its task list, returning error and warning messages. */
export function validateWorkflow(
  tasks: TaskTemplateEntry[],
  workflow: WorkflowTemplateDefinition,
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];
  const keys = tasks.map((t, i) => resolveTaskKey(t, i));
  const keySet = new Set(keys);

  // Duplicate keys
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  for (const key of dupes) {
    messages.push({ severity: "error", text: `Two tasks share key '${key}'` });
  }

  // Missing keys on tasks referenced by gates (auto-fix suggestion)
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i].key && countUpstreamGates(`task_${i + 1}`, workflow.gates) > 0) {
      // This task is referenced but has no explicit key — it works via auto-gen, just note it
    }
  }

  // Dangling references
  for (const gate of workflow.gates) {
    if (!keySet.has(gate.upstreamTaskKey)) {
      messages.push({
        severity: "error",
        text: `Gate references upstream task key '${gate.upstreamTaskKey}' but no task with that key exists`,
      });
    }
    if (!keySet.has(gate.downstreamTaskKey)) {
      messages.push({
        severity: "error",
        text: `Gate references downstream task key '${gate.downstreamTaskKey}' but no task with that key exists`,
      });
    }
  }

  // Cycle detection
  const cycle = detectCycle(workflow.gates);
  if (cycle) {
    messages.push({
      severity: "error",
      text: `Gate cycle detected: ${cycle.join(" → ")}`,
    });
  }

  // Missing join specs on multi-gate tasks
  for (const key of keys) {
    const upstreamCount = countUpstreamGates(key, workflow.gates);
    if (upstreamCount > 1 && !workflow.joinSpecs?.[key]) {
      messages.push({
        severity: "warning",
        text: `Task '${key}' has ${upstreamCount} upstream gates but no join spec — defaults to all_of`,
      });
    }
  }

  // Unreachable tasks (no upstream and no downstream gates)
  for (const key of keys) {
    const upstream = countUpstreamGates(key, workflow.gates);
    const downstream = workflow.gates.filter((g) => g.upstreamTaskKey === key).length;
    if (upstream === 0 && downstream === 0 && workflow.gates.length > 0) {
      messages.push({
        severity: "warning",
        text: `Task '${key}' has no upstream or downstream gates — it's not part of the workflow`,
      });
    }
  }

  return messages;
}
