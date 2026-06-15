import * as taskRepo from "../../repositories/task.js";
import * as agentRepo from "../../repositories/agent.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import * as watcherService from "../watcherService.js";
import * as missionService from "../featureService.js";
import type { Task } from "../../models/index.js";
import { validateAgentCapabilities } from "./helpers.js";
import { emitTransition } from "./transition-emitter.js";

/**
 * Delegates a claimed or in-progress {@link Task} from the assigned agent to
 * another agent, emitting a `delegated` transition on success.
 */
export function delegateTask(
  taskId: string,
  fromAgentId: string,
  toAgentId: string,
  reason?: string,
): { success: true; task: Task } | { success: false; reason: string; message: string } {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "not_found", message: "Task not found" };

  if (!task.assignedAgentId) {
    return {
      success: false,
      reason: "not_assigned",
      message: "Task must be claimed before delegation",
    };
  }

  if (task.assignedAgentId !== fromAgentId) {
    return {
      success: false,
      reason: "not_owner",
      message: "Only the assigned agent can delegate this task",
    };
  }

  if (fromAgentId === toAgentId) {
    return {
      success: false,
      reason: "self_delegation",
      message: "Cannot delegate a task to yourself",
    };
  }

  if (task.status !== "claimed" && task.status !== "in_progress") {
    return {
      success: false,
      reason: "invalid_status",
      message: `Task in status '${task.status}' cannot be delegated. Must be claimed or in_progress.`,
    };
  }

  const targetAgent = agentRepo.getAgentById(toAgentId);
  if (!targetAgent) {
    return { success: false, reason: "target_not_found", message: "Target agent not found" };
  }

  if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
    const missing = validateAgentCapabilities(
      targetAgent.capabilities || [],
      task.requiredCapabilities as string[],
    );
    if (missing.length > 0) {
      return {
        success: false,
        reason: "capability_mismatch",
        message: `Target agent lacks required capabilities: ${missing.join(", ")}`,
      };
    }
  }

  if (
    task.requiredDomain &&
    targetAgent.domain !== task.requiredDomain &&
    targetAgent.domain !== "fullstack"
  ) {
    return {
      success: false,
      reason: "domain_mismatch",
      message: `Target agent domain '${targetAgent.domain}' does not match required domain '${task.requiredDomain}'`,
    };
  }

  const result = taskRepo.updateTask(taskId, { delegatedToAgentId: toAgentId });
  if (!result.success)
    return { success: false, reason: "update_failed", message: "Failed to update task" };

  const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? "";

  emitTransition(taskId, "delegated", habitatId, {
    actorType: "agent",
    actorId: fromAgentId,
    fromAgentId,
    toAgentId,
    metadata: { toAgentId, reason: reason ?? null },
    task: result.task,
  });

  return { success: true, task: result.task };
}

/**
 * Claims a previously delegated {@link Task} for the target agent, validating
 * capabilities and emitting a `claimed_delegated` transition on success.
 */
export function claimDelegatedTask(
  taskId: string,
  agentId: string,
): { success: true; task: Task } | { success: false; reason: string; message?: string } {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { success: false, reason: "not_found", message: "Task not found" };

  if (current.requiredCapabilities && current.requiredCapabilities.length > 0) {
    const agent = agentRepo.getAgentById(agentId);
    if (!agent) return { success: false, reason: "not_found", message: "Agent not found" };

    const missing = validateAgentCapabilities(
      agent.capabilities || [],
      current.requiredCapabilities as string[],
    );

    if (missing.length > 0) {
      return {
        success: false,
        reason: "capability_mismatch",
        message: `Agent lacks required capabilities: ${missing.join(", ")}`,
      };
    }
  }

  const result = taskRepo.claimDelegatedTask(taskId, agentId);

  if (result.success) {
    const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? "";

    emitTransition(taskId, "claimed_delegated", habitatId, {
      actorType: "agent",
      actorId: agentId,
      newStatus: "claimed",
      assignedAgentId: agentId,
      metadata: { delegatedClaim: true },
      task: result.task,
    });
  }

  return result;
}
