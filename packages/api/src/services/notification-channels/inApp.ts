import * as attemptRepo from "../../repositories/notificationDeliveryAttempt.js";
import * as deliveryRepo from "../../repositories/notificationDelivery.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

/** Marks an in-app notification delivery as delivered and records the attempt outcome. */
export async function deliverInApp(
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<{ success: boolean; attemptId?: string; error?: string }> {
  const attempt = attemptRepo.createDeliveryAttempt({
    deliveryId: delivery.id,
    channel: "in_app",
    attempt: 1,
  });

  try {
    deliveryRepo.markDeliveryDelivered(delivery.id);

    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "sent",
      finishedAt: new Date().toISOString(),
    });

    return { success: true, attemptId: attempt.id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "failed",
      error: errorMsg.slice(0, 500),
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: errorMsg };
  }
}
