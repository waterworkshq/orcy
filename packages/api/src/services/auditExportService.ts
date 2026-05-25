import { getDb } from '../db/index.js';
import { taskEvents, missionEvents, tasks, missions, agents, columns } from '../db/schema/index.js';
import { alias } from 'drizzle-orm/sqlite-core';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { FastifyReply } from 'fastify';

const taskFromColumns = alias(columns, 'te_from_columns');
const taskToColumns = alias(columns, 'te_to_columns');
const missionFromColumns = alias(columns, 'fe_from_columns');
const missionToColumns = alias(columns, 'fe_to_columns');

const BATCH_SIZE = 1000;

export interface AuditExportQuery {
  format: 'csv' | 'json' | 'jsonl';
  since?: string;
  until?: string;
  actions?: string;
  actorType?: string;
  actorId?: string;
  entityTypes?: string;
  includeMetadata?: string;
}

export interface AuditSummary {
  totalEvents: number;
  byAction: Record<string, number>;
  byActorType: Record<string, number>;
  byDay: { date: string; count: number }[];
  topMissions: { missionId: string; missionTitle: string; count: number }[];
}

interface AuditRow {
  id: string;
  timestamp: string;
  action: string;
  entityType: string;
  entityId: string;
  entityTitle: string;
  actorType: string;
  actorId: string;
  actorName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fromColumn: string | null;
  toColumn: string | null;
  metadata: Record<string, unknown> | null;
}

function buildConditions(habitatId: string, query: AuditExportQuery) {
  const conditions = [eq(missions.habitatId, habitatId)];

  if (query.since) {
    conditions.push(sql`${taskEvents.timestamp} >= ${query.since}`);
  }
  if (query.until) {
    conditions.push(sql`${taskEvents.timestamp} <= ${query.until}`);
  }
  if (query.actions) {
    const actionList = query.actions.split(',').map(a => a.trim());
    conditions.push(inArray(taskEvents.action, actionList as any));
  }
  if (query.actorType) {
    conditions.push(sql`${taskEvents.actorType} = ${query.actorType}`);
  }
  if (query.actorId) {
    conditions.push(eq(taskEvents.actorId, query.actorId));
  }

  return and(...conditions);
}

function buildMissionConditions(habitatId: string, query: AuditExportQuery) {
  const conditions = [eq(missions.habitatId, habitatId)];

  if (query.since) {
    conditions.push(sql`${missionEvents.timestamp} >= ${query.since}`);
  }
  if (query.until) {
    conditions.push(sql`${missionEvents.timestamp} <= ${query.until}`);
  }
  if (query.actions) {
    const actionList = query.actions.split(',').map(a => a.trim());
    conditions.push(inArray(missionEvents.action, actionList as any));
  }
  if (query.actorType) {
    conditions.push(sql`${missionEvents.actorType} = ${query.actorType}`);
  }
  if (query.actorId) {
    conditions.push(eq(missionEvents.actorId, query.actorId));
  }

  return and(...conditions);
}

function fetchTaskEventBatch(habitatId: string, query: AuditExportQuery, offset: number): AuditRow[] {
  const db = getDb();
  const whereClause = buildConditions(habitatId, query);

  const includeMetadata = query.includeMetadata === 'true';

  const rows = db
    .select({
      id: taskEvents.id,
      timestamp: taskEvents.timestamp,
      action: taskEvents.action,
      entityType: sql`'task'`.as('entityType'),
      entityId: tasks.id,
      entityTitle: tasks.title,
      actorType: taskEvents.actorType,
      actorId: taskEvents.actorId,
      actorName: agents.name,
      fromStatus: taskEvents.fromStatus,
      toStatus: taskEvents.toStatus,
      fromColumn: taskFromColumns.name,
      toColumn: taskToColumns.name,
      ...(includeMetadata ? { metadata: taskEvents.metadata } as any : {}),
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .leftJoin(agents, eq(taskEvents.actorId, agents.id))
    .leftJoin(taskFromColumns, eq(taskEvents.fromColumnId, taskFromColumns.id))
    .leftJoin(taskToColumns, eq(taskEvents.toColumnId, taskToColumns.id))
    .where(whereClause)
    .orderBy(desc(taskEvents.timestamp))
    .limit(BATCH_SIZE)
    .offset(offset)
    .all();

  return rows.map((row: any) => ({
    ...row,
    entityType: 'task',
    metadata: includeMetadata ? (row.metadata as Record<string, unknown>) : null,
  }));
}

function fetchMissionEventBatch(habitatId: string, query: AuditExportQuery, offset: number): AuditRow[] {
  const db = getDb();
  const whereClause = buildMissionConditions(habitatId, query);

  const includeMetadata = query.includeMetadata === 'true';

  const rows = db
    .select({
      id: missionEvents.id,
      timestamp: missionEvents.timestamp,
      action: missionEvents.action,
      entityType: sql`'mission'`.as('entityType'),
      entityId: missions.id,
      entityTitle: missions.title,
      actorType: missionEvents.actorType,
      actorId: missionEvents.actorId,
      actorName: agents.name,
      fromStatus: missionEvents.fromStatus,
      toStatus: missionEvents.toStatus,
      fromColumn: missionFromColumns.name,
      toColumn: missionToColumns.name,
      ...(includeMetadata ? { metadata: missionEvents.metadata } as any : {}),
    })
    .from(missionEvents)
    .innerJoin(missions, eq(missionEvents.missionId, missions.id))
    .leftJoin(agents, eq(missionEvents.actorId, agents.id))
    .leftJoin(missionFromColumns, eq(missionEvents.fromColumnId, missionFromColumns.id))
    .leftJoin(missionToColumns, eq(missionEvents.toColumnId, missionToColumns.id))
    .where(whereClause)
    .orderBy(desc(missionEvents.timestamp))
    .limit(BATCH_SIZE)
    .offset(offset)
    .all();

  return rows.map((row: any) => ({
    ...row,
    entityType: 'mission',
    metadata: includeMetadata ? (row.metadata as Record<string, unknown>) : null,
  }));
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowsToCsv(rows: AuditRow[], includeHeader: boolean): string {
  const headers = [
    'event_id', 'timestamp', 'action', 'entity_type', 'entity_id', 'entity_title',
    'actor_type', 'actor_id', 'actor_name',
    'from_status', 'to_status', 'from_column', 'to_column',
  ];
  const lines: string[] = [];

  if (includeHeader) {
    lines.push(headers.join(','));
  }

  for (const row of rows) {
    lines.push([
      csvEscape(row.id),
      csvEscape(row.timestamp),
      csvEscape(row.action),
      csvEscape(row.entityType),
      csvEscape(row.entityId),
      csvEscape(row.entityTitle),
      csvEscape(row.actorType),
      csvEscape(row.actorId),
      csvEscape(row.actorName),
      csvEscape(row.fromStatus),
      csvEscape(row.toStatus),
      csvEscape(row.fromColumn),
      csvEscape(row.toColumn),
    ].join(','));
  }

  return lines.join('\n') + '\n';
}

function rowsToJsonl(rows: AuditRow[]): string {
  return rows.map(row => JSON.stringify({
    id: row.id,
    timestamp: row.timestamp,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    entityTitle: row.entityTitle,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    fromColumn: row.fromColumn,
    toColumn: row.toColumn,
    metadata: row.metadata,
  })).join('\n') + '\n';
}

export function getExportFilename(habitatId: string, format: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `audit-${habitatId.slice(0, 8)}-${date}.${format}`;
}

export function getExportContentType(format: string): string {
  switch (format) {
    case 'csv': return 'text/csv; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'jsonl': return 'application/x-ndjson; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

export async function streamAuditExport(
  habitatId: string,
  query: AuditExportQuery,
  reply: FastifyReply
): Promise<void> {
  const format = query.format;
  const includeTasks = !query.entityTypes || query.entityTypes.includes('task');
  const includeMissions = !query.entityTypes || query.entityTypes.includes('mission');

  reply.header('Content-Type', getExportContentType(format));
  reply.header('Content-Disposition', `attachment; filename="${getExportFilename(habitatId, format)}"`);

  const collected: AuditRow[] = [];
  let taskOffset = 0;
  let missionOffset = 0;

  if (includeTasks) {
    while (true) {
      const batch = fetchTaskEventBatch(habitatId, query, taskOffset);
      if (batch.length === 0) break;
      collected.push(...batch);
      taskOffset += BATCH_SIZE;
    }
  }

  if (includeMissions) {
    while (true) {
      const batch = fetchMissionEventBatch(habitatId, query, missionOffset);
      if (batch.length === 0) break;
      collected.push(...batch);
      missionOffset += BATCH_SIZE;
    }
  }

  collected.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (format === 'csv') {
    return reply.send(rowsToCsv(collected, true));
  } else if (format === 'jsonl') {
    return reply.send(rowsToJsonl(collected));
  } else {
    const result = collected.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityTitle: row.entityTitle,
      actorType: row.actorType,
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      fromColumn: row.fromColumn,
      toColumn: row.toColumn,
      metadata: row.metadata,
    }));
    return reply.send(result);
  }
}

export function getAuditSummary(habitatId: string, since?: string, until?: string): AuditSummary {
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

  const allRows = [...taskRows, ...missionRows];

  const byAction: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  const byDayMap = new Map<string, number>();
  const missionMap = new Map<string, { missionId: string; missionTitle: string; count: number }>();

  for (const row of allRows) {
    byAction[row.action] = (byAction[row.action] || 0) + 1;
    byActorType[row.actorType] = (byActorType[row.actorType] || 0) + 1;

    const day = row.timestamp.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) || 0) + 1);

    if (row.missionId) {
      const existing = missionMap.get(row.missionId);
      if (existing) {
        existing.count++;
      } else {
        missionMap.set(row.missionId, { missionId: row.missionId, missionTitle: row.missionTitle, count: 1 });
      }
    }
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, eventCount]) => ({ date, count: eventCount }))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const topMissions = Array.from(missionMap.values())
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalEvents: allRows.length,
    byAction,
    byActorType,
    byDay,
    topMissions,
  };
}

export interface AuditExportSchedule {
  id: string;
  habitatId: string;
  name: string;
  format: 'csv' | 'json' | 'jsonl';
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

export function createSchedule(habitatId: string, input: {
  name: string;
  format: 'csv' | 'json' | 'jsonl';
  filters?: Record<string, unknown>;
  schedule: string;
}): AuditExportSchedule {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.run(sql`
    INSERT INTO audit_export_schedules (id, habitat_id, name, format, filters, schedule, enabled, next_run_at, created_by, created_at)
    VALUES (${id}, ${habitatId}, ${input.name}, ${input.format}, ${JSON.stringify(input.filters ?? {})}, ${input.schedule}, 1, ${now}, 'system', ${now})
  `);

  return getScheduleById(id)!;
}

export function getScheduleById(id: string): AuditExportSchedule | null {
  const db = getDb();
  const rows = db.all(sql`SELECT * FROM audit_export_schedules WHERE id = ${id}`) as any[];
  if (rows.length === 0) return null;
  return mapScheduleRow(rows[0]);
}

export function listSchedules(habitatId: string): AuditExportSchedule[] {
  const db = getDb();
  const rows = db.all(sql`SELECT * FROM audit_export_schedules WHERE habitat_id = ${habitatId} ORDER BY created_at`) as any[];
  return rows.map(mapScheduleRow);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  db.run(sql`DELETE FROM audit_export_schedules WHERE id = ${id}`);
  return true;
}

function mapScheduleRow(row: any): AuditExportSchedule {
  return {
    id: row.id,
    habitatId: row.habitat_id,
    name: row.name,
    format: row.format,
    filters: JSON.parse(row.filters),
    schedule: row.schedule,
    destination: row.destination ?? 'local',
    destinationConfig: JSON.parse(row.destination_config ?? '{}'),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at ?? null,
    nextRunAt: row.next_run_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
