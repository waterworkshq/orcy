import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrganization } from "../repositories/organization.js";
import { createTeam } from "../repositories/team.js";
import { addMember, removeMember } from "../repositories/teamMember.js";
import { createUser } from "../repositories/user.js";
import { habitats, pluginEnrollments } from "../db/schema/index.js";
import { createTemplate } from "../repositories/template.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { executeScheduledTask, processDueTasks, registerScheduledTaskHandler } from "../services/scheduledTaskService.js";
import { reserveScheduledOccurrence } from "../repositories/scheduledOccurrenceReservation.js";
import { getOccurrenceWithClient, markOccurrencePublishingWithClient, markOccurrenceRejectedWithClient } from "../repositories/scheduledOccurrences.js";
import { recoverExpiredOccurrenceLeases } from "../services/scheduledOccurrenceRecovery.js";
import { repairScheduledOccurrence } from "../services/scheduledOccurrenceRepair.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { missions, scheduledOccurrences, tasks, scheduledTasks, taskCreationAttempts } from "../db/schema/index.js";
import * as columnRepo from "../repositories/column.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import { badRequest, conflict } from "../errors.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { scheduledTaskRoutes } from "../routes/scheduledTasks.js";

const secret = "manual-scheduled-run-test-secret";
const now = "2026-10-18T12:00:00.000Z";
const scheduledFor = "2026-10-18T13:00:00.000Z";
let app: FastifyInstance;
let habitatId: string;
let pluginDirectory: string | undefined;

beforeEach(async () => {
  // Real SQL.js persistence, JWT authority and publication; only Date is controlled.
  await initTestDb();
  pluginManager.resetPlugins();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  setJwtSecret(secret);
  habitatId = habitatRepo.createHabitat({ name: "Manual scheduled run" }).id;
  columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
  app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(scheduledTaskRoutes, { prefix: "/api/v1" });
  await app.register(scheduledTaskRoutes, { prefix: "/api" });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  pluginManager.resetPlugins();
  closeDb();
  if (pluginDirectory) rmSync(pluginDirectory, { recursive: true, force: true });
  pluginDirectory = undefined;
  vi.useRealTimers();
});

const headers = { authorization: `Bearer ${jwt.sign({ sub: "manual-run-user", username: "operator", role: "admin" }, secret, { issuer: "orcy" })}` };
async function create(extra: Record<string, unknown> = {}, prefix = "/api/v1") {
  const result = await app.inject({ method: "POST", url: `${prefix}/habitats/${habitatId}/scheduled-tasks`, headers,
    payload: { name: "Manual schedule", scheduleType: "once", scheduledAt: scheduledFor, missionTitle: "Manual mission",
      tasksTemplate: [{ title: "Actual scheduled task" }], ...extra } });
  expect(result.statusCode, result.body).toBe(201);
  return result.json().scheduledTask;
}
function durableState() {
  const db = getDb();
  return { schedules: db.select().from(scheduledTasks).all(), occurrences: db.select().from(scheduledOccurrences).all(),
    attempts: db.select().from(taskCreationAttempts).all(), missions: db.select().from(missions).all(), tasks: db.select().from(tasks).all() };
}
function run(id: string, expectedScheduledFor?: unknown, prefix = "/api/v1") {
  return app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${id}/run`, headers,
    ...(expectedScheduledFor !== undefined ? { payload: { expectedScheduledFor } } : {}) });
}

describe("manual scheduled Run", () => {
  it.each(["/api/v1", "/api"])(
    "%s lets a human consume a future once occurrence immediately",
    async (prefix) => {
      const headers = {
        authorization: `Bearer ${jwt.sign(
          { sub: "manual-run-user", username: "operator", role: "admin" },
          secret,
          { issuer: "orcy" },
        )}`,
      };
      const created = await app.inject({
        method: "POST",
        url: `${prefix}/habitats/${habitatId}/scheduled-tasks`,
        headers,
        payload: {
          name: "Future one-time work",
          scheduleType: "once",
          scheduledAt: scheduledFor,
          missionTitle: "Manually requested mission",
          tasksTemplate: [{ title: "Actual scheduled task" }],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().scheduledTask.id as string;
      expect(scheduledTaskRepo.getScheduledTaskById(id)).toMatchObject({
        nextRunAt: scheduledFor,
        enabled: true,
        runCount: 0,
      });
      expect(Date.now()).toBeLessThan(Date.parse(scheduledFor));

      const run = await app.inject({
        method: "POST",
        url: `${prefix}/scheduled-tasks/${id}/run`,
        headers,
        payload: { expectedScheduledFor: scheduledFor },
      });
      expect(run.statusCode, run.body).toBe(200);
      const result = run.json();
      expect(result, run.body).toMatchObject({ success: true });
      expect(result.missionId).toEqual(expect.any(String));

      const db = getDb();
      const occurrences = db.select().from(scheduledOccurrences)
        .where(eq(scheduledOccurrences.scheduledTaskId, id)).all();
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({
        scheduledFor,
        ordinal: 0,
        state: "published",
        createdMissionId: result.missionId,
      });
      const savedMissions = db.select().from(missions)
        .where(eq(missions.habitatId, habitatId)).all();
      expect(savedMissions).toHaveLength(1);
      expect(savedMissions[0]).toMatchObject({
        id: result.missionId,
        title: "Manually requested mission",
      });
      const savedTasks = db.select().from(tasks)
        .where(eq(tasks.missionId, result.missionId)).all();
      expect(savedTasks).toHaveLength(1);
      expect(savedTasks[0].title).toBe("Actual scheduled task");
      expect(scheduledTaskRepo.getScheduledTaskById(id)).toMatchObject({
        enabled: false,
        runCount: 1,
        lastRunAt: now,
      });
      expect(Date.now()).toBeLessThan(Date.parse(scheduledFor));
    },
  );
});

describe("fresh manual once entitlement", () => {
  it.each(["/api/v1", "/api"])("%s refuses a legacy enabled consumed one-shot at its new sentinel key", async (prefix) => {
    const saved = await create({}, prefix);
    expect((await run(saved.id, scheduledFor, prefix)).json().success).toBe(true);
    scheduledTaskRepo.updateScheduledTask(saved.id, { enabled: true });
    const before = durableState();
    const result = await run(saved.id, "9999-12-31T23:59:59.000Z", prefix);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().code).toBe("ONCE_SCHEDULE_CONSUMED");
    expect(durableState()).toEqual(before);
  });
  it.each(["/api/v1", "/api"])("%s refuses fresh once when legacy history cannot establish entitlement", async (prefix) => {
    const saved = await create({}, prefix);
    getDb().update(scheduledTasks).set({ runCount: 1 }).where(eq(scheduledTasks.id, saved.id)).run();
    const before = durableState();
    const result = await run(saved.id, scheduledFor, prefix);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().code).toBe("ONCE_SCHEDULE_HISTORY_UNKNOWN");
    expect(durableState()).toEqual(before);
  });
});

describe.each(["/api/v1", "/api"])("identified manual replay at %s", (prefix) => {
  it("replays the committed once pair after disable without republishing or advancing", async () => {
    const saved = await create({}, prefix);
    const first = await run(saved.id, scheduledFor, prefix);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ success: true, scheduledFor, occurrenceState: "published", replayed: false });
    expect(first.json().occurrenceId).toEqual(expect.any(String));
    const before = durableState();
    const replay = await run(saved.id, scheduledFor, prefix);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ ...first.json(), replayed: true });
    expect(durableState()).toEqual(before);
  });
});

describe.each(["/api/v1", "/api"])("manual recurring advance at %s", (prefix) => {
  it.each([
    [{ scheduleType: "interval", intervalMinutes: 5 }, "2026-10-18T13:05:00.000Z"],
    [{ scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York" }, "2026-10-19T13:00:00.000Z"],
  ] as const)("advances beyond the future slot being consumed (%j)", async (configuration, nextRunAt) => {
    const saved = await create(configuration, prefix);
    const result = await run(saved.id, scheduledFor, prefix);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ success: true, scheduledFor, occurrenceState: "published" });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ enabled: true, runCount: 1, nextRunAt, lastRunAt: now });
    expect(Date.parse(nextRunAt)).toBeGreaterThan(Math.max(Date.now(), Date.parse(scheduledFor)));
    const before = durableState();
    expect((await run(saved.id, scheduledFor, prefix)).json().replayed).toBe(true);
    expect(durableState()).toEqual(before);
  });
});

describe("manual trigger provenance", () => {
  it("stores the actual human and selected slot at creation while scheduler publication attribution remains unchanged", async () => {
    const saved = await create();
    const result = await run(saved.id, scheduledFor);
    expect(result.statusCode).toBe(200);
    const state = durableState();
    expect(state.occurrences[0].scheduleRevision?._manualTrigger).toEqual({ actorId: "manual-run-user", requestedAt: now, scheduledFor });
    expect(state.attempts.find((attempt) => attempt.id === state.occurrences[0].attemptId)).toMatchObject({ actorId: "scheduler", source: "scheduler" });
    const before = durableState();
    const otherHuman = { authorization: `Bearer ${jwt.sign({ sub: "another-human", username: "other", role: "admin" }, secret, { issuer: "orcy" })}` };
    const replay = await app.inject({ method: "POST", url: `/api/v1/scheduled-tasks/${saved.id}/run`, headers: otherHuman, payload: { expectedScheduledFor: scheduledFor } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(durableState()).toEqual(before);
  });
});

describe("manual advance representation boundaries", () => {
  it("keeps legacy offsetless due coordinates on UTC wall time under a non-UTC server", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    try {
      expect(new Date(now).getTimezoneOffset()).toBe(-330);
      const saved = await create({ scheduleType: "interval", intervalMinutes: 5 });
      const legacyDue = "2026-10-18T13:00";
      scheduledTaskRepo.updateScheduledTask(saved.id, { nextRunAt: legacyDue });
      const result = await run(saved.id, legacyDue);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().scheduledFor).toBe(legacyDue);
      expect(scheduledTaskRepo.getScheduledTaskById(saved.id)?.nextRunAt).toBe("2026-10-18T13:05:00.000Z");
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects an unrepresentable advance past a valid extreme future slot without writes", async () => {
    const extremeDue = "+275760-09-13T00:00:00.000Z";
    const saved = await create({ scheduleType: "interval", intervalMinutes: 60, scheduledAt: extremeDue });
    const before = durableState();
    const result = await run(saved.id, extremeDue);
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json().code).toBe("VALIDATION_ERROR");
    expect(durableState()).toEqual(before);
  });
  it("rejects a bodyless fresh run whose legacy due pointer is invalid without writes", async () => {
    const saved = await create({ scheduleType: "interval", intervalMinutes: 5 });
    scheduledTaskRepo.updateScheduledTask(saved.id, { nextRunAt: "not-a-date" });
    const before = durableState();
    const result = await run(saved.id);
    // Explicit compatibility correction: bodyless admission uses the legacy
    // failure envelope; identified callers keep typed 400/409 responses.
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ success: false, error: "Invalid scheduled occurrence timestamp" });
    expect(durableState()).toEqual(before);
  });
});

describe.each(["/api/v1", "/api"])("manual admission and replay controls at %s", (prefix) => {
  it("keeps ordinary future polling due-only and fires only the next automatic slot after early Run", async () => {
    const saved = await create({ scheduleType: "interval", intervalMinutes: 5 }, prefix);
    const before = durableState();
    expect(executeScheduledTask(saved.id)).toMatchObject({ success: false, error: "Scheduled task reservation rejected (schedule_not_due)" });
    expect(durableState()).toEqual(before);
    expect((await run(saved.id, scheduledFor, prefix)).json().success).toBe(true);
    vi.setSystemTime(new Date(scheduledFor));
    expect(processDueTasks()).toEqual({ executed: 0, failed: 0 });
    vi.setSystemTime(new Date("2026-10-18T13:05:00.000Z"));
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 2, nextRunAt: "2026-10-18T13:10:00.000Z" });
    const rows = durableState().occurrences;
    expect(rows).toHaveLength(2);
    expect(rows[0].scheduleRevision?._manualTrigger).toBeTruthy();
    expect(rows[1].scheduleRevision?._manualTrigger).toBeUndefined();
  });
  it("rejects an unmatched stale coordinate without writes, and keeps bodyless consumption deliberately unbound", async () => {
    const saved = await create({ scheduleType: "interval", intervalMinutes: 5 }, prefix);
    const before = durableState();
    const stale = await run(saved.id, "2026-10-18T14:00:00.000Z", prefix);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("SCHEDULE_RUN_STALE");
    expect(durableState()).toEqual(before);
    expect((await run(saved.id, undefined, prefix)).json()).toMatchObject({ scheduledFor, replayed: false });
    expect((await run(saved.id, undefined, prefix)).json()).toMatchObject({ scheduledFor: "2026-10-18T13:05:00.000Z", replayed: false });
    expect(durableState().occurrences).toHaveLength(2);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)?.runCount).toBe(2);
  });
  it.each(["", " ", null, false, 0, "not-a-date", "2026-02-30T00:00:00Z"])("rejects a supplied invalid coordinate %j without treating it as bodyless", async (coordinate) => {
    const saved = await create({}, prefix);
    const before = durableState();
    const response = await run(saved.id, coordinate, prefix);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
    expect(durableState()).toEqual(before);
  });
  it("rejects forged trigger data and fresh disabled requests without writes", async () => {
    const saved = await create({}, prefix);
    const before = durableState();
    const forged = await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/run`, headers,
      payload: { expectedScheduledFor: scheduledFor, _manualTrigger: { actorId: "forged" } } });
    expect(forged.statusCode).toBe(400);
    expect(durableState()).toEqual(before);
    scheduledTaskRepo.updateScheduledTask(saved.id, { enabled: false });
    const disabledState = durableState();
    const disabled = await run(saved.id, scheduledFor, prefix);
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().code).toBe("SCHEDULE_DISABLED");
    expect(durableState()).toEqual(disabledState);
    expect((await run("missing", scheduledFor, prefix)).statusCode).toBe(404);
  });
  it("authorizes the current Habitat for fresh requests and replay and leaves the writer usable after denial", async () => {
    const saved = await create({}, prefix);
    const org = createOrganization({ name: "Run org", slug: "run-org" });
    const team = createTeam({ organizationId: org.id, name: "Run team", slug: "run-team" });
    getDb().update(habitats).set({ teamId: team.id }).where(eq(habitats.id, habitatId)).run();
    const before = durableState();
    expect((await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/run`, payload: { expectedScheduledFor: scheduledFor } })).statusCode).toBe(401);
    expect((await run(saved.id, scheduledFor, prefix)).statusCode).toBe(403);
    expect(durableState()).toEqual(before);
    createUser({ id: "manual-run-user", username: "operator", passwordHash: "fixture", createdAt: now, updatedAt: now });
    addMember({ teamId: team.id, userId: "manual-run-user" });
    expect((await run(saved.id, scheduledFor, prefix)).json().success).toBe(true);
    removeMember(team.id, "manual-run-user");
    const consumed = durableState();
    expect((await run(saved.id, scheduledFor, prefix)).statusCode).toBe(403);
    expect(durableState()).toEqual(consumed);
    addMember({ teamId: team.id, userId: "manual-run-user" });
    // Replay precedes disabled/current malformed configuration admission.
    scheduledTaskRepo.updateScheduledTask(saved.id, { scheduleType: "cron", cronExpression: "not a cron" });
    const malformed = durableState();
    const replay = await run(saved.id, scheduledFor, prefix);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ success: true, replayed: true, occurrenceState: "published" });
    expect(durableState()).toEqual(malformed);
  });
  it.each(["reserved", "publishing", "rejected"])("returns the persisted %s outcome without advancing or republishing", async (state) => {
    const saved = await create({ scheduledAt: now }, prefix);
    const reservation = reserveScheduledOccurrence({ scheduleId: saved.id, nextRunAt: "9999-12-31T23:59:59.000Z" });
    expect(reservation.outcome).toBe("created");
    if (reservation.outcome !== "created") throw new Error("Reservation fixture failed");
    if (state === "publishing") markOccurrencePublishingWithClient(getDb(), reservation.occurrence.id, { leaseOwner: "existing", leaseExpiresAt: scheduledFor });
    if (state === "rejected") markOccurrenceRejectedWithClient(getDb(), reservation.occurrence.id, { leaseOwner: null, result: { reason: "original_failure", retryHistory: [{ outcome: "repaired", missionId: "separate-repair" }] } });
    const before = durableState();
    const result = await run(saved.id, now, prefix);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ success: state !== "rejected", occurrenceState: state, scheduledFor: now, replayed: true });
    expect(result.json().missionId).toBeUndefined();
    if (state !== "rejected") expect(result.json().skipped).toBe(true);
    expect(durableState()).toEqual(before);
  });
  it("permits a first manual once after complete recurring-only history despite its positive count", async () => {
    const saved = await create({ scheduleType: "interval", intervalMinutes: 5, scheduledAt: now }, prefix);
    expect(processDueTasks()).toEqual({ executed: 1, failed: 0 });
    const edit = await app.inject({ method: "PATCH", url: `${prefix}/scheduled-tasks/${saved.id}`, headers,
      payload: { scheduleType: "once", scheduledAt: scheduledFor, intervalMinutes: null } });
    expect(edit.statusCode).toBe(200);
    expect((await run(saved.id, scheduledFor, prefix)).json().success).toBe(true);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 2, enabled: false });
    expect(durableState().occurrences).toHaveLength(2);
  });
});

describe("manual publication dispatch and post-commit faults", () => {
  it("uses the template adapter and returns its committed Mission", async () => {
    const template = createTemplate({ habitatId, name: "Manual template", titlePattern: "Template mission", tasksTemplate: [{ title: "Template task" }], createdBy: "operator" });
    const saved = await create({ templateId: template.id });
    const result = await run(saved.id, scheduledFor);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ success: true, occurrenceState: "published", replayed: false });
    expect(durableState().tasks).toMatchObject([{ title: "Template task" }]);
  });
  it("keeps handler precedence and does not invent a Mission for handler-only completion", async () => {
    let calls = 0;
    registerScheduledTaskHandler("manual-test-handler", () => { calls += 1; return { success: true }; });
    const saved = await create();
    const template = createTemplate({ habitatId, name: "Ignored by handler", titlePattern: "Ignored", createdBy: "operator" });
    scheduledTaskRepo.updateScheduledTask(saved.id, { templateId: template.id });
    getDb().run(sql`UPDATE scheduled_tasks SET handler_key = 'manual-test-handler' WHERE id = ${saved.id}`);
    const first = await run(saved.id, scheduledFor);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ success: true, occurrenceState: "published" });
    expect(first.json().missionId).toBeUndefined();
    expect(durableState().missions).toEqual([]);
    const before = durableState();
    expect((await run(saved.id, scheduledFor)).json().replayed).toBe(true);
    expect(calls).toBe(1);
    expect(durableState()).toEqual(before);
  });
  it("replays a committed result after a late SSE subscriber fault loses the first response", async () => {
    const saved = await create();
    const unsubscribe = sseBroadcaster.subscribe(habitatId, (event) => {
      if (event.type === "scheduled_task.executed") throw new Error("simulated late response loss");
    });
    let first;
    try { first = await run(saved.id, scheduledFor); } finally { unsubscribe(); }
    expect(first!.statusCode).toBe(500);
    const before = durableState();
    expect(before.occurrences[0].state).toBe("published");
    const replay = await run(saved.id, scheduledFor);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ success: true, replayed: true, missionId: before.occurrences[0].createdMissionId });
    expect(durableState()).toEqual(before);
  });
});

describe("legacy bodyless failure compatibility", () => {
  it.each(["/api/v1", "/api"])("%s retains HTTP 200 false for disabled admission but never masks authority/not-found errors", async (prefix) => {
    const saved = await create({}, prefix);
    scheduledTaskRepo.updateScheduledTask(saved.id, { enabled: false });
    const before = durableState();
    const disabled = await run(saved.id, undefined, prefix);
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toEqual({ success: false, error: "Scheduled task is disabled" });
    expect(durableState()).toEqual(before);
    expect((await run("missing", undefined, prefix)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${prefix}/scheduled-tasks/${saved.id}/run` })).statusCode).toBe(401);
  });
});

describe("legacy envelope stops at the durable commit boundary", () => {
  it.each([400, 409])("preserves a late SSE AppError %s after bodyless commit rather than pretending admission failed", async (status) => {
    const saved = await create();
    const unsubscribe = sseBroadcaster.subscribe(habitatId, (event) => {
      if (event.type === "scheduled_task.executed") throw (status === 400 ? badRequest("late committed fault") : conflict("late committed fault"));
    });
    let result;
    try { result = await run(saved.id); } finally { unsubscribe(); }
    // A post-commit subscriber error is infrastructure, even if it looks like
    // a client AppError: identified clients must retain their uncertain slot.
    expect(result!.statusCode, result!.body).toBe(500);
    expect(result!.json().code).toBe("INTERNAL_ERROR");
    const committed = durableState();
    expect(committed.occurrences[0].state).toBe("published");
    const replay = await run(saved.id, scheduledFor);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ success: true, replayed: true, occurrenceState: "published" });
    expect(durableState()).toEqual(committed);
  });
});

describe("manual governance, recovery, repair and transaction rollback", () => {
  it("honors an enrolled governance veto and preserves original trigger/state through a separate successful repair", async () => {
    pluginDirectory = mkdtempSync(join(tmpdir(), "orcy-manual-veto-"));
    writeFileSync(join(pluginDirectory, "manual-veto.mjs"), `export default {
      manifest: { id: 'manual-veto', version: '1.0.0', description: 'Manual veto fixture', contributions: [
        { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'deny-created', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] }
      ] }, interceptors: { 'deny-created': () => ({ allow: false, reason: 'manual governance veto' }) }
    };`);
    pluginManager.setPluginDirectory(pluginDirectory);
    await pluginManager.loadPlugins();
    enrollmentRepo.create({ habitatId, pluginId: "manual-veto", contributionId: "deny-created", contributionKind: "lifecycleInterceptor", enrolledBy: "operator", enabled: 1 });
    pluginManager.invalidateEnrollmentCache(habitatId);
    const template = createTemplate({ habitatId, name: "Veto then repair", titlePattern: "Repaired mission", tasksTemplate: [{ title: "Governed task" }], createdBy: "operator" });
    const saved = await create({ templateId: template.id });
    const rejected = await run(saved.id, scheduledFor);
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ success: false, occurrenceState: "rejected", replayed: false });
    expect(durableState().missions).toEqual([]);
    expect(durableState().tasks).toEqual([]);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ enabled: false, runCount: 1 });
    const original = getOccurrenceWithClient(getDb(), rejected.json().occurrenceId)!;
    const trigger = original.scheduleRevision?._manualTrigger;
    expect(trigger).toEqual({ actorId: "manual-run-user", requestedAt: now, scheduledFor });
    getDb().update(pluginEnrollments).set({ enabled: 0 }).where(eq(pluginEnrollments.habitatId, habitatId)).run();
    pluginManager.invalidateEnrollmentCache(habitatId);
    const repaired = repairScheduledOccurrence({ occurrenceId: original.id, actorId: "repair-operator" });
    expect(repaired.outcome).toBe("repaired");
    const afterRepair = getOccurrenceWithClient(getDb(), original.id)!;
    expect(afterRepair.state).toBe("rejected");
    expect(afterRepair.scheduleRevision?._manualTrigger).toEqual(trigger);
    const beforeReplay = durableState();
    const replay = await run(saved.id, scheduledFor);
    expect(replay.json()).toMatchObject({ success: false, occurrenceState: "rejected", replayed: true });
    expect(replay.json().missionId).toBeUndefined();
    expect(durableState()).toEqual(beforeReplay);
  });

  it("keeps a manually reserved publishing occurrence guarded, then recovers with immutable trigger and no second advance", async () => {
    const saved = await create();
    getDb().run(sql`CREATE TRIGGER manual_intervening_config AFTER UPDATE OF run_count ON scheduled_tasks
      WHEN NEW.id = ${sql.raw("'" + saved.id.replace(/'/g, "''") + "'")} BEGIN UPDATE scheduled_tasks SET name = 'intervening config' WHERE id = NEW.id; END`);
    const first = await run(saved.id, scheduledFor);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ success: true, occurrenceState: "publishing", skipped: true });
    const pending = getOccurrenceWithClient(getDb(), first.json().occurrenceId)!;
    const trigger = pending.scheduleRevision?._manualTrigger;
    expect(trigger).toEqual({ actorId: "manual-run-user", requestedAt: now, scheduledFor });
    expect(durableState().missions).toEqual([]);
    const before = durableState();
    expect((await run(saved.id, scheduledFor)).json()).toMatchObject({ success: true, skipped: true, replayed: true, occurrenceState: "publishing" });
    expect(durableState()).toEqual(before);
    getDb().run(sql`DROP TRIGGER manual_intervening_config`);
    scheduledTaskRepo.updateScheduledTask(saved.id, { name: saved.name });
    vi.setSystemTime(new Date("2026-10-18T12:06:00.000Z"));
    const recovered = recoverExpiredOccurrenceLeases({ leaseOwner: "manual-recovery" });
    expect(recovered.reclaimed).toBe(1);
    const finished = getOccurrenceWithClient(getDb(), pending.id)!;
    expect(finished.state).toBe("published");
    expect(finished.scheduleRevision?._manualTrigger).toEqual(trigger);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 1, enabled: false });
    expect(durableState().missions).toHaveLength(1);
    expect((await run(saved.id, scheduledFor)).json()).toMatchObject({ success: true, replayed: true, missionId: finished.createdMissionId });
  });

  it("rolls back occurrence, coordination attempt, link and schedule advance when the actual advance write fails, then retries cleanly", async () => {
    const saved = await create();
    const before = durableState();
    getDb().run(sql`CREATE TRIGGER manual_advance_fault BEFORE UPDATE OF run_count ON scheduled_tasks
      WHEN NEW.id = ${sql.raw("'" + saved.id.replace(/'/g, "''") + "'")} BEGIN SELECT CASE
        WHEN (SELECT count(*) FROM scheduled_occurrences WHERE scheduled_task_id = NEW.id) = 1
          AND (SELECT count(*) FROM task_creation_attempts WHERE publication_kind = 'scheduled_occurrence') = 1
        THEN RAISE(ABORT, 'injected after occurrence and coordination insertion')
        ELSE RAISE(ABORT, 'incorrect fault stage') END; END`);
    const failed = await run(saved.id, scheduledFor);
    expect(failed.statusCode, failed.body).toBe(500);
    expect(failed.json().details.causeMessage).toContain("injected after occurrence and coordination insertion");
    expect(durableState()).toEqual(before);
    getDb().run(sql`DROP TRIGGER manual_advance_fault`);
    const retry = await run(saved.id, scheduledFor);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ success: true, replayed: false, occurrenceState: "published" });
    expect(durableState().occurrences).toHaveLength(1);
    expect(durableState().attempts.filter((attempt) => attempt.publicationKind === "scheduled_occurrence" && attempt.attemptKey === "occurrence")).toHaveLength(1);
    expect(scheduledTaskRepo.getScheduledTaskById(saved.id)).toMatchObject({ runCount: 1, enabled: false });
  });
});
