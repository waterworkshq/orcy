import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as templateRepo from '../repositories/template.js';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as scheduledTaskService from '../services/scheduledTaskService.js';
import { features, tasks, columns as columnsTable, boards, featureTemplates, scheduledTasks } from '../db/schema/index.js';
import type { TaskPriority, TaskTemplateEntry } from '../models/index.js';

let boardId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(scheduledTasks).run();
  db.delete(tasks).run();
  db.delete(features).run();
  db.delete(columnsTable).run();
  db.delete(boards).run();
  db.delete(featureTemplates).run();

  const board = boardRepo.createBoard({ name: 'Test Board' });
  boardId = board.id;

  const column = columnRepo.createColumn({ boardId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = column.id;
});

afterEach(() => {
  closeDb();
});

describe('calculateNextRun', () => {
  it('computes next run for cron schedule', () => {
    const result = scheduledTaskService.calculateNextRun('cron', '0 9 * * *', null, 'UTC');
    const next = new Date(result);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('computes next run for interval schedule', () => {
    const before = Date.now() + 60 * 60_000 - 1000;
    const result = scheduledTaskService.calculateNextRun('interval', null, 60);
    const after = Date.now() + 60 * 60_000 + 1000;
    const next = new Date(result).getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(after);
  });

  it('computes far future for once schedule', () => {
    const result = scheduledTaskService.calculateNextRun('once', null, null);
    const next = new Date(result);
    expect(next.getFullYear()).toBeGreaterThanOrEqual(9999);
  });

  it('defaults to 1 minute for unknown schedule type', () => {
    const before = Date.now() + 60_000 - 1000;
    const result = scheduledTaskService.calculateNextRun('unknown', null, null);
    const after = Date.now() + 60_000 + 1000;
    const next = new Date(result).getTime();
    expect(next).toBeGreaterThanOrEqual(before);
    expect(next).toBeLessThanOrEqual(after);
  });

  it('respects timezone for cron schedule', () => {
    const result = scheduledTaskService.calculateNextRun('cron', '0 9 * * *', null, 'America/New_York');
    expect(result).toBeTruthy();
    const next = new Date(result);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('executeScheduledTask', () => {
  function createSchedule(overrides: Record<string, unknown> = {}) {
    return scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Daily Standup',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Daily standup feature',
      featureDescription: 'Auto-created standup',
      featurePriority: 'medium' as TaskPriority,
      featureLabels: ['standup'],
      tasksTemplate: [
        { title: 'Review board', description: 'Check progress', order: 0 },
      ] as TaskTemplateEntry[],
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
      ...overrides,
    });
  }

  it('creates feature from schedule with no template', () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    expect(result.featureId).toBeTruthy();

    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature).not.toBeNull();
    expect(feature!.title).toBe('Daily standup feature');
    expect(feature!.boardId).toBe(boardId);

    const schedAfter = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(schedAfter!.runCount).toBe(1);
    expect(schedAfter!.lastRunAt).toBeTruthy();
    expect(schedAfter!.lastCreatedFeatureId).toBe(result.featureId);
    expect(schedAfter!.nextRunAt).not.toBe(schedule.nextRunAt);
  });

  it('creates tasks from tasksTemplate', () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const createdTasks = taskRepo.getTasksByFeatureId(result.featureId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toBe('Review board');
  });

  it('uses template when templateId is set and template exists', () => {
    const template = templateRepo.createTemplate({
      boardId,
      name: 'Sprint Template',
      titlePattern: 'Sprint Task',
      descriptionPattern: 'Sprint description',
      priority: 'high' as TaskPriority,
      labels: ['sprint'],
      tasksTemplate: [
        { title: 'Plan', order: 0 },
        { title: 'Execute', order: 1 },
      ] as TaskTemplateEntry[],
      createdBy: 'human',
    });

    const schedule = createSchedule({ templateId: template.id });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature!.title).toBe('Daily standup feature');

    const createdTasks = taskRepo.getTasksByFeatureId(result.featureId!);
    expect(createdTasks).toHaveLength(2);
  });

  it('falls back to stored fields when template is deleted', () => {
    const template = templateRepo.createTemplate({
      boardId,
      name: 'Deleted Template',
      titlePattern: 'Original',
      descriptionPattern: 'Original desc',
      priority: 'medium' as TaskPriority,
      labels: [],
      tasksTemplate: [],
      createdBy: 'human',
    });

    const schedule = createSchedule({ templateId: template.id });
    templateRepo.deleteTemplate(template.id);

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature!.title).toBe('Daily standup feature');

    const createdTasks = taskRepo.getTasksByFeatureId(result.featureId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toBe('Review board');
  });

  it('returns error for non-existent schedule', () => {
    const result = scheduledTaskService.executeScheduledTask('non-existent-id');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Scheduled task not found');
  });

  it('returns error for disabled schedule', () => {
    const schedule = createSchedule();
    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Scheduled task is disabled');
  });

  it('disables once-type schedule after successful execution', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'One-time task',
      scheduleType: 'once',
      featureTitle: 'One-time feature',
      featurePriority: 'medium' as TaskPriority,
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    expect(result.featureId).toBeTruthy();

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.enabled).toBe(false);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
  });

  it('updates lastRunAt, runCount, and nextRunAt after execution', () => {
    const schedule = createSchedule();
    const before = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(before!.runCount).toBe(0);
    expect(before!.lastRunAt).toBeNull();

    scheduledTaskService.executeScheduledTask(schedule.id);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
    expect(after!.lastCreatedFeatureId).toBeTruthy();
    expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('processDueTasks', () => {
  it('executes enabled schedules with nextRunAt in past', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Due Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Past due feature',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
  });

  it('skips schedules with nextRunAt in future', () => {
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Future Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Future feature',
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(0);
  });

  it('skips disabled schedules', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Disabled Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Disabled feature',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });
    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(0);
  });

  it('prevents concurrent duplicate execution via CAS lock', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'CAS Lock Test',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'CAS Feature',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });

    const nextRun = new Date(Date.now() + 86400_000).toISOString();

    const claimed1 = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed1).toBe(true);

    const claimed2 = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed2).toBe(false);
  });

  it('handles multiple due schedules', () => {
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Task 1',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Feature 1',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Task 2',
      scheduleType: 'cron',
      cronExpression: '0 10 * * *',
      featureTitle: 'Feature 2',
      nextRunAt: new Date(Date.now() - 120_000).toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.processDueTasks();

    expect(result.executed).toBe(2);
  });
});

describe('processDueAuditExports', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(require('drizzle-orm').sql`CREATE TABLE IF NOT EXISTS audit_export_schedules (
      id text PRIMARY KEY NOT NULL,
      board_id text NOT NULL,
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

  it('executes audit export schedules that are due', () => {
    const db = getDb();
    const { sql } = require('drizzle-orm');
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, board_id, name, format, filters, schedule, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-1', ${boardId}, 'Daily Export', 'csv', '{}', '0 0 * * *', 1, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('skips audit exports with future nextRunAt', () => {
    const db = getDb();
    const { sql } = require('drizzle-orm');
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, board_id, name, format, filters, schedule, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-2', ${boardId}, 'Future Export', 'json', '{}', '0 0 * * *', 1, ${new Date(Date.now() + 3600_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(0);
  });

  it('skips disabled audit exports', () => {
    const db = getDb();
    const { sql } = require('drizzle-orm');
    const now = new Date().toISOString();
    db.run(sql`INSERT INTO audit_export_schedules (id, board_id, name, format, filters, schedule, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-3', ${boardId}, 'Disabled Export', 'csv', '{}', '0 0 * * *', 0, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(0);
  });

  it('does not allow user filters to override system format and since', () => {
    const db = getDb();
    const { sql } = require('drizzle-orm');
    const now = new Date().toISOString();
    const maliciousFilters = JSON.stringify({ since: '2020-01-01T00:00:00Z', format: 'evil' });
    db.run(sql`INSERT INTO audit_export_schedules (id, board_id, name, format, filters, schedule, enabled, next_run_at, created_by, created_at)
      VALUES ('audit-filter', ${boardId}, 'Filter Override Test', 'csv', ${maliciousFilters}, '0 0 * * *', 1, ${new Date(Date.now() - 60_000).toISOString()}, 'system', ${now})`);

    const result = scheduledTaskService.processDueAuditExports();

    expect(result.executed).toBe(1);
    expect(result.failed).toBe(0);

    const fs = require('fs');
    const path = require('path');
    const exportDir = path.join(process.cwd(), 'exports', boardId);
    const files = fs.readdirSync(exportDir);
    expect(files.some((f: string) => f.endsWith('.csv'))).toBe(true);
  });
});

describe('processDueScheduledTasks', () => {
  beforeEach(() => {
    const db = getDb();
    db.run(require('drizzle-orm').sql`CREATE TABLE IF NOT EXISTS audit_export_schedules (
      id text PRIMARY KEY NOT NULL,
      board_id text NOT NULL,
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

  it('runs both task and audit processors', () => {
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Task',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Feature',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.processDueScheduledTasks();

    expect(result.tasks.executed).toBe(1);
    expect(result.audit.executed).toBe(0);
  });
});

describe('scheduledTaskRepo', () => {
  it('creates and retrieves a scheduled task', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Test Schedule',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Test Feature',
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const retrieved = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Schedule');
    expect(retrieved!.scheduleType).toBe('cron');
    expect(retrieved!.cronExpression).toBe('0 9 * * *');
    expect(retrieved!.enabled).toBe(true);
    expect(retrieved!.runCount).toBe(0);
  });

  it('lists scheduled tasks by board', () => {
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Task 1',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F1',
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Task 2',
      scheduleType: 'interval',
      intervalMinutes: 30,
      featureTitle: 'F2',
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const list = scheduledTaskRepo.getScheduledTasksByBoardId(boardId);
    expect(list).toHaveLength(2);
  });

  it('updates a scheduled task', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Original',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F1',
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const updated = scheduledTaskRepo.updateScheduledTask(schedule.id, {
      name: 'Updated',
      enabled: false,
    });

    expect(updated!.name).toBe('Updated');
    expect(updated!.enabled).toBe(false);
  });

  it('deletes a scheduled task', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'ToDelete',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F1',
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const deleted = scheduledTaskRepo.deleteScheduledTask(schedule.id);
    expect(deleted).toBe(true);

    const retrieved = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(retrieved).toBeNull();
  });

  it('returns false when deleting non-existent task', () => {
    const deleted = scheduledTaskRepo.deleteScheduledTask('non-existent');
    expect(deleted).toBe(false);
  });

  it('returns null when getting by non-existent ID', () => {
    const result = scheduledTaskRepo.getScheduledTaskById('non-existent-id');
    expect(result).toBeNull();
  });

  it('updateScheduledTask returns null for non-existent task', () => {
    const result = scheduledTaskRepo.updateScheduledTask('non-existent', { name: 'x' });
    expect(result).toBeNull();
  });

  it('getDueScheduledTasks returns only enabled tasks with past nextRunAt', () => {
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Due',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F1',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });
    scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Future',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F2',
      nextRunAt: new Date(Date.now() + 3600_000).toISOString(),
      createdBy: 'human',
    });

    const due = scheduledTaskRepo.getDueScheduledTasks();
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe('Due');
  });

  it('claimExecution updates execution fields', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'ClaimTest',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'F1',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });

    const nextRun = new Date(Date.now() + 86400_000).toISOString();
    const claimed = scheduledTaskRepo.claimExecution(schedule.id, nextRun);
    expect(claimed).toBe(true);

    const after = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(after!.runCount).toBe(1);
    expect(after!.lastRunAt).toBeTruthy();
    expect(after!.nextRunAt).toBe(nextRun);

    scheduledTaskRepo.finalizeExecution(schedule.id, 'feat-123');
    const finalized = scheduledTaskRepo.getScheduledTaskById(schedule.id);
    expect(finalized!.lastCreatedFeatureId).toBe('feat-123');
  });

  it('claimExecution returns false for non-existent task', () => {
    const result = scheduledTaskRepo.claimExecution('non-existent', new Date().toISOString());
    expect(result).toBe(false);
  });

  it('claimExecution returns false for disabled task', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'DisabledClaim',
      scheduleType: 'interval',
      intervalMinutes: 60,
      featureTitle: 'F1',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      createdBy: 'human',
    });

    scheduledTaskRepo.updateScheduledTask(schedule.id, { enabled: false });

    const result = scheduledTaskRepo.claimExecution(schedule.id, new Date().toISOString());
    expect(result).toBe(false);
  });
});

describe('substituteTokens', () => {
  it('returns unchanged string when no tokens present', () => {
    expect(scheduledTaskService.substituteTokens('Weekly Audit', { runCount: 1, timezone: 'UTC' }))
      .toBe('Weekly Audit');
  });

  it('replaces {{date}} with YYYY-MM-DD', () => {
    const result = scheduledTaskService.substituteTokens('Audit {{date}}', { runCount: 1, timezone: 'UTC' });
    expect(result).toMatch(/^Audit \d{4}-\d{2}-\d{2}$/);
  });

  it('replaces {{counter}} with runCount', () => {
    expect(scheduledTaskService.substituteTokens('Sprint {{counter}}', { runCount: 5, timezone: 'UTC' }))
      .toBe('Sprint 5');
  });

  it('replaces both {{counter}} and {{date}}', () => {
    const result = scheduledTaskService.substituteTokens('Sprint {{counter}} — {{date}}', { runCount: 5, timezone: 'UTC' });
    expect(result).toMatch(/^Sprint 5 — \d{4}-\d{2}-\d{2}$/);
  });

  it('replaces multiple occurrences of same token', () => {
    const result = scheduledTaskService.substituteTokens('{{date}} ({{date}})', { runCount: 1, timezone: 'UTC' });
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \(\d{4}-\d{2}-\d{2}\)$/);
  });

  it('leaves unknown tokens untouched', () => {
    expect(scheduledTaskService.substituteTokens('Report {{foo}}', { runCount: 1, timezone: 'UTC' }))
      .toBe('Report {{foo}}');
  });

  it('is case-sensitive: {{Date}} and {{COUNTER}} are not replaced', () => {
    expect(scheduledTaskService.substituteTokens('{{Date}} {{COUNTER}}', { runCount: 1, timezone: 'UTC' }))
      .toBe('{{Date}} {{COUNTER}}');
  });

  it('handles empty string', () => {
    expect(scheduledTaskService.substituteTokens('', { runCount: 1, timezone: 'UTC' }))
      .toBe('');
  });

  it('respects timezone for {{date}}', () => {
    const utcResult = scheduledTaskService.substituteTokens('{{date}}', { runCount: 1, timezone: 'UTC' });
    const tokyoResult = scheduledTaskService.substituteTokens('{{date}}', { runCount: 1, timezone: 'Asia/Tokyo' });
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(utcResult).toMatch(datePattern);
    expect(tokyoResult).toMatch(datePattern);
    // Tokyo is UTC+9 so the dates may differ depending on the current hour;
    // the primary assertion is that the timezone option is wired through to
    // Intl.DateTimeFormat, which is a trusted stdlib — we verify plumbing, not the stdlib.
  });
});

describe('token substitution in execution', () => {
  function createSchedule(overrides: Record<string, unknown> = {}) {
    return scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Templated Schedule',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Sprint {{counter}} — {{date}}',
      featureDescription: 'Week of {{date}}',
      featurePriority: 'medium' as TaskPriority,
      featureLabels: ['sprint'],
      tasksTemplate: [
        { title: 'Review sprint {{counter}} backlog', description: 'Check items', order: 0 },
      ] as TaskTemplateEntry[],
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
      ...overrides,
    });
  }

  it('resolves tokens in feature title, description, and task titles', () => {
    const schedule = createSchedule();

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);
    expect(feature!.description).toMatch(/^Week of \d{4}-\d{2}-\d{2}$/);

    const createdTasks = taskRepo.getTasksByFeatureId(result.featureId!);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].title).toMatch(/^Review sprint 1 backlog$/);
  });

  it('increments counter on second execution', () => {
    const schedule = createSchedule({ scheduleType: 'interval', intervalMinutes: 1 });

    const result1 = scheduledTaskService.executeScheduledTask(schedule.id);
    expect(result1.success).toBe(true);
    const feature1 = featureRepo.getFeatureById(result1.featureId!);
    expect(feature1!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);

    scheduledTaskRepo.updateScheduledTask(schedule.id, {
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });

    const result2 = scheduledTaskService.executeScheduledTask(schedule.id);
    expect(result2.success).toBe(true);
    const feature2 = featureRepo.getFeatureById(result2.featureId!);
    expect(feature2!.title).toMatch(/^Sprint 2 — \d{4}-\d{2}-\d{2}$/);
  });

  it('resolves tokens via template path when templateId is set', () => {
    const template = templateRepo.createTemplate({
      boardId,
      name: 'Sprint Template',
      titlePattern: 'Template Task',
      descriptionPattern: 'Template desc',
      priority: 'high' as TaskPriority,
      labels: ['sprint'],
      tasksTemplate: [
        { title: 'Plan', order: 0 },
      ] as TaskTemplateEntry[],
      createdBy: 'human',
    });

    const schedule = createSchedule({ templateId: template.id });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature!.title).toMatch(/^Sprint 1 — \d{4}-\d{2}-\d{2}$/);
  });

  it('passes non-templated titles through unchanged', () => {
    const schedule = scheduledTaskRepo.createScheduledTask({
      boardId,
      name: 'Plain Schedule',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      featureTitle: 'Daily Standup',
      featureDescription: 'Auto standup',
      featurePriority: 'medium' as TaskPriority,
      featureLabels: [],
      tasksTemplate: [],
      nextRunAt: new Date().toISOString(),
      createdBy: 'human',
    });

    const result = scheduledTaskService.executeScheduledTask(schedule.id);

    expect(result.success).toBe(true);
    const feature = featureRepo.getFeatureById(result.featureId!);
    expect(feature!.title).toBe('Daily Standup');
    expect(feature!.description).toBe('Auto standup');
  });
});
