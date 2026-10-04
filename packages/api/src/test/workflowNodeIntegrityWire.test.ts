/**
 * Workflow node integrity — SERVED wire contract (sql.js, REAL service).
 *
 * The admin attach route (`POST /missions/:id/workflow`) must validate the
 * WHOLE bundle of explicit endpoint pairs against the SELECTED Mission
 * before any write: a missing or foreign-Mission node (same Habitat or
 * foreign Habitat) is refused 400 VALIDATION_ERROR `Invalid workflow nodes`
 * with zero Workflow/gate/audit writes, on BOTH local prefixes
 * (`/api/v1`, `/api`). A valid first gate plus an invalid second proves
 * whole-input prevalidation (refused before writes — NOT rollback
 * evidence). The positive same-Mission attach keeps the 201 shape and the
 * post-commit best-effort `workflow_attached` audit.
 *
 * The drift-after-first-write rollback discriminator and the injected-SQL
 * fault live in `workflowNodeIntegrity.production.test.ts` (real
 * better-sqlite3 driver + statement-level seam).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { workflows, taskWorkflowGates, missionEvents } from "../db/schema/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { workflowRoutes } from "../routes/workflow.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";

const JWT_SECRET = "dev-secret-change-in-production";

function adminHeaders(): Record<string, string> {
  const token = jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
  return { authorization: `Bearer ${token}` };
}

function viewerHeaders(): Record<string, string> {
  const token = jwt.sign({ sub: "viewer-1", username: "viewer", role: "viewer" }, JWT_SECRET, {
    issuer: "orcy",
  });
  return { authorization: `Bearer ${token}` };
}

/** Two distinct wrapper closures so both local prefixes serve the same routes. */
async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(
    async (v1) => {
      await v1.register(workflowRoutes);
    },
    { prefix: "/api/v1" },
  );
  await f.register(
    async (dep) => {
      await dep.register(workflowRoutes);
    },
    { prefix: "/api" },
  );
  await f.ready();
  return f;
}

let app: FastifyInstance;
let habitatId: string;
let missionId: string;
let taskA: string;
let taskB: string;
let taskC: string;
let otherMissionId: string;
let otherMissionTaskId: string;
let foreignHabitatMissionId: string;
let foreignHabitatTaskId: string;

beforeEach(async () => {
  await initTestDb();
  app = await buildApp();

  const db = getDb();
  habitatId = habitatRepo.createHabitat({ name: "Wire Habitat" }).id;
  const column = columnRepo.createColumn({ habitatId, name: "Todo", order: 0 });
  missionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "selected-mission",
    createdBy: "t",
  }).id;
  taskA = taskCrudRepo.createTask({ missionId, title: "A", createdBy: "t" }).id;
  taskB = taskCrudRepo.createTask({ missionId, title: "B", createdBy: "t" }).id;
  taskC = taskCrudRepo.createTask({ missionId, title: "C", createdBy: "t" }).id;

  // Same-Habitat, DIFFERENT Mission endpoint — legal under the independent
  // FKs (existence only); must be refused by scope validation.
  otherMissionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "other-mission",
    createdBy: "t",
  }).id;
  otherMissionTaskId = taskCrudRepo.createTask({
    missionId: otherMissionId,
    title: "foreign-same-habitat",
    createdBy: "t",
  }).id;

  // Foreign-Habitat endpoint.
  const habitat2 = habitatRepo.createHabitat({ name: "Foreign Habitat" });
  const column2 = columnRepo.createColumn({ habitatId: habitat2.id, name: "Todo", order: 0 });
  foreignHabitatMissionId = missionRepo.createMission({
    habitatId: habitat2.id,
    columnId: column2.id,
    title: "foreign-habitat-mission",
    createdBy: "t",
  }).id;
  foreignHabitatTaskId = taskCrudRepo.createTask({
    missionId: foreignHabitatMissionId,
    title: "foreign-habitat",
    createdBy: "t",
  }).id;
  void db;
});

afterEach(async () => {
  await app.close();
  closeDb();
});

function attachBody(gates: Array<{ upstreamTaskKey: string; downstreamTaskKey: string }>) {
  return {
    definition: {
      gates: gates.map((g) => ({ ...g, gateType: "on_complete" })),
    },
    variables: { v: "1" },
  };
}

function workflowCount(): number {
  return getDb()
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.missionId, missionId))
    .all().length;
}

function gateCount(): number {
  return getDb()
    .select({ id: taskWorkflowGates.id })
    .from(taskWorkflowGates)
    .where(eq(taskWorkflowGates.missionId, missionId))
    .all().length;
}

function attachedAuditCount(): number {
  return getDb()
    .select()
    .from(missionEvents)
    .where(eq(missionEvents.missionId, missionId))
    .all()
    .filter((e) => e.action === "workflow_attached").length;
}

describe("workflow node integrity — served attach (sql.js, real service)", () => {
  it("refuses a same-Habitat foreign-Mission endpoint with 400 VALIDATION_ERROR on both local prefixes, writing nothing", async () => {
    for (const prefix of ["/api/v1", "/api"]) {
      const res = await app.inject({
        method: "POST",
        url: `${prefix}/missions/${missionId}/workflow`,
        headers: adminHeaders(),
        payload: attachBody([{ upstreamTaskKey: taskA, downstreamTaskKey: otherMissionTaskId }]),
      });
      expect(res.statusCode, `${prefix} status`).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("Invalid workflow nodes");
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.details).toBeUndefined();
    }
    expect(workflowCount()).toBe(0);
    expect(gateCount()).toBe(0);
    expect(attachedAuditCount()).toBe(0);
  });

  it("refuses a foreign-Habitat endpoint with 400 VALIDATION_ERROR, writing nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([{ upstreamTaskKey: foreignHabitatTaskId, downstreamTaskKey: taskB }]),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Invalid workflow nodes");
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(workflowCount()).toBe(0);
    expect(gateCount()).toBe(0);
    expect(attachedAuditCount()).toBe(0);
  });

  it("refuses a missing endpoint node with 400 VALIDATION_ERROR, writing nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([{ upstreamTaskKey: taskA, downstreamTaskKey: "no-such-task" }]),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid workflow nodes");
    expect(workflowCount()).toBe(0);
    expect(gateCount()).toBe(0);
  });

  it("a valid first gate followed by an input-invalid second gate is refused by whole-input prevalidation — zero writes (no-write proof, not rollback)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: otherMissionTaskId },
      ]),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid workflow nodes");
    expect(workflowCount()).toBe(0);
    expect(gateCount()).toBe(0);
    expect(attachedAuditCount()).toBe(0);
  });

  it("attaches a valid same-Mission two-gate workflow: 201 {workflow}, persisted shape, exactly one post-commit audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: taskC },
      ]),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.workflow.missionId).toBe(missionId);
    expect(body.workflow.habitatId).toBe(habitatId);
    expect(body.workflow.resolvedVariables).toEqual({ v: "1" });
    expect(workflowCount()).toBe(1);
    expect(gateCount()).toBe(2);
    expect(attachedAuditCount()).toBe(1);
  });

  it("keeps auth ahead of validity: a non-admin gets 403 even with a foreign node", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: viewerHeaders(),
      payload: attachBody([{ upstreamTaskKey: taskA, downstreamTaskKey: otherMissionTaskId }]),
    });
    expect(res.statusCode).toBe(403);
    expect(workflowCount()).toBe(0);
  });

  it("keeps the route-owned selected-Mission 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/no-such-mission/workflow`,
      headers: adminHeaders(),
      payload: attachBody([{ upstreamTaskKey: taskA, downstreamTaskKey: taskB }]),
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Mission not found");
  });
});
