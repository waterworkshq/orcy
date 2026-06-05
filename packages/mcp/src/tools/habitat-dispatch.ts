import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  habitatListHabitats,
  habitatFind,
  habitatGetSettings,
  habitatUpdateSettings,
  habitatGetSummary,
  habitatGetHealth,
  habitatGetHealthHistory,
  habitatGetPredictions,
  habitatGetBottlenecks,
  habitatGetAgentQuality,
  habitatGetRules,
  habitatUpdateRules,
  habitatEvaluateRules,
} from "./habitat.js";
import { habitatGetMetrics } from "./lifecycle-gaps.js";

export const HABITAT_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_habitat",
  description:
    "Board-level operations: list, find, get-settings, update-settings, summary, metrics, get-health, get-health-history, predictions, bottlenecks, agent-quality, get-rules, update-rules, evaluate-rules",
  actions: [
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
  ],
  sharedParams: {
    boardId: { type: "string", description: "The UUID of the Orcy habitat" },
    name: {
      type: "string",
      description: "Habitat name or partial name to search for (used with action=find)",
    },
    since: {
      type: "string",
      enum: ["24h", "7d", "30d", "all"],
      description: "Time range for activity summary (action=summary)",
    },
    maxTasks: {
      type: "number",
      description: "Maximum number of task narratives to return (action=summary)",
    },
    includeDigest: {
      type: "boolean",
      description: "Whether to include markdown digest (action=summary)",
    },
    days: {
      type: "number",
      description: "Number of days for analytics windows (action=bottlenecks)",
    },
    description: {
      type: "string",
      description: "Updated habitat description (action=update-settings)",
    },
    rules: {
      type: "object",
      description: "Prioritization settings to update (action=update-rules)",
    },
  },
});

export const HABITAT_ACTIONS: Record<string, Handler> = {
  list: habitatListHabitats,
  find: habitatFind,
  "get-settings": habitatGetSettings,
  "update-settings": habitatUpdateSettings,
  summary: habitatGetSummary,
  metrics: habitatGetMetrics,
  "get-health": habitatGetHealth,
  "get-health-history": habitatGetHealthHistory,
  predictions: habitatGetPredictions,
  bottlenecks: habitatGetBottlenecks,
  "agent-quality": habitatGetAgentQuality,
  "get-rules": habitatGetRules,
  "update-rules": habitatUpdateRules,
  "evaluate-rules": habitatEvaluateRules,
};

export const HABITAT_DISPATCH_HANDLER = createDispatchHandler(HABITAT_ACTIONS);
