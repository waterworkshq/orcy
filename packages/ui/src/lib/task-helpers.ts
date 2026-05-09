import type { Task, TaskEvent, Agent } from '../types/index.js';

// --- formatDuration ---
export function formatDuration(ms: number): string {
  if (ms < 60000) return '< 1m';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// --- formatTimestamp ---
export function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// --- getActorDisplayName ---
export function getActorDisplayName(
  event: TaskEvent,
  agents: Agent[]
): string {
  if (event.actorType === 'agent') {
    return agents.find((a) => a.id === event.actorId)?.name ?? event.actorId;
  }
  if (event.actorType === 'system') return 'system';
  return event.actorId || 'anonymous';
}

// --- getStatusBadgeClass ---
export function getStatusBadgeClass(
  status: Task['status']
): string {
  switch (status) {
    case 'pending': return 'glass-badge glass-badge-low';
    case 'claimed': return 'glass-badge glass-badge-active';
    case 'in_progress': return 'glass-badge glass-badge-active';
    case 'submitted': return 'glass-badge glass-badge-review';
    case 'approved': return 'glass-badge glass-badge-done';
    case 'rejected': return 'glass-badge glass-badge-blocked';
    case 'done': return 'glass-badge glass-badge-done';
    case 'failed': return 'glass-badge glass-badge-blocked';
    default: return 'glass-badge glass-badge-low';
  }
}

// --- getTimeComparisonClass ---
export function getTimeComparisonClass(diff: number): string {
  if (diff > 0) return 'text-red-600 dark:text-red-400';
  if (diff < 0) return 'text-green-600 dark:text-green-400';
  return 'text-muted-foreground';
}

// --- getAgentDisplayName ---
export function getAgentDisplayName(
  agentId: string | null | undefined,
  agents: Agent[]
): string {
  if (!agentId) return 'Unassigned';
  const agent = agents.find((a) => a.id === agentId);
  return agent ? agent.name : 'Agent not found';
}

// --- invalidateSubtasks helper (query invalidation) ---
// Kept here for potential shared use; actual invalidation happens in the hook.

// --- initEditForm ---
export function initEditForm(task: Task) {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    labels: '',
    requiredDomain: task.requiredDomain || '',
    requiredCapabilities: task.requiredCapabilities ?? [],
  };
}
