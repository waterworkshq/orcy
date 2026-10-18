import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as scheduler from "../services/scheduledTaskService.js";
import { logger } from "../lib/logger.js";

let habitatId: string;
let exportRoot: string;
const due = "2020-01-01T00:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  habitatId = habitatRepo.createHabitat({ name: "Scheduler isolation" }).id;
  columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
  exportRoot = mkdtempSync(join(tmpdir(), "orcy-scheduler-isolation-"));
  // Filesystem-location boundary only: export generation, writes and DB updates are real.
  vi.spyOn(process, "cwd").mockReturnValue(exportRoot);
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  rmSync(exportRoot, { recursive: true, force: true });
});

function seed(name: string, cronExpression = "0 9 * * *") {
  return scheduledTaskRepo.createScheduledTask({
    habitatId, name, missionTitle: name, scheduleType: "cron", cronExpression,
    tasksTemplate: [{ title: `${name} task`, order: 0 }], nextRunAt: due, createdBy: "scheduler-test",
  });
}

describe("due scheduled task failure isolation", () => {
  it("isolates an unexpected row read exception and bounds its operator diagnostic", () => {
    const bad = seed("Unexpected read fault");
    const healthy = seed("Healthy after read fault");
    expect(scheduledTaskRepo.getDueScheduledTasks().map((row) => row.id)).toEqual([bad.id, healthy.id]);
    const read = scheduledTaskRepo.getScheduledTaskById;
    // Named fault-injection exception: force a repository read to fail for one row;
    // both schedules, the scan and healthy occurrence publication use the real DB.
    const fault = vi.spyOn(scheduledTaskRepo, "getScheduledTaskById").mockImplementation((id) => {
      if (id === bad.id) throw new Error("x".repeat(2048));
      return read(id);
    });

    expect(scheduler.processDueTasks()).toEqual({ executed: 1, failed: 1 });
    fault.mockRestore();
    expect(scheduledTaskRepo.getScheduledTaskById(bad.id)).toEqual(bad);
    expect(scheduledTaskRepo.getScheduledTaskById(healthy.id)?.runCount).toBe(1);
    expect(getDb().all(sql`SELECT state FROM scheduled_occurrences WHERE scheduled_task_id = ${healthy.id}`)).toEqual([{ state: "published" }]);
    expect(logger.error).toHaveBeenCalledWith(
      { scheduleId: bad.id, error: "x".repeat(512) }, "Error executing scheduled task",
    );
  });

  it("continues healthy rows after a legacy malformed cron without advancing the bad row", () => {
    const bad = seed("Malformed", "not a cron");
    const healthy = seed("Healthy");
    // The SQL query has no ordering promise; assert actual invalid-first enumeration.
    expect(scheduledTaskRepo.getDueScheduledTasks().map((row) => row.id)).toEqual([bad.id, healthy.id]);

    expect(scheduler.processDueTasks()).toEqual({ executed: 1, failed: 1 });
    expect(scheduledTaskRepo.getScheduledTaskById(healthy.id)?.runCount).toBe(1);
    expect(getDb().all(sql`SELECT state FROM scheduled_occurrences WHERE scheduled_task_id = ${healthy.id}`)).toEqual([{ state: "published" }]);
    expect(scheduledTaskRepo.getScheduledTaskById(bad.id)).toEqual(bad);
    expect(getDb().all(sql`SELECT * FROM scheduled_occurrences WHERE scheduled_task_id = ${bad.id}`)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      { scheduleId: bad.id, error: expect.any(String) }, "Error executing scheduled task",
    );

    // It remains due on later polls, but it cannot starve the next pass either.
    expect(scheduler.processDueTasks()).toEqual({ executed: 0, failed: 1 });
    expect(scheduledTaskRepo.getScheduledTaskById(bad.id)).toEqual(bad);
  });
});


function seedAuditExport() {
  getDb().run(sql`INSERT INTO audit_export_schedules
    (id, habitat_id, name, format, filters, schedule, destination_config, enabled, next_run_at, created_by, created_at)
    VALUES ('isolation-export', ${habitatId}, 'Isolation export', 'json', '{}', '0 0 * * *', '{}', 1, ${due}, 'scheduler-test', ${due})`);
}

function expectActualExport() {
  const row = getDb().get(sql`SELECT last_run_at AS lastRunAt, next_run_at AS nextRunAt
    FROM audit_export_schedules WHERE id = 'isolation-export'`) as { lastRunAt: string; nextRunAt: string };
  expect(Number.isFinite(new Date(row.lastRunAt).getTime())).toBe(true);
  expect(new Date(row.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  const dir = join(exportRoot, "exports", habitatId);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/\.json$/);
  expect(Array.isArray(JSON.parse(readFileSync(join(dir, files[0]), "utf8")))).toBe(true);
}

describe("shared scheduled-task and audit-export pass", () => {
  it("publishes a healthy task and a real audit export despite a malformed first row", () => {
    const bad = seed("Malformed shared", "not a cron");
    const healthy = seed("Healthy shared");
    expect(scheduledTaskRepo.getDueScheduledTasks().map((row) => row.id)).toEqual([bad.id, healthy.id]);
    seedAuditExport();

    expect(scheduler.processDueScheduledTasks()).toEqual({
      tasks: { executed: 1, failed: 1 }, audit: { executed: 1, failed: 0 },
    });
    expect(scheduledTaskRepo.getScheduledTaskById(healthy.id)?.runCount).toBe(1);
    expect(getDb().all(sql`SELECT state FROM scheduled_occurrences WHERE scheduled_task_id = ${healthy.id}`)).toEqual([{ state: "published" }]);
    expect(scheduledTaskRepo.getScheduledTaskById(bad.id)).toEqual(bad);
    expectActualExport();
  });

  it("still writes a real export when the due-task SQL scan fails, without inventing a failed row", () => {
    seedAuditExport();
    // A real query failure in this test's isolated DB; the export tables remain usable.
    getDb().run(sql`ALTER TABLE scheduled_tasks RENAME TO unavailable_scheduled_tasks`);

    expect(scheduler.processDueScheduledTasks()).toEqual({
      tasks: { executed: 0, failed: 0, error: expect.stringContaining("scheduled_tasks") },
      audit: { executed: 1, failed: 0 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      { error: expect.any(String) }, "Error processing scheduled task stage",
    );
    expectActualExport();
  });
});
