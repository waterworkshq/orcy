import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { learningListAccepted, learningGetFinding } from "./learning.js";

/**
 * MCP {@link Tool} descriptor for the `orcy_learning` dispatch tool — a
 * read-only contextual knowledge surface backed by the Learning Loop
 * accepted-finding ledger. Exposes ONLY `list_accepted` and `get` actions.
 * No mutating action (review, promotion, run) is available.
 *
 * Both actions require `habitatId` + active `taskId`. The repository
 * actor-bound predicate is the sole authorization authority — the MCP layer
 * does NOT recreate it. Filters narrow the authorized result only.
 */
export const LEARNING_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_learning",
  description:
    "Read-only contextual knowledge from accepted Learning Loop findings. " +
    "Returns bounded summaries scoped to your active task — subject/body excerpt, " +
    "finding type, confidence, sample size, caveats, citation count, and revision. " +
    "Both actions require an active taskId and return only findings scoped to that " +
    "task's context (exact task, mission, or domain scope match). " +
    "This is contextual knowledge, not authoritative task mutation. " +
    'Use action="list_accepted" to browse findings or action="get" to read one finding by ID.',
  actions: ["list_accepted", "get"],
  sharedParams: {
    habitatId: {
      type: "string",
      description: "Habitat UUID (required for every action)",
    },
    taskId: {
      type: "string",
      description:
        "The UUID of your currently claimed/in-progress/submitted task. Required for every action — findings are scoped to this task's context.",
    },
    findingId: {
      type: "string",
      description: "Finding UUID — required for action=get",
    },
    findingType: {
      type: "string",
      enum: ["lesson", "convention", "risk", "anomaly", "rule_recommendation", "knowledge_draft"],
      description: "Narrow list_accepted to a specific finding type (optional)",
    },
    maxAgeSeconds: {
      type: "number",
      description: "Exclude findings older than this many seconds (optional, list_accepted only)",
    },
    limit: {
      type: "number",
      description: "Maximum findings to return (default 10, hard cap 25, list_accepted only)",
    },
    maxChars: {
      type: "number",
      description:
        "Server-owned total character budget for subject+body combined (default 4000, hard max 8000, list_accepted only)",
    },
  },
});

/** Action-name → {@link Handler} map routing each learning operation to its client implementation. */
export const LEARNING_ACTIONS: Record<string, Handler> = {
  list_accepted: learningListAccepted,
  get: learningGetFinding,
};

/** Per-action required parameters, validated by {@link createDispatchHandler} before the handler runs. */
export const LEARNING_REQUIRED_PARAMS: Record<string, string[]> = {
  list_accepted: ["habitatId", "taskId"],
  get: ["habitatId", "taskId", "findingId"],
};

/**
 * Top-level {@link ToolHandler} that routes incoming `orcy_learning` MCP calls
 * to the matching action handler.
 */
export const LEARNING_DISPATCH_HANDLER = createDispatchHandler(
  LEARNING_ACTIONS,
  LEARNING_REQUIRED_PARAMS,
);
