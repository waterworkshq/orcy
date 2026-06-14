import type { Task, TaskEvent, Agent } from "../types/index.js";
import { formatDurationMs } from "./formatting.js";
import { TASK_STATUS_BADGE, getStatusBadge } from "./status-maps.js";

export const formatDuration = formatDurationMs;

// --- formatTimestamp ---
export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// --- getActorDisplayName ---
export function getActorDisplayName(event: TaskEvent, agents: Agent[]): string {
  if (event.actorType === "agent") {
    return agents.find((a) => a.id === event.actorId)?.name ?? event.actorId;
  }
  if (event.actorType === "system") return "system";
  if (event.actorType === "remote_orcy") return `Remote Or: ${event.actorId.slice(0, 8)}`;
  if (event.actorType === "remote_human") return `Remote User: ${event.actorId.slice(0, 8)}`;
  if (event.actorType === "remote_pod") return `Remote Pod: ${event.actorId.slice(0, 8)}`;
  return event.actorId || "anonymous";
}

// --- getStatusBadgeClass ---
export function getStatusBadgeClass(status: Task["status"]): string {
  return getStatusBadge(TASK_STATUS_BADGE, status);
}

// --- getTimeComparisonClass ---
export function getTimeComparisonClass(diff: number): string {
  if (diff > 0) return "text-red-600 dark:text-red-400";
  if (diff < 0) return "text-green-600 dark:text-green-400";
  return "text-muted-foreground";
}

// --- getAgentDisplayName ---
export function getAgentDisplayName(agentId: string | null | undefined, agents: Agent[]): string {
  if (!agentId) return "Unassigned";
  const agent = agents.find((a) => a.id === agentId);
  return agent ? agent.name : "Agent not found";
}

// --- invalidateSubtasks helper (query invalidation) ---
// Kept here for potential shared use; actual invalidation happens in the hook.

// --- initEditForm ---
export function initEditForm(task: Task) {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    labels: (task.labels ?? []).join(", "),
    requiredDomain: task.requiredDomain || "",
    requiredCapabilities: task.requiredCapabilities ?? [],
  };
}
