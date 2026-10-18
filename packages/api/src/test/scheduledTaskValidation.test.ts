import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import { processDueTasks } from "../services/scheduledTaskService.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import { scheduledTaskRoutes } from "../routes/scheduledTasks.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { registerErrorHandler } from "../errors/plugin.js";

// Real HTTP parsing, authentication, cron parser and DB: no internal mocks.
let app: FastifyInstance;
let habitatId: string;
const secret = "schedule-validation-test-secret";
const headers = {
  authorization: `Bearer ${jwt.sign({ sub: "schedule-user", username: "scheduler", role: "admin" }, secret, { issuer: "orcy" })}`,
};

beforeEach(async () => {
  await initTestDb();
  setJwtSecret(secret);
  habitatId = habitatRepo.createHabitat({ name: "Schedule validation" }).id;
  app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(scheduledTaskRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb();
  vi.useRealTimers();
});

function create(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/habitats/${habitatId}/scheduled-tasks`, headers,
    payload: { name: "Schedule", missionTitle: "Scheduled mission", ...payload },
  });
}

describe("scheduled task semantic admission", () => {
  it("preserves UTC wall time for an offsetless UI first run regardless of server timezone", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    try {
      // Pin the boundary in the committed test, even on UTC CI workers.
      expect(new Date("2026-10-18T12:00:00.000Z").getTimezoneOffset()).toBe(-330);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
      columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
      const scheduledAt = "2026-10-18T13:00";
      const response = await create({ scheduleType: "once", scheduledAt, tasksTemplate: [{ title: "Actual scheduled task" }] });
      expect(response.statusCode).toBe(201);
      const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);

      // The UI's offsetless wall time historically compares against UTC due pointers.
      // Poll before and at the independently specified instant, not a host-local Date parse.
      expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
      expect(saved).toMatchObject({ scheduledAt, timezone: "UTC", nextRunAt: "2026-10-18T13:00:00.000Z" });
      vi.setSystemTime(new Date("2026-10-18T13:00:00.000Z"));
      expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 1, enabled: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["2026-10-18T13:00:00", "2026-10-18T13:00:00.000Z"],
    ["2026-10-18t13:00:00.125", "2026-10-18T13:00:00.125Z"],
    ["2026-10-18T15:00:00+02:00", "2026-10-18T13:00:00.000Z"],
    ["2026-10-18T11:00:00-02:00", "2026-10-18T13:00:00.000Z"],
    ["2026-10-18T13:00:00.000Z", "2026-10-18T13:00:00.000Z"],
    ["Oct 18 2026 13:00 UTC", "2026-10-18T13:00:00.000Z"],
    ["2026-10-19", "2026-10-19T00:00:00.000Z"],
  ])("keeps first-run input %s on its UTC instant independently of the selected timezone", async (scheduledAt, expectedInstant) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
    const response = await create({
      scheduleType: "once", scheduledAt, timezone: "America/New_York",
      tasksTemplate: [{ title: "Actual scheduled task" }],
    });
    expect(response.statusCode).toBe(201);
    const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    expect(saved).toMatchObject({ scheduledAt, timezone: "America/New_York", nextRunAt: expectedInstant });
    vi.setSystemTime(new Date(expectedInstant));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 1, enabled: false });
  });

  it.each([
    [{ scheduleType: "interval", intervalMinutes: 5 }, "2026-10-18T12:35:00.000Z"],
    [{ scheduleType: "cron", cronExpression: "0 9 * * *" }, "2026-10-18T13:00:00.000Z"],
  ] as const)("keeps an offsetless recurring first-run override separate from its later cadence (%j)", async (configuration, nextCadence) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
    const response = await create({
      ...configuration, scheduledAt: "2026-10-18T12:30", timezone: "America/New_York",
      tasksTemplate: [{ title: "Actual scheduled task" }],
    });
    expect(response.statusCode).toBe(201);
    const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    expect(saved.nextRunAt).toBe("2026-10-18T12:30:00.000Z");
    vi.setSystemTime(new Date("2026-10-18T12:30:00.000Z"));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({
      scheduledAt: "2026-10-18T12:30", runCount: 1, enabled: true, nextRunAt: nextCadence,
    });
  });

  it("continues applying the selected timezone to cron when no first-run override is supplied", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
    const response = await create({
      scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York",
      tasksTemplate: [{ title: "Actual scheduled task" }],
    });
    expect(response.statusCode).toBe(201);
    const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(saved).toMatchObject({ scheduledAt: null, nextRunAt: "2026-10-18T13:00:00.000Z" });
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    vi.setSystemTime(new Date("2026-10-18T13:00:00.000Z"));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({
      runCount: 1, enabled: true, nextRunAt: "2026-10-19T13:00:00.000Z",
    });
  });

  it("executes a past noncanonical first run created through HTTP", async () => {
    // Clock boundary only: HTTP, due scan and occurrence publication use real code and DB.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
    const scheduledAt = "Jan 2 2020 UTC";
    const response = await create({ scheduleType: "once", scheduledAt, tasksTemplate: [{ title: "Actual scheduled task" }] });
    expect(response.statusCode).toBe(201);
    const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(saved.scheduledAt).toBe(scheduledAt);

    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({
      runCount: 1, enabled: false,
    });
  });

  describe.each([
    { scheduleType: "once" },
    { scheduleType: "interval", intervalMinutes: 5 },
    { scheduleType: "cron", cronExpression: "0 9 * * *" },
  ] as const)("first-run instant for $scheduleType", (configuration) => {
    it.each([
      ["Jan 2 2020 UTC", true],
      ["2026-10-18T13:00:00+02:00", true],
      ["2026-10-18T11:00:00-02:00", false],
      ["2026-10-18T11:00:00.000Z", true],
      ["2026-10-18T13:00:00.000Z", false],
    ] as const)("preserves input and polls by its UTC instant (%s)", async (scheduledAt, isDue) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
      columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
      const response = await create({
        ...configuration, scheduledAt, tasksTemplate: [{ title: "Actual scheduled task" }],
      });
      expect(response.statusCode).toBe(201);
      const [saved] = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
      expect(saved).toMatchObject({ scheduledAt, nextRunAt: new Date(scheduledAt).toISOString() });

      expect(processDueTasks()).toEqual({ executed: isDue ? 1 : 0, failed: 0 });
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({
        runCount: isDue ? 1 : 0,
        enabled: !(isDue && configuration.scheduleType === "once"),
      });
    });
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 144_000_000_000])(
    "rejects missing or unsupported intervals (%s) before persistence", async (intervalMinutes) => {
      const response = await create({ scheduleType: "interval", intervalMinutes });
      expect(response.statusCode).toBe(400);
      expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
    },
  );
  it.each([undefined, null, "", " ", "not-a-date"])(
    "rejects missing or invalid one-time dates (%s) before persistence", async (scheduledAt) => {
      const response = await create({ scheduleType: "once", scheduledAt });
      expect(response.statusCode).toBe(400);
      expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
    },
  );

  it.each([
    { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "", scheduledAt: "2020-01-01T00:00:00.000Z" },
    { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "Mars/Olympus", scheduledAt: "2020-01-01T00:00:00.000Z" },
    { scheduleType: "interval", intervalMinutes: 5, timezone: "Mars/Olympus" },
  ])("rejects invalid timezones before persistence (%j)", async (payload) => {
    const response = await create(payload);
    expect(response.statusCode).toBe(400);
    expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });

  it.each([undefined, null, "", " ", "not a cron"])(
    "rejects missing or invalid cron (%s) without an override", async (cronExpression) => {
      const response = await create({ scheduleType: "cron", cronExpression });
      expect(response.statusCode).toBe(400);
      expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
    },
  );

  it.each([
    { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York" },
    { scheduleType: "interval", intervalMinutes: 5 },
    { scheduleType: "once", scheduledAt: "2090-01-01T00:00:00.000Z" },
    { scheduleType: "once", scheduledAt: "2020-01-01T00:00:00.000Z" },
    { scheduleType: "once", scheduledAt: "Jan 2 2020 UTC" },
    { scheduleType: "cron", cronExpression: "0 9 * * *", scheduledAt: "2020-01-01T00:00:00.000Z" },
    { scheduleType: "interval", intervalMinutes: 5, scheduledAt: "2020-01-01T00:00:00.000Z" },
  ])("persists valid schedules and preserves explicit first-run overrides (%j)", async (payload) => {
    const response = await create(payload);
    expect(response.statusCode).toBe(201);
    const saved = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ scheduleType: payload.scheduleType, runCount: 0 });
    if (payload.scheduledAt !== undefined) {
      expect(saved[0].scheduledAt).toBe(payload.scheduledAt);
      expect(saved[0].nextRunAt).toBe(new Date(payload.scheduledAt).toISOString());
    } else {
      expect(new Date(saved[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it.each([null, Number.MAX_SAFE_INTEGER + 1, 144_000_000_000])(
    "does not let a first-run override bypass interval validation (%s)", async (intervalMinutes) => {
      const response = await create({ scheduleType: "interval", intervalMinutes, scheduledAt: "2020-01-01T00:00:00.000Z" });
      expect(response.statusCode).toBe(400);
      expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
    },
  );

  it.each([
    { scheduleType: "cron", cronExpression: "0 9 * * *", scheduledAt: "not-a-date" },
    { scheduleType: "interval", intervalMinutes: 5, scheduledAt: "" },
  ])("rejects invalid recurring first-run dates (%j)", async (payload) => {
    const response = await create(payload);
    expect(response.statusCode).toBe(400);
    expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });

  it("rejects malformed cron even with a valid first-run override before persistence", async () => {
    const response = await create({ scheduleType: "cron", cronExpression: "not a cron", scheduledAt: "2020-01-01T00:00:00.000Z" });
    expect(response.statusCode).toBe(400);
    expect(scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId)).toEqual([]);
  });
});


describe("scheduled task effective PATCH configuration", () => {
  function seed(scheduleType: "cron" | "interval" | "once") {
    return scheduledTaskRepo.createScheduledTask({
      habitatId, name: "Existing", missionTitle: "Existing mission", scheduleType,
      cronExpression: scheduleType === "cron" ? "0 9 * * *" : null,
      intervalMinutes: scheduleType === "interval" ? 5 : null,
      scheduledAt: scheduleType === "once" ? "2090-01-01T00:00:00.000Z" : null,
      nextRunAt: "2090-01-01T00:00:00.000Z", createdBy: "schedule-user",
    });
  }

  it.each([
    ["cron", { cronExpression: null }], ["cron", { cronExpression: "" }],
    ["cron", { cronExpression: "not a cron" }], ["cron", { timezone: "Mars/Olympus" }],
    ["cron", { scheduleType: "interval" }], ["cron", { scheduleType: "once" }],
    ["cron", { scheduledAt: "not-a-date" }],
    ["interval", { intervalMinutes: null }], ["interval", { intervalMinutes: Number.MAX_SAFE_INTEGER + 1 }],
    ["interval", { intervalMinutes: 144_000_000_000 }],
    ["interval", { scheduleType: "cron", cronExpression: null }],
    ["once", { scheduledAt: null }], ["once", { scheduledAt: "" }],
    ["once", { scheduledAt: "not-a-date" }], ["once", { scheduleType: "cron" }],
  ] as const)("rejects invalid effective %s config without changing the row (%j)", async (scheduleType, payload) => {
    const existing = seed(scheduleType);
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers, payload });
    expect(response.statusCode).toBe(400);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)).toEqual(existing);
  });

  it("inherits omitted required fields while preserving nullable clears of inactive fields", async () => {
    const existing = seed("cron");
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers,
      payload: { name: "Renamed", intervalMinutes: null, scheduledAt: null } });
    expect(response.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)).toMatchObject({
      name: "Renamed", cronExpression: existing.cronExpression, timezone: existing.timezone,
      intervalMinutes: null, scheduledAt: null, nextRunAt: existing.nextRunAt,
    });
  });

  it.each([
    ["cron", { scheduleType: "interval", intervalMinutes: 10 }],
    ["interval", { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York" }],
    ["cron", { cronExpression: "0 8 * * *" }],
    ["interval", { intervalMinutes: 10 }],
  ] as const)("accepts complete valid changes from %s (%j)", async (scheduleType, payload) => {
    const existing = seed(scheduleType);
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers, payload });
    expect(response.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)).toMatchObject(payload);
  });

  it("validates legacy effective configuration even for unrelated edits", async () => {
    const existing = seed("cron");
    scheduledTaskRepo.updateScheduledTask(existing.id, { cronExpression: "not a cron" });
    const before = scheduledTaskRepo.getScheduledTaskById(existing.id);
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers, payload: { name: "Renamed" } });
    expect(response.statusCode).toBe(400);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)).toEqual(before);
  });

  it("allows a complete repair of a malformed legacy schedule", async () => {
    const existing = seed("cron");
    scheduledTaskRepo.updateScheduledTask(existing.id, { cronExpression: "not a cron" });
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers, payload: { cronExpression: "0 8 * * *" } });
    expect(response.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)?.cronExpression).toBe("0 8 * * *");
  });

  it("preserves one-time edit pointer behavior while accepting a valid date", async () => {
    const existing = seed("once");
    const scheduledAt = "2091-01-01T00:00:00.000Z";
    const response = await app.inject({ method: "PATCH", url: `/scheduled-tasks/${existing.id}`, headers, payload: { scheduledAt } });
    expect(response.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(existing.id)).toMatchObject({ scheduledAt, nextRunAt: existing.nextRunAt });
  });
});
