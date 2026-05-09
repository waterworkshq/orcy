export const EVENT_EMOJI_MAP: Record<string, string> = {
  'task.created': '🆕',
  'task.claimed': '🤚',
  'task.submitted': '📨',
  'task.approved': '✅',
  'task.rejected': '❌',
  'task.completed': '🎉',
  'task.failed': '⚠️',
  'task.released': '🔓',
  'agent.status_changed': '🤖',
  'column.wip_limit_reached': '🚧',
};

export function formatEventTitle(eventType: string): string {
  return eventType
    .replace('.', ' ')
    .replace('_', ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}
