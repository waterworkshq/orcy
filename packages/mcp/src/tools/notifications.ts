import type { KanbanApiClient } from "../api.js";

/** Returns the caller's pending {@link NotificationDelivery} entries for a board's notification inbox, paginated by limit/offset. */
export async function getInbox(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number; offset?: number },
) {
  return client.getInbox(args.boardId, { limit: args.limit, offset: args.offset });
}

/** Returns past {@link NotificationDelivery} entries (acknowledged, snoozed, cleared) for a board's notification history, paginated by limit/offset. */
export async function getHistory(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number; offset?: number },
) {
  return client.getHistory(args.boardId, { limit: args.limit, offset: args.offset });
}

/** Fetches a single {@link NotificationDelivery} by its ID. */
export async function getDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.getDelivery(args.boardId, args.deliveryId);
}

/** Marks a {@link NotificationDelivery} as acknowledged, removing it from the active inbox. */
export async function acknowledgeDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.acknowledgeDelivery(args.boardId, args.deliveryId);
}

/** Snoozes a {@link NotificationDelivery} until the supplied ISO timestamp, deferring redelivery. */
export async function snoozeDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string; snoozedUntil: string },
) {
  return client.snoozeDelivery(args.boardId, args.deliveryId, args.snoozedUntil);
}

/** Clears a {@link NotificationDelivery} from the inbox and history without acknowledgement. */
export async function clearDelivery(
  client: KanbanApiClient,
  args: { boardId: string; deliveryId: string },
) {
  return client.clearDelivery(args.boardId, args.deliveryId);
}

/** Lists the {@link NotificationSubscription} rules (overrides and defaults) configured for a board. */
export async function getSubscriptions(client: KanbanApiClient, args: { boardId: string }) {
  return client.getSubscriptions(args.boardId);
}
