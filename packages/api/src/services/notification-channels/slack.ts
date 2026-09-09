import * as chatIntegrationRepo from "../../repositories/chatIntegration.js";
import { sendToSlack, formatSlackMessage } from "../slackService.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { redactError } from "./truncate.js";
import { NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION } from "../../repositories/notificationChannelState.js";

/**
 * Sends a notification to the habitat's enabled Slack webhook. PURE SENDER:
 * no repository writes — the delivery worker records the attempt/outcome
 * under its fence. A missing integration is an honest SKIP with fixed
 * disposition text, not an error.
 */
export async function deliverSlack(
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const integrations = chatIntegrationRepo.getEnabledIntegrationsByHabitat(delivery.habitatId);
  const slackIntegration = integrations.find((i) => i.provider === "slack" && i.webhookUrl);

  if (!slackIntegration) {
    return {
      success: false,
      skipped: true,
      error: NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION,
    };
  }

  try {
    const message = formatSlackMessage(event.eventType, {
      id: event.sourceId ?? "",
      title: event.title,
      status: "",
      priority: event.severity,
    });

    const ok = await sendToSlack(slackIntegration.webhookUrl, message);
    if (ok) return { success: true };
    return { success: false, error: "Slack webhook returned failure or was blocked" };
  } catch (err) {
    return {
      success: false,
      error: redactError(err instanceof Error ? err.message : String(err)),
    };
  }
}
