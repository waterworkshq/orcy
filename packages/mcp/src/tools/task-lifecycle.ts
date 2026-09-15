import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { KanbanApiClient } from "../api.js";
import type { Task } from "@orcy/shared";
import { enrichTaskWithAgentName } from "./enrichment.js";
import { ARTIFACT_SCHEMA_FRAGMENT } from "./constants.js";

/**
 * @requires TaskClient
 */
export const BOARD_CLAIM_TASK_TOOL: Tool = {
  name: "board_claim_task",
  description:
    "Atomically claim a task for an agent. Only one agent can claim a task at a time. " +
    "Prerequisites: Call board_list_features and feature_get_context first to find available work. " +
    'After claiming, start work by calling board_start_task to transition the task to "in_progress". ' +
    "Failure reasons: already_claimed (try another task), not_found, domain_mismatch, capability_mismatch (missing required skills), dependencies_unmet, " +
    "mission_dependencies_unmet (a depended-on mission is not done), release_gate_unmet (task belongs to a release gate with no matching release), workflow_gates_unmet (workflow gates not satisfied). " +
    "Only one agent can claim a task at a time — concurrent claims are rejected.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task to claim",
      },
    },
    required: ["taskId"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatClaimTask(client: KanbanApiClient, args: { taskId: string }) {
  const result = await client.claimTask(args.taskId);
  if (!result.success) {
    return result;
  }
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

/**
 * @requires TaskClient
 */
export const BOARD_START_TASK_TOOL: Tool = {
  name: "board_start_task",
  description:
    'Start work on a task you own, transitioning it from "claimed" (or "rejected", for rework) to "in_progress". ' +
    "Call immediately after board_claim_task to begin work. Present the executionToken from your claim response, or from your successful rework start response after rejection. " +
    "On a REJECTED task, present your preserved claim token: the start mints a FRESH rework token Y in this call's response — capture Y from THIS response (never a task GET, never the old token) and use Y for submit/fail/release. " +
    "The task must be assigned to the calling agent.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the claimed (or rejected-for-rework) task to start",
      },
      executionToken: {
        type: "string",
        description:
          "executionToken from your claim response, or from your successful rework start response after rejection (task.executionToken); never a fresh task GET. Required on tokened tasks for start/submit/fail/release; omitted or wrong token returns 409 EPOCH_MISMATCH.",
      },
    },
    required: ["taskId"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatStartTask(
  client: KanbanApiClient,
  args: { taskId: string; executionToken?: string | null },
) {
  const result = await client.startTask(args.taskId, args.executionToken ?? null);
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

/**
 * @requires TaskClient
 */
export const BOARD_SUBMIT_TASK_TOOL: Tool = {
  name: "board_submit_task",
  description:
    "Submit completed work for human review. This is the correct endpoint for finished work. " +
    "Always include: (1) Clear result summary describing what was done, (2) Artifact links (PR, commits, files) if applicable, (3) executionToken from your claim response, or from your successful rework start response after rejection. " +
    "After submission, an assigned reviewer will either approve or reject it — a human reviewer or an agent holding a pending agent-typed reviewer row. " +
    "Check board_heartbeat to monitor status while waiting for review.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task to submit",
      },
      result: {
        type: "string",
        description: "Summary of what was accomplished (be specific about changes made)",
      },
      artifacts: {
        type: "array",
        items: ARTIFACT_SCHEMA_FRAGMENT,
        description: "Links to PRs, commits, files, screenshots, or logs",
      },
      executionToken: {
        type: "string",
        description:
          "executionToken from your claim response, or from your successful rework start response after rejection (task.executionToken); never a fresh task GET. Required on tokened tasks for start/submit/fail/release; omitted or wrong token returns 409 EPOCH_MISMATCH.",
      },
    },
    required: ["taskId", "result"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatSubmitTask(
  client: KanbanApiClient,
  args: {
    taskId: string;
    result: string;
    artifacts?: { type: string; url: string; description: string }[];
    executionToken?: string | null;
  },
) {
  return client.submitTask(
    args.taskId,
    args.result,
    args.artifacts as Task["artifacts"],
    args.executionToken ?? null,
  );
}

/**
 * @requires TaskClient
 */
export const BOARD_COMPLETE_TASK_TOOL: Tool = {
  name: "board_complete_task",
  description:
    "Agent self-approves their submitted task after reviewing the work. " +
    "Use AFTER calling board_get_task_context, board_get_task_comments, and board_get_task_events " +
    "to verify the work is complete and review any human feedback. " +
    "This bypasses human-in-the-loop review and moves the task directly to Done column. " +
    "Required when: (1) task was rejected and you fixed the issues, (2) you want to advance a submitted task to Done without waiting for human approval.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task to complete",
      },
      reviewNote: {
        type: "string",
        description: "Review note describing what was verified",
      },
      artifacts: {
        type: "array",
        items: ARTIFACT_SCHEMA_FRAGMENT,
        description: "Optional artifact links to attach at completion",
      },
    },
    required: ["taskId"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatCompleteTask(
  client: KanbanApiClient,
  args: {
    taskId: string;
    reviewNote?: string;
    artifacts?: { type: string; url: string; description: string }[];
  },
) {
  return client.completeTask(args.taskId, args.reviewNote, args.artifacts as Task["artifacts"]);
}

/**
 * Review decision — approve a submitted task (review authorization).
 * Token-free: admission is a human reviewer or a pending agent-typed
 * reviewer row (server-enforced); identity derives from the authenticated
 * caller. Does not run quality gates (reviewer override; `complete` does).
 * @requires TaskClient
 */
export async function habitatApproveTask(client: KanbanApiClient, args: { taskId: string }) {
  const result = await client.approveTask(args.taskId);
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

/**
 * Review decision — reject a submitted task back for rework (review
 * authorization). Token-free; same admission contract as approve.
 * `reason` is required (1–1000 chars).
 * @requires TaskClient
 */
export async function habitatRejectTask(
  client: KanbanApiClient,
  args: { taskId: string; reason: string },
) {
  const result = await client.rejectTask(args.taskId, args.reason);
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

/**
 * @requires TaskClient
 */
export const BOARD_RELEASE_TASK_TOOL: Tool = {
  name: "board_release_task",
  description:
    "Release a claimed task back to the pending pool. " +
    "Use when you cannot complete the task and need to return it to the queue. Present the executionToken from your claim response, or from your successful rework start response after rejection. " +
    "Always provide a clear reason: blocked_by_dependency, requires_domain_expertise, external_blocker, etc. " +
    "After releasing, call board_list_features to find alternative work.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task to release",
      },
      reason: {
        type: "string",
        description: "Why the task is being released",
      },
      executionToken: {
        type: "string",
        description:
          "executionToken from your claim response, or from your successful rework start response after rejection (task.executionToken); never a fresh task GET. Required on tokened tasks for start/submit/fail/release; omitted or wrong token returns 409 EPOCH_MISMATCH.",
      },
    },
    required: ["taskId", "reason"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatReleaseTask(
  client: KanbanApiClient,
  args: { taskId: string; reason: string; executionToken?: string | null },
) {
  return client.releaseTask(args.taskId, args.reason, args.executionToken ?? null);
}

/**
 * @requires TaskClient
 */
export const BOARD_RETRY_TASK_TOOL: Tool = {
  name: "board_retry_task",
  description:
    "Manually retry a failed task, resetting it to pending status so it can be reclaimed. " +
    "Use when a task has failed but the underlying issue has been resolved and you want to give it another attempt. " +
    "Only works on tasks currently in failed status.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the failed task to retry",
      },
    },
    required: ["taskId"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatRetryTask(client: KanbanApiClient, args: { taskId: string }) {
  return client.retryTask(args.taskId);
}

/**
 * @requires TaskClient
 */
export const BOARD_FAIL_TASK_TOOL: Tool = {
  name: "board_fail_task",
  description:
    "Mark a task as failed with a required reason. " +
    "Use when the task cannot be completed (blocked by external issue, missing prerequisites, " +
    "out of scope, etc.). Provide a clear failureReason describing what went wrong, and the executionToken from your claim response, or from your successful rework start response after rejection.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The UUID of the task to fail",
      },
      failureReason: {
        type: "string",
        description: "Why the task could not be completed (required)",
      },
      executionToken: {
        type: "string",
        description:
          "executionToken from your claim response, or from your successful rework start response after rejection (task.executionToken); never a fresh task GET. Required on tokened tasks for start/submit/fail/release; omitted or wrong token returns 409 EPOCH_MISMATCH.",
      },
    },
    required: ["taskId", "failureReason"],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatFailTask(
  client: KanbanApiClient,
  args: { taskId: string; failureReason: string; executionToken?: string | null },
) {
  const result = await client.failTask(
    args.taskId,
    args.failureReason,
    args.executionToken ?? null,
  );
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}
