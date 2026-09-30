/**
 * Task dependency fault + production-driver checks (dependency-contract).
 *
 * Three claims the sql.js wire matrix alone cannot prove:
 *
 * 1. A database fault at the DELETION STATEMENT itself — after successful
 *    authentication, source admission and exact-pair lookup — propagates as
 *    500 INTERNAL_ERROR with the edge preserved, never flattening into 404
 *    or a false success. Proven on the real wire with a live database via a
 *    sql.js `BEFORE DELETE` trigger raising a distinct abort error, driven
 *    by a valid human JWT (no DB-backed authentication ambiguity), with a
 *    same-request differential control: dropping the trigger turns the
 *    identical request into 200 success and removes the edge.
 *
 * 2. A database that is entirely unavailable when the request arrives is
 *    500, not 404/success. Proven by closing the initialized database
 *    between two real requests to the same live server (this fault surfaces
 *    at the first repository call — authentication for the agent key used
 *    — NOT at the deletion statement; the deletion-statement proof is (1)).
 *
 * 3. The duplicate-insert classifier and the matched-deletion result run
 *    correctly on the PRODUCTION driver (better-sqlite3, SqliteError
 *    `.code === "SQLITE_CONSTRAINT_UNIQUE"`, DELETE ... RETURNING), via a
 *    real file DB from `initDb()` — labeled unit-level driver
 *    classification because the shared wire harness runs on sql.js.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as dependencyService from "../services/dependencyService.js";
import * as agentRepo from "../repositories/agent.js";
import { taskDependencies } from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { and, eq, sql } from "drizzle-orm";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function edgeRowsFor(taskId: string, dependsOnId: string) {
  return getDb()
    .select()
    .from(taskDependencies)
    .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
    .all();
}

describe("task dependency DELETE — absent pair 404 vs DB failure 5xx on the real wire", () => {
  let app: HttpRuntimeHandle;
  let baseUrl: string;
  let srcId: string;
  let depId: string;
  let agentKey: string;
  let humanJwt: string;

  beforeAll(async () => {
    await initTestDb();
    app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
    await app.finalize();
    const port = await freePort();
    await app.listen({ port, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${port}`;

    const habitatId = habitatRepo.createHabitat({ name: "tdf-habitat" }).id;
    const column = columnRepo.createColumn({
      habitatId,
      name: "tdf-col",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "tdf-mission",
      createdBy: "tdf-seed",
    });
    srcId = taskRepo.createTask({
      missionId: mission.id,
      title: "tdf-src",
      createdBy: "tdf-seed",
    }).id;
    depId = taskRepo.createTask({
      missionId: mission.id,
      title: "tdf-dep",
      createdBy: "tdf-seed",
    }).id;
    dependencyRepo.addTaskDependency(srcId, depId);

    const created = agentRepo.createAgent({
      name: "tdf-agent",
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
    agentKey = created.plainApiKey;
    humanJwt = jwt.sign(
      { sub: "tdf-human", username: "tdf-human", role: "admin" },
      getJwtSecret(),
      {
        expiresIn: "1h",
        issuer: "orcy",
      },
    );
  }, 120_000);

  afterAll(async () => {
    await app.close();
    closeDb();
  });

  it("deletion-statement fault after successful admission is 500 with the edge preserved; identical request succeeds once the trigger is dropped", async () => {
    // The trigger fires ONLY on DELETE of task_dependencies. A 500 here
    // therefore proves the request passed installed auth, source admission
    // and the exact-pair lookup and reached the deletion statement itself;
    // a 401/403/404 would mean it never got there. Valid human JWT keeps
    // authentication DB-free; the differential control below reruns the
    // byte-identical request with only the trigger removed.
    const db = getDb();
    db.run(
      sql`CREATE TRIGGER tdf_review_deletion_fault BEFORE DELETE ON task_dependencies BEGIN SELECT RAISE(ABORT, 'review deletion failure'); END`,
    );

    try {
      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${srcId}/dependencies/${depId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${humanJwt}` },
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(body.success).toBeUndefined();
      // The aborting DELETE preserved the edge row.
      expect(edgeRowsFor(srcId, depId)).toHaveLength(1);
    } finally {
      db.run(sql`DROP TRIGGER tdf_review_deletion_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${srcId}/dependencies/${depId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${humanJwt}` },
    });
    expect(control.status).toBe(200);
    expect(((await control.json()) as any).success).toBe(true);
    expect(edgeRowsFor(srcId, depId)).toHaveLength(0);
  }, 30_000);

  it("absent pair stays a clean 404 while the DB is up", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/tasks/${srcId}/dependencies/00000000-0000-4000-8000-000000000091`,
      { method: "DELETE", headers: { "x-agent-api-key": agentKey } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("Dependency not found");
  }, 30_000);

  it("database entirely unavailable when the request arrives is 500, never 404 or success", async () => {
    // This fault surfaces at the FIRST repository call (agent-key
    // authentication's DB read), not at the deletion statement — the
    // deletion-statement proof is the trigger test above. It still pins the
    // outcome contract: infra failure maps to 500 INTERNAL_ERROR.
    closeDb();

    const res = await fetch(`${baseUrl}/api/v1/tasks/${srcId}/dependencies/${depId}`, {
      method: "DELETE",
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.success).toBeUndefined();
  }, 30_000);
});

describe("task dependency service — production driver (better-sqlite3 file DB)", () => {
  let dbFile: string;
  let taskIdA: string;
  let taskIdB: string;

  beforeEach(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tdf-prod-")), "orcy.db");
    await initDb(dbFile);
    const habitatId = habitatRepo.createHabitat({ name: "tdf-prod-habitat" }).id;
    const column = columnRepo.createColumn({
      habitatId,
      name: "tdf-prod-col",
      order: 0,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "tdf-prod-mission",
      createdBy: "tdf-seed",
    });
    taskIdA = taskRepo.createTask({
      missionId: mission.id,
      title: "tdf-prod-a",
      createdBy: "tdf-seed",
    }).id;
    taskIdB = taskRepo.createTask({
      missionId: mission.id,
      title: "tdf-prod-b",
      createdBy: "tdf-seed",
    }).id;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it("duplicate insert maps to already_exists via the SqliteError code path", () => {
    const first = dependencyService.addTaskDependency(taskIdA, taskIdB);
    expect(first).toEqual({ success: true });

    const second = dependencyService.addTaskDependency(taskIdA, taskIdB);
    expect(second).toEqual({ success: false, reason: "already_exists" });
  }, 30_000);

  it("matched deletion reflects rows actually deleted (DELETE ... RETURNING)", () => {
    expect(dependencyService.removeTaskDependency(taskIdA, taskIdB)).toBe(false);

    dependencyRepo.addTaskDependency(taskIdA, taskIdB);
    expect(dependencyService.removeTaskDependency(taskIdA, taskIdB)).toBe(true);
    expect(dependencyService.removeTaskDependency(taskIdA, taskIdB)).toBe(false);
  }, 30_000);
});
