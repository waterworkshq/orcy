import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  listSprints,
  getActiveSprint,
  getSprint,
  getSprintMetrics,
  getSprintBurndown,
  getSprintCarryOver,
  createSprint,
  updateSprint,
  deleteSprint,
  startSprint,
  completeSprint,
  cancelSprint,
  addMissionToSprint,
  removeMissionFromSprint,
} from "./sprint.js";

/** MCP {@link Tool} descriptor registering the `orcy_sprint` tool surface. */
export const SPRINT_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_sprint",
  description:
    "Sprint operations: list, get, get_active, get_metrics, get_burndown, get_carry_over, create, update, delete, start, complete, cancel, add_mission, remove_mission",
  actions: [
    "list",
    "get",
    "get_active",
    "get_metrics",
    "get_burndown",
    "get_carry_over",
    "create",
    "update",
    "delete",
    "start",
    "complete",
    "cancel",
    "add_mission",
    "remove_mission",
  ],
  sharedParams: {
    boardId: { type: "string", description: "Habitat UUID (used with list, get_active, create)" },
    sprintId: {
      type: "string",
      description:
        "Sprint UUID (used with get, analytics, update, delete, start, complete, cancel, add_mission, remove_mission)",
    },
    missionId: {
      type: "string",
      description: "Mission UUID (used with add_mission, remove_mission)",
    },
    name: { type: "string", description: "Sprint name (used with create, update)" },
    goal: { type: "string", description: "Sprint goal description (used with create, update)" },
    startDate: { type: "string", description: "Start date ISO string (used with create, update)" },
    endDate: { type: "string", description: "End date ISO string (used with create, update)" },
    capacityMinutes: {
      type: "number",
      description: "Sprint capacity in minutes (used with create, update)",
    },
    notes: { type: "string", description: "Sprint notes (used with create, update)" },
  },
});

/** Map of MCP action name (e.g. `list`, `get`, `create`) to the corresponding {@link Handler}. */
export const SPRINT_ACTIONS: Record<string, Handler> = {
  list: listSprints,
  get: getSprint,
  get_active: getActiveSprint,
  get_metrics: getSprintMetrics,
  get_burndown: getSprintBurndown,
  get_carry_over: getSprintCarryOver,
  create: createSprint,
  update: updateSprint,
  delete: deleteSprint,
  start: startSprint,
  complete: completeSprint,
  cancel: cancelSprint,
  add_mission: addMissionToSprint,
  remove_mission: removeMissionFromSprint,
};

/** Top-level {@link ToolHandler} that resolves incoming `orcy_sprint` calls to their action handler. */
export const SPRINT_DISPATCH_HANDLER = createDispatchHandler(SPRINT_ACTIONS);
