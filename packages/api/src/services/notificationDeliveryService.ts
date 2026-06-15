import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import { deliverInApp } from "./notification-channels/inApp.js";
import { deliverWebhook } from "./notification-channels/webhook.js";
import { deliverSlack } from "./notification-channels/slack.js";
import { deliverDiscord } from "./notification-channels/discord.js";
import type { NotificationDelivery, NotificationEvent, NotificationChannel } from "@orcy/shared";

/** Outcome of attempting delivery through a single notification channel. */
export interface ChannelDeliveryResult {
  channel: NotificationChannel;
  success: boolean;
  attemptId?: string;
  error?: string;
  statusCode?: number;
}

/** Aggregated outcome of delivering a single notification delivery across all of its configured channels. */
export interface DeliveryResult {
  deliveryId: string;
  results: ChannelDeliveryResult[];
}

/** Delivers a persisted notification through every channel on its delivery record and returns the per-channel results. */
export async function deliverNotification(deliveryId: string): Promise<DeliveryResult> {
  const delivery = deliveryRepo.getNotificationDeliveryById(deliveryId);
  if (!delivery) {
    return { deliveryId, results: [] };
  }

  const event = eventRepo.getNotificationEventById(delivery.eventId);
  if (!event) {
    return { deliveryId, results: [] };
  }

  const channels = delivery.channels ?? [];
  const results: ChannelDeliveryResult[] = [];

  for (const channel of channels) {
    const result = await dispatchChannel(delivery, event, channel);
    results.push(result);
  }

  return { deliveryId, results };
}

async function dispatchChannel(
  delivery: NotificationDelivery,
  event: NotificationEvent,
  channel: NotificationChannel,
): Promise<ChannelDeliveryResult> {
  switch (channel) {
    case "in_app": {
      const r = await deliverInApp(delivery, event);
      return { channel: "in_app", ...r };
    }
    case "webhook": {
      const webhookUrl =
        ((delivery.channels as unknown as Record<string, unknown>)?.webhookUrl as string) ??
        (event.payload?.webhookUrl as string);
      if (!webhookUrl) {
        return { channel: "webhook", success: false, error: "No webhook URL configured" };
      }
      const r = await deliverWebhook(delivery, event, webhookUrl);
      return { channel: "webhook", ...r };
    }
    case "slack": {
      const r = await deliverSlack(delivery, event);
      return { channel: "slack", ...r };
    }
    case "discord": {
      const r = await deliverDiscord(delivery, event);
      return { channel: "discord", ...r };
    }
    default:
      return { channel, success: false, error: `Unknown channel: ${channel}` };
  }
}
