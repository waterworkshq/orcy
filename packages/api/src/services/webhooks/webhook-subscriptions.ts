import { getDb } from '../../db/index.js';
import { webhookSubscriptions } from '../../db/schema/index.js';
import { eq, or, isNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { generateSecret } from '../../utils/webhookSigning.js';

export interface WebhookSubscription {
  id: string;
  boardId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: 'standard' | 'slack' | 'discord';
  enabled: number;
}

export function createWebhookSubscription(
  boardId: string | null,
  name: string,
  url: string,
  format: 'standard' | 'slack' | 'discord',
  events: string[],
  headers: Record<string, string>
): WebhookSubscription {
  const db = getDb();
  const id = uuid();
  const secret = generateSecret();
  const now = new Date().toISOString();

  db.insert(webhookSubscriptions).values({
    id,
    boardId,
    name,
    url,
    secret,
    events,
    headers,
    format,
    enabled: 1,
    createdAt: now,
    updatedAt: now,
  }).run();

  return {
    id,
    boardId,
    name,
    url,
    secret,
    events,
    headers,
    format,
    enabled: 1,
  };
}

export function getWebhookSubscriptions(boardId?: string | null): WebhookSubscription[] {
  const db = getDb();

  if (boardId === undefined) {
    return db.select().from(webhookSubscriptions).all();
  } else if (boardId === null) {
    return db.select().from(webhookSubscriptions).where(isNull(webhookSubscriptions.boardId)).all();
  } else {
    return db.select().from(webhookSubscriptions).where(
      or(eq(webhookSubscriptions.boardId, boardId), isNull(webhookSubscriptions.boardId))
    ).all();
  }
}

export function getWebhookSubscriptionById(id: string): WebhookSubscription | null {
  const db = getDb();
  const row = db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get();
  return row ?? null;
}

export function updateWebhookSubscription(
  id: string,
  updates: { name?: string; url?: string; format?: 'standard' | 'slack' | 'discord'; events?: string[]; headers?: Record<string, string>; enabled?: boolean }
): boolean {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return false;

  const db = getDb();
  const now = new Date().toISOString();
  const name = updates.name ?? existing.name;
  const url = updates.url ?? existing.url;
  const format = updates.format ?? existing.format;
  const events = updates.events !== undefined ? updates.events : existing.events;
  const headers = updates.headers !== undefined ? updates.headers : existing.headers;
  const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled;

  db.update(webhookSubscriptions)
    .set({ name, url, format, events, headers, enabled, updatedAt: now })
    .where(eq(webhookSubscriptions.id, id))
    .run();

  return true;
}

export function deleteWebhookSubscription(id: string): boolean {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return false;

  const db = getDb();
  db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).run();

  return true;
}

export function rotateWebhookSecret(id: string): string | null {
  const existing = getWebhookSubscriptionById(id);
  if (!existing) return null;

  const db = getDb();
  const newSecret = generateSecret();
  const now = new Date().toISOString();

  db.update(webhookSubscriptions)
    .set({ secret: newSecret, updatedAt: now })
    .where(eq(webhookSubscriptions.id, id))
    .run();

  return newSecret;
}
