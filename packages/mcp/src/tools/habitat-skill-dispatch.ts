import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { habitatSkillGet, habitatSkillRefresh, habitatSkillContribute } from "./habitat-skill.js";

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
      enum: ["convention", "pattern", "pitfall", "domain_knowledge", "agent_insight"],
      description: "Derived category for the contributed insight (contribute action, optional)",
    },
  },
});

export const HABITAT_SKILL_ACTIONS: Record<string, Handler> = {
  get: habitatSkillGet,
  refresh: habitatSkillRefresh,
  contribute: habitatSkillContribute,
};

export const HABITAT_SKILL_DISPATCH_HANDLER = createDispatchHandler(HABITAT_SKILL_ACTIONS);
