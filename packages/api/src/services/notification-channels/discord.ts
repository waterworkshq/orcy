import * as chatIntegrationRepo from "../../repositories/chatIntegration.js";
import { sendToDiscord, formatDiscordMessage } from "../discordService.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { redactError } from "./truncate.js";
import { NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION } from "../../repositories/notificationChannelState.js";

/**
 * Sends a notification to the habitat's enabled Discord webhook. PURE SENDER:
 * no repository writes — the delivery worker records the attempt/outcome
 * under its fence. A missing integration is an honest SKIP with fixed
 * disposition text, not an error.
 */
export async function deliverDiscord(
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const integrations = chatIntegrationRepo.getEnabledIntegrationsByHabitat(delivery.habitatId);
  const discordIntegration = integrations.find((i) => i.provider === "discord" && i.webhookUrl);

  if (!discordIntegration) {
    return {
      success: false,
      skipped: true,
      error: NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION,
    };
  }

  try {
    const message = formatDiscordMessage(event.eventType, {
      id: event.sourceId ?? "",
      title: event.title,
      status: "",
      priority: event.severity,
    });

    const ok = await sendToDiscord(discordIntegration.webhookUrl, message);
    if (ok) return { success: true };
    return { success: false, error: "Discord webhook returned failure or was blocked" };
  } catch (err) {
    return {
      success: false,
      error: redactError(err instanceof Error ? err.message : String(err)),
    };
  }
}
