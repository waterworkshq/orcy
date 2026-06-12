import { getDb } from "../db/index.js";
import { webhookSubscriptions } from "../db/schema/index.js";
import { and, eq, isNull, or } from "drizzle-orm";

export interface WebhookSubscriptionRecord {
  id: string;
  habitatId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: "standard" | "slack" | "discord";
  enabled: number;
}

export interface CreateWebhookSubscriptionRecordInput {
  id: string;
  habitatId: string | null;
  name: string;
  url: string;
  secret: string;
  events: string[];
  headers: Record<string, string>;
  format: "standard" | "slack" | "discord";
}

export interface UpdateWebhookSubscriptionRecordInput {
  name: string;
  url: string;
  format: "standard" | "slack" | "discord";
  events: string[];
  headers: Record<string, string>;
  enabled: number;
}

export function createWebhookSubscriptionRecord(
  input: CreateWebhookSubscriptionRecordInput,
): WebhookSubscriptionRecord {
  const db = getDb();
  const now = new Date().toISOString();

  db.insert(webhookSubscriptions)
    .values({
      id: input.id,
      habitatId: input.habitatId,
      name: input.name,
      url: input.url,
      secret: input.secret,
      events: input.events,
      headers: input.headers,
      format: input.format,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    id: input.id,
    habitatId: input.habitatId,
    name: input.name,
    url: input.url,
    secret: input.secret,
    events: input.events,
    headers: input.headers,
    format: input.format,
    enabled: 1,
  };
}

export function listWebhookSubscriptionRecords(
  habitatId?: string | null,
): WebhookSubscriptionRecord[] {
  const db = getDb();

  if (habitatId === undefined) {
    return db.select().from(webhookSubscriptions).all();
  }

  if (habitatId === null) {
    return db
      .select()
      .from(webhookSubscriptions)
      .where(isNull(webhookSubscriptions.habitatId))
      .all();
  }

  return db
    .select()
    .from(webhookSubscriptions)
    .where(
      or(eq(webhookSubscriptions.habitatId, habitatId), isNull(webhookSubscriptions.habitatId)),
    )
    .all();
}

export function listEnabledWebhookSubscriptionRecordsForHabitat(
  habitatId: string,
): WebhookSubscriptionRecord[] {
  const db = getDb();

  return db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        or(eq(webhookSubscriptions.habitatId, habitatId), isNull(webhookSubscriptions.habitatId)),
        eq(webhookSubscriptions.enabled, 1),
      ),
    )
    .all();
}

export function getWebhookSubscriptionRecordById(id: string): WebhookSubscriptionRecord | null {
  const db = getDb();
  const row = db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get();
  return row ?? null;
}

export function updateWebhookSubscriptionRecord(
  id: string,
  input: UpdateWebhookSubscriptionRecordInput,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(webhookSubscriptions)
    .set({ ...input, updatedAt: now })
    .where(eq(webhookSubscriptions.id, id))
    .run();
}

export function deleteWebhookSubscriptionRecord(id: string): void {
  const db = getDb();
  db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).run();
}

export function updateWebhookSubscriptionSecret(id: string, secret: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(webhookSubscriptions)
    .set({ secret, updatedAt: now })
    .where(eq(webhookSubscriptions.id, id))
    .run();
}
