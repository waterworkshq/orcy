import { getDb } from "../db/index.js";
import {
  auditExportSchedules,
  missionEvents,
  missions,
  taskEvents,
  tasks,
} from "../db/schema/index.js";
import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";

export interface AuditSummaryRow {
  action: string;
  actorType: string;
  timestamp: string;
  missionId: string;
  missionTitle: string;
}

export interface CreateAuditExportScheduleInput {
  name: string;
  format: "csv" | "json" | "jsonl";
  filters?: Record<string, unknown>;
  schedule: string;
}

export interface AuditExportSchedule {
  id: string;
  habitatId: string;
  name: string;
  format: "csv" | "json" | "jsonl";
  filters: Record<string, unknown>;
  schedule: string;
  destination: string;
  destinationConfig: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdBy: string;
  createdAt: string;
}

export function getAuditSummaryRows(
  habitatId: string,
  since?: string,
  until?: string,
): AuditSummaryRow[] {
  const db = getDb();

  const taskCondition = [eq(missions.habitatId, habitatId)];
  if (since) taskCondition.push(sql`${taskEvents.timestamp} >= ${since}`);
  if (until) taskCondition.push(sql`${taskEvents.timestamp} <= ${until}`);

  const taskRows = db
    .select({
      action: taskEvents.action,
      actorType: taskEvents.actorType,
      timestamp: taskEvents.timestamp,
      missionId: missions.id,
      missionTitle: missions.title,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...taskCondition))
    .all();

  const missionCondition = [eq(missions.habitatId, habitatId)];
  if (since) missionCondition.push(sql`${missionEvents.timestamp} >= ${since}`);
  if (until) missionCondition.push(sql`${missionEvents.timestamp} <= ${until}`);

  const missionRows = db
    .select({
      action: missionEvents.action,
      actorType: missionEvents.actorType,
      timestamp: missionEvents.timestamp,
      missionId: missions.id,
      missionTitle: missions.title,
    })
    .from(missionEvents)
    .innerJoin(missions, eq(missionEvents.missionId, missions.id))
    .where(and(...missionCondition))
    .all();

  return [...taskRows, ...missionRows];
}

export function createScheduleRecord(
  habitatId: string,
  input: CreateAuditExportScheduleInput,
): AuditExportSchedule {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(auditExportSchedules)
    .values({
      id,
      habitatId,
      name: input.name,
      format: input.format,
      filters: input.filters ?? {},
      schedule: input.schedule,
      enabled: true,
      nextRunAt: now,
      createdBy: "system",
      createdAt: now,
    })
    .run();

  return getScheduleById(id)!;
}

export function getScheduleById(id: string): AuditExportSchedule | null {
  const db = getDb();
  const row = db.select().from(auditExportSchedules).where(eq(auditExportSchedules.id, id)).get();
  return row ? mapScheduleRow(row) : null;
}

export function listSchedules(habitatId: string): AuditExportSchedule[] {
  const db = getDb();
  return db
    .select()
    .from(auditExportSchedules)
    .where(eq(auditExportSchedules.habitatId, habitatId))
    .orderBy(auditExportSchedules.createdAt)
    .all()
    .map(mapScheduleRow);
}

export function deleteSchedule(id: string): void {
  const db = getDb();
  db.delete(auditExportSchedules).where(eq(auditExportSchedules.id, id)).run();
}

function mapScheduleRow(row: typeof auditExportSchedules.$inferSelect): AuditExportSchedule {
  return {
    id: row.id,
    habitatId: row.habitatId,
    name: row.name,
    format: row.format,
    filters: row.filters,
    schedule: row.schedule,
    destination: row.destination,
    destinationConfig: row.destinationConfig,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
