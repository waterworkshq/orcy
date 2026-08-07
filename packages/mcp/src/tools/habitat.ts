import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";
import type { HabitatListItem } from "@orcy/shared";
import { TIME_RANGES } from "./constants.js";

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_LIST_HABITATS_TOOL: Tool = {
  name: "habitat_list_habitats",
  description:
    "List all available Orcy habitats. Use this to discover habitat IDs before listing missions " +
    "or creating new missions. Returns all habitats with their IDs, names, and descriptions.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatListHabitats(client: KanbanApiClient, _args: Record<string, never>) {
  const result = await client.listHabitats();
  return {
    habitats: result.habitats.map(
      (b): HabitatListItem => ({ id: b.id, name: b.name, description: b.description }),
    ),
  };
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_FIND_TOOL: Tool = {
  name: "habitat_find",
  description:
    "Find a habitat by name. Searches all habitats and returns matching ones with their IDs. " +
    "Use this when a user refers to a habitat by name instead of ID. " +
    "Performs case-insensitive partial matching on habitat names.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The habitat name or partial name to search for",
      },
    },
    required: ["name"],
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatFind(client: KanbanApiClient, args: { name: string }) {
  const result = await client.listHabitats(args.name);
  return {
    habitats: result.habitats.map(
      (b): HabitatListItem => ({ id: b.id, name: b.name, description: b.description }),
    ),
  };
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_GET_HABITAT_TOOL: Tool = {
  name: "habitat_get_habitat",
  description:
    "Get the settings and metadata for an Orcy habitat. " +
    "Returns habitat name, description, columns, and other configuration.",
  inputSchema: {
    type: "object",
    properties: {
      habitatId: {
        type: "string",
        description: "The UUID of the Orcy habitat",
      },
    },
    required: ["habitatId"],
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetHabitat(client: KanbanApiClient, args: { habitatId: string }) {
  return client.getHabitat(args.habitatId);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_GET_SUMMARY_TOOL: Tool = {
  name: "habitat_get_summary",
  description:
    "Get a temporal summary of habitat activity — what was done, by whom, when, and in what order. " +
    "Returns a compact digest with task lifecycle narratives, metrics, and current habitat state. " +
    "Use this FIRST when you need to understand what work has been done in a habitat, " +
    "instead of listing and inspecting missions individually. " +
    "Each task narrative shows the full lifecycle: Created → Claimed → Started → Submitted → Approved/Rejected → Done. " +
    "The digest field contains a pre-formatted markdown summary ready for context.",
  inputSchema: {
    type: "object",
    properties: {
      habitatId: {
        type: "string",
        description: "The UUID of the Orcy habitat",
      },
      since: {
        type: "string",
        enum: [...TIME_RANGES],
        description: "Time range for activity (default: 7d)",
      },
      maxTasks: {
        type: "number",
        description: "Maximum number of task narratives to return (default: 20, max: 50)",
        minimum: 1,
        maximum: 50,
      },
      includeDigest: {
        type: "boolean",
        description: "Whether to include the pre-formatted markdown digest (default: true)",
      },
    },
    required: ["habitatId"],
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetSummary(
  client: KanbanApiClient,
  args: {
    habitatId: string;
    since?: "24h" | "7d" | "30d" | "all";
    maxTasks?: number;
    includeDigest?: boolean;
  },
) {
  return client.getHabitatSummary(args.habitatId, {
    since: args.since,
    maxTasks: args.maxTasks,
    includeDigest: args.includeDigest,
  });
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_GET_HEALTH_TOOL: Tool = {
  name: "habitat_get_health",
  description:
    "Get the current board health score (0-100) with a breakdown across 5 dimensions: flow, quality, delivery, capacity, and stability. Includes A-F grade and actionable recommendations.",
  inputSchema: {
    type: "object",
    properties: {
      habitatId: {
        type: "string",
        description: "The UUID of the Orcy habitat",
      },
    },
    required: ["habitatId"],
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetHealth(client: KanbanApiClient, args: { habitatId: string }) {
  return client.getHabitatHealth(args.habitatId);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export const HABITAT_GET_HEALTH_HISTORY_TOOL: Tool = {
  name: "habitat_get_health_history",
  description:
    "Get board health history over time. Returns snapshots with scores for trend tracking.",
  inputSchema: {
    type: "object",
    properties: {
      habitatId: {
        type: "string",
        description: "The UUID of the Orcy habitat",
      },
      days: {
        type: "number",
        description: "Number of days of history to return (default: 30, max: 365)",
        minimum: 1,
        maximum: 365,
      },
    },
    required: ["habitatId"],
  },
};

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetHealthHistory(
  client: KanbanApiClient,
  args: { habitatId: string; days?: number },
) {
  return client.getHabitatHealthHistory(args.habitatId, args.days);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetPredictions(client: KanbanApiClient, args: { habitatId: string }) {
  const predictions = await client.getHabitatPredictions(args.habitatId);
  return {
    habitatId: args.habitatId,
    velocity: predictions.velocity,
    forecasts: predictions.forecasts,
    atRiskTasks: predictions.atRiskTasks,
  };
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetBottlenecks(
  client: KanbanApiClient,
  args: { habitatId: string; days?: number },
) {
  const result = await client.getHabitatBottlenecks(args.habitatId, args.days);
  return {
    habitatId: args.habitatId,
    days: result.days,
    bottlenecks: result.bottlenecks,
    warnings: result.warnings,
  };
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetAgentQuality(client: KanbanApiClient, args: { habitatId: string }) {
  return client.getHabitatAgentQuality(args.habitatId);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatGetRules(client: KanbanApiClient, args: { habitatId: string }) {
  return client.getPrioritizationRules(args.habitatId);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatUpdateRules(
  client: KanbanApiClient,
  args: { habitatId: string; rules: Record<string, unknown> },
) {
  return client.updatePrioritizationRules(args.habitatId, args.rules);
}

/**
 * @requires HabitatClient
 * @requires DashboardClient
 * @requires HealthClient
 */
export async function habitatEvaluateRules(client: KanbanApiClient, args: { habitatId: string }) {
  return client.evaluatePrioritizationRules(args.habitatId);
}
