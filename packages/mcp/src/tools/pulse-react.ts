import type { KanbanApiClient } from '../api.js';

export async function pulseReact(
  client: KanbanApiClient,
  args: {
    pulseId: string;
    reaction: 'seen' | 'ack' | 'question';
  }
) {
  if (!args.pulseId) {
    throw new Error('pulseId is required');
  }
  if (!args.reaction) {
    throw new Error('reaction is required (seen, ack, or question)');
  }

  return client.reactToPulse(args.pulseId, args.reaction);
}
