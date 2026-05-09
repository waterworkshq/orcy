import { EVENT_EMOJI_MAP, formatEventTitle } from './shared.js';
import type { EventEnrichment } from './standard.js';

export function formatSlackPayload(enrichment: EventEnrichment, eventType: string): object {
  const emoji = EVENT_EMOJI_MAP[eventType] || '🐋';
  const title = formatEventTitle(eventType);

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${title}` },
    },
  ];

  if (enrichment.task) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Task:*\n${enrichment.task.title}` },
        { type: 'mrkdwn', text: `*Priority:*\n${enrichment.task.priority}` },
      ],
    });
    if (enrichment.task.assignedAgentName) {
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent:*\n${enrichment.task.assignedAgentName}` },
        ],
      });
    }
  }

  return { text: `[Orcy] ${title}: ${enrichment.task?.title || ''}`, blocks };
}
