import { getDb } from "../db/index.js";
import { chatIntegrations } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface ChatIntegration {
  id: string;
  habitatId: string;
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId: string | null;
  providerWorkspaceId: string | null;
  botToken: string | null;
  enabled: number;
  events: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Decision-path resolver: exact tuple (provider, signed workspace, non-null
 * channel) over ENABLED rows. Zero matches or an ambiguous duplicate tuple
 * both resolve to null — the caller refuses; there is never a first-match
 * and never an env fallback. NULL-workspace rows are structurally
 * excluded (push-only).
 */
export function findDecisionIntegration(
  provider: "slack" | "discord",
  providerWorkspaceId: string,
  channelId: string,
): ChatIntegration | null {
  const db = getDb();
  const rows = db
    .select()
    .from(chatIntegrations)
    .where(
      and(
        eq(chatIntegrations.provider, provider),
        eq(chatIntegrations.providerWorkspaceId, providerWorkspaceId),
        eq(chatIntegrations.channelId, channelId),
        eq(chatIntegrations.enabled, 1),
      ),
    )
    .all() as ChatIntegration[];
  if (rows.length !== 1) return null;
  return rows[0];
}

export function getIntegrationsByHabitat(habitatId: string): ChatIntegration[] {
  const db = getDb();
  return db
    .select()
    .from(chatIntegrations)
    .where(eq(chatIntegrations.habitatId, habitatId))
    .orderBy(sql`${chatIntegrations.createdAt} DESC`)
    .all() as ChatIntegration[];
}

export function getIntegrationById(id: string): ChatIntegration | null {
  const db = getDb();
  const rows = db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).all();
  return rows.length > 0 ? (rows[0] as ChatIntegration) : null;
}

export function getEnabledIntegrations(): ChatIntegration[] {
  const db = getDb();
  return db
    .select()
    .from(chatIntegrations)
    .where(eq(chatIntegrations.enabled, 1))
    .all() as ChatIntegration[];
}

export function getEnabledIntegrationsByHabitat(habitatId: string): ChatIntegration[] {
  const db = getDb();
  return db
    .select()
    .from(chatIntegrations)
    .where(and(eq(chatIntegrations.habitatId, habitatId), eq(chatIntegrations.enabled, 1)))
    .all() as ChatIntegration[];
}

export function createIntegration(input: {
  habitatId: string;
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId?: string;
  providerWorkspaceId?: string | null;
  botToken?: string;
  events?: string[];
}): ChatIntegration {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(chatIntegrations)
      .values({
        id,
        habitatId: input.habitatId,
        provider: input.provider,
        webhookUrl: input.webhookUrl,
        channelId: input.channelId ?? null,
        providerWorkspaceId: input.providerWorkspaceId ?? null,
        botToken: input.botToken ?? null,
        enabled: 1,
        events: input.events ?? [
          "task_created",
          "task_claimed",
          "task_submitted",
          "task_approved",
          "task_rejected",
          "task_overdue",
        ],
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("chatIntegration", err as Error, id);
  }

  const integration = getIntegrationById(id);
  if (!integration) throw repositoryNotFoundError("chatIntegration", id);
  return integration;
}

export function updateIntegration(
  id: string,
  updates: {
    webhookUrl?: string;
    channelId?: string;
    providerWorkspaceId?: string | null;
    botToken?: string;
    enabled?: boolean;
    events?: string[];
  },
): boolean {
  const existing = getIntegrationById(id);
  if (!existing) return false;

  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof chatIntegrations.$inferInsert> = { updatedAt: now };

  if (updates.webhookUrl !== undefined) setValues.webhookUrl = updates.webhookUrl;
  if (updates.channelId !== undefined) setValues.channelId = updates.channelId;
  if (updates.providerWorkspaceId !== undefined)
    setValues.providerWorkspaceId = updates.providerWorkspaceId;
  if (updates.botToken !== undefined) setValues.botToken = updates.botToken;
  if (updates.enabled !== undefined) setValues.enabled = updates.enabled ? 1 : 0;
  if (updates.events !== undefined) setValues.events = updates.events;

  try {
    db.update(chatIntegrations).set(setValues).where(eq(chatIntegrations.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("chatIntegration", err as Error, id);
  }
  return true;
}

export function deleteIntegration(id: string): boolean {
  const existing = getIntegrationById(id);
  if (!existing) return false;

  const db = getDb();
  try {
    db.delete(chatIntegrations).where(eq(chatIntegrations.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("chatIntegration", err as Error, id);
  }
  return true;
}
