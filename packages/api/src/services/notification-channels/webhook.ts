import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { redactError } from "./truncate.js";
import { executeHttpRequest } from "../webhooks/webhook-delivery.js";
import { signPayload } from "../../utils/webhookSigning.js";
import type { TrustedChannelDestination } from "../../plugins/types.js";

const NOTIFICATION_NO_DESTINATION = "no authorized webhook destination";

/**
 * POSTs the signed notification envelope to an AUTHORIZED destination — the
 * trusted DB-derived subscription row (url/secret/headers), never a URL from
 * the runtime event payload. Full reuse of the board-webhook HTTP authority:
 * SSRF-validated pinned-resolution fetch, fail-closed redirects, 10 s
 * timeout, unsafe-header filtering, and the X-Kanban signature/event/delivery
 * headers receivers already verify. The delivery id in the payload and the
 * `X-Kanban-Delivery` header are stable across retries (remote dedup key).
 *
 * PURE SENDER: no repository writes — the delivery worker records the
 * attempt/outcome under its fence.
 */
export async function deliverWebhook(
  delivery: NotificationDelivery,
  event: NotificationEvent,
  destination: TrustedChannelDestination | null,
): Promise<{ success: boolean; skipped?: boolean; error?: string; statusCode?: number }> {
  if (!destination || !destination.url) {
    return { success: false, skipped: true, error: NOTIFICATION_NO_DESTINATION };
  }

  const payload = {
    id: delivery.id,
    timestamp: new Date().toISOString(),
    event: `notification:${event.eventType}`,
    data: {
      notificationEventId: event.id,
      eventType: event.eventType,
      habitatId: event.habitatId,
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      severity: event.severity,
      title: event.title,
      body: event.body,
      deliveryId: delivery.id,
      recipientType: delivery.recipientType,
      recipientId: delivery.recipientId,
    },
  };
  const payloadString = JSON.stringify(payload);
  const signature = destination.secret
    ? signPayload(payloadString, destination.secret)
    : null;

  try {
    const result = await executeHttpRequest(
      destination.url,
      payloadString,
      signature,
      destination.headers,
      delivery.id,
      `notification:${event.eventType}`,
    );
    if (result.success) {
      return { success: true, statusCode: result.statusCode };
    }
    return {
      success: false,
      statusCode: result.statusCode,
      error: `HTTP ${result.statusCode}`,
    };
  } catch (err) {
    return {
      success: false,
      error: redactError(err instanceof Error ? err.message : String(err)),
    };
  }
}
