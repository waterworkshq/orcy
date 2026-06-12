import { getDb } from "../db/index.js";
import { daemonInstances } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { hashDaemonToken } from "../lib/daemonToken.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

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

  try {
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
  } catch (err) {
    throw repositoryCreateError("daemonInstance", err as Error, id);
  }

  const daemon = getDaemonById(id);
  if (!daemon) throw repositoryNotFoundError("daemonInstance", id);
  return daemon;
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
  try {
    db.update(daemonInstances)
      .set({
        lastHeartbeatAt: now,
        status: "online",
        updatedAt: now,
      })
      .where(eq(daemonInstances.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonInstance", err as Error, id);
  }
  return getDaemonById(id);
}

export function setDaemonStatus(
  id: string,
  status: "online" | "offline" | "draining",
): DaemonInstancePublic | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(daemonInstances)
      .set({ status, updatedAt: now })
      .where(eq(daemonInstances.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonInstance", err as Error, id);
  }
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

export function deleteDaemon(id: string): void {
  const db = getDb();
  try {
    db.delete(daemonInstances).where(eq(daemonInstances.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("daemonInstance", err as Error, id);
  }
}
