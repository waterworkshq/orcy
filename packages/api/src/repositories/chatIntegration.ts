import { getDb } from '../db/index.js';
import { chatIntegrations } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export interface ChatIntegration {
  id: string;
  boardId: string;
  provider: 'slack' | 'discord';
  webhookUrl: string;
  channelId: string | null;
  botToken: string | null;
  enabled: number;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

export function getIntegrationsByBoard(boardId: string): ChatIntegration[] {
  const db = getDb();
  return db.select().from(chatIntegrations)
    .where(eq(chatIntegrations.boardId, boardId))
    .orderBy(sql`${chatIntegrations.createdAt} DESC`)
    .all() as ChatIntegration[];
}

export function getIntegrationById(id: string): ChatIntegration | null {
  const db = getDb();
  const rows = db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).all();
  return rows.length > 0 ? rows[0] as ChatIntegration : null;
}

export function getEnabledIntegrations(): ChatIntegration[] {
  const db = getDb();
  return db.select().from(chatIntegrations)
    .where(eq(chatIntegrations.enabled, 1))
    .all() as ChatIntegration[];
}

export function getEnabledIntegrationsByBoard(boardId: string): ChatIntegration[] {
  const db = getDb();
  return db.select().from(chatIntegrations)
    .where(and(eq(chatIntegrations.boardId, boardId), eq(chatIntegrations.enabled, 1)))
    .all() as ChatIntegration[];
}

export function createIntegration(input: {
  boardId: string;
  provider: 'slack' | 'discord';
  webhookUrl: string;
  channelId?: string;
  botToken?: string;
  events?: string[];
}): ChatIntegration {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(chatIntegrations).values({
    id,
    boardId: input.boardId,
    provider: input.provider,
    webhookUrl: input.webhookUrl,
    channelId: input.channelId ?? null,
    botToken: input.botToken ?? null,
    enabled: 1,
    events: input.events ?? ['task_created', 'task_claimed', 'task_submitted', 'task_approved', 'task_rejected', 'task_overdue'],
    createdAt: now,
    updatedAt: now,
  }).run();

  return getIntegrationById(id)!;
}

export function updateIntegration(id: string, updates: {
  webhookUrl?: string;
  channelId?: string;
  botToken?: string;
  enabled?: boolean;
  events?: string[];
}): boolean {
  const existing = getIntegrationById(id);
  if (!existing) return false;

  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof chatIntegrations.$inferInsert> = { updatedAt: now };

  if (updates.webhookUrl !== undefined) setValues.webhookUrl = updates.webhookUrl;
  if (updates.channelId !== undefined) setValues.channelId = updates.channelId;
  if (updates.botToken !== undefined) setValues.botToken = updates.botToken;
  if (updates.enabled !== undefined) setValues.enabled = updates.enabled ? 1 : 0;
  if (updates.events !== undefined) setValues.events = updates.events;

  db.update(chatIntegrations).set(setValues).where(eq(chatIntegrations.id, id)).run();
  return true;
}

export function deleteIntegration(id: string): boolean {
  const existing = getIntegrationById(id);
  if (!existing) return false;

  const db = getDb();
  db.delete(chatIntegrations).where(eq(chatIntegrations.id, id)).run();
  return true;
}
