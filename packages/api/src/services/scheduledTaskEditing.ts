import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import type { ScheduledTask } from "../models/index.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import { getOccurrenceByScheduleAndDueWithClient } from "../repositories/scheduledOccurrences.js";
import { badRequest, conflictWithCode, notFound } from "../errors.js";
import { calculateNextRun } from "./scheduledTaskService.js";
import { parseScheduledAt, validateScheduleConfiguration } from "./scheduledTaskConfiguration.js";

// Timing, operational, and future fields retain the entitlement evidence path.
const METADATA_EDIT_FIELDS = new Set<PropertyKey>([
  "name", "description", "missionTitle", "missionDescription", "missionPriority",
  "missionLabels", "missionDomain", "tasksTemplate", "templateId",
] satisfies (keyof scheduledTaskRepo.UpdateScheduledTaskInput)[]);

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

    const inputPrototype = Object.getPrototypeOf(input);
    const metadataOnly = (inputPrototype === Object.prototype || inputPrototype === null) &&
      Reflect.ownKeys(input).every((key) => METADATA_EDIT_FIELDS.has(key));
    if (metadataOnly) {
      const updated = scheduledTaskRepo.updateScheduledTask(id, input, db);
      if (!updated) throw notFound("Scheduled task not found", "SCHEDULED_TASK_NOT_FOUND");
      db.run(sql`COMMIT`);
      return updated;
    }

    // Snapshot identity, rather than runCount, distinguishes prior recurring
    // runs from consumption of this schedule's one-shot entitlement.
    const entitlement = getOnceEntitlementWithClient(db, existing);
    const consumed = entitlement === "consumed";
    const historyUnknown = entitlement === "unknown" &&
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
