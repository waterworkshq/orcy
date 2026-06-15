import * as taskRepo from "../../repositories/task.js";
import type { Task, TaskStatus, Artifact } from "../../models/index.js";

/** Allowed task status transitions indexed by current status. */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["claimed"],
  claimed: ["in_progress", "pending"],
  in_progress: ["submitted", "pending", "failed"],
  submitted: ["approved", "rejected"],
  approved: ["done"],
  rejected: ["in_progress"],
  done: [],
  failed: ["pending"],
};

/** Returns true if transitioning from one task status to another is allowed. */
export function validateTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Appends '(Copy)' to a task title, truncating when needed to stay within limits. */
export function formatClonedTitle(title: string): string {
  return title.length > 193 ? title.slice(0, 193) + "... (Copy)" : title + " (Copy)";
}

/** Merges new artifacts into an existing task's artifact list and persists the result. */
export function mergeArtifacts(taskId: string, current: Task, artifacts?: Artifact[]): void {
  if (artifacts && artifacts.length > 0) {
    const mergedArtifacts = [...(current.artifacts || []), ...artifacts];
    taskRepo.updateTask(taskId, { artifacts: mergedArtifacts });
  }
}

/** Returns the list of required capabilities missing from the given agent capabilities. */
export function validateAgentCapabilities(
  agentCapabilities: string[],
  requiredCapabilities: string[],
): string[] {
  const agentCaps = agentCapabilities.map((c) => c.toLowerCase());
  const requiredCaps = requiredCapabilities.map((c) => c.toLowerCase());
  return requiredCaps.filter((cap) => !agentCaps.includes(cap));
}
