import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskEvents, users } from "../db/schema/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { auditExportRoutes } from "../routes/auditExport.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";

const app = Fastify({ logger: false });
let url: string;
const token = jwt.sign({ sub: "audit-user", username: "audit-user", role: "admin" }, "dev-secret-change-in-production", { issuer: "orcy" });
const headers = { authorization: `Bearer ${token}` };

beforeAll(async () => {
  await initTestDb();
  const now = new Date().toISOString();
  getDb().insert(users).values({ id: "audit-user", username: "audit-user", passwordHash: "hash", displayName: "Audit User", role: "admin", createdAt: now, updatedAt: now }).run();
  const { habitat, columns } = habitatService.createHabitat({ name: "Audit pagination", defaultColumns: true });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: "Mission", createdBy: "audit-user" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "audit-user" });
  for (let i = 0; i < 1001; i++) {
    getDb().insert(taskEvents).values({ id: `page-${String(i).padStart(4, "0")}`, taskId: task.id, actorType: "human", actorId: "audit-user", action: "updated", metadata: {}, timestamp: i < 2 ? "2020-01-01T00:00:00.000Z" : new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() }).run();
  }
  registerErrorHandler(app);
  await app.register(auditExportRoutes);
  await app.ready();
  url = `/habitats/${habitat.id}/audit/events?taskId=${task.id}&actorId=audit-user`;
});
afterAll(async () => { await app.close(); closeDb(); });

describe("Habitat audit event pagination", () => {
  it("pages the real authorized projection in both orders, with stable ties", async () => {
    const get = async (query: string) => {
      const response = await app.inject({ method: "GET", url: `${url}${query}`, headers });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    const first = await get("");
    expect(first.events).toHaveLength(1000);
    expect(first.warnings.some((w: { code: string }) => w.code === "result_truncated")).toBe(true);
    expect(first.completenessSummary.totalEvents).toBe(1001);
    const last = await get("&limit=1&offset=1000&order=asc");
    expect(last.events).toHaveLength(1);
    expect(first.events.some((event: { id: string }) => event.id === last.events[0].id)).toBe(false);
    expect(last.warnings.some((w: { code: string }) => w.code === "result_truncated")).toBe(true);
    const desc = await get("&limit=1&offset=0&order=desc");
    expect(desc.events[0].id).toBe(last.events[0].id);
    const descLast = await get("&limit=2&offset=999&order=desc");
    expect(descLast.events.map((e: { id: string }) => e.id)).toEqual(["task_event:page-0000", "task_event:page-0001"]);
    const ties = await get("&limit=2&order=asc");
    expect(ties.events.map((e: { id: string }) => e.id)).toEqual(["task_event:page-0000", "task_event:page-0001"]);
  });

  it("rejects malformed controls with typed validation errors and preserves authentication", async () => {
    for (const query of ["limit=0", "limit=10001", "limit=1.5", "limit=", "limit=1&limit=2", "offset=-1", "offset=no", "offset=9007199254740992", "order=sideways"]) {
      const res = await app.inject({ method: "GET", url: `${url}&${query}`, headers });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    }
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});
