import { getDb } from "../db/index.js";
import { daemonInstances } from "../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { hashDaemonToken } from "../lib/daemonToken.js";
import { serviceUnavailable } from "../errors.js";
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
  stopIntent: string | null;
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
  stopIntent: daemonInstances.stopIntent,
  status: daemonInstances.status,
  metadata: daemonInstances.metadata,
  createdAt: daemonInstances.createdAt,
  updatedAt: daemonInstances.updatedAt,
} as const;

// Staged enforcement can defer later migrations while the API remains up.
// Probe per connection rather than assuming the new column exists.
function supportsStopIntent(): boolean {
  return (getDb().all(sql`PRAGMA table_info(daemon_instances)`) as Array<{ name: string }>)
    .some((column) => column.name === "stop_intent");
}

function publicFields() {
  return { ...daemonPublicFields, stopIntent: supportsStopIntent() ? daemonInstances.stopIntent : sql<string | null>`NULL` };
}

export function createDaemon(input: CreateDaemonInput): DaemonInstancePublic {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    if (!supportsStopIntent()) {
      db.run(sql`INSERT INTO daemon_instances (id, name, hostname, token_hash, max_concurrent, daemon_version, last_heartbeat_at, status, metadata, created_at, updated_at)
        VALUES (${id}, ${input.name}, ${input.hostname}, ${hashDaemonToken(input.plainToken)}, ${input.maxConcurrent}, ${input.daemonVersion}, ${now}, ${"online"}, ${JSON.stringify(input.metadata ?? {})}, ${now}, ${now})`);
    } else db.insert(daemonInstances)
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
    .select(publicFields())
    .from(daemonInstances)
    .where(eq(daemonInstances.id, id))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function getDaemonByTokenHash(tokenHash: string): DaemonInstancePublic | null {
  const db = getDb();
  const rows = db
    .select(publicFields())
    .from(daemonInstances)
    .where(eq(daemonInstances.tokenHash, tokenHash))
    .all();
  return rows.length > 0 ? rows[0] : null;
}

export function updateDaemonHeartbeat(id: string): DaemonInstancePublic | null {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    const intentFields = supportsStopIntent() ? { stopIntent: null } : {};
    db.update(daemonInstances)
      .set({
        lastHeartbeatAt: now,
        status: "online",
        ...intentFields,
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

/** Persist stop ownership before draining. A new heartbeat clears this token. */
export function beginDaemonStop(id: string, token: string): void {
  const db = getDb();
  if (!supportsStopIntent()) {
    throw serviceUnavailable("Daemon stop requires pending database migrations; resolve migration blockers and restart the API");
  }
  let updated: { id: string } | undefined;
  try {
    updated = db.update(daemonInstances).set({ stopIntent: token, updatedAt: new Date().toISOString() })
      .where(eq(daemonInstances.id, id)).returning({ id: daemonInstances.id }).get();
  } catch (err) {
    throw repositoryUpdateError("daemonInstance", err as Error, id);
  }
  if (!updated) throw repositoryNotFoundError("daemonInstance", id);
}

/** Finish or roll back only the intent we own, never a later heartbeat/start. */
export function completeDaemonStop(id: string, token: string, status: "online" | "offline"): void {
  const db = getDb();
  try {
    db.update(daemonInstances)
      .set({ status, stopIntent: null, updatedAt: new Date().toISOString() })
      .where(and(eq(daemonInstances.id, id), eq(daemonInstances.stopIntent, token)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("daemonInstance", err as Error, id);
  }
}

/** Fence a new start against recovery of the exact intent it observed. */
export function reserveDaemonStart(id: string, expectedIntent: string, newIntent: string): boolean {
  const db = getDb();
  try {
    const updated = db.update(daemonInstances)
      .set({ stopIntent: newIntent, updatedAt: new Date().toISOString() })
      .where(and(eq(daemonInstances.id, id), eq(daemonInstances.stopIntent, expectedIntent)))
      .returning({ id: daemonInstances.id }).get();
    return updated != null;
  } catch (err) {
    throw repositoryUpdateError("daemonInstance", err as Error, id);
  }
}

export function listDaemons(): DaemonInstancePublic[] {
  const db = getDb();
  return db
    .select(publicFields())
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
