import { describe, it, expect } from "vitest";
import * as habitat from "../../tools/habitat.js";
import * as lifecycleGaps from "../../tools/lifecycle-gaps.js";
import { HABITAT_DISPATCH_TOOL, HABITAT_ACTIONS } from "../../tools/habitat-dispatch.js";

describe("HABITAT_DISPATCH_TOOL", () => {
  it("has the correct name", () => {
    expect(HABITAT_DISPATCH_TOOL.name).toBe("orcy_habitat");
  });

  it("includes all actions in the enum", () => {
    const actionProp = HABITAT_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      "list",
      "find",
      "get-settings",
      "update-settings",
      "summary",
      "metrics",
      "get-health",
      "get-health-history",
      "predictions",
      "bottlenecks",
      "agent-quality",
      "get-rules",
      "update-rules",
      "evaluate-rules",
    ]);
  });

  it("requires action", () => {
    expect(HABITAT_DISPATCH_TOOL.inputSchema.required).toContain("action");
  });
});

describe("HABITAT_ACTIONS", () => {
  it("routes list to habitatListHabitats", () => {
    expect(HABITAT_ACTIONS["list"]).toBe(habitat.habitatListHabitats);
  });

  it("routes find to habitatFind", () => {
    expect(HABITAT_ACTIONS["find"]).toBe(habitat.habitatFind);
  });

  it("routes get-settings to habitatGetSettings", () => {
    expect(HABITAT_ACTIONS["get-settings"]).toBe(habitat.habitatGetSettings);
  });

  it("routes update-settings to habitatUpdateSettings", () => {
    expect(HABITAT_ACTIONS["update-settings"]).toBe(habitat.habitatUpdateSettings);
  });

  it("routes summary to habitatGetSummary", () => {
    expect(HABITAT_ACTIONS["summary"]).toBe(habitat.habitatGetSummary);
  });

  it("routes metrics to habitatGetMetrics", () => {
    expect(HABITAT_ACTIONS["metrics"]).toBe(lifecycleGaps.habitatGetMetrics);
  });

  it("routes predictions to habitatGetPredictions", () => {
    expect(HABITAT_ACTIONS["predictions"]).toBe(habitat.habitatGetPredictions);
  });

  it("routes bottlenecks to habitatGetBottlenecks", () => {
    expect(HABITAT_ACTIONS["bottlenecks"]).toBe(habitat.habitatGetBottlenecks);
  });

  it("routes agent-quality to habitatGetAgentQuality", () => {
    expect(HABITAT_ACTIONS["agent-quality"]).toBe(habitat.habitatGetAgentQuality);
  });

  it("routes get-rules to habitatGetRules", () => {
    expect(HABITAT_ACTIONS["get-rules"]).toBe(habitat.habitatGetRules);
  });

  it("routes update-rules to habitatUpdateRules", () => {
    expect(HABITAT_ACTIONS["update-rules"]).toBe(habitat.habitatUpdateRules);
  });

  it("routes evaluate-rules to habitatEvaluateRules", () => {
    expect(HABITAT_ACTIONS["evaluate-rules"]).toBe(habitat.habitatEvaluateRules);
  });

  it("has exactly 14 actions", () => {
    expect(Object.keys(HABITAT_ACTIONS)).toHaveLength(14);
  });

  it("every action maps to a function", () => {
    for (const handler of Object.values(HABITAT_ACTIONS)) {
      expect(typeof handler).toBe("function");
    }
  });
});
