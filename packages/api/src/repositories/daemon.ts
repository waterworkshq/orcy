import { getDb } from "../db/index.js";
import { daemonInstances, daemonAgents, daemonSessions, agents } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { hashDaemonToken } from "../lib/daemonToken.js";

export interface CreateDaemonInput {
  name: string;
  hostname: string;
  maxConcurrent: number;
  daemonVersion: string;
  plainToken: string;
  metadata?: Record<string, unknown>;
}

export interface DaemonInstancePublic {
  id: string;
  name: string;
  hostname: string;
  maxConcurrent: number;
  daemonVersion: string;
  lastHeartbeatAt: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const daemonPublicFields = {
  id: daemonInstances.id,
  name: daemonInstances.name,
  hostname: daemonInstances.hostname,
  maxConcurrent: daemonInstances.maxConcurrent,
  daemonVersion: daemonInstances.daemonVersion,
  lastHeartbeatAt: daemonInstances.lastHeartbeatAt,
  status: daemonInstances.status,
  metadata: daemonInstances.metadata,
  createdAt: daemonInstances.createdAt,
  updatedAt: daemonInstances.updatedAt,
} as const;

export function createDaemon(input: CreateDaemonInput): DaemonInstancePublic {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(daemonInstances)
    .values({
      id,
      name: input.name,
      hostname: input.hostname,
      tokenHash: hashDaemonToken(input.plainToken),
      maxConcurrent: input.maxConcurrent,
      daemonVersion: input.daemonVersion,
      lastHeartbeatAt: now,
      status: "online",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getDaemonById(id)!;
}

export function getDaemonById(id: string): DaemonInstancePublic | null {
  const db = getDb();
  const rows = db
    .select(daemonPublicFields)
    .from(daemonInstances)
    .where(eq(daemonInstances.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getDaemonByTokenHash(tokenHash: string): DaemonInstancePublic | null {
  const db = getDb();
  const rows = db
    .select(daemonPublicFields)
    .from(daemonInstances)
    .where(eq(daemonInstances.tokenHash, tokenHash))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateDaemonHeartbeat(id: string): DaemonInstancePublic | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.update(daemonInstances)
    .set({
      lastHeartbeatAt: now,
      status: "online",
      updatedAt: now,
    })
    .where(eq(daemonInstances.id, id))
    .run();
  return getDaemonById(id);
}

export function setDaemonStatus(
  id: string,
  status: "online" | "offline" | "draining",
): DaemonInstancePublic | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.update(daemonInstances)
    .set({ status, updatedAt: now })
    .where(eq(daemonInstances.id, id))
    .run();
  return getDaemonById(id);
}

export function listDaemons(): DaemonInstancePublic[] {
  const db = getDb();
  return db
    .select(daemonPublicFields)
    .from(daemonInstances)
    .orderBy(sql`${daemonInstances.createdAt} DESC`)
    .all();
}

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

  return getDaemonAgentById(id)!;
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
  db.update(daemonAgents)
    .set({ status, lastSeenAt: now, updatedAt: now })
    .where(eq(daemonAgents.id, id))
    .run();
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

export interface CreateDaemonSessionInput {
  daemonId: string;
  agentId: string;
  taskId: string;
  habitatId: string;
  workdir: string;
  pid?: number;
}

export interface DaemonSessionRow {
  id: string;
  daemonId: string;
  agentId: string;
  taskId: string;
  habitatId: string;
  pid: number | null;
  cliSessionId: string | null;
  workdir: string;
  status: string;
  lastProgress: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

const daemonSessionFields = {
  id: daemonSessions.id,
  daemonId: daemonSessions.daemonId,
  agentId: daemonSessions.agentId,
  taskId: daemonSessions.taskId,
  habitatId: daemonSessions.habitatId,
  pid: daemonSessions.pid,
  cliSessionId: daemonSessions.cliSessionId,
  workdir: daemonSessions.workdir,
  status: daemonSessions.status,
  lastProgress: daemonSessions.lastProgress,
  startedAt: daemonSessions.startedAt,
  endedAt: daemonSessions.endedAt,
  updatedAt: daemonSessions.updatedAt,
} as const;

export function createDaemonSession(input: CreateDaemonSessionInput): DaemonSessionRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(daemonSessions)
    .values({
      id,
      daemonId: input.daemonId,
      agentId: input.agentId,
      taskId: input.taskId,
      habitatId: input.habitatId,
      pid: input.pid ?? null,
      workdir: input.workdir,
      status: "starting",
      startedAt: now,
      updatedAt: now,
    })
    .run();

  return getSessionById(id)!;
}

export function getSessionById(id: string): DaemonSessionRow | null {
  const db = getDb();
  const rows = db
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(eq(daemonSessions.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getSessionsByDaemonId(daemonId: string): DaemonSessionRow[] {
  const db = getDb();
  return db
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(eq(daemonSessions.daemonId, daemonId))
    .all();
}

export function getActiveSessionByTaskId(taskId: string): DaemonSessionRow | null {
  const db = getDb();
  const rows = db
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(
      and(
        eq(daemonSessions.taskId, taskId),
        sql`${daemonSessions.status} IN ('starting', 'running')`,
      ),
    )
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateSessionStatus(
  id: string,
  status: "starting" | "running" | "completed" | "failed" | "released" | "lost",
  lastProgress?: string,
): DaemonSessionRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const updates: Partial<typeof daemonSessions.$inferInsert> = { status, updatedAt: now };
  if (lastProgress !== undefined) updates.lastProgress = lastProgress;
  if (["completed", "failed", "released", "lost"].includes(status)) updates.endedAt = now;
  db.update(daemonSessions).set(updates).where(eq(daemonSessions.id, id)).run();
  return getSessionById(id);
}

export function deleteDaemon(id: string): void {
  const db = getDb();
  db.delete(daemonInstances).where(eq(daemonInstances.id, id)).run();
}
