import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { habitatSuggestNextTask } from "./suggest.js";

/** MCP {@link Tool} descriptor registering the `orcy_suggest` tool surface. */
export const SUGGEST_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_suggest",
  description:
    "Suggest next task: recommend the next task for the calling agent based on skills, board state, and priority weighting",
  actions: ["suggest-next-task"],
  sharedParams: {
    boardId: { type: "string", description: "The UUID of the Orcy habitat" },
    limit: {
      type: "number",
      description: "Maximum number of suggestions to return (default: 3, max: 20)",
    },
  },
});

/** Map of MCP action name (e.g. `suggest-next-task`) to the corresponding {@link Handler}. */
export const SUGGEST_ACTIONS: Record<string, Handler> = {
  "suggest-next-task": habitatSuggestNextTask,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_suggest` calls to their action handler. */
export const SUGGEST_DISPATCH_HANDLER = createDispatchHandler(SUGGEST_ACTIONS);
