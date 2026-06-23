import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { SKILL_CATEGORIES } from "@orcy/shared";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { habitatSkillGet, habitatSkillRefresh, habitatSkillContribute } from "./habitat-skill.js";

/** MCP {@link Tool} descriptor registering the `orcy_habitat_skill` tool surface. */
export const HABITAT_SKILL_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_habitat_skill",
  description:
    "Habitat skill — the living knowledge document that grows as agents work. Read accumulated knowledge (conventions, patterns, pitfalls) before starting work on a habitat.",
  actions: ["get", "refresh", "contribute"],
  sharedParams: {
    boardId: { type: "string", description: "The UUID of the Orcy habitat" },
    insight: { type: "string", description: "The insight text to add (contribute action)" },
    skillCategory: {
      type: "string",
      enum: [...SKILL_CATEGORIES],
      description: "Derived category for the contributed insight (contribute action, optional)",
    },
  },
});

/** Map of MCP action name (e.g. `get`, `refresh`, `contribute`) to the corresponding {@link Handler}. */
export const HABITAT_SKILL_ACTIONS: Record<string, Handler> = {
  get: habitatSkillGet,
  refresh: habitatSkillRefresh,
  contribute: habitatSkillContribute,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_habitat_skill` calls to their action handler. */
export const HABITAT_SKILL_DISPATCH_HANDLER = createDispatchHandler(HABITAT_SKILL_ACTIONS);
