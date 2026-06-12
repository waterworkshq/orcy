import { getDb } from "../db/index.js";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema/index.js";
import { and, desc, eq, sql } from "drizzle-orm";

export interface WebhookDeliveryRecord {
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

export interface PendingWebhookRetryRecord {
  id: string;
  subscriptionId: string;
  payload: string;
  url: string;
  secret: string | null;
  headers: string;
  attempts: number;
}

export function updateWebhookDeliveryStatus(
  deliveryId: string,
  status: "pending" | "success" | "failed",
  statusCode?: number,
  responseBody?: string,
  nextRetryAt?: string,
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

export function createWebhookDeliveryRecord(
  subscriptionId: string,
  eventType: string,
  payload: string,
  deliveryId: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.insert(webhookDeliveries)
    .values({
      id: deliveryId,
      subscriptionId,
      eventType,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: now,
    })
    .run();
}

export function listWebhookDeliveriesForSubscription(
  subscriptionId: string,
  limit = 25,
): WebhookDeliveryRecord[] {
  const db = getDb();
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
    .all();
}

export function listPendingWebhookRetries(): PendingWebhookRetryRecord[] {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = db
    .select({
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
    .where(
      and(eq(webhookDeliveries.status, "pending"), sql`${webhookDeliveries.nextRetryAt} <= ${now}`),
    )
    .limit(50)
    .all();

  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    payload: row.payload,
    url: row.url,
    secret: row.secret,
    headers: typeof row.headers === "string" ? row.headers : JSON.stringify(row.headers),
    attempts: row.attempts,
  }));
}
