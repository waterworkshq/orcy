import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import { triageInvestigate, triageTopIssues, triageResolutionLookup } from "./triage.js";

/** MCP {@link Tool} descriptor registering the `orcy_triage` tool surface. */
export const TRIAGE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_triage",
  description:
    "Triage investigation surface — investigate signal clusters, check top issues, and " +
    "look up historical resolutions before starting work in a domain. " +
    'Use action="top_issues" to list the highest-signal unresolved clusters in a habitat. ' +
    'Use action="investigate" with a clusterKey to pull full cluster context (findings, ' +
    "affected tasks, agent IDs, historical resolution) for an in-progress investigation. " +
    'Use action="resolution_lookup" with a clusterKey to retrieve prior resolutions for a ' +
    "recurring pain point. All actions are read-only and habitat-scoped (habitatId required).",
  actions: ["investigate", "top_issues", "resolution_lookup"],
  sharedParams: {
    habitatId: {
      type: "string",
      description: "Habitat UUID (required for every action)",
    },
    clusterKey: {
      type: "string",
      description:
        "Cluster key (normalized signal subject) — required for investigate and resolution_lookup",
    },
    limit: {
      type: "number",
      description: "Max clusters to return for top_issues (default 10)",
    },
  },
  requiredFor: {
    investigate: ["habitatId", "clusterKey"],
    top_issues: ["habitatId"],
    resolution_lookup: ["habitatId", "clusterKey"],
  },
});

/** Map of MCP action name to the corresponding triage {@link Handler}. */
export const TRIAGE_ACTIONS: Record<string, Handler> = {
  investigate: triageInvestigate,
  top_issues: triageTopIssues,
  resolution_lookup: triageResolutionLookup,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_triage` calls to their action handler. */
export const TRIAGE_DISPATCH_HANDLER = createDispatchHandler(TRIAGE_ACTIONS, {
  investigate: ["habitatId", "clusterKey"],
  top_issues: ["habitatId"],
  resolution_lookup: ["habitatId", "clusterKey"],
});
