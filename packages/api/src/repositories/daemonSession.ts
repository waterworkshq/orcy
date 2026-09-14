import { getDb } from "../db/index.js";
import { daemonSessions } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { SessionStatus } from "@orcy/shared/types";
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
  executionToken: string | null;
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
  executionToken: daemonSessions.executionToken,
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

/**
 * Tx-aware session-join primitive: inserts a daemon session carrying the
 * claiming Task's `executionToken` on the caller-supplied `tx`. Called from
 * inside the claim authority's success hook so the session INSERT shares the
 * claim's transaction — a hook throw (e.g. FK violation) rolls back the
 * claim with it. Never calls `getDb()`.
 */
export function createDaemonSessionWithClient(
  tx: ReturnType<typeof getDb>,
  input: CreateDaemonSessionInput,
  executionToken: string,
): { id: string } {
  const id = uuid();
  const now = new Date().toISOString();
  try {
    tx.insert(daemonSessions)
      .values({
        id,
        daemonId: input.daemonId,
        agentId: input.agentId,
        taskId: input.taskId,
        habitatId: input.habitatId,
        pid: input.pid ?? null,
        executionToken,
        workdir: input.workdir,
        status: "starting",
        startedAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("daemonSession", err as Error, id);
  }
  return { id };
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

/**
 * Exact (taskId, executionToken) session lookup (daemon-worker contract A3):
 * unique by T1 construction (the session INSERT shares the claim tx that
 * mints the token), served by `idx_daemon_sessions_task`. The recovery
 * sweep's task-side leg resolves sessions ONLY this way — never by recency
 * or latest-row heuristics; legacy NULL-token sessions are naturally
 * excluded (`execution_token = ` never matches NULL).
 */
export function getSessionByTaskAndToken(
  taskId: string,
  executionToken: string,
): DaemonSessionRow | null {
  const db = getDb();
  const rows = db
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(
      and(eq(daemonSessions.taskId, taskId), eq(daemonSessions.executionToken, executionToken)),
    )
    .all();
  return rows.length > 0 ? rows[0] : null;
}

/** Statuses a session row may leave; everything past this fence is terminal. */
const ACTIVE_SESSION_STATUSES = sql`${daemonSessions.status} IN ('starting', 'running')`;

function buildStatusUpdate(
  id: string,
  status: SessionStatus,
  lastProgress?: string,
): Partial<typeof daemonSessions.$inferInsert> {
  const now = new Date().toISOString();
  const updates: Partial<typeof daemonSessions.$inferInsert> = { status, updatedAt: now };
  if (lastProgress !== undefined) updates.lastProgress = lastProgress;
  if (["completed", "failed", "released", "lost"].includes(status)) updates.endedAt = now;
  return updates;
}

/**
 * Monotonic status write (daemon-worker contract): every status UPDATE is
 * fenced with `AND status IN ('starting','running')` — the observed write is
 * the first accepted one and no later write can resurrect or flip a terminal
 * row (a stale standalone PATCH cannot turn `lost` back into `running`, and
 * two terminal PATCHes race to observed-first). `starting→running` remains a
 * normal in-fence transition; progress/pid/workdir writes never touch status.
 */
export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  lastProgress?: string,
): DaemonSessionRow | null {
  const db = getDb();
  try {
    db.update(daemonSessions)
      .set(buildStatusUpdate(id, status, lastProgress))
      .where(and(eq(daemonSessions.id, id), ACTIVE_SESSION_STATUSES))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonSession", err as Error, id);
  }
  return getSessionById(id);
}

/**
 * Tx-aware twin of {@link updateSessionStatus} — the same monotonic fence,
 * applied on the caller-supplied `tx` (the ghost sweep's terminalization
 * transaction re-reads the owner's heartbeat fresh and writes `lost` under
 * one `BEGIN IMMEDIATE`). Never calls `getDb()`.
 */
export function updateSessionStatusWithClient(
  tx: ReturnType<typeof getDb>,
  id: string,
  status: SessionStatus,
  lastProgress?: string,
): DaemonSessionRow | null {
  try {
    tx.update(daemonSessions)
      .set(buildStatusUpdate(id, status, lastProgress))
      .where(and(eq(daemonSessions.id, id), ACTIVE_SESSION_STATUSES))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonSession", err as Error, id);
  }
  const rows = tx
    .select(daemonSessionFields)
    .from(daemonSessions)
    .where(eq(daemonSessions.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
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
