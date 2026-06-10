import * as attemptRepo from "../../repositories/notificationDeliveryAttempt.js";
import * as chatIntegrationRepo from "../../repositories/chatIntegration.js";
import { sendToSlack, formatSlackMessage } from "../slackService.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

export async function deliverSlack(
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<{ success: boolean; attemptId?: string; error?: string }> {
  const attempt = attemptRepo.createDeliveryAttempt({
    deliveryId: delivery.id,
    channel: "slack",
    attempt: 1,
  });

  const integrations = chatIntegrationRepo.getEnabledIntegrationsByHabitat(delivery.habitatId);
  const slackIntegration = integrations.find((i) => i.provider === "slack" && i.webhookUrl);

  if (!slackIntegration) {
    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "skipped",
      error: "No enabled Slack integration found for this habitat",
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: "No enabled Slack integration" };
  }

  try {
    const message = formatSlackMessage(event.eventType, {
      id: event.sourceId ?? "",
      title: event.title,
      status: "",
      priority: event.severity,
    });

    const ok = await sendToSlack(slackIntegration.webhookUrl, message);

    if (ok) {
      attemptRepo.updateDeliveryAttempt(attempt.id, {
        status: "sent",
        finishedAt: new Date().toISOString(),
      });
      return { success: true, attemptId: attempt.id };
    }

    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "failed",
      error: "Slack webhook returned failure or was blocked",
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: "Slack delivery failed" };
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
