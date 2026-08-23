import * as attemptRepo from "../../repositories/notificationDeliveryAttempt.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { redactError, redactResponseBody } from "./truncate.js";
import { fetchValidated } from "../../config/integrationSecurity.js";

/** POSTs a notification payload to a custom webhook URL — validated by the canonical SSRF checker, pinned to the validated resolution, fail-closed redirects, 10-second timeout — and records the HTTP response on the delivery attempt. */
export async function deliverWebhook(
  delivery: NotificationDelivery,
  event: NotificationEvent,
  webhookUrl: string,
): Promise<{ success: boolean; attemptId?: string; error?: string; statusCode?: number }> {
  const attempt = attemptRepo.createDeliveryAttempt({
    deliveryId: delivery.id,
    channel: "webhook",
    attempt: 1,
  });

  const payload = {
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
  };

  try {
    const response = await fetchValidated(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Orcy-Notification/1.0" },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.text().catch(() => "");
    const statusCode = response.status;
    const ok = response.ok;

    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: ok ? "sent" : "failed",
      statusCode,
      responseBody: redactResponseBody(responseBody),
      finishedAt: new Date().toISOString(),
    });

    if (ok) {
      return { success: true, attemptId: attempt.id, statusCode };
    }
    return { success: false, attemptId: attempt.id, statusCode, error: `HTTP ${statusCode}` };
  } catch (err) {
    const errorMsg = redactError(err instanceof Error ? err.message : String(err));
    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "failed",
      error: errorMsg,
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: errorMsg };
  }
}
