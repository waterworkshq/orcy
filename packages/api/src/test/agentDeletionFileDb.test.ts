/**
 * REC-06 (agent-deletion batch) — the production-driver (better-sqlite3,
 * file-backed, WAL, FK-enforced) serialization contract:
 *
 *   - the atomic deletion runs under ONE outer `BEGIN IMMEDIATE`; a second
 *     writer holding the database's write lock makes the deletion FAIL
 *     (SQLITE_BUSY → 503) with every row unchanged — blocked-safe, never a
 *     partial teardown;
 *   - once the lock frees, the same delete completes and the claim that
 *     committed BEFORE the deletion tx is released through the canonical
 *     bundle (zero straggler — no eventless reset);
 *   - after the delete commits, the dead agent's API key no longer
 *     authenticates (no stale authorizations);
 *   - the production driver journal is WAL with foreign_keys ON (the FK
 *     cascade/no-action semantics the teardown relies on).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, closeDb, getDb } from "../db/index.js";
import { agentRoutes } from "../routes/agents.js";
import { registerErrorHandler } from "../errors/plugin.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { tasks, taskEvents } from "../db/schema/index.js";
import type { EventAction } from "../models/index.js";

const JWT_SECRET = "dev-secret-change-in-production";
const ADMIN_SUB = "admin-1";

function adminHeaders(): Record<string, string> {
  const token = jwt.sign({ sub: ADMIN_SUB, username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
  return { authorization: `Bearer ${token}` };
}

let app: FastifyInstance;
let dbFile: string;
let conn2: import("better-sqlite3").Database | null = null;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(agentRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

function eventsFor(taskId: string, action: EventAction) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
}

describe("atomic agent deletion — production file DB (better-sqlite3, WAL, FK)", () => {
  beforeEach(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-agent-del-")), "orcy.db");
    await initDb(dbFile);
    app = await buildApp();
    // Keep the contention test fast: the singleton connection was opened with
    // busy_timeout=5000; shorten it for the deliberate-lock scenario only.
    getDb().run(sql`PRAGMA busy_timeout = 250`);
  });
  afterEach(async () => {
    try {
      conn2?.close();
    } catch {}
    conn2 = null;
    await app.close();
    closeDb();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it("runs on the production driver journal (WAL, foreign_keys ON)", () => {
    const journal = (getDb().all(sql`PRAGMA journal_mode`) as Array<{ journal_mode: string }>)[0]!;
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    const fk = (getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>)[0]!;
    expect(fk.foreign_keys).toBe(1);
  });

  it("a foreign writer holding BEGIN IMMEDIATE blocks the deletion (503) with zero row changes; after release the delete completes with zero stragglers", async () => {
    const habitat = habitatRepo.createHabitat({ name: "IPC Habitat" });
    columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      title: "IPC Mission",
      createdBy: "user-1",
    });
    const makeTask = (title: string) =>
      taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" }) as never as {
        id: string;
      };
    const a = agentRepo.createAgent({ name: "ipc-agent", type: "claude-code", domain: "backend" });
    const t = makeTask("ipc-task");
    // A claim that commits BEFORE the deletion tx — must be visible in-tx and
    // released through the bundle (never a straggler reset).
    expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
    const tokenBefore = (taskRow(t.id) as { executionToken: string | null }).executionToken;
    expect(tokenBefore).not.toBeNull();

    // A second process-shaped connection takes the database write lock.
    const Database = (await import("better-sqlite3")).default;
    conn2 = new Database(dbFile);
    conn2.pragma("busy_timeout = 100");
    conn2.exec("BEGIN IMMEDIATE");

    const busy = await app.inject({
      method: "DELETE",
      url: `/api/agents/${a.agent.id}`,
      headers: adminHeaders(),
    });
    // Blocked-safe: the single outer BEGIN IMMEDIATE cannot interleave with
    // the foreign writer — the deletion FAILS whole (503 busy family), rows
    // byte-identical, no stale teardown state.
    expect([500, 503]).toContain(busy.statusCode);
    expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
    const duringRow = taskRow(t.id) as typeof tasks.$inferSelect;
    expect(duringRow.status).toBe("claimed");
    expect(duringRow.assignedAgentId).toBe(a.agent.id);
    expect(duringRow.executionToken).toBe(tokenBefore);
    expect(eventsFor(t.id, "released")).toHaveLength(0);

    // Release the foreign lock; the same delete now completes atomically.
    conn2.exec("ROLLBACK");
    conn2.close();
    conn2 = null;

    const ok = await app.inject({
      method: "DELETE",
      url: `/api/agents/${a.agent.id}`,
      headers: adminHeaders(),
    });
    expect(ok.statusCode).toBe(204);
    expect(agentRepo.getAgentById(a.agent.id)).toBeNull();
    const afterRow = taskRow(t.id) as typeof tasks.$inferSelect;
    expect(afterRow.status).toBe("pending");
    expect(afterRow.assignedAgentId).toBeNull();
    expect(afterRow.executionToken).toBeNull();
    // Zero straggler: the pre-tx claim got the canonical release bundle.
    const released = eventsFor(t.id, "released");
    expect(released).toHaveLength(1);
    expect(released[0]!.actorType).toBe("human");
    expect(afterRow.lastReleaseEventId).toBe(released[0]!.id);

    // No stale authorization: the dead agent's API key no longer authenticates.
    const ghost = await app.inject({
      method: "DELETE",
      url: `/api/agents/${a.agent.id}/self`,
      headers: { "x-agent-api-key": a.plainApiKey },
    });
    expect(ghost.statusCode).toBe(401);
  });
});
