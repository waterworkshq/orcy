import type { SSEEvent } from "../../models/index.js";
import { v4 as uuid } from "uuid";
import { signPayload } from "../../utils/webhookSigning.js";
import { enrichEvent } from "../eventEnricher.js";
import { formatStandardPayload } from "../webhook-formatters/standard.js";
import { formatSlackPayload } from "../webhook-formatters/slack.js";
import { formatDiscordPayload } from "../webhook-formatters/discord.js";
import type { EventEnrichment } from "../webhook-formatters/standard.js";
import type { WebhookSubscription } from "./webhook-subscriptions.js";
import { createDeliveryRecord } from "./webhook-delivery.js";
import { executeHttpRequest, handleDeliveryOutcome } from "./webhook-delivery.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { logger } from "../../lib/logger.js";
import { listEnabledWebhookSubscriptionRecordsForHabitat } from "../../repositories/webhookSubscription.js";

type FormatterFn = (enrichment: EventEnrichment, eventType: string, deliveryId: string) => object;

const FORMATTER_REGISTRY: Map<WebhookSubscription["format"], FormatterFn> = new Map([
  [
    "standard",
    (enrichment, eventType, deliveryId) => formatStandardPayload(enrichment, eventType, deliveryId),
  ],
  ["slack", (enrichment, eventType, _deliveryId) => formatSlackPayload(enrichment, eventType)],
  ["discord", (enrichment, eventType, _deliveryId) => formatDiscordPayload(enrichment, eventType)],
]);

function formatPayload(
  format: WebhookSubscription["format"],
  enrichment: EventEnrichment,
  eventType: string,
  deliveryId: string,
): object {
  // Plugin formatter registry first (ADR-0021): if a plugin has registered a
  // handler for this format, invoke it. Miss falls through to the in-tree
  // FORMATTER_REGISTRY below (gradual migration pattern, same as notification channels).
  const pluginFormatter = pluginManager.getFormatterHandler(format);
  if (pluginFormatter) {
    return pluginFormatter(enrichment, eventType, deliveryId);
  }
  const formatter = FORMATTER_REGISTRY.get(format) ?? FORMATTER_REGISTRY.get("standard")!;
  return formatter(enrichment, eventType, deliveryId);
}

function getSubscriptionsForEvent(habitatId: string, eventType: string): WebhookSubscription[] {
  const allSubs = listEnabledWebhookSubscriptionRecordsForHabitat(habitatId);

  const subscriptions: WebhookSubscription[] = [];
  for (const sub of allSubs) {
    if (sub.events.length === 0 || sub.events.includes(eventType)) {
      subscriptions.push(sub);
    }
  }

  return subscriptions;
}

async function dispatchToSubscription(
  subscription: WebhookSubscription,
  event: SSEEvent,
  habitatId: string,
): Promise<void> {
  const enrichment = enrichEvent(habitatId, event);
  const eventType = event.type;
  const deliveryId = uuid();

  const formattedPayload = formatPayload(subscription.format, enrichment, eventType, deliveryId);
  const payloadString = JSON.stringify(formattedPayload);
  const signature = subscription.secret ? signPayload(payloadString, subscription.secret) : null;

  createDeliveryRecord(subscription.id, eventType, payloadString, deliveryId);

  const result = await executeHttpRequest(
    subscription.url,
    payloadString,
    signature,
    subscription.headers,
    deliveryId,
    "webhook.delivery",
  );
  handleDeliveryOutcome(deliveryId, result, 1);
}

/** Dispatches an event to every enabled webhook subscription for a habitat. */
export async function dispatchWebhooks(habitatId: string, event: SSEEvent): Promise<void> {
  const subscriptions = getSubscriptionsForEvent(habitatId, event.type);

  for (const subscription of subscriptions) {
    dispatchToSubscription(subscription, event, habitatId).catch((err) => {
      logger.error({ err, subscriptionId: subscription.id }, "Webhook dispatch error");
    });
  }
}
