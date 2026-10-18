import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { createHabitat } from "../repositories/habitat.js";
import * as schedules from "../repositories/scheduledTask.js";
import { listOccurrencesForScheduleWithClient } from "../repositories/scheduledOccurrences.js";
import { scheduledTaskRoutes } from "../routes/scheduledTasks.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { registerErrorHandler } from "../errors/plugin.js";

let app: FastifyInstance;
let habitatId: string;
let headers: { authorization: string };
beforeEach(async () => {
  await initTestDb();
  const secret = randomBytes(32).toString("hex");
  setJwtSecret(secret);
  headers = { authorization: `Bearer ${jwt.sign({ sub: "calendar-test-user", username: "calendar", role: "admin" }, secret, { issuer: "orcy" })}` };
  habitatId = createHabitat({ name: "Calendar validation" }).id;
  app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(scheduledTaskRoutes, { prefix: "/api/v1" });
  await app.register(scheduledTaskRoutes, { prefix: "/api" });
  await app.ready();
});
afterEach(async () => { await app.close(); closeDb(); });

function create(prefix: string, scheduledAt: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `${prefix}/habitats/${habitatId}/scheduled-tasks`, headers,
    payload: { name: "Calendar", missionTitle: "Calendar mission", scheduleType: "once", scheduledAt, ...extra } });
}

describe.each(["/api/v1", "/api"])("scheduled ISO calendar admission through %s", (prefix) => {
  it("rejects February 30 instead of storing text for a normalized March run", async () => {
    const response = await create(prefix, "2026-02-30T09:00:00.000Z");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid schedule configuration" });
    expect(schedules.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });
  it.each([
    "2026-02-29", "2026-04-31T09:00", "1900-02-29T23:00:00-02:00",
    "2100-02-29T00:00:00+05:30", "2026-06-31T12:00:00Z", "0099-02-29T00:00:00Z",
  ])("rejects impossible calendar date %s without persistence", async (date) => {
    const response = await create(prefix, date);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid schedule configuration" });
    expect(schedules.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });

  it.each([
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2000-02-29T09:00:00Z", "2000-02-29T09:00:00.000Z"],
    ["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000Z"],
    ["0004-02-29T00:00:00Z", "0004-02-29T00:00:00.000Z"],
    ["2026-02-28T23:30:00-02:00", "2026-03-01T01:30:00.000Z"],
    ["2026-03-01T00:30:00+02:00", "2026-02-28T22:30:00.000Z"],
    ["2026-12-31T23:30:00-02:00", "2027-01-01T01:30:00.000Z"],
    ["2026-01-31T24:00:00Z", "2026-02-01T00:00:00.000Z"],
    ["2026-02-28T09:00", "2026-02-28T09:00:00.000Z"],
    ["Jan 2 2020 UTC", "2020-01-02T00:00:00.000Z"],
  ])("preserves valid calendar and offset behavior for %s", async (date, instant) => {
    const response = await create(prefix, date);
    expect(response.statusCode).toBe(201);
    expect(response.json().scheduledTask).toMatchObject({ scheduledAt: date, nextRunAt: instant });
    expect(schedules.getScheduledTasksByHabitatId(habitatId)).toHaveLength(1);
  });

  it.each(["interval", "cron"])("rejects impossible %s first-run overrides", async (scheduleType) => {
    const response = await create(prefix, "2026-02-30T00:00:00Z", {
      scheduleType, intervalMinutes: 5, cronExpression: "0 9 * * *",
    });
    expect(response.statusCode).toBe(400);
    expect(schedules.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });

  it("rejects an impossible PATCH without changing the prior due pointer or history", async () => {
    const created = await create(prefix, "2040-01-01T09:00:00.000Z");
    expect(created.statusCode).toBe(201);
    const before = created.json().scheduledTask;
    const response = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${before.id}`, headers,
      payload: { scheduledAt: "2040-02-30T09:00:00.000Z" } });
    expect(response.statusCode).toBe(400);
    expect(schedules.getScheduledTaskById(before.id)).toEqual(before);
    expect(listOccurrencesForScheduleWithClient(getDb(), before.id)).toEqual([]);
  });

  it.each(["dedicated", "patch"])("refuses %s enable of an impossible legacy date with no writes", async (mode) => {
    const saved = schedules.createScheduledTask({ habitatId, name: "Legacy", missionTitle: "Legacy mission",
      scheduleType: "once", scheduledAt: "2040-02-30T09:00:00Z", nextRunAt: "2040-03-01T09:00:00.000Z", createdBy: "calendar-test-user" });
    schedules.updateScheduledTask(saved.id, { enabled: false });
    const before = schedules.getScheduledTaskById(saved.id);
    const response = await app.inject(mode === "dedicated"
      ? { method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/enable`, headers }
      : { method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers, payload: { enabled: true } });
    expect(response.statusCode).toBe(400);
    expect(schedules.getScheduledTaskById(saved.id)).toEqual(before);
    expect(listOccurrencesForScheduleWithClient(getDb(), saved.id)).toEqual([]);
  });

});
