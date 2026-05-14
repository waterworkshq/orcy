import { CronExpressionParser } from 'cron-parser';
import * as scheduledTaskRepo from '../repositories/scheduledTask.js';
import * as templateRepo from '../repositories/template.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as auditExportService from './auditExportService.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import { logger } from '../lib/logger.js';
import { getDb } from '../db/index.js';
import { auditExportSchedules } from '../db/schema/index.js';
import { eq, and, lte } from 'drizzle-orm';
import type { ScheduledTask, TaskPriority, TaskTemplateEntry } from '../models/index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export function calculateNextRun(
  scheduleType: string,
  cronExpression: string | null,
  intervalMinutes: number | null,
  timezone: string = 'UTC',
): string {
  if (scheduleType === 'cron' && cronExpression) {
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone,
    });
    const next = interval.next();
    return next.toISOString() ?? new Date(Date.now() + 60_000).toISOString();
  }

  if (scheduleType === 'interval' && intervalMinutes) {
    return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  }

  if (scheduleType === 'once') {
    return new Date('9999-12-31T23:59:59Z').toISOString();
  }

  return new Date(Date.now() + 60_000).toISOString();
}

function createFeatureFromSchedule(schedule: ScheduledTask): { featureId: string; featureTitle: string } {
  const feature = featureRepo.createFeature({
    boardId: schedule.boardId,
    title: schedule.featureTitle,
    description: schedule.featureDescription,
    priority: schedule.featurePriority,
    labels: schedule.featureLabels,
    createdBy: 'system',
  });

  for (const entry of (schedule.tasksTemplate ?? []) as TaskTemplateEntry[]) {
    taskRepo.createTask({
      featureId: feature.id,
      title: entry.title,
      description: entry.description,
      priority: entry.priority,
      requiredDomain: entry.requiredDomain,
      requiredCapabilities: entry.requiredCapabilities,
      estimatedMinutes: entry.estimatedMinutes,
      order: entry.order,
      createdBy: 'system',
    });
  }

  return { featureId: feature.id, featureTitle: schedule.featureTitle };
}

export function executeScheduledTask(id: string): { success: boolean; featureId?: string; error?: string } {
  const schedule = scheduledTaskRepo.getScheduledTaskById(id);
  if (!schedule) {
    return { success: false, error: 'Scheduled task not found' };
  }

  if (!schedule.enabled) {
    return { success: false, error: 'Scheduled task is disabled' };
  }

  try {
    let featureId: string;
    let featureTitle: string;

    if (schedule.templateId) {
      const result = templateRepo.applyTemplate(
        schedule.templateId,
        schedule.boardId,
        {
          title: schedule.featureTitle,
          description: schedule.featureDescription,
          priority: schedule.featurePriority,
          labels: schedule.featureLabels,
        },
        'system',
      );

      if (result) {
        featureId = result.feature.id;
        featureTitle = schedule.featureTitle;
      } else {
        const fallback = createFeatureFromSchedule(schedule);
        featureId = fallback.featureId;
        featureTitle = fallback.featureTitle;
      }
    } else {
      const direct = createFeatureFromSchedule(schedule);
      featureId = direct.featureId;
      featureTitle = direct.featureTitle;
    }

    const nextRunAt = calculateNextRun(
      schedule.scheduleType,
      schedule.cronExpression,
      schedule.intervalMinutes,
      schedule.timezone,
    );
    scheduledTaskRepo.markExecuted(id, featureId, nextRunAt);

    sseBroadcaster.publish(schedule.boardId, {
      type: 'scheduled_task.executed',
      data: { scheduleId: id, featureId, featureTitle },
    });

    return { success: true, featureId };
  } catch (err) {
    logger.error({ err, scheduleId: id }, 'Error executing scheduled task');

    sseBroadcaster.publish(schedule.boardId, {
      type: 'scheduled_task.failed',
      data: { scheduleId: id, error: (err as Error).message },
    });

    return { success: false, error: (err as Error).message };
  }
}

export function processDueTasks(): { executed: number; failed: number } {
  const dueTasks = scheduledTaskRepo.getDueScheduledTasks();
  let executed = 0;
  let failed = 0;

  for (const task of dueTasks) {
    if (task.lastRunAt) {
      const lastRun = new Date(task.lastRunAt).getTime();
      const oneMinuteAgo = Date.now() - 60_000;
      if (lastRun > oneMinuteAgo) {
        continue;
      }
    }

    const result = executeScheduledTask(task.id);
    if (result.success) {
      executed++;
    } else {
      failed++;
    }
  }

  return { executed, failed };
}

export function processDueAuditExports(): { executed: number; failed: number } {
  const db = getDb();
  const now = new Date().toISOString();

  const dueSchedules = db
    .select()
    .from(auditExportSchedules)
    .where(
      and(
        eq(auditExportSchedules.enabled, true),
        lte(auditExportSchedules.nextRunAt, now),
      )
    )
    .all() as any[];

  let executed = 0;
  let failed = 0;

  for (const schedule of dueSchedules) {
    try {
      if (schedule.lastRunAt || schedule.last_run_at) {
        const lastRun = new Date(schedule.last_run_at ?? schedule.lastRunAt).getTime();
        const oneMinuteAgo = Date.now() - 60_000;
        if (lastRun > oneMinuteAgo) {
          continue;
        }
      }

      const boardId = schedule.board_id ?? schedule.boardId;
      const format = schedule.format;
      const filters = typeof schedule.filters === 'string' ? JSON.parse(schedule.filters) : (schedule.filters ?? {});

      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const query = { format, since, userFilters: filters || {} };

      const filename = auditExportService.getExportFilename(boardId, format);
      const exportDir = join(process.cwd(), 'exports', boardId);
      mkdirSync(exportDir, { recursive: true });
      const filePath = join(exportDir, filename);

      const content = generateAuditExportContent(boardId, format, query);
      writeFileSync(filePath, content, 'utf-8');

      const nextRunAt = calculateNextRun('cron', schedule.schedule, null);
      db.update(auditExportSchedules)
        .set({
          lastRunAt: now,
          nextRunAt,
        })
        .where(eq(auditExportSchedules.id, schedule.id))
        .run();

      executed++;
      logger.info({ scheduleId: schedule.id, filePath }, 'Audit export schedule executed');
    } catch (err) {
      failed++;
      logger.error({ err, scheduleId: schedule.id }, 'Error executing audit export schedule');
    }
  }

  return { executed, failed };
}

function generateAuditExportContent(boardId: string, format: string, query: Record<string, unknown>): string {
  const summary = auditExportService.getAuditSummary(
    boardId,
    query.since as string | undefined,
  );

  if (format === 'csv') {
    const header = 'date,count\n';
    const rows = summary.byDay.map(d => `${d.date},${d.count}`).join('\n');
    return header + rows + '\n';
  }

  if (format === 'jsonl') {
    return summary.byDay.map(d => JSON.stringify(d)).join('\n') + '\n';
  }

  return JSON.stringify(summary, null, 2);
}

export function processDueScheduledTasks(): { tasks: { executed: number; failed: number }; audit: { executed: number; failed: number } } {
  const tasks = processDueTasks();
  const audit = processDueAuditExports();
  return { tasks, audit };
}

export function startScheduledTaskProcessor(intervalMs: number = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const result = processDueScheduledTasks();
      if (result.tasks.executed > 0 || result.tasks.failed > 0 || result.audit.executed > 0 || result.audit.failed > 0) {
        logger.info(result, 'Scheduled task processor completed');
      }
    } catch (err) {
      logger.error({ err }, 'Error processing scheduled tasks');
    }
  }, intervalMs);
}
