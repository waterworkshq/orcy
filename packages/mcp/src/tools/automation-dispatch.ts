import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { listRules, getRule, simulateRule, listRuns, getRuleRuns } from "./automation.js";

export const AUTOMATION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_automation",
  description:
    "Automation operations (read/simulate/history-only): list, get, simulate, list_runs, get_rule_runs. No create/update/delete/enable/disable allowed.",
  actions: ["list", "get", "simulate", "list_runs", "get_rule_runs"],
  sharedParams: {
    boardId: { type: "string", description: "Habitat UUID (for list, list_runs)" },
    ruleId: {
      type: "string",
      description: "Automation rule UUID (for get, simulate, get_rule_runs)",
    },
    triggerEventId: { type: "string", description: "Trigger event ID for simulation" },
    targetType: { type: "string", description: "Target entity type for simulation" },
    targetId: { type: "string", description: "Target entity ID for simulation" },
    limit: { type: "number", description: "Max results (default 50)" },
    offset: { type: "number", description: "Pagination offset" },
  },
});

export const AUTOMATION_ACTIONS: Record<string, Handler> = {
  list: listRules,
  get: getRule,
  simulate: simulateRule,
  list_runs: listRuns,
  get_rule_runs: getRuleRuns,
};

export const AUTOMATION_DISPATCH_HANDLER = createDispatchHandler(AUTOMATION_ACTIONS);
