import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { scheduledOccurrences } from "../db/schema/index.js";
import type { ScheduledTask } from "../models/index.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import { getOccurrenceByScheduleAndDueWithClient } from "../repositories/scheduledOccurrences.js";
import { badRequest, conflictWithCode, notFound } from "../errors.js";
import { calculateNextRun } from "./scheduledTaskService.js";
import { parseScheduledAt, validateScheduleConfiguration } from "./scheduledTaskConfiguration.js";

/**
 * Edit against current persisted state, serialized with occurrence reservation.
 * BEGIN IMMEDIATE takes the writer lock before the history/configuration reads;
 * a deferred read-to-write upgrade can bypass busy_timeout under SQLite WAL.
 * Authorization executes on the same connection while that lock is held.
 */
export function editScheduledTask(
  id: string,
  input: scheduledTaskRepo.UpdateScheduledTaskInput,
  authorize: (schedule: ScheduledTask) => void,
  db = getDb(),
): ScheduledTask {
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const existing = scheduledTaskRepo.getScheduledTaskById(id, db);
    if (!existing) throw notFound("Scheduled task not found", "SCHEDULED_TASK_NOT_FOUND");
    authorize(existing);
    const effective = { ...existing, ...input };
    const scheduleError = validateScheduleConfiguration(effective);
    if (scheduleError) throw badRequest("Invalid schedule configuration", scheduleError);

    // Snapshot identity, rather than runCount, distinguishes prior recurring
    // runs from consumption of this schedule's one-shot entitlement.
    const history = db.select({
      count: sql<number>`count(*)`,
      ordinals: sql<number>`count(distinct ${scheduledOccurrences.ordinal})`,
      first: sql<number | null>`min(${scheduledOccurrences.ordinal})`,
      last: sql<number | null>`max(${scheduledOccurrences.ordinal})`,
      once: sql<number>`coalesce(sum(CASE WHEN json_valid(${scheduledOccurrences.scheduleRevision})
        THEN CASE WHEN json_extract(${scheduledOccurrences.scheduleRevision}, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
        ELSE 0 END), 0)`,
      unknown: sql<number>`coalesce(sum(CASE WHEN json_valid(${scheduledOccurrences.scheduleRevision})
        THEN CASE WHEN json_extract(${scheduledOccurrences.scheduleRevision}, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
        ELSE 1 END), 0)`,
    }).from(scheduledOccurrences).where(eq(scheduledOccurrences.scheduledTaskId, id)).get();
    const consumed = (history?.once ?? 0) > 0;
    // No pagination: an older once snapshot must never disappear behind the
    // history UI's page size. Counts/ordinal coverage catch missing legacy rows.
    const completeHistory = history?.count === existing.runCount && history.ordinals === existing.runCount &&
      (existing.runCount === 0 || history.first === 0 && history.last === existing.runCount - 1);
    const historyUnknown = !consumed && (!completeHistory || (history?.unknown ?? 0) > 0) &&
      (existing.scheduleType === "once" || effective.scheduleType === "once");
    const sameInstant = input.scheduledAt != null && existing.scheduledAt != null &&
      parseScheduledAt(input.scheduledAt).getTime() === parseScheduledAt(existing.scheduledAt).getTime();
    const timingChanged = (["scheduleType", "cronExpression", "intervalMinutes", "scheduledAt", "timezone"] as const)
      .some((key) => input[key] !== undefined && input[key] !== existing[key] &&
        !(key === "scheduledAt" && sameInstant));
    if (consumed && (timingChanged || input.enabled === true)) {
      throw conflictWithCode("ONCE_SCHEDULE_CONSUMED", "This one-time schedule was already reserved; create a new schedule for another firing");
    }

    if (historyUnknown && (timingChanged || input.enabled === true)) {
      throw conflictWithCode("ONCE_SCHEDULE_HISTORY_UNKNOWN", "One-time consumption cannot be established from legacy history; create a new schedule");
    }

    const update = { ...input };
    if ((consumed || historyUnknown) && sameInstant) update.scheduledAt = existing.scheduledAt;
    if (!consumed && !historyUnknown) {
      const timingSupplied = effective.scheduleType === "once"
        ? (["scheduleType", "cronExpression", "intervalMinutes", "timezone"] as const)
            .some((key) => input[key] !== undefined)
        : Boolean(input.scheduleType || input.cronExpression || input.intervalMinutes || input.timezone);
      if (timingSupplied || input.enabled === true ||
          effective.scheduleType === "once" && input.scheduledAt !== undefined) {
        update.nextRunAt = effective.scheduleType === "once"
          ? parseScheduledAt(effective.scheduledAt!).toISOString()
          : calculateNextRun(effective.scheduleType, effective.cronExpression,
              effective.intervalMinutes, effective.timezone);
      }
    }
    if (!consumed && effective.scheduleType === "once" && update.nextRunAt !== undefined &&
        getOccurrenceByScheduleAndDueWithClient(db, id, update.nextRunAt)) {
      throw conflictWithCode("SCHEDULE_DUE_ALREADY_RESERVED", "This due instant was already reserved; choose another instant or create a new schedule");
    }
    const updated = scheduledTaskRepo.updateScheduledTask(id, update, db);
    if (!updated) throw notFound("Scheduled task not found", "SCHEDULED_TASK_NOT_FOUND");
    db.run(sql`COMMIT`);
    return updated;
  } catch (error) {
    try { db.run(sql`ROLLBACK`); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
