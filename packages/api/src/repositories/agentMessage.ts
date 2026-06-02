import { getDb } from "../db/index.js";
import { agentMessages } from "../db/schema/index.js";
import { eq, and, isNull, sql, count } from "drizzle-orm";

import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface AgentMessage {
  id: string;
  habitatId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string | null;
  subject: string;
  body: string;
  messageType: "info" | "request" | "response" | "alert";
  priority: "low" | "normal" | "high" | "urgent";
  readAt: string | null;
  createdAt: string;
}

export interface SendMessageInput {
  habitatId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId?: string;
  subject: string;
  body: string;
  messageType?: "info" | "request" | "response" | "alert";
  priority?: "low" | "normal" | "high" | "urgent";
}

export function createMessage(input: SendMessageInput): AgentMessage {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(agentMessages)
      .values({
        id,
        habitatId: input.habitatId,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        taskId: input.taskId ?? null,
        subject: input.subject,
        body: input.body,
        messageType: input.messageType ?? "info",
        priority: input.priority ?? "normal",
        readAt: null,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("agentMessage", err as Error, id);
  }

  const message = getMessageById(id);
  if (!message) throw repositoryNotFoundError("agentMessage", id);
  return message;
}

export function getMessageById(id: string): AgentMessage | null {
  const db = getDb();
  const rows = db.select().from(agentMessages).where(eq(agentMessages.id, id)).all();
  return rows.length > 0 ? (rows[0] as AgentMessage) : null;
}

export function getMessagesByAgent(
  agentId: string,
  filters?: { unreadOnly?: boolean; taskId?: string; limit?: number; offset?: number },
): { messages: AgentMessage[]; total: number } {
  const db = getDb();
  const conditions = [eq(agentMessages.toAgentId, agentId)];

  if (filters?.unreadOnly) {
    conditions.push(isNull(agentMessages.readAt));
  }
  if (filters?.taskId) {
    conditions.push(eq(agentMessages.taskId, filters.taskId));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(agentMessages).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const messages = db
    .select()
    .from(agentMessages)
    .where(where)
    .orderBy(sql`${agentMessages.createdAt} DESC`)
    .limit(limit)
    .offset(offset)
    .all() as AgentMessage[];

  return { messages, total };
}

export function getUnreadCount(agentId: string): number {
  const db = getDb();
  const rows = db
    .select({ count: count() })
    .from(agentMessages)
    .where(and(eq(agentMessages.toAgentId, agentId), isNull(agentMessages.readAt)))
    .all();
  return rows[0]?.count ?? 0;
}

export function markAsRead(messageId: string): AgentMessage | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(agentMessages)
      .set({ readAt: now })
      .where(and(eq(agentMessages.id, messageId), isNull(agentMessages.readAt)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("agentMessage", err as Error, messageId);
  }

  return getMessageById(messageId);
}

export function markAllAsRead(agentId: string): number {
  const db = getDb();

  const totalRows = db
    .select({ count: count() })
    .from(agentMessages)
    .where(and(eq(agentMessages.toAgentId, agentId), isNull(agentMessages.readAt)))
    .all();
  const countVal = totalRows[0]?.count ?? 0;

  const now = new Date().toISOString();
  try {
    db.update(agentMessages)
      .set({ readAt: now })
      .where(and(eq(agentMessages.toAgentId, agentId), isNull(agentMessages.readAt)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("agentMessage", err as Error, agentId);
  }

  return countVal;
}

export function deleteMessage(messageId: string): boolean {
  const db = getDb();
  try {
    db.delete(agentMessages).where(eq(agentMessages.id, messageId)).run();
  } catch (err) {
    throw repositoryDeleteError("agentMessage", err as Error, messageId);
  }
  return true;
}
