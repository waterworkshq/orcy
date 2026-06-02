import { getDb } from "../db/index.js";
import { agents, tasks } from "../db/schema/index.js";
import { eq, and, not, lt, sql, inArray } from "drizzle-orm";

import type { Agent, AgentType, AgentDomain, AgentStatus } from "../models/index.js";
import { v4 as uuid } from "uuid";
import { createHash, randomBytes } from "crypto";
import {
  repositoryCreateError,
  assertFound,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryTransactionError,
} from "../errors/repository.js";

export interface CreateAgentInput {
  name: string;
  type: AgentType;
  domain: AgentDomain;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentInput {
  name?: string;
  type?: AgentType;
  domain?: AgentDomain;
  capabilities?: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
  rateLimitPerMinute?: number | null;
}

type AgentPublic = Omit<Agent, "apiKeyHash">;

const agentPublicFields = {
  id: agents.id,
  name: agents.name,
  type: agents.type,
  domain: agents.domain,
  capabilities: agents.capabilities,
  status: agents.status,
  currentTaskId: agents.currentTaskId,
  rateLimitPerMinute: agents.rateLimitPerMinute,
  createdAt: agents.createdAt,
  lastHeartbeat: agents.lastHeartbeat,
  metadata: agents.metadata,
} as const;

export function createAgent(input: CreateAgentInput): { agent: AgentPublic; plainApiKey: string } {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  const plainApiKey = `${id}-${randomBytes(16).toString("hex")}`;
  const apiKeyHash = hashApiKey(plainApiKey);

  try {
    db.insert(agents)
      .values({
        id,
        name: input.name,
        type: input.type,
        domain: input.domain,
        capabilities: input.capabilities ?? [],
        status: "idle",
        apiKey: apiKeyHash,
        createdAt: now,
        lastHeartbeat: now,
        metadata: input.metadata ?? {},
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("agent", err as Error, id);
  }

  return { agent: assertFound(getAgentById(id), "agent", id), plainApiKey };
}

export function getAgentById(id: string): AgentPublic | null {
  const db = getDb();
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function listAgents(): AgentPublic[] {
  const db = getDb();
  return db
    .select(agentPublicFields)
    .from(agents)
    .orderBy(sql`${agents.createdAt} DESC`)
    .all();
}

export function getAgentByName(name: string): AgentPublic | null {
  const db = getDb();
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.name, name)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getAgentByApiKey(plainKey: string): AgentPublic | null {
  const db = getDb();
  const hash = hashApiKey(plainKey);
  const rows = db.select(agentPublicFields).from(agents).where(eq(agents.apiKey, hash)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateAgent(id: string, input: UpdateAgentInput): AgentPublic | null {
  const db = getDb();
  const updates: Partial<typeof agents.$inferInsert> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.type !== undefined) updates.type = input.type;
  if (input.domain !== undefined) updates.domain = input.domain;
  if (input.capabilities !== undefined) updates.capabilities = input.capabilities;
  if (input.status !== undefined) updates.status = input.status;
  if (input.metadata !== undefined) updates.metadata = input.metadata;
  if (input.rateLimitPerMinute !== undefined) updates.rateLimitPerMinute = input.rateLimitPerMinute;

  if (Object.keys(updates).length === 0) return getAgentById(id);

  try {
    db.update(agents).set(updates).where(eq(agents.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, id);
  }
  return getAgentById(id);
}

export function deleteAgent(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.transaction((tx) => {
      tx.update(tasks)
        .set({
          assignedAgentId: null,
          status: "pending",
          updatedAt: now,
        })
        .where(
          and(eq(tasks.assignedAgentId, id), inArray(tasks.status, ["claimed", "in_progress"])),
        )
        .run();

      tx.delete(agents).where(eq(agents.id, id)).run();
    });
  } catch (err) {
    throw repositoryTransactionError("agent", err as Error, id);
  }
}

export function heartbeat(agentId: string, taskId?: string): AgentPublic | null {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    if (taskId) {
      db.update(agents)
        .set({
          lastHeartbeat: now,
          currentTaskId: taskId,
          status: "working",
        })
        .where(eq(agents.id, agentId))
        .run();
    } else {
      db.update(agents)
        .set({
          lastHeartbeat: now,
          status: "idle",
          currentTaskId: null,
        })
        .where(eq(agents.id, agentId))
        .run();
    }
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }

  return getAgentById(agentId);
}

export function getStaleAgents(thresholdMinutes: number = 30): AgentPublic[] {
  const db = getDb();
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  return db
    .select(agentPublicFields)
    .from(agents)
    .where(and(lt(agents.lastHeartbeat, threshold), not(eq(agents.status, "offline"))))
    .all();
}

export function setAgentOffline(agentId: string): void {
  const db = getDb();
  try {
    db.update(agents)
      .set({
        status: "offline",
        currentTaskId: null,
      })
      .where(eq(agents.id, agentId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("agent", err as Error, agentId);
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
