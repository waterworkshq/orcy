import type { KanbanApiClient } from "../api.js";

export async function getInbox(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number; offset?: number },
) {
  return client.getInbox(args.boardId, { limit: args.limit, offset: args.offset });
}

export async function getHistory(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number; offset?: number },
) {
  return client.getHistory(args.boardId, { limit: args.limit, offset: args.offset });
}

export async function getDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.getDelivery(args.boardId, args.deliveryId);
}

export async function acknowledgeDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.acknowledgeDelivery(args.boardId, args.deliveryId);
}

export async function snoozeDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string; snoozedUntil: string },
) {
  return client.snoozeDelivery(args.boardId, args.deliveryId, args.snoozedUntil);
}

export async function clearDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.clearDelivery(args.boardId, args.deliveryId);
}

export async function getSubscriptions(client: KanbanApiClient, args: { boardId: string }) {
  return client.getSubscriptions(args.boardId);
}
