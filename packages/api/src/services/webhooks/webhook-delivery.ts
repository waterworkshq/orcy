import { v4 as uuid } from "uuid";
import { signPayload } from "../../utils/webhookSigning.js";
import { validateOutboundUrl, filterUnsafeHeaders } from "../../config/integrationSecurity.js";
import { logger } from "../../lib/logger.js";
import type { WebhookSubscription } from "./webhook-subscriptions.js";
import {
  createWebhookDeliveryRecord,
  listPendingWebhookRetries,
  listWebhookDeliveriesForSubscription,
  updateWebhookDeliveryStatus,
  type PendingWebhookRetryRecord,
} from "../../repositories/webhookDelivery.js";

/** Represents a single webhook delivery attempt and its outcome. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
}

const RETRY_DELAYS = [1000, 2000, 4000];

/** Error indicating that a webhook URL was rejected by outbound URL validation. */
export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

/** Sends a signed webhook payload via POST and returns the response summary. */
export async function executeHttpRequest(
  url: string,
  payloadString: string,
  signature: string | null,
  headers: Record<string, string>,
  deliveryId: string,
  eventType: string,
): Promise<{ success: boolean; statusCode: number; responseBody: string }> {
  const urlValidation = await validateOutboundUrl(url);
  if (!urlValidation.valid) {
    return {
      success: false,
      statusCode: 0,
      responseBody: `Blocked outbound URL: ${urlValidation.reason}`,
    };
  }

  const { headers: safeHeaders, blocked } = filterUnsafeHeaders(headers);
  if (blocked.length > 0) {
    logger.warn({ deliveryId, blocked }, "Blocked unsafe custom headers in delivery");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...safeHeaders,
    };

    if (signature) {
      requestHeaders["X-Kanban-Signature"] = signature;
    }
    requestHeaders["X-Kanban-Event"] = eventType;
    requestHeaders["X-Kanban-Delivery"] = deliveryId;

    const response = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const body = await response.text();
    return {
      success: response.ok,
      statusCode: response.status,
      responseBody: body.slice(0, 1024),
    };
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      statusCode: 0,
      responseBody: message,
    };
  }
}

/** Updates the stored status for a webhook delivery attempt. */
export function updateDeliveryStatus(
  deliveryId: string,
  status: "pending" | "success" | "failed",
  statusCode?: number,
  responseBody?: string,
  nextRetryAt?: string,
): void {
  updateWebhookDeliveryStatus(deliveryId, status, statusCode, responseBody, nextRetryAt);
}

/** Marks a delivery as success, failed, or pending for the next retry. */
export function handleDeliveryOutcome(
  deliveryId: string,
  result: { success: boolean; statusCode: number; responseBody: string },
  attemptNumber: number,
): void {
  if (result.success) {
    updateDeliveryStatus(deliveryId, "success", result.statusCode, result.responseBody);
  } else if (attemptNumber >= 3) {
    updateDeliveryStatus(deliveryId, "failed", result.statusCode, result.responseBody);
  } else {
    const nextRetry = new Date(Date.now() + RETRY_DELAYS[attemptNumber - 1]).toISOString();
    updateDeliveryStatus(deliveryId, "pending", result.statusCode, result.responseBody, nextRetry);
  }
}

/** Creates a pending delivery record for a webhook event. */
export function createDeliveryRecord(
  subscriptionId: string,
  eventType: string,
  payload: string,
  deliveryId: string,
): void {
  createWebhookDeliveryRecord(subscriptionId, eventType, payload, deliveryId);
}

/** Returns recent webhook deliveries for a subscription. */
export function getDeliveriesForSubscription(
  subscriptionId: string,
  limit = 25,
): WebhookDelivery[] {
  return listWebhookDeliveriesForSubscription(subscriptionId, limit);
}

/** Sends a test payload to a subscription URL and reports the result. */
export async function sendTestWebhook(
  subscription: WebhookSubscription,
): Promise<{ success: boolean; statusCode: number; latencyMs: number }> {
  const urlValidation = await validateOutboundUrl(subscription.url);
  if (!urlValidation.valid) {
    return {
      success: false,
      statusCode: 0,
      latencyMs: 0,
    };
  }

  const deliveryId = uuid();
  const testPayload = {
    id: deliveryId,
    timestamp: new Date().toISOString(),
    event: "test",
    data: {
      habitatName: "Test Habitat",
      task: {
        id: "test-task-id",
        title: "Test Task",
        status: "pending",
        priority: "medium",
        assignedAgentId: null,
        assignedAgentName: undefined,
        result: null,
        artifacts: [],
      },
    },
  };

  const payloadString = JSON.stringify(testPayload);
  const signature = subscription.secret ? signPayload(payloadString, subscription.secret) : null;

  const startTime = Date.now();

  const result = await executeHttpRequest(
    subscription.url,
    payloadString,
    signature,
    subscription.headers,
    deliveryId,
    "webhook.test",
  );

  return {
    success: result.success,
    statusCode: result.statusCode,
    latencyMs: Date.now() - startTime,
  };
}

function processRetryQueue(): void {
  const retries: PendingWebhookRetryRecord[] = listPendingWebhookRetries();

  for (const retry of retries) {
    const signature = retry.secret ? signPayload(retry.payload, retry.secret) : null;
    const headers = JSON.parse(retry.headers) as Record<string, string>;

    executeHttpRequest(
      retry.url,
      retry.payload,
      signature,
      headers,
      retry.id,
      "webhook.delivery",
    ).then((result) => {
      handleDeliveryOutcome(retry.id, result, retry.attempts + 1);
    });
  }
}

let retryInterval: ReturnType<typeof setInterval> | null = null;

/** Starts the background interval that processes pending webhook retries. */
export function startRetryProcessor(): void {
  if (retryInterval) return;
  retryInterval = setInterval(processRetryQueue, 60000);
}

/** Stops the background webhook retry processor. */
export function stopRetryProcessor(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}
