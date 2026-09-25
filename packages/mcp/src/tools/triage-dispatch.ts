import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  triageInvestigate,
  triageTopIssues,
  triageResolutionLookup,
  triageInsertDeferredMission,
  triageMapOrphanMission,
  triageSetFocusMission,
} from "./triage.js";

/** MCP {@link Tool} descriptor registering the `orcy_triage` tool surface. */
export const TRIAGE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_triage",
  description:
    "Triage investigation surface — investigate signal clusters, check top issues, " +
    "look up historical resolutions, insert deferred corrective missions into the " +
    "roadmap DAG, position orphan missions, and set the habitat focus goal. " +
    'Use action="top_issues" to list the highest-signal unresolved clusters ' +
    'in a habitat. Use action="investigate" with a clusterKey to pull full cluster context ' +
    "(findings, affected tasks, agent IDs, historical resolution, roadmap DAG) for an " +
    'in-progress investigation. Use action="resolution_lookup" with a clusterKey to retrieve ' +
    'prior resolutions for a recurring pain point. Use action="insert_deferred_mission" to ' +
    "route a finding to a deferred bucket through ONE atomic lifecycle command — the gated " +
    "corrective mission, its dependency placement, and the finding link commit together " +
    "(ADR-0048 restored lifecycle; authorized only for the agent currently claiming the " +
    'finding\'s admitted investigation task). Use action="map_orphan_mission" to position an ' +
    "existing orphan mission in the DAG (set its dependencies/gate) through the bounded " +
    "agent-owned triage route — authorized only for the agent currently claiming that " +
    "orphan's active investigation task in an unteamed habitat; paired with an " +
    'orphan-mission:{id} investigation. Use action="set_focus_mission" to designate ' +
    "the habitat's focus goal (or pass missionId=null to clear/auto-derive). " +
    "All actions are habitat-scoped (habitatId required); not all actions are read-only — " +
    "the three write actions are claim-bound server-side.",
  actions: [
    "investigate",
    "top_issues",
    "resolution_lookup",
    "insert_deferred_mission",
    "map_orphan_mission",
    "set_focus_mission",
  ],
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
      description:
        "Description body for the corrective mission — required for insert_deferred_mission",
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description:
        "Mission IDs the positioned mission depends on. insert_deferred_mission maps this to the " +
        "route command's `dependencies` (optional). map_orphan_mission REQUIRES it (at least one " +
        "same-habitat mission id to position after).",
    },
    releaseGateType: {
      type: "string",
      enum: ["patch", "minor", "major"],
      description:
        "Release-class gate — required for insert_deferred_mission (patch → defer_to_patch; minor/major → defer_to_release); optional for map_orphan_mission",
    },
    releaseGateVersion: {
      type: "string",
      description:
        'Version the gate waits on (e.g. "v0.25" or "v0.25.0") — required for insert_deferred_mission; optional for map_orphan_mission',
    },
    missionId: {
      type: "string",
      description:
        "Existing mission UUID to position — required for map_orphan_mission. For set_focus_mission, pass the mission to designate as the focus goal, or omit/null to clear (auto-derive).",
    },
    expectedVersion: {
      type: "number",
      description:
        "Optional map_orphan_mission mission version you observed; on mismatch the server refuses with the current version and no write",
    },
  },
});

/** Map of MCP action name to the corresponding triage {@link Handler}. */
export const TRIAGE_ACTIONS: Record<string, Handler> = {
  investigate: triageInvestigate,
  top_issues: triageTopIssues,
  resolution_lookup: triageResolutionLookup,
  insert_deferred_mission: triageInsertDeferredMission,
  map_orphan_mission: triageMapOrphanMission,
  set_focus_mission: triageSetFocusMission,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_triage` calls to their action handler. */
export const TRIAGE_DISPATCH_HANDLER = createDispatchHandler(TRIAGE_ACTIONS, {
  investigate: ["habitatId", "clusterKey"],
  top_issues: ["habitatId"],
  resolution_lookup: ["habitatId", "clusterKey"],
  insert_deferred_mission: [
    "habitatId",
    "findingId",
    "missionTitle",
    "missionDescription",
    "releaseGateType",
    "releaseGateVersion",
  ],
  map_orphan_mission: ["habitatId", "missionId"],
  set_focus_mission: ["habitatId"],
});
