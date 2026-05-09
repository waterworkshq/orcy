import { EVENT_EMOJI_MAP, formatEventTitle } from './shared.js';
import type { EventEnrichment } from './standard.js';

const COLOR_MAP: Record<string, number> = {
  'task.created': 3447003,
  'task.claimed': 16776960,
  'task.submitted': 5763719,
  'task.approved': 5763719,
  'task.rejected': 15548997,
  'task.completed': 5763719,
  'task.failed': 15548997,
  'task.released': 16776960,
  'agent.status_changed': 3447003,
  'column.wip_limit_reached': 16776960,
};

export function formatDiscordPayload(enrichment: EventEnrichment, eventType: string): object {
  const emoji = EVENT_EMOJI_MAP[eventType] || '🐋';
  const title = formatEventTitle(eventType);
  const color = COLOR_MAP[eventType] || 5763719;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (enrichment.task) {
    fields.push({ name: 'Task', value: enrichment.task.title, inline: true });
    fields.push({ name: 'Priority', value: enrichment.task.priority, inline: true });
    if (enrichment.task.assignedAgentName) {
      fields.push({ name: 'Agent', value: enrichment.task.assignedAgentName, inline: true });
    }
  }

  return {
    content: `${emoji} ${title}`,
    embeds: [{
      title: `${emoji} ${title}`,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };
}
