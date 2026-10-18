import { CronExpressionParser } from 'cron-parser';
import type * as scheduledTaskRepo from '../repositories/scheduledTask.js';

export type ScheduleConfiguration = Pick<scheduledTaskRepo.CreateScheduledTaskInput,
  'scheduleType' | 'cronExpression' | 'intervalMinutes' | 'scheduledAt' | 'timezone'>;

/** Keep ISO wall times from datetime-local inputs on their existing UTC due-time basis. */
export function parseScheduledAt(value: string): Date {
  const isoWallTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/i.test(value);
  return new Date(isoWallTime ? `${value}Z` : value);
}

/** Validate schedule semantics independently of a first-run override. */
export function validateScheduleConfiguration(schedule: ScheduleConfiguration): string | null {
  try {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone ?? 'UTC' });
  } catch {
    return 'Invalid timezone';
  }
  if (schedule.scheduleType === 'once' && schedule.scheduledAt == null) {
    return 'scheduledAt is required for one-time schedules';
  }
  if (schedule.scheduledAt != null &&
      (!schedule.scheduledAt.trim() || !Number.isFinite(parseScheduledAt(schedule.scheduledAt).getTime()))) {
    return 'scheduledAt must be a valid nonempty date';
  }
  if (schedule.scheduleType === 'interval') {
    const minutes = schedule.intervalMinutes;
    if (minutes == null || !Number.isSafeInteger(minutes) || minutes < 1 ||
        !Number.isFinite(new Date(Date.now() + minutes * 60_000).getTime())) {
      return 'intervalMinutes must be a positive safe integer with a representable next run';
    }
  }
  if (schedule.scheduleType === 'cron') {
    if (!schedule.cronExpression?.trim()) return 'cronExpression is required for cron schedules';
    try {
      CronExpressionParser.parse(schedule.cronExpression, { tz: schedule.timezone ?? 'UTC' }).next();
    } catch {
      return 'Invalid cronExpression or timezone';
    }
  }
  return null;
}
