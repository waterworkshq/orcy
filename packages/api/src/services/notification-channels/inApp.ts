import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

/**
 * In-app is an AVAILABILITY, not a push send: the inbox row exists at enqueue
 * and `pending` is already inbox-visible, so the unit is satisfied at enqueue
 * and the worker never claims or dispatches it. This pure sender only
 * confirms that availability — it performs no writes of any kind (the worker
 * owns all delivery/attempt persistence).
 */
export async function deliverInApp(
  _delivery: NotificationDelivery,
  _event: NotificationEvent,
): Promise<{ success: boolean }> {
  return { success: true };
}
