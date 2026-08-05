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

/**
 * Returns whether the given approved domains cover the task's required
 * domain. A null/empty required domain means no domain gate (passes).
 * Otherwise the required domain must appear (case-sensitively) in the
 * approved domains list — used by the remote D2 eligibility gate to enforce
 * `approvedDomains` against `task.requiredDomain` (mirror of the local
 * `task-delegation.ts` domain check, which uses single `agent.domain`).
 */
export function validateAgentDomain(
  approvedDomains: string[],
  requiredDomain: string | null,
): { ok: boolean; missingDomains: string[] } {
  if (!requiredDomain) return { ok: true, missingDomains: [] };
  if (approvedDomains.includes(requiredDomain)) return { ok: true, missingDomains: [] };
  return { ok: false, missingDomains: [requiredDomain] };
}
