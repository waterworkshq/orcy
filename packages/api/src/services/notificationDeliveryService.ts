import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import { deliverInApp } from "./notification-channels/inApp.js";
import { deliverWebhook } from "./notification-channels/webhook.js";
import { deliverSlack } from "./notification-channels/slack.js";
import { deliverDiscord } from "./notification-channels/discord.js";
import * as pluginManager from "../plugins/pluginManager.js";
import type { TrustedChannelDestination } from "../plugins/types.js";
import type { NotificationDelivery, NotificationEvent, NotificationChannel } from "@orcy/shared";

export type { TrustedChannelDestination };

/** Outcome of one pure channel send: no repository writes anywhere below this
 * seam — the delivery worker owns all attempt/delivery persistence. */
export interface ChannelSendResult {
  channel: NotificationChannel;
  success: boolean;
  /** Honest skip (no integration / no destination) — terminal, not an error. */
  skipped?: boolean;
  error?: string;
  statusCode?: number;
}

/** Aggregated outcome of dispatching one delivery across its base channels (pure). */
export interface DeliveryResult {
  deliveryId: string;
  results: ChannelSendResult[];
}

/**
 * Dispatches a delivery through one BASE channel. Channel registry first
 * (ADR-0017): a plugin registered for the base channel is invoked with the
 * trusted DB-derived destination context (when the unit carries one) and its
 * result wins; a registry miss falls through to the in-tree senders. A
 * plugin-returned `attemptId` is informational-only and dropped here — the
 * worker's pre-created attempt row is the single attempt identity.
 */
export async function dispatchChannel(
  delivery: NotificationDelivery,
  event: NotificationEvent,
  channel: NotificationChannel,
  destination?: TrustedChannelDestination | null,
): Promise<ChannelSendResult> {
  const pluginResult = await pluginManager.dispatchToChannelPlugin(
    channel,
    delivery,
    event,
    destination ?? null,
  );
  if (pluginResult) {
    // Fixed error code only: plugin-returned error text (which can embed
    // secrets/URLs/parser strings from plugin-supplied code) is classified
    // at this boundary and never forwarded raw. The status code is safe
    // classification metadata and is preserved.
    return {
      channel,
      success: pluginResult.success,
      error: pluginResult.error ? "delivery_failed" : undefined,
      skipped: !pluginResult.success && pluginResult.error === undefined && pluginResult.statusCode === undefined ? undefined : undefined,
      statusCode: pluginResult.statusCode,
    };
  }

  switch (channel) {
    case "in_app": {
      const r = await deliverInApp(delivery, event);
      return { channel: "in_app", ...r };
    }
    case "webhook": {
      const r = await deliverWebhook(delivery, event, destination ?? null);
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

/**
 * Dispatches a persisted notification through every base channel on its
 * delivery record — PURE: no attempt writes, no delivery-status writes. The
 * production push path is the delivery worker (per-unit claims, fences,
 * attempts); this entry point remains for tests and direct inspection.
 */
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
  const results: ChannelSendResult[] = [];

  for (const channel of channels) {
    const result = await dispatchChannel(delivery, event, channel);
    results.push(result);
  }

  return { deliveryId, results };
}
