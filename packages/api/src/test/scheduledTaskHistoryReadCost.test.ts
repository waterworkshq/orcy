import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { closeDb, getDb, initDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import { createHabitat } from "../repositories/habitat.js";
import * as schedules from "../repositories/scheduledTask.js";
import { listOccurrencesForScheduleWithClient } from "../repositories/scheduledOccurrences.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import { editScheduledTask } from "../services/scheduledTaskEditing.js";
import { originalOnceEntitlement } from "./fixtures/scheduled-task-entitlement-original.js";

const { scheduledOccurrences, scheduledTasks } = schema;

beforeEach(async () => { await initDb(":memory:"); });
afterEach(() => { closeDb(); });

describe("scheduled task history read cost", () => {
  it("saves metadata without reparsing historical snapshots while retaining edit guards", () => {
    const db = getDb();
    const habitat = createHabitat({ name: "History read cost" });
    const schedule = schedules.createScheduledTask({
      habitatId: habitat.id, name: "Before", missionTitle: "Scheduled mission",
      scheduleType: "interval", intervalMinutes: 60,
      nextRunAt: "2090-01-01T00:00:00.000Z", createdBy: "history-cost-test",
    });
    const historyCount = 32;
    db.insert(scheduledOccurrences).values(Array.from({ length: historyCount }, (_, ordinal) => ({
      id: `history-cost-${ordinal}`, scheduledTaskId: schedule.id,
      scheduledFor: new Date(Date.UTC(2000, 0, 1) + ordinal * 60_000).toISOString(),
      ordinal, scheduleRevision: { scheduleType: ordinal === 0 ? "once" : "interval" },
      state: "rejected" as const,
    }))).run();
    db.update(scheduledTasks).set({ runCount: historyCount }).where(eq(scheduledTasks.id, schedule.id)).run();
    const before = schedules.getScheduledTaskById(schedule.id)!;
    const history = listOccurrencesForScheduleWithClient(db, schedule.id);
    expect(originalOnceEntitlement(db, before)).toBe("consumed");

    // Native classifier sentinel plus a public driver SQL trace: the latter
    // catches JSON scans that bypass json_valid and plain snapshot reads.
    // Install after migration/seeding; exercise the public edit on this client.
    const native = (db as typeof db & { $client: Database.Database }).$client;
    let snapshotParses = 0;
    native.function("json_valid", { deterministic: true }, (_snapshot: unknown) => {
      snapshotParses++;
      throw new Error("metadata edit reparsed a historical snapshot");
    });
    const queries: string[] = [];
    const traced = drizzle(native, { schema, logger: { logQuery(query) { queries.push(query); } } });

    const denied = new Error("current authority denied");
    expect(() => editScheduledTask(schedule.id, { name: "Denied" }, () => { throw denied; }))
      .toThrow(denied);
    expect(() => editScheduledTask(schedule.id, { intervalMinutes: 0 }, () => {}))
      .toThrow("Invalid schedule configuration");
    expect(snapshotParses).toBe(0);
    expect(schedules.getScheduledTaskById(schedule.id)).toEqual(before);

    // Counterexample: this real historical JSON scan evades the old sentinel,
    // while the driver trace sees it. Clear the control before the public edit.
    traced.all(sql`SELECT json_extract(${scheduledOccurrences.scheduleRevision}, '$.scheduleType') FROM ${scheduledOccurrences}`);
    expect(snapshotParses).toBe(0);
    expect(queries.some(query => /\bjsonb?(?:_\w+)?\s*\(/iu.test(query))).toBe(true);
    queries.length = 0;
    const authorize = vi.fn();
    let saved: ReturnType<typeof editScheduledTask> | undefined;
    expect(() => { saved = editScheduledTask(schedule.id, { name: "After" }, authorize, traced); })
      .not.toThrow();
    expect(authorize).toHaveBeenCalledExactlyOnceWith(before);
    expect(saved).toMatchObject({
      name: "After", runCount: historyCount, nextRunAt: before.nextRunAt,
      scheduleType: before.scheduleType, intervalMinutes: before.intervalMinutes,
    });
    expect(schedules.getScheduledTaskById(schedule.id)).toEqual(saved);
    expect(listOccurrencesForScheduleWithClient(db, schedule.id)).toEqual(history);
    expect(snapshotParses).toBe(0);
    expect(queries.filter(query => /\bjsonb?(?:_\w+)?\s*\(/iu.test(query))).toEqual([]);
    expect(queries.some(query => /scheduled_occurrences|scheduled_occurrence_history/iu.test(query))).toBe(false);
  });

  it("retains consumed one-shot evidence without reparsing historical snapshots", () => {
    const db = getDb();
    const habitat = createHabitat({ name: "Bounded one-shot evidence" });
    const schedule = schedules.createScheduledTask({
      habitatId: habitat.id, name: "Consumed once", missionTitle: "Scheduled mission",
      scheduleType: "once", scheduledAt: "2090-01-01T00:00:00.000Z",
      nextRunAt: "2090-01-01T00:00:00.000Z", createdBy: "history-cost-test",
    });
    db.insert(scheduledOccurrences).values({
      id: "historical-rejected-once", scheduledTaskId: schedule.id,
      scheduledFor: "2000-01-01T00:00:00.000Z", ordinal: 0,
      scheduleRevision: { scheduleType: "once" }, state: "rejected",
    }).run();
    db.update(scheduledTasks).set({ runCount: 1 }).where(eq(scheduledTasks.id, schedule.id)).run();
    const current = schedules.getScheduledTaskById(schedule.id)!;
    expect(originalOnceEntitlement(db, current)).toBe("consumed");

    const native = (db as typeof db & { $client: Database.Database }).$client;
    let snapshotParses = 0;
    native.function("json_valid", { deterministic: true }, (_snapshot: unknown) => {
      snapshotParses++;
      throw new Error("entitlement read reparsed a historical snapshot");
    });
    const queries: string[] = [];
    const traced = drizzle(native, { schema, logger: { logQuery(query) { queries.push(query); } } });

    let entitlement: ReturnType<typeof getOnceEntitlementWithClient> | undefined;
    expect(() => { entitlement = getOnceEntitlementWithClient(traced, current); }).not.toThrow();
    expect(entitlement).toBe("consumed");
    expect(snapshotParses).toBe(0);
    expect(queries.filter(query => /\bjsonb?(?:_\w+)?\s*\(/iu.test(query))).toEqual([]);
    expect(queries.some(query => /\bschedule_revision\b/iu.test(query))).toBe(false);
  });
});
