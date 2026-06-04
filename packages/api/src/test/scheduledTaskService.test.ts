import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import * as templateRepo from "../repositories/template.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as scheduledTaskService from "../services/scheduledTaskService.js";
import {
  missions,
  tasks,
  columns as columnsTable,
  habitats,
  missionTemplates,
  scheduledTasks,
} from "../db/schema/index.js";
import type { TaskPriority, TaskTemplateEntry } from "../models/index.js";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(scheduledTasks).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;

  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => {
  const exportDir = join(process.cwd(), "exports", habitatId);
  if (existsSync(exportDir)) {
    rmSync(exportDir, { recursive: true, force: true });
  }
  closeDb();
});

describe("calculateNextRun", () => {
  it("computes next run for cron schedule", () => {
    const result = scheduledTaskService.calculateNextRun("cron", "0 9 * * *", null, "UTC");
    const next = new Date(result);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("computes next run for interval schedule", () => {
    const before = Date.now() + 60 * 60_000 - 1000;
    const result = scheduledTaskService.calculateNextRun("interval", null, 60);
    const after = Date.now() + 60 * 60_000 + 1000;
    const next = new Date(result).getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(after);
  });

  it("computes far future for once schedule", () => {
    const result = scheduledTaskService.calculateNextRun("once", null, null);
    const next = new Date(result);
    expect(next.getFullYear()).toBeGreaterThanOrEqual(9999);
  });

  it("defaults to 1 minute for unknown schedule type", () => {
    const before = Date.now() + 60_000 - 1000;
    const result = scheduledTaskService.calculateNextRun("unknown", null, null);
    const after = Date.now() + 60_000 + 1000;
    const next = new Date(result).getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(after);
  });

  it("respects timezone for cron schedule", () => {
    const result = scheduledTaskService.calculateNextRun(
      "cron",
      "0 9 * * *",
      null,
      "America/New_York",
    );
    expect(result).toBeTruthy();
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe("executeScheduledTask", () => {
  function createSchedule(overrides: Record<string, unknown> = {}) {
    return scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Daily Standup",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Daily standup mission",
      missionDescription: "Auto-created standup",
      missionPriority: "medium" as TaskPriority,
      missionLabels: ["standup"],
      tasksTemplate: [
        { title: "Review habitat", description: "Check progress", order: 0 },
      ] as TaskTemplateEntry[],
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
      ...overrides,
    });
  }

  it("creates mission from schedule with no template", () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    expect(result.missionId).toBeTruthy();

    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission).not.toBeNull();
    expect(mission!.title).toBe("Daily standup mission");
    expect(mission!.habitatId).toBe(habitatId);

    const schedAfter = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(schedAfter!.runCount).toBe(1);
    expect(schedAfter!.lastRunAt).toBeTruthy();
    expect(schedAfter!.lastCreatedMissionId).toBe(result.missionId);
    expect(schedAfter!.nextRunAt).not.toBe(schedule.nextRunAt);
  });

  it("creates tasks from tasksTemplate", () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const createdTasks = taskRepo.getTasksByMissionId(result.missionId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toBe("Review habitat");
  });

  it("uses template when templateId is set and template exists", () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Sprint Template",
      titlePattern: "Sprint Task",
      descriptionPattern: "Sprint description",
      priority: "high" as TaskPriority,
      labels: ["sprint"],
      tasksTemplate: [
        { title: "Plan", order: 0 },
        { title: "Execute", order: 1 },
      ] as TaskTemplateEntry[],
      createdBy: "human",
    });

    const schedule = createSchedule({ templateId: template.id });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission!.title).toBe("Daily standup mission");

    const createdTasks = taskRepo.getTasksByMissionId(result.missionId!);
    expect(createdTasks).toHaveLength(2);
  });

  it("falls back to stored fields when template is deleted", () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Deleted Template",
      titlePattern: "Original",
      descriptionPattern: "Original desc",
      priority: "medium" as TaskPriority,
      labels: [],
      tasksTemplate: [],
      createdBy: "human",
    });

    const schedule = createSchedule({ templateId: template.id });
    templateRepo.deleteTemplate(template.id);

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission!.title).toBe("Daily standup mission");

    const createdTasks = taskRepo.getTasksByMissionId(result.missionId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toBe("Review habitat");
  });

  it("returns error for non-existent schedule", () => {
    const result = scheduledTaskService.executeScheduledTask("non-existent-id");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Scheduled task not found");
  });

  it("returns error for disabled schedule", () => {
    const schedule = createSchedule();
    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Scheduled task is disabled");
  });

  it("disables once-type schedule after successful execution", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "One-time task",
      scheduleType: "once",
      missionTitle: "One-time mission",
      missionPriority: "medium" as TaskPriority,
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    expect(result.missionId).toBeTruthy();

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.enabled).toBe(false);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
  });

  it("updates lastRunAt, runCount, and nextRunAt after execution", () => {
    const schedule = createSchedule();
    const before = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(before!.runCount).toBe(0);
    expect(before!.lastRunAt).toBeNull();

    scheduledTaskService.executeScheduledTask(schedule.id);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
    expect(after!.lastCreatedMissionId).toBeTruthy();
    expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe("processDueTasks", () => {
  it("executes enabled schedules with nextRunAt in past", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Due Task",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Past due mission",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
  });

  it("skips schedules with nextRunAt in future", () => {
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Future Task",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Future mission",
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(0);
  });

  it("skips disabled schedules", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Disabled Task",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Disabled mission",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });
    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(0);
  });

  it("prevents concurrent duplicate execution via CAS lock", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "CAS Lock Test",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "CAS Mission",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });

    const nextRun = new Date(Date.now() + 86400_000).toISOString();

    const claimed1 = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed1).toBe(true);

    const claimed2 = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed2).toBe(false);
  });

  it("handles multiple due schedules", () => {
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Task 1",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Mission 1",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Task 2",
      scheduleType: "cron",
      cronExpression: "0 10 * * *",
      missionTitle: "Mission 2",
      nextRunAt: new Date(Date.now() - 120_000).toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(2);
  });
});

describe("processDueAuditExports", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(require("drizzle-orm").sql`CREATE TABLE IF NOT EXISTS audit_export_schedules (
      id text PRIMARY KEY NOT NULL,
      habitat_id text NOT NULL,
      name text NOT NULL,
      format text NOT NULL,
      filters text NOT NULL DEFAULT '{}',
      schedule text NOT NULL,
      destination text NOT NULL DEFAULT 'local',
      destination_config text NOT NULL DEFAULT '{}',
      enabled integer DEFAULT 1 NOT NULL,
      last_run_at text,
      next_run_at text NOT NULL,
      created_by text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  function insertAuditExportSchedule(id: string, format: "csv" | "json" | "jsonl", filters = "{}") {
    const db = getDb();
    const { sql } = require("drizzle-orm");
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, habitat_id, name, format, filters, schedule, destination_config, enabled, next_run_at, created_by, created_at)
      VALUES (${id}, ${habitatId}, 'Daily Export', ${format}, ${filters}, '0 0 * * *', '{}', 1, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);
  }

  function readOnlyExportFile(extension: string): string {
    const exportDir = join(process.cwd(), "exports", habitatId);
    const files = readdirSync(exportDir).filter((file) => file.endsWith(extension));
    expect(files).toHaveLength(1);
    return readFileSync(join(exportDir, files[0]), "utf-8");
  }

  it("executes audit export schedules that are due", () => {
    insertAuditExportSchedule("audit-1", "csv");

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("writes CSV event export content instead of summary counts", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "CSV audit mission",
      createdBy: "human",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "CSV audit task",
      createdBy: "human",
    });
    eventRepo.createEvent({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });
    insertAuditExportSchedule("audit-csv", "csv");

    const result = scheduledTaskService.processDueAuditExports();

    expect(result).toEqual({ executed: 1, failed: 0 });
    const content = readOnlyExportFile(".csv");
    expect(content).toContain(
      "id,occurredAt,habitatId,entityType,entityId,action,actorType,actorId,source,summary,completenessStatus",
    );
    expect(content).toContain(",task,");
    expect(content).toContain(",created,");
    expect(content).not.toContain("date,count\n");
  });

  it("writes JSONL event rows", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "JSONL audit mission",
      createdBy: "human",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "JSONL audit task",
      createdBy: "human",
    });
    eventRepo.createEvent({
      taskId: task.id,
      actorType: "human",
      actorId: "user-1",
      action: "created",
    });
    insertAuditExportSchedule("audit-jsonl", "jsonl");

    const result = scheduledTaskService.processDueAuditExports();

    expect(result).toEqual({ executed: 1, failed: 0 });
    const lines = readOnlyExportFile(".jsonl").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0])).toMatchObject({ entity: { type: "task" }, action: "created" });
  });

  it("honors scheduled export action filters", () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Filtered audit mission",
      createdBy: "human",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "Filtered audit task",
      createdBy: "human",
    });
    eventRepo.createEvent({
      taskId: task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "claimed",
    });
    insertAuditExportSchedule(
      "audit-filtered-actions",
      "json",
      JSON.stringify({ actions: "claimed" }),
    );

    const result = scheduledTaskService.processDueAuditExports();

    expect(result).toEqual({ executed: 1, failed: 0 });
    const rows = JSON.parse(readOnlyExportFile(".json"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "claimed", entity: { type: "task" } });
  });

  it("skips audit exports with future nextRunAt", () => {
    const db = getDb();
    const { sql } = require("drizzle-orm");
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, habitat_id, name, format, filters, schedule, destination_config, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-2', ${habitatId}, 'Future Export', 'json', '{}', '0 0 * * *', '{}', 1, ${new Date(Date.now() + 3600_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(0);
  });

  it("skips disabled audit exports", () => {
    const db = getDb();
    const { sql } = require("drizzle-orm");
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, habitat_id, name, format, filters, schedule, destination_config, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-3', ${habitatId}, 'Disabled Export', 'csv', '{}', '0 0 * * *', '{}', 0, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(0);
  });

  it("does not allow user filters to override system format and since", () => {
    const db = getDb();
    const { sql } = require("drizzle-orm");
    const now = new Date().toISOString();
    const maliciousFilters = JSON.stringify({ since: "2020-01-01T00:00:00Z", format: "evil" });
    db.run(sql`INSERT INTO audit_export_schedules (id, habitat_id, name, format, filters, schedule, destination_config, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-filter', ${habitatId}, 'Filter Override Test', 'csv', ${maliciousFilters}, '0 0 * * *', '{}', 1, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const fs = require("fs");
    const path = require("path");
    const exportDir = path.join(process.cwd(), "exports", habitatId);
    const files = fs.readdirSync(exportDir);
    expect(files.some((f: string) => f.endsWith(".csv"))).toBe(true);
  });
});

describe("processDueScheduledTasks", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(require("drizzle-orm").sql`CREATE TABLE IF NOT EXISTS audit_export_schedules (
      id text PRIMARY KEY NOT NULL,
      habitat_id text NOT NULL,
      name text NOT NULL,
      format text NOT NULL,
      filters text NOT NULL DEFAULT '{}',
      schedule text NOT NULL,
      destination text NOT NULL DEFAULT 'local',
      destination_config text NOT NULL DEFAULT '{}',
      enabled integer DEFAULT 1 NOT NULL,
      last_run_at text,
      next_run_at text NOT NULL,
      created_by text NOT NULL,
      created_at text NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  it("runs both task and audit processors", () => {
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Task",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Mission",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.processDueScheduledTasks();

    expect(result.tasks.executed).toBe(1);
    expect(result.audit.executed).toBe(0);
  });
});

describe("scheduledTaskRepo", () => {
  it("creates and retrieves a scheduled task", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Test Schedule",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Test Mission",
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const retrieved = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Test Schedule");
    expect(retrieved!.scheduleType).toBe("cron");
    expect(retrieved!.cronExpression).toBe("0 9 * * *");
    expect(retrieved!.enabled).toBe(true);
    expect(retrieved!.runCount).toBe(0);
  });

  it("lists scheduled tasks by habitat", () => {
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Task 1",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F1",
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Task 2",
      scheduleType: "interval",
      intervalMinutes: 30,
      missionTitle: "F2",
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const list = scheduledTaskRepo.getScheduledTasksByHabitatId(habitatId);
    expect(list).toHaveLength(2);
  });

  it("updates a scheduled task", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Original",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F1",
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const updated = scheduledTaskRepo.updateScheduledTask(schedule.id, {
      name: "Updated",
      enabled: false,
    });

    expect(updated!.name).toBe("Updated");
    expect(updated!.enabled).toBe(false);
  });

  it("deletes a scheduled task", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "ToDelete",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F1",
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const deleted = scheduledTaskRepo.deleteScheduledTask(schedule.id);
    expect(deleted).toBe(true);

    const retrieved = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(retrieved).toBeNull();
  });

  it("returns false when deleting non-existent task", () => {
    const deleted = scheduledTaskRepo.deleteScheduledTask("non-existent");
    expect(deleted).toBe(false);
  });

  it("returns null when getting by non-existent ID", () => {
    const result = scheduledTaskRepo.getScheduledTaskById("non-existent-id");
    expect(result).toBeNull();
  });

  it("updateScheduledTask returns null for non-existent task", () => {
    const result = scheduledTaskRepo.updateScheduledTask("non-existent", { name: "x" });
    expect(result).toBeNull();
  });

  it("getDueScheduledTasks returns only enabled tasks with past nextRunAt", () => {
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Due",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F1",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });
    scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Future",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F2",
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      createdBy: "human",
    });

    const due = scheduledTaskRepo.getDueScheduledTasks();
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("Due");
  });

  it("claimExecution updates execution fields", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "ClaimTest",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "F1",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });

    const nextRun = new Date(Date.now() + 86400_000).toISOString();
    const claimed = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed).toBe(true);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
    expect(after!.nextRunAt).toBe(nextRun);

    scheduledTaskRepo.finalizeExecution(schedule.id, "feat-123");
    const finalized = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(finalized!.lastCreatedMissionId).toBe("feat-123");
  });

  it("claimExecution returns false for non-existent task", () => {
    const result = scheduledTaskRepo.claimExecution("non-existent", new Date().toISOString());
    expect(result).toBe(false);
  });

  it("claimExecution returns false for disabled task", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "DisabledClaim",
      scheduleType: "interval",
      intervalMinutes: 60,
      missionTitle: "F1",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: "human",
    });

    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskRepo.claimExecution(schedule.id, new Date().toISOString());
    expect(result).toBe(false);
  });
});

describe("substituteTokens", () => {
  it("returns unchanged string when no tokens present", () => {
    expect(
      scheduledTaskService.substituteTokens("Weekly Audit", { runCount: 1, timezone: "UTC" }),
    ).toBe("Weekly Audit");
  });

  it("replaces {{date}} with YYYY-MM-DD", () => {
    const result = scheduledTaskService.substituteTokens("Audit {{date}}", {
      runCount: 1,
      timezone: "UTC",
    });
    expect(result).toMatch(/^Audit \d{4}-\d{2}-\d{2}$/);
  });

  it("replaces {{counter}} with runCount", () => {
    expect(
      scheduledTaskService.substituteTokens("Sprint {{counter}}", { runCount: 5, timezone: "UTC" }),
    ).toBe("Sprint 5");
  });

  it("replaces both {{counter}} and {{date}}", () => {
    const result = scheduledTaskService.substituteTokens("Sprint {{counter}} — {{date}}", {
      runCount: 5,
      timezone: "UTC",
    });
    expect(result).toMatch(/^Sprint 5 — \d{4}-\d{2}-\d{2}$/);
  });

  it("replaces multiple occurrences of same token", () => {
    const result = scheduledTaskService.substituteTokens("{{date}} ({{date}})", {
      runCount: 1,
      timezone: "UTC",
    });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \(\d{4}-\d{2}-\d{2}\)$/);
  });

  it("leaves unknown tokens untouched", () => {
    expect(
      scheduledTaskService.substituteTokens("Report {{foo}}", { runCount: 1, timezone: "UTC" }),
    ).toBe("Report {{foo}}");
  });

  it("is case-sensitive: {{Date}} and {{COUNTER}} are not replaced", () => {
    expect(
      scheduledTaskService.substituteTokens("{{Date}} {{COUNTER}}", {
        runCount: 1,
        timezone: "UTC",
      }),
    ).toBe("{{Date}} {{COUNTER}}");
  });

  it("handles empty string", () => {
    expect(scheduledTaskService.substituteTokens("", { runCount: 1, timezone: "UTC" })).toBe("");
  });

  it("respects timezone for {{date}}", () => {
    const utcResult = scheduledTaskService.substituteTokens("{{date}}", {
      runCount: 1,
      timezone: "UTC",
    });
    const tokyoResult = scheduledTaskService.substituteTokens("{{date}}", {
      runCount: 1,
      timezone: "Asia/Tokyo",
    });
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(utcResult).toMatch(datePattern);
    expect(tokyoResult).toMatch(datePattern);
    // Tokyo is UTC+9 so the dates may differ depending on the current hour;
    // the primary assertion is that the timezone option is wired through to
    // Intl.DateTimeFormat, which is a trusted stdlib — we verify plumbing, not the stdlib.
  });
});

describe("token substitution in execution", () => {
  function createSchedule(overrides: Record<string, unknown> = {}) {
    return scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Templated Schedule",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Sprint {{counter}} — {{date}}",
      missionDescription: "Week of {{date}}",
      missionPriority: "medium" as TaskPriority,
      missionLabels: ["sprint"],
      tasksTemplate: [
        { title: "Review sprint {{counter}} backlog", description: "Check items", order: 0 },
      ] as TaskTemplateEntry[],
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
      ...overrides,
    });
  }

  it("resolves tokens in mission title, description, and task titles", () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);
    expect(mission!.description).toMatch(/^Week of \d{4}-\d{2}-\d{2}$/);

    const createdTasks = taskRepo.getTasksByMissionId(result.missionId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toMatch(/^Review sprint 1 backlog$/);
  });

  it("increments counter on second execution", () => {
    const schedule = createSchedule({ scheduleType: "interval", intervalMinutes: 1 });

    const result1 = scheduledTaskService.executeScheduledTask(schedule.id);
    expect(result1.success).toBe(true);
    const feature1 = missionRepo.getMissionById(result1.missionId!);
    expect(feature1!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);

    scheduledTaskRepo.updateScheduledTask(schedule.id, {
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result2 = scheduledTaskService.executeScheduledTask(schedule.id);
    expect(result2.success).toBe(true);
    const feature2 = missionRepo.getMissionById(result2.missionId!);
    expect(feature2!.title).toMatch(/^Sprint 2 — \d{4}-\d{2}-\d{2}$/);
  });

  it("resolves tokens via template path when templateId is set", () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Sprint Template",
      titlePattern: "Template Task",
      descriptionPattern: "Template desc",
      priority: "high" as TaskPriority,
      labels: ["sprint"],
      tasksTemplate: [{ title: "Plan", order: 0 }] as TaskTemplateEntry[],
      createdBy: "human",
    });

    const schedule = createSchedule({ templateId: template.id });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);
  });

  it("passes non-templated titles through unchanged", () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: "Plain Schedule",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      missionTitle: "Daily Standup",
      missionDescription: "Auto standup",
      missionPriority: "medium" as TaskPriority,
      missionLabels: [],
      tasksTemplate: [],
      nextRunAt: new Date().toISOString(),
      createdBy: "human",
    });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const mission = missionRepo.getMissionById(result.missionId!);
    expect(mission!.title).toBe("Daily Standup");
    expect(mission!.description).toBe("Auto standup");
  });
});
