import { getDb } from "../db/index.js";
import { daemonSessions } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

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

  try {
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
  } catch (err) {
    throw repositoryCreateError("daemonSession", err as Error, id);
  }

  const session = getSessionById(id);
  if (!session) throw repositoryNotFoundError("daemonSession", id);
  return session;
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

export function getActiveSessionsByDaemonId(daemonId: string): DaemonSessionRow[] {
  const db = getDb();
  return db
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(
      and(
        eq(daemonSessions.daemonId, daemonId),
        sql`${daemonSessions.status} IN ('starting', 'running')`,
      ),
    )
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
  try {
    db.update(daemonSessions).set(updates).where(eq(daemonSessions.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("daemonSession", err as Error, id);
  }
  return getSessionById(id);
}

export function updateSessionProgress(
  id: string,
  fields: Record<string, unknown>,
): DaemonSessionRow | null {
  const db = getDb();
  const now = new Date().toISOString();
  const updates: Partial<typeof daemonSessions.$inferInsert> = { updatedAt: now };
  if (fields.lastProgress) updates.lastProgress = fields.lastProgress as string;
  if (fields.pid !== undefined) updates.pid = fields.pid as number | null;
  if (fields.workdir !== undefined) updates.workdir = fields.workdir as string;
  if (fields.cliSessionId !== undefined)
    updates.cliSessionId = fields.cliSessionId as string | null;
  try {
    db.update(daemonSessions).set(updates).where(eq(daemonSessions.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("daemonSession", err as Error, id);
  }
  return getSessionById(id);
}
