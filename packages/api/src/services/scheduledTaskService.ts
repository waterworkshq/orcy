import { CronExpressionParser } from "cron-parser";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as templateRepo from "../repositories/template.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as auditExportService from "./auditExportService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";
import { getDb } from "../db/index.js";
import { auditExportSchedules } from "../db/schema/index.js";
import { eq, and, lte } from "drizzle-orm";
import type { ScheduledTask, TaskTemplateEntry } from "../models/index.js";
import type { AuditExportQuery } from "./auditExportService.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { sanitizeFilename } from "./fileStorage.js";

export function substituteTokens(
  template: string,
  context: { runCount: number; timezone: string },
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
  }).format(new Date());
  return template.replaceAll("{{date}}", date).replaceAll("{{counter}}", String(context.runCount));
}

export function calculateNextRun(
  scheduleType: string,
  cronExpression: string | null,
  intervalMinutes: number | null,
  timezone: string = "UTC",
): string {
  if (scheduleType === "cron" && cronExpression) {
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone,
    });
    const next = interval.next();
    return next.toISOString() ?? new Date(Date.now() + 60_000).toISOString();
  }

  if (scheduleType === "interval" && intervalMinutes) {
    return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  }

  if (scheduleType === "once") {
    return new Date("9999-12-31T23:59:59Z").toISOString();
  }

  return new Date(Date.now() + 60_000).toISOString();
}

function buildTokenContext(schedule: ScheduledTask) {
  return { runCount: schedule.runCount + 1, timezone: schedule.timezone ?? "UTC" };
}

function createMissionFromSchedule(schedule: ScheduledTask): {
  missionId: string;
  missionTitle: string;
} {
  const ctx = buildTokenContext(schedule);
  const resolvedTitle = substituteTokens(schedule.missionTitle, ctx);
  const mission = missionRepo.createMission({
    habitatId: schedule.habitatId,
    title: resolvedTitle,
    description: substituteTokens(schedule.missionDescription, ctx),
    priority: schedule.missionPriority,
    labels: schedule.missionLabels,
    createdBy: "system",
  });

  for (const entry of (schedule.tasksTemplate ?? []) as TaskTemplateEntry[]) {
    taskRepo.createTask({
      missionId: mission.id,
      title: substituteTokens(entry.title, ctx),
      description: entry.description,
      priority: entry.priority,
      requiredDomain: entry.requiredDomain,
      requiredCapabilities: entry.requiredCapabilities,
      estimatedMinutes: entry.estimatedMinutes,
      order: entry.order,
      createdBy: "system",
    });
  }

  return { missionId: mission.id, missionTitle: resolvedTitle };
}

export function executeScheduledTask(id: string): {
  success: boolean;
  missionId?: string;
  error?: string;
  skipped?: boolean;
} {
  const schedule = scheduledTaskRepo.getScheduledTaskById(id);
  if (!schedule) {
    return { success: false, error: "Scheduled task not found" };
  }

  if (!schedule.enabled) {
    return { success: false, error: "Scheduled task is disabled" };
  }

  const nextRunAt = calculateNextRun(
    schedule.scheduleType,
    schedule.cronExpression,
    schedule.intervalMinutes,
    schedule.timezone,
  );

  const claimed = scheduledTaskRepo.claimExecution(id, nextRunAt);
  if (!claimed) {
    return { success: true, skipped: true };
  }

  try {
    let missionId: string;
    let missionTitle: string;

    if (schedule.templateId) {
      const ctx = buildTokenContext(schedule);
      const resolvedTitle = substituteTokens(schedule.missionTitle, ctx);
      const result = templateRepo.applyTemplate(
        schedule.templateId,
        schedule.habitatId,
        {
          title: resolvedTitle,
          description: substituteTokens(schedule.missionDescription, ctx),
          priority: schedule.missionPriority,
          labels: schedule.missionLabels,
        },
        "system",
      );

      if (result) {
        missionId = result.mission.id;
        missionTitle = resolvedTitle;
      } else {
        const fallback = createMissionFromSchedule(schedule);
        missionId = fallback.missionId;
        missionTitle = fallback.missionTitle;
      }
    } else {
      const direct = createMissionFromSchedule(schedule);
      missionId = direct.missionId;
      missionTitle = direct.missionTitle;
    }

    scheduledTaskRepo.finalizeExecution(id, missionId);

    if (schedule.scheduleType === "once") {
      scheduledTaskRepo.updateScheduledTask(id, { enabled: false });
    }

    sseBroadcaster.publish(schedule.habitatId, {
      type: "scheduled_task.executed",
      data: { scheduleId: id, missionId, missionTitle },
    });

    return { success: true, missionId };
  } catch (err) {
    logger.error({ err, scheduleId: id }, "Error executing scheduled task");

    sseBroadcaster.publish(schedule.habitatId, {
      type: "scheduled_task.failed",
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
    const result = executeScheduledTask(task.id);
    if (result.skipped) continue;
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
    .where(and(eq(auditExportSchedules.enabled, true), lte(auditExportSchedules.nextRunAt, now)))
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

      const habitatId = schedule.habitat_id ?? schedule.habitatId;
      const format = schedule.format;
      const filters =
        typeof schedule.filters === "string"
          ? JSON.parse(schedule.filters)
          : (schedule.filters ?? {});

      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const query = buildAuditExportQuery(format, since, filters || {});

      const filename = auditExportService.getExportFilename(habitatId, format);
      const safeHabitatDir = sanitizeFilename(habitatId);
      const exportDir = join(process.cwd(), "exports", safeHabitatDir);
      mkdirSync(exportDir, { recursive: true });
      const filePath = join(exportDir, filename);

      const content = auditExportService.generateAuditExportContent(habitatId, query);
      writeFileSync(filePath, content, "utf-8");

      const nextRunAt = calculateNextRun("cron", schedule.schedule, null);
      db.update(auditExportSchedules)
        .set({
          lastRunAt: now,
          nextRunAt,
        })
        .where(eq(auditExportSchedules.id, schedule.id))
        .run();

      executed++;
      logger.info({ scheduleId: schedule.id, filePath }, "Audit export schedule executed");
    } catch (err) {
      failed++;
      logger.error({ err, scheduleId: schedule.id }, "Error executing audit export schedule");
    }
  }

  return { executed, failed };
}

function buildAuditExportQuery(
  format: AuditExportQuery["format"],
  since: string,
  filters: Record<string, unknown>,
): AuditExportQuery {
  const query: AuditExportQuery = { format, since };
  const stringFilters: Array<keyof Omit<AuditExportQuery, "format">> = [
    "until",
    "actions",
    "actorType",
    "actorId",
    "entityTypes",
    "entityType",
    "entityId",
    "taskId",
    "missionId",
    "source",
    "provider",
    "preset",
    "includeMetadata",
    "includeProvenance",
    "includeIntegrity",
    "includeHealthSnapshots",
  ];

  for (const key of stringFilters) {
    const value = filters[key];
    if (typeof value === "string" && value.length > 0) {
      query[key] = value;
    }
  }

  return query;
}

export function processDueScheduledTasks(): {
  tasks: { executed: number; failed: number };
  audit: { executed: number; failed: number };
} {
  const tasks = processDueTasks();
  const audit = processDueAuditExports();
  return { tasks, audit };
}

export function startScheduledTaskProcessor(intervalMs: number = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const result = processDueScheduledTasks();
      if (
        result.tasks.executed > 0 ||
        result.tasks.failed > 0 ||
        result.audit.executed > 0 ||
        result.audit.failed > 0
      ) {
        logger.info(result, "Scheduled task processor completed");
      }
    } catch (err) {
      logger.error({ err }, "Error processing scheduled tasks");
    }
  }, intervalMs);
}
