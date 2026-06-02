import { getDb } from "../db/index.js";
import { scheduledTasks } from "../db/schema/index.js";
import { eq, and, sql, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  ScheduledTask,
  ScheduleType,
  TaskPriority,
  TaskTemplateEntry,
} from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface CreateScheduledTaskInput {
  habitatId: string;
  templateId?: string | null;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  cronExpression?: string | null;
  intervalMinutes?: number | null;
  scheduledAt?: string | null;
  timezone?: string;
  missionTitle: string;
  missionDescription?: string;
  missionPriority?: TaskPriority;
  missionLabels?: string[];
  missionDomain?: string | null;
  tasksTemplate?: TaskTemplateEntry[];
  nextRunAt: string;
  createdBy: string;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  description?: string;
  scheduleType?: ScheduleType;
  cronExpression?: string | null;
  intervalMinutes?: number | null;
  scheduledAt?: string | null;
  timezone?: string;
  missionTitle?: string;
  missionDescription?: string;
  missionPriority?: TaskPriority;
  missionLabels?: string[];
  missionDomain?: string | null;
  tasksTemplate?: TaskTemplateEntry[];
  enabled?: boolean;
  templateId?: string | null;
  nextRunAt?: string;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(scheduledTasks)
      .values({
        id,
        habitatId: input.habitatId,
        templateId: input.templateId ?? null,
        name: input.name,
        description: input.description ?? "",
        scheduleType: input.scheduleType,
        cronExpression: input.cronExpression ?? null,
        intervalMinutes: input.intervalMinutes ?? null,
        scheduledAt: input.scheduledAt ?? null,
        timezone: input.timezone ?? "UTC",
        missionTitle: input.missionTitle,
        missionDescription: input.missionDescription ?? "",
        missionPriority: input.missionPriority ?? "medium",
        missionLabels: input.missionLabels ?? [],
        missionDomain: input.missionDomain ?? null,
        tasksTemplate: input.tasksTemplate ?? [],
        enabled: true,
        lastRunAt: null,
        nextRunAt: input.nextRunAt,
        runCount: 0,
        lastCreatedMissionId: null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("scheduledTask", err as Error, id);
  }

  const task = getScheduledTaskById(id);
  if (!task) throw repositoryNotFoundError("scheduledTask", id);
  return task;
}

export function getScheduledTaskById(id: string): ScheduledTask | null {
  const db = getDb();
  const row = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
  return (row as ScheduledTask) ?? null;
}

export function getScheduledTasksByHabitatId(habitatId: string): ScheduledTask[] {
  const db = getDb();
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.habitatId, habitatId))
    .orderBy(scheduledTasks.createdAt)
    .all() as ScheduledTask[];
}

export function getDueScheduledTasks(): ScheduledTask[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now)))
    .all() as ScheduledTask[];
}

export function updateScheduledTask(
  id: string,
  input: UpdateScheduledTaskInput,
): ScheduledTask | null {
  const db = getDb();
  const existing = getScheduledTaskById(id);
  if (!existing) return null;

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.scheduleType !== undefined) set.scheduleType = input.scheduleType;
  if (input.cronExpression !== undefined) set.cronExpression = input.cronExpression;
  if (input.intervalMinutes !== undefined) set.intervalMinutes = input.intervalMinutes;
  if (input.scheduledAt !== undefined) set.scheduledAt = input.scheduledAt;
  if (input.timezone !== undefined) set.timezone = input.timezone;
  if (input.missionTitle !== undefined) set.missionTitle = input.missionTitle;
  if (input.missionDescription !== undefined) set.missionDescription = input.missionDescription;
  if (input.missionPriority !== undefined) set.missionPriority = input.missionPriority;
  if (input.missionLabels !== undefined) set.missionLabels = input.missionLabels;
  if (input.missionDomain !== undefined) set.missionDomain = input.missionDomain;
  if (input.tasksTemplate !== undefined) set.tasksTemplate = input.tasksTemplate;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.templateId !== undefined) set.templateId = input.templateId;
  if (input.nextRunAt !== undefined) set.nextRunAt = input.nextRunAt;

  if (Object.keys(set).length === 0) return existing;

  set.updatedAt = new Date().toISOString();

  try {
    db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
  return getScheduledTaskById(id);
}

export function claimExecution(id: string, nextRunAt: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();

  const before = db
    .select({ runCount: scheduledTasks.runCount })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .get();
  const beforeRunCount = before?.runCount ?? -1;

  try {
    db.update(scheduledTasks)
      .set({
        lastRunAt: now,
        nextRunAt,
        runCount: sql`${scheduledTasks.runCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.enabled, true),
          lte(scheduledTasks.nextRunAt, now),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }

  const after = db
    .select({ runCount: scheduledTasks.runCount })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .get();
  return after?.runCount === beforeRunCount + 1;
}

export function finalizeExecution(id: string, missionId: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(scheduledTasks)
      .set({
        lastCreatedMissionId: missionId,
        updatedAt: now,
      })
      .where(eq(scheduledTasks.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
}

export function deleteScheduledTask(id: string): boolean {
  const db = getDb();
  const existing = getScheduledTaskById(id);
  if (!existing) return false;

  try {
    db.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("scheduledTask", err as Error, id);
  }
  return true;
}
