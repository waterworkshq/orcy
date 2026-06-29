import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import { deliverInApp } from "./notification-channels/inApp.js";
import { deliverWebhook } from "./notification-channels/webhook.js";
import { deliverSlack } from "./notification-channels/slack.js";
import { deliverDiscord } from "./notification-channels/discord.js";
import * as pluginManager from "../plugins/pluginManager.js";
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
  // Channel registry (ADR-0017): if a plugin has registered a handler for this channel,
  // invoke it and return. Miss falls through to the in-tree switch below unchanged.
  const pluginResult = await pluginManager.dispatchToChannelPlugin(channel, delivery, event);
  if (pluginResult) {
    return { channel, ...pluginResult };
  }

  switch (channel) {
    case "in_app": {
      const r = await deliverInApp(delivery, event);
      return { channel: "in_app", ...r };
    }
    case "webhook": {
      const webhookUrl = event.payload?.webhookUrl as string | undefined;
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
