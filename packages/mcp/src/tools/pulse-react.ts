import type { PulseClient } from "../api/interfaces.js";

/**
 * @requires PulseClient
 */
export async function pulseReact(
  client: PulseClient,
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
