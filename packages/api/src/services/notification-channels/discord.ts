import * as attemptRepo from "../../repositories/notificationDeliveryAttempt.js";
import * as chatIntegrationRepo from "../../repositories/chatIntegration.js";
import { sendToDiscord, formatDiscordMessage } from "../discordService.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";

/** Delivers a notification to the habitat's configured Discord webhook and records the delivery attempt outcome. */
export async function deliverDiscord(
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<{ success: boolean; attemptId?: string; error?: string }> {
  const attempt = attemptRepo.createDeliveryAttempt({
    deliveryId: delivery.id,
    channel: "discord",
    attempt: 1,
  });

  const integrations = chatIntegrationRepo.getEnabledIntegrationsByHabitat(delivery.habitatId);
  const discordIntegration = integrations.find((i) => i.provider === "discord" && i.webhookUrl);

  if (!discordIntegration) {
    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "skipped",
      error: "No enabled Discord integration found for this habitat",
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: "No enabled Discord integration" };
  }

  try {
    const message = formatDiscordMessage(event.eventType, {
      id: event.sourceId ?? "",
      title: event.title,
      status: "",
      priority: event.severity,
    });

    const ok = await sendToDiscord(discordIntegration.webhookUrl, message);

    if (ok) {
      attemptRepo.updateDeliveryAttempt(attempt.id, {
        status: "sent",
        finishedAt: new Date().toISOString(),
      });
      return { success: true, attemptId: attempt.id };
    }

    attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "failed",
      error: "Discord webhook returned failure or was blocked",
      finishedAt: new Date().toISOString(),
    });
    return { success: false, attemptId: attempt.id, error: "Discord delivery failed" };
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
