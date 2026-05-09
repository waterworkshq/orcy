import { getDb } from '../../db/index.js';
import { webhookDeliveries, webhookSubscriptions } from '../../db/schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { signPayload } from '../../utils/webhookSigning.js';
import { validateOutboundUrl, filterUnsafeHeaders } from '../../config/integrationSecurity.js';
import { logger } from '../../lib/logger.js';
import type { WebhookSubscription } from './webhook-subscriptions.js';

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: 'pending' | 'success' | 'failed';
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
}

const RETRY_DELAYS = [1000, 2000, 4000];

export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlError';
  }
}

export async function executeHttpRequest(
  url: string,
  payloadString: string,
  signature: string | null,
  headers: Record<string, string>,
  deliveryId: string,
  eventType: string
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
    logger.warn({ deliveryId, blocked }, 'Blocked unsafe custom headers in delivery');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...safeHeaders,
    };

    if (signature) {
      requestHeaders['X-Kanban-Signature'] = signature;
    }
    requestHeaders['X-Kanban-Event'] = eventType;
    requestHeaders['X-Kanban-Delivery'] = deliveryId;

    const response = await fetch(url, {
      method: 'POST',
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      success: false,
      statusCode: 0,
      responseBody: message,
    };
  }
}

export function updateDeliveryStatus(
  deliveryId: string,
  status: 'pending' | 'success' | 'failed',
  statusCode?: number,
  responseBody?: string,
  nextRetryAt?: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(webhookDeliveries)
    .set({
      status,
      statusCode: statusCode ?? null,
      responseBody: responseBody ?? null,
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      lastAttemptAt: now,
      nextRetryAt: nextRetryAt ?? null,
    })
    .where(eq(webhookDeliveries.id, deliveryId))
    .run();
}

export function handleDeliveryOutcome(
  deliveryId: string,
  result: { success: boolean; statusCode: number; responseBody: string },
  attemptNumber: number
): void {
  if (result.success) {
    updateDeliveryStatus(deliveryId, 'success', result.statusCode, result.responseBody);
  } else if (attemptNumber >= 3) {
    updateDeliveryStatus(deliveryId, 'failed', result.statusCode, result.responseBody);
  } else {
    const nextRetry = new Date(Date.now() + RETRY_DELAYS[attemptNumber - 1]).toISOString();
    updateDeliveryStatus(deliveryId, 'pending', result.statusCode, result.responseBody, nextRetry);
  }
}

export function createDeliveryRecord(subscriptionId: string, eventType: string, payload: string, deliveryId: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.insert(webhookDeliveries).values({
    id: deliveryId,
    subscriptionId,
    eventType,
    payload,
    status: 'pending',
    attempts: 0,
    createdAt: now,
  }).run();
}

export function getDeliveriesForSubscription(subscriptionId: string, limit = 25): WebhookDelivery[] {
  const db = getDb();
  const rows = db.select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
    .all();

  return rows;
}

export async function sendTestWebhook(subscription: WebhookSubscription): Promise<{ success: boolean; statusCode: number; latencyMs: number }> {
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
    event: 'test',
    data: {
      boardName: 'Test Board',
      task: {
        id: 'test-task-id',
        title: 'Test Task',
        status: 'pending',
        priority: 'medium',
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

  const result = await executeHttpRequest(subscription.url, payloadString, signature, subscription.headers, deliveryId, 'webhook.test');

  return {
    success: result.success,
    statusCode: result.statusCode,
    latencyMs: Date.now() - startTime,
  };
}

interface RetryDelivery {
  id: string;
  subscriptionId: string;
  payload: string;
  url: string;
  secret: string | null;
  headers: string;
  attempts: number;
}

function getPendingRetries(): RetryDelivery[] {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = db.select({
    id: webhookDeliveries.id,
    subscriptionId: webhookDeliveries.subscriptionId,
    payload: webhookDeliveries.payload,
    url: webhookSubscriptions.url,
    secret: webhookSubscriptions.secret,
    headers: sql<string>`${webhookSubscriptions.headers}`,
    attempts: webhookDeliveries.attempts,
  })
  .from(webhookDeliveries)
  .innerJoin(webhookSubscriptions, eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id))
  .where(and(
    eq(webhookDeliveries.status, 'pending'),
    sql`${webhookDeliveries.nextRetryAt} <= ${now}`
  ))
  .limit(50)
  .all();

  return rows.map(row => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    payload: row.payload,
    url: row.url,
    secret: row.secret,
    headers: typeof row.headers === 'string' ? row.headers : JSON.stringify(row.headers),
    attempts: row.attempts,
  }));
}

function processRetryQueue(): void {
  const retries = getPendingRetries();

  for (const retry of retries) {
    const signature = retry.secret ? signPayload(retry.payload, retry.secret) : null;
    const headers = JSON.parse(retry.headers) as Record<string, string>;

    executeHttpRequest(retry.url, retry.payload, signature, headers, retry.id, 'webhook.delivery').then(result => {
      handleDeliveryOutcome(retry.id, result, retry.attempts + 1);
    });
  }
}

let retryInterval: ReturnType<typeof setInterval> | null = null;

export function startRetryProcessor(): void {
  if (retryInterval) return;
  retryInterval = setInterval(processRetryQueue, 60000);
}

export function stopRetryProcessor(): void {
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
}
