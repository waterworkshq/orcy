import { getDb } from '../db/index.js';
import { scheduledTasks } from '../db/schema/index.js';
import { eq, and, sql, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { ScheduledTask, ScheduleType, TaskPriority, TaskTemplateEntry } from '../models/index.js';

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
  featureTitle: string;
  featureDescription?: string;
  featurePriority?: TaskPriority;
  featureLabels?: string[];
  featureDomain?: string | null;
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
  featureTitle?: string;
  featureDescription?: string;
  featurePriority?: TaskPriority;
  featureLabels?: string[];
  featureDomain?: string | null;
  tasksTemplate?: TaskTemplateEntry[];
  enabled?: boolean;
  templateId?: string | null;
  nextRunAt?: string;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(scheduledTasks).values({
    id,
    habitatId: input.habitatId,
    templateId: input.templateId ?? null,
    name: input.name,
    description: input.description ?? '',
    scheduleType: input.scheduleType,
    cronExpression: input.cronExpression ?? null,
    intervalMinutes: input.intervalMinutes ?? null,
    scheduledAt: input.scheduledAt ?? null,
    timezone: input.timezone ?? 'UTC',
    featureTitle: input.featureTitle,
    featureDescription: input.featureDescription ?? '',
    featurePriority: input.featurePriority ?? 'medium',
    featureLabels: input.featureLabels ?? [],
    featureDomain: input.featureDomain ?? null,
    tasksTemplate: input.tasksTemplate ?? [],
    enabled: true,
    lastRunAt: null,
    nextRunAt: input.nextRunAt,
    runCount: 0,
    lastCreatedMissionId: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }).run();

  return getScheduledTaskById(id)!;
}

export function getScheduledTaskById(id: string): ScheduledTask | null {
  const db = getDb();
  const row = db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .get();
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
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        lte(scheduledTasks.nextRunAt, now),
      )
    )
    .all() as ScheduledTask[];
}

export function updateScheduledTask(id: string, input: UpdateScheduledTaskInput): ScheduledTask | null {
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
  if (input.featureTitle !== undefined) set.featureTitle = input.featureTitle;
  if (input.featureDescription !== undefined) set.featureDescription = input.featureDescription;
  if (input.featurePriority !== undefined) set.featurePriority = input.featurePriority;
  if (input.featureLabels !== undefined) set.featureLabels = input.featureLabels;
  if (input.featureDomain !== undefined) set.featureDomain = input.featureDomain;
  if (input.tasksTemplate !== undefined) set.tasksTemplate = input.tasksTemplate;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.templateId !== undefined) set.templateId = input.templateId;
  if (input.nextRunAt !== undefined) set.nextRunAt = input.nextRunAt;

  if (Object.keys(set).length === 0) return existing;

  set.updatedAt = new Date().toISOString();

  db.update(scheduledTasks)
    .set(set)
    .where(eq(scheduledTasks.id, id))
    .run();
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

  db.update(scheduledTasks)
    .set({
      lastRunAt: now,
      nextRunAt,
      runCount: sql`${scheduledTasks.runCount} + 1`,
      updatedAt: now,
    })
    .where(and(
      eq(scheduledTasks.id, id),
      eq(scheduledTasks.enabled, true),
      lte(scheduledTasks.nextRunAt, now),
    ))
    .run();

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

  db.update(scheduledTasks)
    .set({
      lastCreatedMissionId: missionId,
      updatedAt: now,
    })
    .where(eq(scheduledTasks.id, id))
    .run();
}

export function deleteScheduledTask(id: string): boolean {
  const db = getDb();
  const existing = getScheduledTaskById(id);
  if (!existing) return false;

  db.delete(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .run();
  return true;
}
