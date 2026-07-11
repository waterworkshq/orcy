import * as taskRepo from "../../repositories/task.js";
import * as agentRepo from "../../repositories/agent.js";
import { checkClaimability } from "../../repositories/taskQueries.js";
import { claimTask } from "../../repositories/taskStateMachine.js";
import type { Task, TaskStatus, TaskPriority } from "../../models/index.js";
import { updateTask, deleteTask } from "./task-crud.js";

/**
 * Returns an error message if the agent cannot be assigned to the task due to
 * status, domain, or capability constraints, otherwise `null`.
 */
function validateBatchAssignTarget(task: Task, agentId: string): string | null {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) return "Agent not found";
  if (["approved", "done", "failed"].includes(task.status))
    return `Task in status '${task.status}' cannot be assigned`;
  if (task.requiredDomain && agent.domain !== task.requiredDomain)
    return "Agent domain does not match task requirement";

  const missingCapabilities = task.requiredCapabilities.filter(
    (cap) => !(agent.capabilities || []).map((c) => c.toLowerCase()).includes(cap.toLowerCase()),
  );
  if (missingCapabilities.length > 0) {
    return `Agent lacks required capabilities: ${missingCapabilities.join(", ")}`;
  }

  return null;
}

export { validateBatchAssignTarget };

/**
 * Returns {@link Task}s available in a habitat that match the agent's domain and
 * required capabilities.
 */
export function getAvailableTasksForAgent(
  habitatId: string,
  agentDomain: string,
  agentCapabilities: string[],
  filters?: { status?: TaskStatus; priority?: TaskPriority; limit?: number },
): Task[] {
  const availableTasks = taskRepo.getAvailableTasksForAgent(habitatId, agentDomain, filters);
  const agentCapSet = new Set(agentCapabilities.map((c) => c.toLowerCase()));
  return availableTasks.filter((task) => {
    if (!task.requiredCapabilities || task.requiredCapabilities.length === 0) return true;
    return (task.requiredCapabilities as string[]).every((cap) =>
      agentCapSet.has(cap.toLowerCase()),
    );
  });
}

/**
 * Applies a priority, assignment, or deletion operation to a set of tasks in a
 * habitat, collecting per-task success or failure results.
 */
export function batchOperateTasks(
  habitatId: string,
  input: import("../../models/schemas.js").BatchTaskInput,
  actorId: string,
  _actorType: "human" | "agent" = "human",
): import("../../models/index.js").BatchTaskResponse {
  const { taskIds, operation, payload } = input;
  const results: import("../../models/index.js").BatchTaskResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  for (const taskId of taskIds) {
    const task = taskRepo.getTaskById(taskId);
    const taskHabitatId = task ? taskRepo.getHabitatIdForTask(taskId) : null;
    if (!task || taskHabitatId !== habitatId) {
      results.push({ taskId, success: false, error: "Task not found on this habitat" });
      failureCount++;
      continue;
    }

    if (operation === "priority") {
      const updated = updateTask(
        task.id,
        { priority: (payload as { priority: TaskPriority }).priority },
        actorId,
      );
      if (!updated.success) {
        results.push({ taskId: task.id, success: false, error: "Priority update failed" });
        failureCount++;
      } else {
        results.push({ taskId: task.id, success: true, task: updated.task });
        successCount++;
      }
      continue;
    }

    if (operation === "assign") {
      const assignPayload = payload as { assignedAgentId: string };
      const assignError = validateBatchAssignTarget(task, assignPayload.assignedAgentId);
      if (assignError) {
        results.push({ taskId: task.id, success: false, error: assignError });
        failureCount++;
        continue;
      }

      const claimability = checkClaimability(task.id);
      if (!claimability.claimable) {
        results.push({ taskId: task.id, success: false, error: claimability.reason! });
        failureCount++;
        continue;
      }

      const claimed = claimTask(task.id, assignPayload.assignedAgentId);
      if (!claimed.success) {
        results.push({ taskId: task.id, success: false, error: claimed.reason });
        failureCount++;
      } else {
        results.push({ taskId: task.id, success: true, task: claimed.task });
        successCount++;
      }
      continue;
    }

    if (operation === "delete") {
      const deleted = deleteTask(task.id);
      if (!deleted.success) {
        results.push({
          taskId: task.id,
          success: false,
          error:
            deleted.reason === "has_dependents"
              ? `Task has ${deleted.dependentCount} dependent task(s)`
              : "Task not found",
        });
        failureCount++;
      } else {
        results.push({ taskId: task.id, success: true });
        successCount++;
      }
      continue;
    }

    results.push({ taskId: task.id, success: false, error: `Unknown operation: ${operation}` });
    failureCount++;
  }

  return { successCount, failureCount, results };
}
