import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  triageInvestigate,
  triageTopIssues,
  triageResolutionLookup,
  triageInsertDeferredMission,
} from "./triage.js";

/** MCP {@link Tool} descriptor registering the `orcy_triage` tool surface. */
export const TRIAGE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_triage",
  description:
    "Triage investigation surface — investigate signal clusters, check top issues, " +
    "look up historical resolutions, and insert deferred corrective missions into the " +
    'roadmap DAG. Use action="top_issues" to list the highest-signal unresolved clusters ' +
    'in a habitat. Use action="investigate" with a clusterKey to pull full cluster context ' +
    "(findings, affected tasks, agent IDs, historical resolution, roadmap DAG) for an " +
    'in-progress investigation. Use action="resolution_lookup" with a clusterKey to retrieve ' +
    'prior resolutions for a recurring pain point. Use action="insert_deferred_mission" to ' +
    "create a gated corrective mission positioned in the DAG and link it to a finding " +
    "(bootstrapping path, ADR-0033). All actions are habitat-scoped (habitatId required).",
  actions: ["investigate", "top_issues", "resolution_lookup", "insert_deferred_mission"],
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
    findingId: {
      type: "string",
      description:
        "Finding triage record id — required for insert_deferred_mission (links the new mission to this finding)",
    },
    missionTitle: {
      type: "string",
      description:
        "Title for the deferred corrective mission — required for insert_deferred_mission",
    },
    missionDescription: {
      type: "string",
      description: "Optional description body for the deferred corrective mission",
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description:
        "Mission IDs the inserted mission depends on (positions it after the in-flight work it corrects)",
    },
    releaseGateType: {
      type: "string",
      enum: ["patch", "minor", "major"],
      description:
        "Release-class gate that must be satisfied for the mission to become actionable — required for insert_deferred_mission",
    },
    releaseGateVersion: {
      type: "string",
      description:
        'Optional version-pin gate (e.g. "v0.25" or "v0.25.0") — either-match semantics with releaseGateType',
    },
  },
  requiredFor: {
    investigate: ["habitatId", "clusterKey"],
    top_issues: ["habitatId"],
    resolution_lookup: ["habitatId", "clusterKey"],
    insert_deferred_mission: ["habitatId", "findingId", "missionTitle", "releaseGateType"],
  },
});

/** Map of MCP action name to the corresponding triage {@link Handler}. */
export const TRIAGE_ACTIONS: Record<string, Handler> = {
  investigate: triageInvestigate,
  top_issues: triageTopIssues,
  resolution_lookup: triageResolutionLookup,
  insert_deferred_mission: triageInsertDeferredMission,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_triage` calls to their action handler. */
export const TRIAGE_DISPATCH_HANDLER = createDispatchHandler(TRIAGE_ACTIONS, {
  investigate: ["habitatId", "clusterKey"],
  top_issues: ["habitatId"],
  resolution_lookup: ["habitatId", "clusterKey"],
  insert_deferred_mission: ["habitatId", "findingId", "missionTitle", "releaseGateType"],
});
