import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as timeTrackingService from "./timeTrackingService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { Agent, AgentStatus, Task } from "../models/index.js";
import { logger } from "../lib/logger.js";

/**
 * Creates a new {@link Agent} and returns it with a freshly generated
 * plaintext API key.
 */
export function createAgent(input: Parameters<typeof agentRepo.createAgent>[0]): {
  agent: Omit<Agent, "apiKeyHash">;
  plainApiKey: string;
} {
  const result = agentRepo.createAgent(input);
  return result;
}

/**
 * Returns the {@link Agent} with the given id, or `null` if no such agent exists.
 */
export function getAgent(agentId: string): Omit<Agent, "apiKeyHash"> | null {
  return agentRepo.getAgentById(agentId);
}

/**
 * Lists all {@link Agent}s, optionally filtered by `status` and `domain`.
 */
export function listAgents(status?: string, domain?: string): Omit<Agent, "apiKeyHash">[] {
  const agents = agentRepo.listAgents();
  return agents.filter((a) => {
    if (status && a.status !== status) return false;
    if (domain && a.domain !== domain) return false;
    return true;
  });
}

/**
 * Lists {@link Agent}s with their current {@link Task} title joined in, applying
 * the same `status`/`domain` filters as {@link listAgents}.
 */
export function listAgentsWithTasks(
  status?: string,
  domain?: string,
): {
  agent: Omit<Agent, "apiKeyHash">;
  currentTaskTitle: string | null;
}[] {
  const agents = listAgents(status, domain);
  const taskIds = [...new Set(agents.filter((a) => a.currentTaskId).map((a) => a.currentTaskId!))];
  const taskMap = new Map<string, string>();
  for (const taskId of taskIds) {
    const task = taskRepo.getTaskById(taskId);
    if (task) taskMap.set(taskId, task.title);
  }
  return agents.map((agent) => ({
    agent,
    currentTaskTitle: agent.currentTaskId ? (taskMap.get(agent.currentTaskId) ?? null) : null,
  }));
}

/**
 * Updates an {@link Agent} and returns the updated record. Publishes an
 * `agent.status_changed` SSE event on the `global` channel when the agent's
 * status field actually changes.
 */
export function updateAgent(
  agentId: string,
  input: Parameters<typeof agentRepo.updateAgent>[1],
): Omit<Agent, "apiKeyHash"> | null {
  const current = agentRepo.getAgentById(agentId);
  const agent = agentRepo.updateAgent(agentId, input);

  if (agent && current && agent.status !== current.status) {
    sseBroadcaster.publish("global", {
      type: "agent.status_changed",
      data: { agentId, status: agent.status },
    });
  }

  return agent;
}

/**
 * Deletes an {@link Agent} and, if the agent currently holds one, releases its
 * {@link Task} with reason `system`.
 */
export function deleteAgent(agentId: string): void {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) return;

  if (agent.currentTaskId) {
    taskRepo.releaseTask(agent.currentTaskId, "system");
  }

  agentRepo.deleteAgent(agentId);
}

/**
 * Records a heartbeat for an agent and, when a `taskId` is supplied and that
 * {@link Task} is in `claimed` or `in_progress` state, records 5 minutes of
 * work time tracking. Publishes an `agent.heartbeat` SSE event on the `global`
 * channel and returns the agent's current {@link AgentStatus} along with a
 * fixed 300s next-check-in hint.
 */
export function heartbeat(
  agentId: string,
  taskId?: string,
): { status: AgentStatus; nextCheckIn: number; taskStatus: string | null } | null {
  const agent = agentRepo.heartbeat(agentId, taskId);
  if (!agent) return null;

  sseBroadcaster.publish("global", {
    type: "agent.heartbeat",
    data: { agentId, taskId: taskId ?? null },
  });

  let taskStatus: string | null = null;
  if (taskId) {
    const task = taskRepo.getTaskById(taskId);
    taskStatus = task?.status ?? null;

    if (task && (task.status === "in_progress" || task.status === "claimed")) {
      try {
        timeTrackingService.recordWork(taskId, agentId, 5, task.status);
      } catch (err) {
        logger.warn({ err, taskId, agentId }, "Failed to record work during heartbeat");
      }
    }
  }

  return {
    status: agent.status,
    nextCheckIn: 300,
    taskStatus,
  };
}

/**
 * Resolves the {@link Agent} that owns the given plaintext API key, or `null`
 * if no match.
 */
export function getAgentByApiKey(plainKey: string): Omit<Agent, "apiKeyHash"> | null {
  return agentRepo.getAgentByApiKey(plainKey);
}

/**
 * Returns the {@link Agent} together with its current {@link Task} in a single
 * call, or `null` if the agent does not exist.
 */
export function getAgentWithTask(agentId: string): {
  agent: Omit<Agent, "apiKeyHash">;
  currentTask: Task | null;
} | null {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) return null;

  const currentTask = agent.currentTaskId ? taskRepo.getTaskById(agent.currentTaskId) : null;
  return { agent, currentTask };
}

/**
 * Marks agents that have not checked in within `thresholdMinutes` as `offline`
 * and releases their current {@link Task} with reason `stale_timeout`. Publishes
 * `agent.status_changed`, `task.released`, and `task.updated` SSE events as
 * appropriate.
 */
export function releaseStaleTasks(thresholdMinutes = 30): void {
  const staleAgents = agentRepo.getStaleAgents(thresholdMinutes);

  for (const agent of staleAgents) {
    agentRepo.setAgentOffline(agent.id);

    sseBroadcaster.publish("global", {
      type: "agent.status_changed",
      data: { agentId: agent.id, status: "offline" },
    });

    if (agent.currentTaskId) {
      const task = taskRepo.releaseTask(agent.currentTaskId, "stale_timeout");
      if (task) {
        const habitatId = getHabitatIdForTask(task.id);
        if (habitatId) {
          sseBroadcaster.publish(habitatId, {
            type: "task.released",
            data: { taskId: task.id, reason: "stale_timeout" },
          });
          sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
        }
      }
    }
  }
}
