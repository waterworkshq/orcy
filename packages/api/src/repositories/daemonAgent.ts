import { getDb } from "../db/index.js";
import { daemonAgents } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export interface CreateDaemonAgentInput {
  daemonId: string;
  agentId: string;
  cliType: string;
  cliVersion: string | null;
  cliPath: string;
}

export interface DaemonAgentRow {
  id: string;
  daemonId: string;
  agentId: string;
  cliType: string;
  cliVersion: string | null;
  cliPath: string;
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const daemonAgentFields = {
  id: daemonAgents.id,
  daemonId: daemonAgents.daemonId,
  agentId: daemonAgents.agentId,
  cliType: daemonAgents.cliType,
  cliVersion: daemonAgents.cliVersion,
  cliPath: daemonAgents.cliPath,
  status: daemonAgents.status,
  lastSeenAt: daemonAgents.lastSeenAt,
  createdAt: daemonAgents.createdAt,
  updatedAt: daemonAgents.updatedAt,
} as const;

export function createDaemonAgent(input: CreateDaemonAgentInput): DaemonAgentRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(daemonAgents)
      .values({
        id,
        daemonId: input.daemonId,
        agentId: input.agentId,
        cliType: input.cliType as any,
        cliVersion: input.cliVersion,
        cliPath: input.cliPath,
        status: "idle",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("daemonAgent", err as Error, id);
  }

  const agent = getDaemonAgentById(id);
  if (!agent) throw repositoryNotFoundError("daemonAgent", id);
  return agent;
}

export function getDaemonAgentById(id: string): DaemonAgentRow | null {
  const db = getDb();
  const rows = db.select(daemonAgentFields).from(daemonAgents).where(eq(daemonAgents.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function getDaemonAgentsByDaemonId(daemonId: string): DaemonAgentRow[] {
  const db = getDb();
  return db
    .select(daemonAgentFields)
    .from(daemonAgents)
    .where(eq(daemonAgents.daemonId, daemonId))
    .all();
}

export function getDaemonAgentByAgentId(agentId: string): DaemonAgentRow | null {
  const db = getDb();
  const rows = db
    .select(daemonAgentFields)
    .from(daemonAgents)
    .where(eq(daemonAgents.agentId, agentId))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateDaemonAgentStatus(
  id: string,
  status: "idle" | "working" | "offline",
): DaemonAgentRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(daemonAgents)
      .set({ status, lastSeenAt: now, updatedAt: now })
      .where(eq(daemonAgents.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonAgent", err as Error, id);
  }
  return getDaemonAgentById(id);
}

export function isAgentOwnedByDaemon(agentId: string, daemonId: string): boolean {
  const db = getDb();
  const rows = db
    .select({ id: daemonAgents.id })
    .from(daemonAgents)
    .where(and(eq(daemonAgents.agentId, agentId), eq(daemonAgents.daemonId, daemonId)))
    .all();
  return rows.length > 0;
}
