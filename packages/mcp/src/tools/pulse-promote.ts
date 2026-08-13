import type { InsightClient } from "../api/interfaces.js";

/**
 * @requires InsightClient
 */
export async function pulsePromote(
  client: InsightClient,
  args: {
    habitatId?: string;
    boardId?: string;
    pulseId: string;
    relevanceTags?: string[];
    subject?: string;
    body?: string;
  }
) {
  const habitatId = args.habitatId ?? args.boardId;
  if (!habitatId) {
    throw new Error('habitatId is required to promote a signal to an insight');
  }
  if (!args.pulseId) {
    throw new Error('pulseId is required to specify which signal to promote');
  }

  return client.promoteInsight(habitatId, {
    sourcePulseId: args.pulseId,
    relevanceTags: args.relevanceTags,
    subject: args.subject,
    body: args.body,
  });
}
