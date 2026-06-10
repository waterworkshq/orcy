import type { InsightClient } from "../api/interfaces.js";
import type { KanbanApiClient } from '../api.js';

export async function pulsePromote(
  client: KanbanApiClient,
  args: {
    boardId: string;
    pulseId: string;
    relevanceTags?: string[];
    subject?: string;
    body?: string;
  }
) {
  if (!args.boardId) {
    throw new Error('boardId is required to promote a signal to an insight');
  }
  if (!args.pulseId) {
    throw new Error('pulseId is required to specify which signal to promote');
  }

  return client.promoteInsight(args.boardId, {
    sourcePulseId: args.pulseId,
    relevanceTags: args.relevanceTags,
    subject: args.subject,
    body: args.body,
  });
}
