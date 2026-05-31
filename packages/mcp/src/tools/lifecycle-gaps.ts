import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";

export const BOARD_GET_TASK_TIME_REPORT_TOOL: Tool = {
  name: "board_get_task_time_report",
  description:
    "Get detailed time tracking report for a task. Returns estimated vs actual time, " +
    "cycle time, lead time, estimation accuracy, and heartbeat history.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
    },
    required: ["taskId"],
  },
};

export async function habitatGetTaskTimeReport(client: KanbanApiClient, args: { taskId: string }) {
  return client.getTaskTimeReport(args.taskId);
}

export const BOARD_GET_METRICS_TOOL: Tool = {
  name: "board_get_metrics",
  description:
    "Get aggregate performance metrics for a board. Returns average cycle time, " +
    "estimation accuracy, overdue tasks, on-time completion rate, and per-agent metrics.",
  inputSchema: {
    type: "object",
    properties: {
      boardId: {
        type: "string",
        description: "The UUID of the board",
      },
    },
    required: ["boardId"],
  },
};

export async function habitatGetMetrics(client: KanbanApiClient, args: { boardId: string }) {
  return client.getHabitatMetrics(args.boardId);
}

export const BOARD_GET_TASK_BLOCKED_STATUS_TOOL: Tool = {
  name: "board_get_task_blocked_status",
  description:
    "Check if a task is blocked by incomplete dependencies. Returns blocked status, " +
    "blocking dependencies, and tasks that this task is blocking.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
    },
    required: ["taskId"],
  },
};

export async function habitatGetTaskBlockedStatus(
  client: KanbanApiClient,
  args: { taskId: string },
) {
  return client.getTaskBlockedStatus(args.taskId);
}

export const BOARD_ADD_TASK_DEPENDENCY_TOOL: Tool = {
  name: "board_add_task_dependency",
  description:
    "Add a dependency to a task. The task cannot be completed until the dependency is done. " +
    "Prevents circular dependencies.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task that has the dependency",
      },
      dependsOnTaskId: {
        type: "string",
        description: "The UUID of the task that must be completed first",
      },
    },
    required: ["taskId", "dependsOnTaskId"],
  },
};

export async function habitatAddTaskDependency(
  client: KanbanApiClient,
  args: { taskId: string; dependsOnTaskId: string },
) {
  return client.addTaskDependency(args.taskId, args.dependsOnTaskId);
}

export const BOARD_REMOVE_TASK_DEPENDENCY_TOOL: Tool = {
  name: "board_remove_task_dependency",
  description: "Remove a dependency from a task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
      dependencyTaskId: {
        type: "string",
        description: "The UUID of the dependency to remove",
      },
    },
    required: ["taskId", "dependencyTaskId"],
  },
};

export async function habitatRemoveTaskDependency(
  client: KanbanApiClient,
  args: { taskId: string; dependencyTaskId: string },
) {
  return client.removeTaskDependency(args.taskId, args.dependencyTaskId);
}

export const BOARD_GET_TASK_QUALITY_CHECKLIST_TOOL: Tool = {
  name: "board_get_task_quality_checklist",
  description:
    "Get the quality checklist for a task. Returns overall status, individual checklist " +
    "categories (code review, testing, documentation, deployment), and completion progress.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
    },
    required: ["taskId"],
  },
};

export async function habitatGetTaskQualityChecklist(
  client: KanbanApiClient,
  args: { taskId: string },
) {
  return client.getTaskQualityChecklist(args.taskId);
}

export const BOARD_UPDATE_QUALITY_CHECKLIST_ITEM_TOOL: Tool = {
  name: "board_update_quality_checklist_item",
  description:
    "Update a quality checklist item. Mark items as completed, add evidence URLs, or add notes.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
      checklistId: {
        type: "string",
        description: "The UUID of the quality checklist",
      },
      itemId: {
        type: "string",
        description: "The UUID of the checklist item to update",
      },
      isCompleted: {
        type: "boolean",
        description: "Whether the item is completed",
      },
      evidenceUrl: {
        type: "string",
        description: "URL to evidence (e.g., CI build, PR link)",
      },
      notes: {
        type: "string",
        description: "Notes about the completion",
      },
    },
    required: ["taskId", "checklistId", "itemId"],
  },
};

export async function habitatUpdateQualityChecklistItem(
  client: KanbanApiClient,
  args: {
    taskId: string;
    checklistId: string;
    itemId: string;
    isCompleted?: boolean;
    evidenceUrl?: string;
    notes?: string;
  },
) {
  const input: { isCompleted?: boolean; evidenceUrl?: string; notes?: string } = {};
  if (args.isCompleted !== undefined) input.isCompleted = args.isCompleted;
  if (args.evidenceUrl !== undefined) input.evidenceUrl = args.evidenceUrl;
  if (args.notes !== undefined) input.notes = args.notes;
  return client.updateQualityChecklistItem(args.taskId, args.checklistId, args.itemId, input);
}

export const BOARD_VALIDATE_QUALITY_GATES_TOOL: Tool = {
  name: "board_validate_quality_gates",
  description:
    "Validate all quality gates for a task. Returns whether the task passes all required " +
    "quality checks and lists any missing requirements.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
    },
    required: ["taskId"],
  },
};

export async function habitatValidateQualityGates(
  client: KanbanApiClient,
  args: { taskId: string },
) {
  return client.validateQualityGates(args.taskId);
}

export const BOARD_GET_TASK_APPROVAL_STATUS_TOOL: Tool = {
  name: "board_get_task_approval_status",
  description:
    "Get the detailed approval status for a task. Checks quality gates, dependency completion, " +
    "and time tracking to determine if a task can be approved.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task",
      },
    },
    required: ["taskId"],
  },
};

export async function habitatGetTaskApprovalStatus(
  client: KanbanApiClient,
  args: { taskId: string },
) {
  return client.getTaskApprovalStatus(args.taskId);
}

export async function habitatLogEffort(
  client: KanbanApiClient,
  args: { taskId: string; minutes: number; note?: string; startedAt?: string; endedAt?: string },
) {
  return client.logEffort(args.taskId, args.minutes, args.note, args.startedAt, args.endedAt);
}

export async function habitatListEffort(
  client: KanbanApiClient,
  args: { taskId: string; includeCorrections?: boolean },
) {
  return client.listEffortEntries(args.taskId, args.includeCorrections);
}

export async function habitatGetEffortReport(client: KanbanApiClient, args: { taskId: string }) {
  return client.getEffortReport(args.taskId);
}

export async function habitatCorrectEffortEntry(
  client: KanbanApiClient,
  args: {
    taskId: string;
    entryId: string;
    minutesDelta: number;
    correctionReason: string;
    note?: string;
  },
) {
  return client.correctEffortEntry(
    args.taskId,
    args.entryId,
    args.minutesDelta,
    args.correctionReason,
    args.note,
  );
}
