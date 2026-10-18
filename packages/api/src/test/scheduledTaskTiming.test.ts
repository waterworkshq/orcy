import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { scheduledTasks, scheduledOccurrences, habitats } from "../db/schema/index.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import { processDueTasks } from "../services/scheduledTaskService.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import { createOrganization } from "../repositories/organization.js";
import { createTeam } from "../repositories/team.js";
import { addMember } from "../repositories/teamMember.js";
import { createUser } from "../repositories/user.js";
import { reserveScheduledOccurrence } from "../repositories/scheduledOccurrenceReservation.js";
import { markOccurrencePublishingWithClient, markOccurrenceRejectedWithClient, listOccurrencesForScheduleWithClient } from "../repositories/scheduledOccurrences.js";
import { scheduledTaskRoutes } from "../routes/scheduledTasks.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { registerErrorHandler } from "../errors/plugin.js";

// Real HTTP/auth, SQL.js, due scan, reservation and publication. Only Date is controlled.
let app: FastifyInstance;
let habitatId: string;
const secret = "schedule-timing-test-secret";
const headers = { authorization: `Bearer ${jwt.sign({ sub: "schedule-user", username: "scheduler", role: "admin" }, secret, { issuer: "orcy" })}` };
const start = "2026-10-18T12:00:00.000Z";
const oldDue = "2026-10-18T13:00:00.000Z";
const newDue = "2026-10-18T14:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  setJwtSecret(secret);
  habitatId = habitatRepo.createHabitat({ name: "Schedule timing" }).id;
  columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
  app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(scheduledTaskRoutes, { prefix: "/api/v1" });
  await app.register(scheduledTaskRoutes, { prefix: "/api" });
  await app.ready();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(start));
});
afterEach(async () => { await app.close(); closeDb(); vi.useRealTimers(); });

async function create(prefix: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({ method: "POST", url: `${prefix}/habitats/${habitatId}/scheduled-tasks`, headers,
    payload: { name: "Schedule", missionTitle: "Scheduled mission", scheduleType: "once", scheduledAt: oldDue,
      tasksTemplate: [{ title: "Actual scheduled task" }], ...extra } });
  expect(response.statusCode).toBe(201);
  return response.json().scheduledTask;
}
function occurrences(id: string) { return listOccurrencesForScheduleWithClient(getDb(), id); }

describe.each(["/api/v1", "/api"])("one-shot timing through %s", (prefix) => {
  it("postpones a scheduledAt-only edit and publishes once at the selected instant", async () => {
    const saved = await create(prefix);
    const edited = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduledAt: newDue } });
    expect(edited.statusCode).toBe(200);
    vi.setSystemTime(new Date(oldDue));
    expect(scheduledTaskRepo.getDueScheduledTasks()).toEqual([]);
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    expect(occurrences(saved.id)).toEqual([]);
    vi.setSystemTime(new Date(newDue));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({
      scheduledAt: newDue, nextRunAt: "9999-12-31T23:59:59.000Z", enabled: false, runCount: 1,
    });
    expect(occurrences(saved.id)).toMatchObject([{ scheduledFor: newDue, state: "published" }]);
    expect(occurrences(saved.id)).toHaveLength(1);
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
  });
  it.each(["dedicated", "patch"])("enables an unconsumed once through %s with its selected past instant", async (mode) => {
    const saved = await create(prefix);
    await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/disable`, headers });
    const edited = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduledAt: "2020-01-01T00:00:00.000Z" } });
    expect(edited.statusCode).toBe(200);
    // Simulate an existing unconsumed row suppressed by the old enable bug.
    scheduledTaskRepo.updateScheduledTask(saved.id, { nextRunAt: "9999-12-31T23:59:59.000Z" });
    const enabled = await app.inject(mode === "dedicated"
      ? { method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/enable`, headers }
      : { method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().scheduledTask).toMatchObject({ enabled: true, nextRunAt: "2020-01-01T00:00:00.000Z" });
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(occurrences(saved.id)).toHaveLength(1);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ enabled: false, runCount: 1 });
  });

  it("refuses to rearm a published once while permitting metadata edits", async () => {
    const saved = await create(prefix, { scheduledAt: start });
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id);
    const history = occurrences(saved.id);
    for (const action of [
      { method: "POST" as const, url: `${prefix}/scheduled-tasks/${saved.id}/enable` },
      { method: "PATCH" as const, url: `${prefix}/scheduled-tasks/${saved.id}`, payload: { enabled: true } },
      { method: "PATCH" as const, url: `${prefix}/scheduled-tasks/${saved.id}`, payload: { scheduledAt: newDue } },
      { method: "PATCH" as const, url: `${prefix}/scheduled-tasks/${saved.id}`, payload: { scheduleType: "interval", intervalMinutes: 5 } },
    ]) {
      const rejected = await app.inject({ ...action, headers });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "ONCE_SCHEDULE_CONSUMED" });
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toEqual(before);
      expect(occurrences(saved.id)).toEqual(history);
    }
    const renamed = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { name: "Renamed", scheduleType: "once", scheduledAt: start, timezone: "UTC", enabled: false } });
    expect(renamed.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ name: "Renamed", enabled: false,
      nextRunAt: before!.nextRunAt, runCount: 1 });
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    expect(occurrences(saved.id)).toEqual(history);
  });

  it("uses the same recurring cadence reset for PATCH enable as dedicated enable", async () => {
    const saved = await create(prefix, { scheduleType: "interval", intervalMinutes: 5, scheduledAt: oldDue });
    await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/disable`, headers });
    const enabled = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().scheduledTask.nextRunAt).toBe("2026-10-18T12:05:00.000Z");
  });

  it("rejects a first once transition onto an already reserved recurring due key", async () => {
    const saved = await create(prefix, { scheduleType: "interval", intervalMinutes: 5, scheduledAt: start });
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id);
    const history = occurrences(saved.id);
    const rejected = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduleType: "once", scheduledAt: start } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "SCHEDULE_DUE_ALREADY_RESERVED" });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toEqual(before);
    expect(occurrences(saved.id)).toEqual(history);
  });

  it.each(["missing", "snapshot"])("fails closed when legacy %s history cannot prove a one-shot unconsumed", async (kind) => {
    const saved = await create(prefix, { scheduledAt: start });
    if (kind === "snapshot") {
      expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
      getDb().update(scheduledOccurrences).set({ scheduleRevision: null })
        .where(eq(scheduledOccurrences.scheduledTaskId, saved.id)).run();
    } else {
      // Legacy operational evidence without durable occurrence history.
      getDb().update(scheduledTasks).set({ runCount: 1, enabled: false })
        .where(eq(scheduledTasks.id, saved.id)).run();
    }
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id);
    for (const payload of [{ enabled: true }, { scheduledAt: newDue }, { scheduleType: "interval", intervalMinutes: 5 }]) {
      const rejected = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers, payload });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: "ONCE_SCHEDULE_HISTORY_UNKNOWN" });
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toEqual(before);
    }
    const metadata = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { name: "Legacy metadata", enabled: false } });
    expect(metadata.statusCode).toBe(200);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ enabled: false,
      nextRunAt: before!.nextRunAt, runCount: 1 });
  });

  it("allows a consumed metadata save to round-trip an equivalent UI wall-time representation", async () => {
    const saved = await create(prefix, { scheduledAt: start });
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id)!;
    const response = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { name: "UI rename", scheduleType: "once", scheduledAt: "2026-10-18T12:00", timezone: "UTC" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().scheduledTask).toMatchObject({ name: "UI rename", scheduledAt: start,
      nextRunAt: before.nextRunAt, enabled: false, runCount: 1 });
    expect(occurrences(saved.id)).toHaveLength(1);
  });

  it.each(["reserved", "publishing", "rejected"])("treats %s reservation as consumed without rewriting occurrence or lease", async (state) => {
    const saved = await create(prefix, { scheduledAt: start });
    const result = reserveScheduledOccurrence({ scheduleId: saved.id, nextRunAt: "9999-12-31T23:59:59.000Z" });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("Reservation fixture failed");
    if (state === "publishing") {
      expect(markOccurrencePublishingWithClient(getDb(), result.occurrence.id, {
        leaseOwner: "existing-publisher", leaseExpiresAt: newDue,
      }).outcome).toBe("transitioned");
    }
    if (state === "rejected") {
      expect(markOccurrenceRejectedWithClient(getDb(), result.occurrence.id, {
        leaseOwner: null, result: { reason: "test_validation" },
      }).outcome).toBe("transitioned");
    }
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id);
    const history = occurrences(saved.id);
    for (const payload of [{ enabled: true }, { scheduledAt: newDue }, { scheduleType: "interval", intervalMinutes: 5 }]) {
      const response = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers, payload });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ONCE_SCHEDULE_CONSUMED");
    }
    const enabled = await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/enable`, headers });
    expect(enabled.statusCode).toBe(409);
    expect(enabled.json().code).toBe("ONCE_SCHEDULE_CONSUMED");
    expect(reserveScheduledOccurrence({ scheduleId: saved.id, scheduledFor: start,
      nextRunAt: "9999-12-31T23:59:59.000Z" }).outcome).toBe("already_exists");
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toEqual(before);
    expect(occurrences(saved.id)).toEqual(history);
  });

  it("permits the first unused once instant after recurring history, then consumes that entitlement", async () => {
    const saved = await create(prefix, { scheduleType: "interval", intervalMinutes: 5, scheduledAt: start });
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    const response = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduleType: "once", scheduledAt: newDue, intervalMinutes: null, cronExpression: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json().scheduledTask).toMatchObject({ scheduleType: "once", runCount: 1, nextRunAt: newDue });
    vi.setSystemTime(new Date(oldDue));
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    vi.setSystemTime(new Date(newDue));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 2, enabled: false });
    expect(occurrences(saved.id)).toHaveLength(2);
    expect(occurrences(saved.id).map((row) => row.scheduleRevision?.scheduleType)).toEqual(["interval", "once"]);
    // Existing historical rows may have changed type before this boundary was introduced.
    scheduledTaskRepo.updateScheduledTask(saved.id, { scheduleType: "interval", intervalMinutes: 5 });
    const blocked = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduleType: "once", scheduledAt: "2026-10-19T12:00:00.000Z", enabled: true } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("ONCE_SCHEDULE_CONSUMED");
    expect(occurrences(saved.id)).toHaveLength(2);
  });

  it("keeps metadata pointers and uses a full UI timing save at its selected UTC wall time", async () => {
    const saved = await create(prefix);
    const metadata = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { name: "Metadata", missionDescription: "Updated description" } });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().scheduledTask.nextRunAt).toBe(oldDue);
    const full = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { name: "UI save", description: "", scheduleType: "once", cronExpression: null, intervalMinutes: null,
        scheduledAt: "2026-10-18T14:00", timezone: "America/New_York", missionTitle: "Scheduled mission",
        missionDescription: "", missionPriority: "medium", missionLabels: [], missionDomain: null,
        tasksTemplate: saved.tasksTemplate } });
    expect(full.statusCode).toBe(200);
    expect(full.json().scheduledTask.nextRunAt).toBe(newDue);
    vi.setSystemTime(new Date("2026-10-18T13:59:59.999Z"));
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    vi.setSystemTime(new Date(newDue));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(occurrences(saved.id)).toMatchObject([{ scheduledFor: newDue, state: "published" }]);
    expect(occurrences(saved.id)).toHaveLength(1);
  });

  it("advances an unconsumed once to an earlier selected instant", async () => {
    const saved = await create(prefix, { scheduledAt: newDue });
    const response = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduledAt: oldDue } });
    expect(response.statusCode).toBe(200);
    vi.setSystemTime(new Date("2026-10-18T12:59:59.999Z"));
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    vi.setSystemTime(new Date(oldDue));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(occurrences(saved.id)).toMatchObject([{ scheduledFor: oldDue, state: "published" }]);
  });

  it.each([true, false])("keeps interval/cron edit cadence and both enable paths consistent when initially enabled=%s", async (initialEnabled) => {
    for (const configuration of [
      { scheduleType: "interval", intervalMinutes: 5, expected: "2026-10-18T12:05:00.000Z" },
      { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York", expected: oldDue },
    ]) {
      const saved = await create(prefix, { ...configuration, scheduledAt: "2026-10-20T14:00:00.000Z" });
      const edit = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
        payload: { scheduledAt: newDue, name: `Cadence preserved ${configuration.scheduleType}` } });
      expect(edit.statusCode, edit.body).toBe(200);
      expect(edit.json().scheduledTask.nextRunAt).toBe("2026-10-20T14:00:00.000Z");
      if (!initialEnabled) await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/disable`, headers });
      const patch = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers, payload: { enabled: true } });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().scheduledTask.nextRunAt).toBe(configuration.expected);
      const enabled = await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/enable`, headers });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().scheduledTask.nextRunAt).toBe(configuration.expected);
    }
  });

  it("denies unauthenticated and nonmember edits/enables, then permits a current team member after rollback", async () => {
    const saved = await create(prefix);
    const organization = createOrganization({ name: "Private org", slug: "private" });
    const team = createTeam({ organizationId: organization.id, name: "Private team", slug: "private" });
    getDb().update(habitats).set({ teamId: team.id }).where(eq(habitats.id, habitatId)).run();
    const before = scheduledTaskRepo.getScheduledTaskById(saved.id);
    for (const action of [
      { method: "PATCH" as const, url: `${prefix}/scheduled-tasks/${saved.id}`, payload: { scheduledAt: newDue } },
      { method: "POST" as const, url: `${prefix}/scheduled-tasks/${saved.id}/enable` },
    ]) {
      expect((await app.inject(action)).statusCode).toBe(401);
      const denied = await app.inject({ ...action, headers });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("BOARD_ACCESS_DENIED");
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toEqual(before);
      expect(occurrences(saved.id)).toEqual([]);
    }
    createUser({ id: "schedule-user", username: "scheduler", passwordHash: "unused", createdAt: start, updatedAt: start });
    addMember({ teamId: team.id, userId: "schedule-user", role: "member" });
    const edited = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduledAt: newDue } });
    expect(edited.statusCode).toBe(200);
    const enabled = await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/enable`, headers });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().scheduledTask.nextRunAt).toBe(newDue);
  });

});
