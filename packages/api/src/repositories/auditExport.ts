import { getDb } from "../db/index.js";
import { auditExportSchedules } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

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