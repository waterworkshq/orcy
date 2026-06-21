import { describe, it, expect } from "vitest";
import type {
  TaskTemplateEntry,
  WorkflowTemplateDefinition,
  WorkflowTemplateGate,
} from "../../types/index.js";
import {
  resolveTaskKey,
  resolveTaskOptions,
  countUpstreamGates,
  detectCycle,
  validateWorkflow,
  SELECTABLE_GATE_TYPES,
} from "./workflowEditorUtils.js";

describe("workflowEditorUtils", () => {
  describe("SELECTABLE_GATE_TYPES", () => {
    it("includes 5 gate types but not on_automation", () => {
      expect(SELECTABLE_GATE_TYPES).toHaveLength(5);
      expect(SELECTABLE_GATE_TYPES).toContain("on_complete");
      expect(SELECTABLE_GATE_TYPES).toContain("on_approve");
      expect(SELECTABLE_GATE_TYPES).toContain("on_signal");
      expect(SELECTABLE_GATE_TYPES).toContain("on_manual");
      expect(SELECTABLE_GATE_TYPES).toContain("on_fail");
      expect(SELECTABLE_GATE_TYPES).not.toContain("on_automation");
    });
  });

  describe("resolveTaskKey", () => {
    it("returns explicit key when present", () => {
      const task: TaskTemplateEntry = { key: "build", title: "Build" };
      expect(resolveTaskKey(task, 0)).toBe("build");
    });

    it("auto-generates task_N when key is absent", () => {
      const task: TaskTemplateEntry = { title: "Build" };
      expect(resolveTaskKey(task, 0)).toBe("task_1");
      expect(resolveTaskKey(task, 2)).toBe("task_3");
    });
  });

  describe("resolveTaskOptions", () => {
    it("maps tasks to key/label pairs", () => {
      const tasks: TaskTemplateEntry[] = [
        { key: "build", title: "Build Step" },
        { title: "Test Step" },
      ];
      const options = resolveTaskOptions(tasks);
      expect(options).toHaveLength(2);
      expect(options[0]).toEqual({ key: "build", label: "build — Build Step" });
      expect(options[1]).toEqual({ key: "task_2", label: "task_2 — Test Step" });
    });

    it("handles untitled tasks", () => {
      const tasks: TaskTemplateEntry[] = [{ title: "" }];
      const options = resolveTaskOptions(tasks);
      expect(options[0].label).toContain("(untitled)");
    });
  });

  describe("countUpstreamGates", () => {
    it("counts gates targeting a task key", () => {
      const gates: WorkflowTemplateGate[] = [
        { upstreamTaskKey: "a", downstreamTaskKey: "c", gateType: "on_complete" },
        { upstreamTaskKey: "b", downstreamTaskKey: "c", gateType: "on_approve" },
        { upstreamTaskKey: "c", downstreamTaskKey: "d", gateType: "on_complete" },
      ];
      expect(countUpstreamGates("c", gates)).toBe(2);
      expect(countUpstreamGates("d", gates)).toBe(1);
      expect(countUpstreamGates("a", gates)).toBe(0);
    });
  });

  describe("detectCycle", () => {
    it("returns null for acyclic graph", () => {
      const gates: WorkflowTemplateGate[] = [
        { upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" },
        { upstreamTaskKey: "b", downstreamTaskKey: "c", gateType: "on_complete" },
      ];
      expect(detectCycle(gates)).toBeNull();
    });

    it("detects a simple cycle", () => {
      const gates: WorkflowTemplateGate[] = [
        { upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" },
        { upstreamTaskKey: "b", downstreamTaskKey: "a", gateType: "on_complete" },
      ];
      const cycle = detectCycle(gates);
      expect(cycle).not.toBeNull();
      expect(cycle!.length).toBeGreaterThanOrEqual(2);
    });

    it("detects a longer cycle", () => {
      const gates: WorkflowTemplateGate[] = [
        { upstreamTaskKey: "a", downstreamTaskKey: "b", gateType: "on_complete" },
        { upstreamTaskKey: "b", downstreamTaskKey: "c", gateType: "on_complete" },
        { upstreamTaskKey: "c", downstreamTaskKey: "a", gateType: "on_complete" },
      ];
      const cycle = detectCycle(gates);
      expect(cycle).not.toBeNull();
    });

    it("returns null for empty gates", () => {
      expect(detectCycle([])).toBeNull();
    });
  });

  describe("validateWorkflow", () => {
    const tasks: TaskTemplateEntry[] = [
      { key: "build", title: "Build" },
      { key: "test", title: "Test" },
      { key: "deploy", title: "Deploy" },
    ];

    it("returns no messages for a valid workflow", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_complete" },
          { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
        ],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(messages).toHaveLength(0);
    });

    it("detects dangling upstream reference", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: "nonexistent", downstreamTaskKey: "test", gateType: "on_complete" },
        ],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(messages.some((m) => m.severity === "error" && m.text.includes("nonexistent"))).toBe(
        true,
      );
    });

    it("detects dangling downstream reference", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [{ upstreamTaskKey: "build", downstreamTaskKey: "ghost", gateType: "on_complete" }],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(messages.some((m) => m.severity === "error" && m.text.includes("ghost"))).toBe(true);
    });

    it("detects duplicate keys", () => {
      const dupedTasks: TaskTemplateEntry[] = [
        { key: "build", title: "Build A" },
        { key: "build", title: "Build B" },
      ];
      const workflow: WorkflowTemplateDefinition = { gates: [] };
      const messages = validateWorkflow(dupedTasks, workflow);
      expect(
        messages.some((m) => m.severity === "error" && m.text.includes("share key 'build'")),
      ).toBe(true);
    });

    it("warns about missing join spec on multi-gate task", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "deploy", gateType: "on_complete" },
          { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
        ],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(
        messages.some(
          (m) =>
            m.severity === "warning" && m.text.includes("'deploy'") && m.text.includes("all_of"),
        ),
      ).toBe(true);
    });

    it("does not warn when join spec is present", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "deploy", gateType: "on_complete" },
          { upstreamTaskKey: "test", downstreamTaskKey: "deploy", gateType: "on_approve" },
        ],
        joinSpecs: { deploy: { mode: "any_of" } },
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(
        messages.filter((m) => m.severity === "warning" && m.text.includes("join spec")),
      ).toHaveLength(0);
    });

    it("warns about unreachable tasks when gates exist", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [{ upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_complete" }],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(
        messages.some(
          (m) =>
            m.severity === "warning" &&
            m.text.includes("'deploy'") &&
            m.text.includes("not part of the workflow"),
        ),
      ).toBe(true);
    });

    it("does not warn about unreachable tasks when no gates exist", () => {
      const workflow: WorkflowTemplateDefinition = { gates: [] };
      const messages = validateWorkflow(tasks, workflow);
      expect(
        messages.filter(
          (m) => m.severity === "warning" && m.text.includes("not part of the workflow"),
        ),
      ).toHaveLength(0);
    });

    it("detects cycles as errors", () => {
      const workflow: WorkflowTemplateDefinition = {
        gates: [
          { upstreamTaskKey: "build", downstreamTaskKey: "test", gateType: "on_complete" },
          { upstreamTaskKey: "test", downstreamTaskKey: "build", gateType: "on_complete" },
        ],
      };
      const messages = validateWorkflow(tasks, workflow);
      expect(messages.some((m) => m.severity === "error" && m.text.includes("cycle"))).toBe(true);
    });
  });
});
