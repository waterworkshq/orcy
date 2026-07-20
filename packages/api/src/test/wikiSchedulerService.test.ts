import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { sql, eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as wikiService from "../services/wikiService.js";
import * as scheduler from "../services/wikiSchedulerService.js";
import { executeScheduledTask } from "../services/scheduledTaskService.js";
import {
  habitats,
  columns,
  missions,
  scheduledOccurrences,
  scheduledTasks,
  taskCreationAttempts,
  wikiPages,
  wikiPageVersions,
  wikiPageLinks,
  wikiCoverageMarkers,
  pulses,
} from "../db/schema/index.js";
import {
  reserveScheduledOccurrence,
  type ReserveScheduledOccurrenceInput,
} from "../repositories/scheduledOccurrenceReservation.js";
import {
  markOccurrencePublishingWithClient,
  reacquireExpiredOccurrenceLeaseWithClient,
} from "../repositories/scheduledOccurrences.js";
import {
  dispatchHandlerScheduledOccurrence,
  resumeHandlerScheduledOccurrenceDispatch,
} from "../services/scheduledHandlerDispatch.js";

// Time helpers used by the M2 dispatch-path recovery simulation (M3 fix proof).
// Anchored to a fixed instant so chunked-schedule name comparisons are
// deterministic — the spawn primitive embeds `now` (ISO) into the schedule
// name, and a moving `now` would break the dedupe contract under test.
const NOW_ISO = "2026-07-19T12:00:00.000Z";
const NEXT_RUN_INTERVAL = "2026-07-19T13:00:00.000Z"; // 1h after NOW (interval advance target)
const LEASE_FUTURE = "2099-01-01T00:00:00.000Z";
const LEASE_PAST = "2020-01-01T00:00:00.000Z"; // expired — for reclaim tests.

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Scheduler Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  // Order matters: occurrences + attempts FK-link into schedules; wipe them first.
  db.delete(scheduledOccurrences).run();
  db.delete(taskCreationAttempts).run();
  db.delete(scheduledTasks).run();
  db.delete(wikiPageLinks).run();
  db.delete(wikiCoverageMarkers).run();
  db.delete(wikiPageVersions).run();
  db.delete(wikiPages).run();
  db.delete(pulses).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("wikiSchedulerService.getWatermark", () => {
  it("returns null when no markers exist", () => {
    const { habitat } = setupHabitat();
    expect(scheduler.getWatermark(habitat.id)).toBeNull();
  });

  it("advances the watermark when a no_update_needed marker is posted", () => {
    const { habitat } = setupHabitat();
    const before = scheduler.getWatermark(habitat.id);
    expect(before).toBeNull();

    scheduler.postNoUpdateNeeded(
      habitat.id,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
      "human-1",
    );

    const after = scheduler.getWatermark(habitat.id);
    expect(after).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("wikiSchedulerService.getCoverageGap", () => {
  it("returns the watermark-to-now span when a watermark exists", () => {
    const { habitat } = setupHabitat();
    scheduler.postNoUpdateNeeded(
      habitat.id,
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
      "human-1",
    );
    const gap = scheduler.getCoverageGap(habitat.id);
    expect(gap.from).toBe("2026-01-08T00:00:00.000Z");
    expect(new Date(gap.to).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("returns an empty-gap shape when no markers exist and no primitives", () => {
    const { habitat } = setupHabitat();
    const gap = scheduler.getCoverageGap(habitat.id);
    expect(gap.from).toBe(gap.to);
  });
});

describe("wikiSchedulerService.getCadence", () => {
  it("returns null when no cadence is configured", () => {
    const { habitat } = setupHabitat();
    expect(scheduler.getCadence(habitat.id)).toBeNull();
  });

  it("throws 404 for an unknown habitat", () => {
    expect(() => scheduler.getCadence("nonexistent-habitat")).toThrow(/not found/i);
  });
});

describe("wikiSchedulerService.setCadence", () => {
  it("registers a scheduled_tasks row when enabled", () => {
    const { habitat } = setupHabitat();
    const settings = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "interval", intervalMinutes: 60, timezone: "UTC" },
      "human-1",
    );

    expect(settings.enabled).toBe(true);
    expect(settings.scheduledTaskId).toBeDefined();
    expect(settings.intervalMinutes).toBe(60);

    const schedule = scheduledTaskRepo.getScheduledTaskById(settings.scheduledTaskId!);
    expect(schedule).toBeTruthy();
    expect(schedule!.habitatId).toBe(habitat.id);
    expect(schedule!.scheduleType).toBe("interval");
    expect(schedule!.intervalMinutes).toBe(60);
    // The cadence schedule no longer carries a meta "run_cadence" task template — the due-run
    // is dispatched to wikiSchedulerService.runCadence via the handler registered under the
    // "wiki-cadence" handlerKey (initWikiScheduler). Dispatch is explicit via the handler_key
    // column, not name-prefix matching. tasksTemplate is empty by design.
    expect(schedule!.tasksTemplate).toHaveLength(0);
    expect(schedule!.handlerKey).toBe("wiki-cadence");
    expect(schedule!.name.startsWith("wiki-cadence:")).toBe(true);
  });

  it("registers a cron schedule when scheduleType is cron", () => {
    const { habitat } = setupHabitat();
    const settings = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "UTC" },
      "human-1",
    );

    expect(settings.cronExpression).toBe("0 9 * * *");
    const schedule = scheduledTaskRepo.getScheduledTaskById(settings.scheduledTaskId!);
    expect(schedule!.scheduleType).toBe("cron");
    expect(schedule!.cronExpression).toBe("0 9 * * *");
  });

  it("removes the prior schedule when re-setting cadence", () => {
    const { habitat } = setupHabitat();
    const first = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "interval", intervalMinutes: 60 },
      "human-1",
    );
    const second = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "interval", intervalMinutes: 30 },
      "human-1",
    );

    expect(scheduledTaskRepo.getScheduledTaskById(first.scheduledTaskId!)).toBeNull();
    expect(scheduledTaskRepo.getScheduledTaskById(second.scheduledTaskId!)).toBeTruthy();
  });

  it("throws 400 when intervalMinutes is missing for interval cadence", () => {
    const { habitat } = setupHabitat();
    expect(() =>
      scheduler.setCadence(
        habitat.id,
        { enabled: true, scheduleType: "interval" } as never,
        "human-1",
      ),
    ).toThrow(/intervalMinutes/i);
  });

  it("throws 400 when cronExpression is missing for cron cadence", () => {
    const { habitat } = setupHabitat();
    expect(() =>
      scheduler.setCadence(habitat.id, { enabled: true, scheduleType: "cron" } as never, "human-1"),
    ).toThrow(/cronExpression/i);
  });
});

describe("wikiSchedulerService.disableCadence", () => {
  it("clears wiki_settings and removes the registered schedule", () => {
    const { habitat } = setupHabitat();
    const settings = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "interval", intervalMinutes: 60 },
      "human-1",
    );
    expect(settings.scheduledTaskId).toBeDefined();

    scheduler.disableCadence(habitat.id);

    expect(scheduler.getCadence(habitat.id)).toBeNull();
    expect(scheduledTaskRepo.getScheduledTaskById(settings.scheduledTaskId!)).toBeNull();
  });

  it("is a no-op when no cadence is set", () => {
    const { habitat } = setupHabitat();
    expect(() => scheduler.disableCadence(habitat.id)).not.toThrow();
    expect(scheduler.getCadence(habitat.id)).toBeNull();
  });
});

describe("wikiSchedulerService.triggerBootstrap", () => {
  it("chunks a 30-day gap into 5 weekly tasks with correct date bounds", () => {
    const { habitat } = setupHabitat();
    const db = getDb();

    db.insert(pulses)
      .values({
        id: "p1",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "h-1",
        signalType: "context",
        subject: "Old pulse",
        body: "x",
        metadata: {},
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
        pinned: 0,
        isAuto: false,
      })
      .run();

    const result = scheduler.triggerBootstrap(habitat.id, { chunkDays: 7 });
    expect(result.habitatId).toBe(habitat.id);
    expect(result.tasksCreated).toBe(5);
    expect(result.chunks).toHaveLength(5);
    for (const chunk of result.chunks) {
      const schedule = scheduledTaskRepo.getScheduledTaskById(chunk.scheduledTaskId);
      expect(schedule).toBeTruthy();
      expect(schedule!.scheduleType).toBe("once");
      expect(schedule!.missionTitle).toContain(chunk.from);
      expect(schedule!.missionTitle).toContain(chunk.to);
    }
  });

  it("returns 0 tasks when there is no gap (no primitives)", () => {
    const { habitat } = setupHabitat();
    const result = scheduler.triggerBootstrap(habitat.id);
    expect(result.tasksCreated).toBe(0);
    expect(result.chunks).toEqual([]);
  });

  it("uses a custom chunkDays override", () => {
    const { habitat } = setupHabitat();
    const db = getDb();
    db.insert(pulses)
      .values({
        id: "p1",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "h-1",
        signalType: "context",
        subject: "x",
        body: "x",
        metadata: {},
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(),
        pinned: 0,
        isAuto: false,
      })
      .run();

    const result = scheduler.triggerBootstrap(habitat.id, { chunkDays: 2 });
    // The gap is ~10 days + sub-second drift between primitive insert and triggerBootstrap call.
    // 5 chunks is the nominal math; allow 5 or 6 to absorb the drift.
    expect(result.tasksCreated).toBeGreaterThanOrEqual(5);
    expect(result.tasksCreated).toBeLessThanOrEqual(6);
  });
});

describe("wikiSchedulerService.triggerRefresh", () => {
  it("spawns one task covering the full gap", () => {
    const { habitat } = setupHabitat();
    const db = getDb();
    const oldTs = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    db.insert(pulses)
      .values({
        id: "p1",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "h-1",
        signalType: "context",
        subject: "x",
        body: "x",
        metadata: {},
        createdAt: oldTs,
        pinned: 0,
        isAuto: false,
      })
      .run();

    const result = scheduler.triggerRefresh(habitat.id);
    expect(result.tasksCreated).toBe(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].from).toBe(oldTs);
  });

  it("returns 0 tasks when there is no gap", () => {
    const { habitat } = setupHabitat();
    const result = scheduler.triggerRefresh(habitat.id);
    expect(result.tasksCreated).toBe(0);
  });
});

describe("wikiSchedulerService.runCadence (ADR-0008 invariant)", () => {
  it("spawns authoring tasks when a gap exists, no-op when empty", () => {
    const { habitat } = setupHabitat();
    const db = getDb();
    db.insert(pulses)
      .values({
        id: "p1",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "h-1",
        signalType: "context",
        subject: "x",
        body: "x",
        metadata: {},
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
        pinned: 0,
        isAuto: false,
      })
      .run();

    const beforePages = db.select().from(wikiPages).all().length;
    const beforeVersions = db.select().from(wikiPageVersions).all().length;
    const result = scheduler.runCadence(habitat.id);
    expect(result.tasksCreated).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);

    const afterPages = db.select().from(wikiPages).all().length;
    const afterVersions = db.select().from(wikiPageVersions).all().length;
    expect(afterPages).toBe(beforePages);
    expect(afterVersions).toBe(beforeVersions);
  });

  it("no-ops when there is no coverage gap", () => {
    const { habitat } = setupHabitat();
    const result = scheduler.runCadence(habitat.id);
    expect(result.tasksCreated).toBe(0);
    expect(result.chunks).toEqual([]);
  });
});

describe("wikiSchedulerService cadence handler dispatch", () => {
  it("initWikiScheduler registers a handler that runCadence on due cadence schedules (no meta mission created)", () => {
    const { habitat } = setupHabitat();
    const db = getDb();
    db.insert(pulses)
      .values({
        id: "p-dispatch",
        habitatId: habitat.id,
        scope: "habitat",
        fromType: "human",
        fromId: "h-1",
        signalType: "context",
        subject: "x",
        body: "x",
        metadata: {},
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
        pinned: 0,
        isAuto: false,
      })
      .run();

    // Register the handler (idempotent; mirrors API boot).
    scheduler.initWikiScheduler();

    // Enable cadence with a due-now interval schedule.
    const settings = scheduler.setCadence(
      habitat.id,
      { enabled: true, scheduleType: "interval", intervalMinutes: 60, timezone: "UTC" },
      "human-1",
    );
    const schedule = scheduledTaskRepo.getScheduledTaskById(settings.scheduledTaskId!);
    expect(schedule).toBeTruthy();

    // Force the schedule due and process it via the generic scheduled-task executor.
    db.update(scheduledTasks)
      .set({ nextRunAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(scheduledTasks.id, schedule!.id))
      .run();

    const beforeMissions = db.select().from(missions).all().length;
    const result = executeScheduledTask(schedule!.id);
    expect(result.success).toBe(true);

    // The handler ran runCadence, which spawned one-shot wiki-authoring scheduled tasks —
    // NOT a "Wiki cadence run" mission. Mission count is unchanged.
    const afterMissions = db.select().from(missions).all().length;
    expect(afterMissions).toBe(beforeMissions);

    // The cadence schedule advanced its nextRunAt (finalizeExecution ran) and is still enabled
    // (interval schedules stay enabled; only "once" schedules auto-disable).
    const refreshed = scheduledTaskRepo.getScheduledTaskById(schedule!.id);
    expect(refreshed!.enabled).toBe(true);
  });

  it("fails loud when a handler-keyed schedule has no registered handler (no silent mission fallback)", () => {
    const { habitat } = setupHabitat();
    const db = getDb();

    // A schedule stamped with a handlerKey for which no handler is registered (simulates a domain
    // service forgetting to call its init at boot). Use a unique key no test registers.
    const dueAt = new Date(Date.now() - 1000).toISOString();
    db.insert(scheduledTasks)
      .values({
        id: "orphan-handler-schedule",
        habitatId: habitat.id,
        templateId: null,
        name: "orphan-handler-schedule",
        description: "handlerKey set, no handler registered",
        scheduleType: "interval",
        cronExpression: null,
        intervalMinutes: 60,
        scheduledAt: null,
        timezone: "UTC",
        missionTitle: "Orphan",
        missionDescription: "",
        missionPriority: "medium",
        missionLabels: [],
        missionDomain: "wiki",
        handlerKey: "nonexistent-handler-key",
        tasksTemplate: [],
        enabled: true,
        lastRunAt: null,
        nextRunAt: dueAt,
        runCount: 0,
        lastCreatedMissionId: null,
        createdBy: "human-1",
        createdAt: dueAt,
        updatedAt: dueAt,
      })
      .run();

    const beforeMissions = db.select().from(missions).all().length;
    const result = executeScheduledTask("orphan-handler-schedule");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No handler registered for handlerKey "nonexistent-handler-key"/);

    // The fail-loud guard must NOT fall through to mission creation.
    const afterMissions = db.select().from(missions).all().length;
    expect(afterMissions).toBe(beforeMissions);
  });
});

// ===========================================================================
// T9A-10 M3 — spawnAuthoringTask idempotency. Closes the regression that
// M2 (handler dispatch) + T9B (lease recovery) + T11 (cutover) introduce:
// a re-dispatch of the wiki-cadence handler with an unmoved watermark
// re-computes the same chunks and — without this dedupe — inserts duplicate
// `wiki-authoring:` rows. The schedule name format
// `wiki-authoring:${chunkFrom}:${chunkTo}:${habitatId}` is deterministic
// from the coverage watermark + chunk bounds, so (habitatId, name) is a
// sound dedupe key.
// ===========================================================================

/** Counts the wiki-authoring scheduled_tasks rows for a habitat (the spawned children). */
function countWikiAuthoringRows(habitatId: string): number {
  const db = getDb();
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.habitatId, habitatId))
    .all()
    .filter((t) => t.name.startsWith("wiki-authoring:")).length;
}

describe("wikiSchedulerService.spawnAuthoringTask — idempotency (M3 fix)", () => {
  it("re-spawning the same chunk via runCadence returns the existing schedule (no duplicate wiki-authoring row)", () => {
    // Freeze Date to NOW_ISO for both calls. The dedupe key is the
    // schedule name `wiki-authoring:${chunkFrom}:${chunkTo}:${habitatId}`;
    // the last chunk's `chunkTo` is bounded by `Date.now()` (via
    // `getCoverageGap.to`), so a drifting clock between the two calls
    // would yield different names and the last-chunk dedupe would miss.
    // This is a test-determinism concern; the production dedupe is
    // sound (M3 fix) for the all-but-last case and re-derives the last
    // chunk on a small drift.
    vi.useFakeTimers({ now: new Date(NOW_ISO), toFake: ["Date"] });
    try {
      const { habitat } = setupHabitat();
      const db = getDb();

      // Primitive signal 30 days old → runCadence has a 30-day coverage gap
      // that chunks into 5 weekly windows at chunkDays=7.
      db.insert(pulses)
        .values({
          id: "p-respawn",
          habitatId: habitat.id,
          scope: "habitat",
          fromType: "human",
          fromId: "h-1",
          signalType: "context",
          subject: "Old pulse",
          body: "x",
          metadata: {},
          createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
          pinned: 0,
          isAuto: false,
        })
        .run();

      // First run: spawns 5 weekly wiki-authoring chunks.
      const first = scheduler.runCadence(habitat.id, { chunkDays: 7 });
      expect(first.tasksCreated).toBe(5);
      expect(first.chunks).toHaveLength(5);
      expect(countWikiAuthoringRows(habitat.id)).toBe(5);
      const firstIds = first.chunks.map((c) => c.scheduledTaskId).sort();

      // Second run with the same coverage gap (watermark UNMOVED — the
      // spawned children haven't been claimed + completed + posted a
      // `no_update_needed` marker yet). WITHOUT the M3 dedupe, this would
      // insert 5 more `wiki-authoring:` rows. WITH the dedupe,
      // spawnAuthoringTask returns the existing row for each chunk.
      const second = scheduler.runCadence(habitat.id, { chunkDays: 7 });
      expect(second.tasksCreated).toBe(5);
      expect(second.chunks).toHaveLength(5);

      // The schedule ids from the second run match the first run — the
      // dedupe returns the existing row, so the same id is surfaced.
      const secondIds = second.chunks.map((c) => c.scheduledTaskId).sort();
      expect(secondIds).toEqual(firstIds);

      // The wiki-authoring row count is still 5, not 10.
      expect(countWikiAuthoringRows(habitat.id)).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wikiSchedulerService — M2 dispatch path recovery idempotency (M3 fix)", () => {
  it("M2 dispatch + lease-expired resume does NOT create duplicate wiki-authoring schedules", () => {
    // Freeze Date to NOW_ISO for both firings. Same rationale as the
    // characterization test above — the dedupe key is the schedule name
    // embedding `chunkTo`, which is bounded by `Date.now()`. A drifting
    // clock between the dispatch and the resume would make the last
    // chunk's name differ and the dedupe would miss for that one chunk.
    vi.useFakeTimers({ now: new Date(NOW_ISO), toFake: ["Date"] });
    try {
      // Register the real wiki-cadence handler (idempotent; mirrors API boot).
      scheduler.initWikiScheduler();

      const { habitat } = setupHabitat();
      const db = getDb();

      // Primitive signal 30 days old → runCadence finds a 30-day coverage gap.
      db.insert(pulses)
        .values({
          id: "p-recovery",
          habitatId: habitat.id,
          scope: "habitat",
          fromType: "human",
          fromId: "h-1",
          signalType: "context",
          subject: "Old pulse",
          body: "x",
          metadata: {},
          createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
          pinned: 0,
          isAuto: false,
        })
        .run();

      // --- FIRST FIRING: dispatcher runs the cadence handler via the M2 path.
      // Create a cadence schedule (handlerKey="wiki-cadence", tasksTemplate:[]).
      const scheduleA = scheduledTaskRepo.createScheduledTask({
        habitatId: habitat.id,
        templateId: null,
        name: `wiki-cadence:${habitat.id}:A`,
        description: "first firing",
        scheduleType: "interval",
        intervalMinutes: 60,
        scheduledAt: null,
        timezone: "UTC",
        missionTitle: "Wiki cadence run A",
        missionDescription: "first firing",
        missionPriority: "low",
        missionLabels: ["wiki", "cadence"],
        missionDomain: "wiki",
        handlerKey: "wiki-cadence",
        tasksTemplate: [],
        nextRunAt: NOW_ISO,
        createdBy: "test",
      });

      // Reserve + dispatch via the M2 path. The handler runs runCadence →
      // spawns 5 weekly chunks → occurrence terminalizes as `published`.
      const reserveA = reserveScheduledOccurrence({
        scheduleId: scheduleA.id,
        nextRunAt: NEXT_RUN_INTERVAL,
        now: NOW_ISO,
      } satisfies ReserveScheduledOccurrenceInput);
      if (reserveA.outcome !== "created") throw new Error(`reserveA: ${reserveA.outcome}`);

      const dispatchA = dispatchHandlerScheduledOccurrence({
        occurrenceId: reserveA.occurrence.id,
        leaseOwner: "worker-A",
        leaseExpiresAt: LEASE_FUTURE,
      });
      expect(dispatchA.outcome).toBe("dispatched");

      // 5 wiki-authoring chunks should have been spawned.
      expect(countWikiAuthoringRows(habitat.id)).toBe(5);
      const firstIds = db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.habitatId, habitat.id))
        .all()
        .filter((t) => t.name.startsWith("wiki-authoring:"))
        .map((t) => t.id)
        .sort();

      // --- SECOND FIRING (the recovery scenario): a publishing occurrence
      //     with an EXPIRED lease that T9B's recovery worker reclaims + re-drives.
      //     Same handlerKey, same habitat, same (unmoved) watermark. The
      //     resume re-runs the handler → runCadence re-computes the same
      //     chunks. WITHOUT the M3 dedupe this would insert 5 MORE rows;
      //     WITH the dedupe, spawnAuthoringTask returns the existing row.

      // Create a SECOND cadence schedule (same handlerKey, same habitat) —
      // represents the next cron tick of the cadence that needs to re-run.
      const scheduleB = scheduledTaskRepo.createScheduledTask({
        habitatId: habitat.id,
        templateId: null,
        name: `wiki-cadence:${habitat.id}:B`,
        description: "second firing (recovery)",
        scheduleType: "interval",
        intervalMinutes: 60,
        scheduledAt: null,
        timezone: "UTC",
        missionTitle: "Wiki cadence run B",
        missionDescription: "second firing (recovery)",
        missionPriority: "low",
        missionLabels: ["wiki", "cadence"],
        missionDomain: "wiki",
        handlerKey: "wiki-cadence",
        tasksTemplate: [],
        nextRunAt: NOW_ISO,
        createdBy: "test",
      });

      // Reserve the second occurrence via Phase-2.
      const reserveB = reserveScheduledOccurrence({
        scheduleId: scheduleB.id,
        nextRunAt: NEXT_RUN_INTERVAL,
        now: NOW_ISO,
      } satisfies ReserveScheduledOccurrenceInput);
      if (reserveB.outcome !== "created") throw new Error(`reserveB: ${reserveB.outcome}`);

      // Simulate a worker that acquired the lease then CRASHED before
      // terminalizing (the dispatch path's STEP 7 throws between STEP 6
      // and the terminalization commit). The occurrence is `publishing` with
      // an EXPIRED lease.
      const acquire = markOccurrencePublishingWithClient(db, reserveB.occurrence.id, {
        leaseOwner: "crashed-worker",
        leaseExpiresAt: LEASE_PAST,
      });
      expect(acquire.outcome).toBe("transitioned");

      // T9B's recovery worker reclaims the expired lease.
      const reclaim = reacquireExpiredOccurrenceLeaseWithClient(db, reserveB.occurrence.id, {
        leaseOwner: "recovery-worker",
        leaseExpiresAt: LEASE_FUTURE,
      });
      expect(reclaim.outcome).toBe("reclaimed");

      // RESUME: the recovery worker re-drives the handler. The handler re-runs
      // runCadence → tries to spawn the SAME 5 chunks. With the M3 fix in
      // place, spawnAuthoringTask dedupes by (habitatId, name) and returns
      // the existing row → no new rows.
      const resume = resumeHandlerScheduledOccurrenceDispatch({
        occurrenceId: reserveB.occurrence.id,
        leaseOwner: "recovery-worker",
      });
      expect(resume.outcome).toBe("dispatched");

      // THE PROOF: still 5 wiki-authoring rows, not 10. The same ids as
      // the first firing (the dedupe returns the original rows).
      expect(countWikiAuthoringRows(habitat.id)).toBe(5);
      const resumeIds = db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.habitatId, habitat.id))
        .all()
        .filter((t) => t.name.startsWith("wiki-authoring:"))
        .map((t) => t.id)
        .sort();
      expect(resumeIds).toEqual(firstIds);
    } finally {
      vi.useRealTimers();
    }
  });
});
