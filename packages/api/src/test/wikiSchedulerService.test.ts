import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { sql, eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as wikiService from "../services/wikiService.js";
import * as scheduler from "../services/wikiSchedulerService.js";
import { executeScheduledTask } from "../services/scheduledTaskService.js";
import {
  habitats,
  columns,
  missions,
  scheduledTasks,
  wikiPages,
  wikiPageVersions,
  wikiPageLinks,
  wikiCoverageMarkers,
  pulses,
} from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Scheduler Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
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
    // wiki-cadence: name prefix (initWikiScheduler). tasksTemplate is empty by design.
    expect(schedule!.tasksTemplate).toHaveLength(0);
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
});
