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

/**
 * Result returned by a registered {@link ScheduledTaskHandler}. `missionId` is optional — handlers
 * that spawn work without creating a mission (e.g. the wiki cadence handler, which spawns further
 * scheduled-task rows via `runCadence`) leave it unset.
 */
export interface ScheduledTaskHandlerResult {
  success: boolean;
  error?: string;
  missionId?: string;
}

/**
 * A custom handler invoked when a due scheduled task's `name` starts with a registered prefix,
 * instead of the default mission-from-template creation path. This lets domain services (wiki
 * cadence) hook into the scheduler without `scheduledTaskService` depending on them.
 */
export type ScheduledTaskHandler = (schedule: ScheduledTask) => ScheduledTaskHandlerResult;

/** Prefix → handler registry, populated by domain services at boot via {@link registerScheduledTaskHandler}. */
const scheduledTaskHandlers = new Map<string, ScheduledTaskHandler>();

/**
 * Registers a handler invoked when a due scheduled task's `name` starts with `namePrefix`. The
 * handler replaces the default mission-from-template execution for matching schedules. Domain
 * services register their handlers at boot (see `wikiSchedulerService.initWikiScheduler`).
 */
export function registerScheduledTaskHandler(
  namePrefix: string,
  handler: ScheduledTaskHandler,
): void {
  scheduledTaskHandlers.set(namePrefix, handler);
}

/** Returns the registered handler whose `namePrefix` matches `scheduleName`, or `null` when none match. */
function findHandlerForName(scheduleName: string): ScheduledTaskHandler | null {
  for (const [prefix, handler] of scheduledTaskHandlers) {
    if (scheduleName.startsWith(prefix)) return handler;
  }
  return null;
}

/** Replaces `{{date}}` and `{{counter}}` tokens in a template string using the schedule's timezone and run count. */
export function substituteTokens(
  template: string,
  context: { runCount: number; timezone: string },
): string {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: context.timezone,
  }).format(new Date());
  return template.replaceAll("{{date}}", date).replaceAll("{{counter}}", String(context.runCount));
}

/** Computes the next run timestamp for a schedule based on its type (cron, interval, or once). */
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

/** Atomically claims and runs a scheduled task, creating a mission (and its tasks) from the stored template, then publishes an SSE event. Returns `skipped` when another worker already claimed the run. */
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
    const handler = findHandlerForName(schedule.name);
    if (handler) {
      const handlerResult = handler(schedule);
      const missionId = handlerResult.missionId ?? null;
      scheduledTaskRepo.finalizeExecution(id, missionId);

      if (schedule.scheduleType === "once") {
        scheduledTaskRepo.updateScheduledTask(id, { enabled: false });
      }

      if (handlerResult.success) {
        sseBroadcaster.publish(schedule.habitatId, {
          type: "scheduled_task.executed",
          data: {
            scheduleId: id,
            ...(missionId ? { missionId } : {}),
          },
        });
        return { success: true, ...(missionId ? { missionId } : {}) };
      }
      sseBroadcaster.publish(schedule.habitatId, {
        type: "scheduled_task.failed",
        data: { scheduleId: id, error: handlerResult.error ?? "handler failed" },
      });
      return { success: false, error: handlerResult.error ?? "handler failed" };
    }

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

/** Runs every due scheduled task in a single pass and returns the count of executed and failed runs. */
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

/** Generates and writes audit export files for every due audit export schedule, debounced to at most once per minute per schedule. */
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
      // The actorType filter is narrowed to a fixed union; only assign
      // if the value matches one of the allowed values.
      if (key === "actorType") {
        const allowed = [
          "human",
          "agent",
          "system",
          "remote_human",
          "remote_orcy",
          "remote_pod",
        ] as const;
        if ((allowed as readonly string[]).includes(value)) {
          query.actorType = value as (typeof allowed)[number];
        }
        continue;
      }
      query[key] = value;
    }
  }

  return query;
}

/** Convenience wrapper that runs both due scheduled tasks and due audit exports in a single pass. */
export function processDueScheduledTasks(): {
  tasks: { executed: number; failed: number };
  audit: { executed: number; failed: number };
} {
  const tasks = processDueTasks();
  const audit = processDueAuditExports();
  return { tasks, audit };
}

/** Starts a recurring interval that polls for and executes due scheduled tasks and audit exports. Returns the handle so the caller can stop it. */
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
