import { getDb } from '../db/index.js';
import { taskEvents, featureEvents, tasks, features, agents, columns } from '../db/schema/index.js';
import { alias } from 'drizzle-orm/sqlite-core';
import { eq, and, or, sql, count, desc, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { FastifyReply } from 'fastify';

const taskFromColumns = alias(columns, 'te_from_columns');
const taskToColumns = alias(columns, 'te_to_columns');
const featureFromColumns = alias(columns, 'fe_from_columns');
const featureToColumns = alias(columns, 'fe_to_columns');

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
  topFeatures: { featureId: string; featureTitle: string; count: number }[];
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

function buildConditions(boardId: string, query: AuditExportQuery) {
  const conditions = [eq(features.boardId, boardId)];

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

function buildFeatureConditions(boardId: string, query: AuditExportQuery) {
  const conditions = [eq(features.boardId, boardId)];

  if (query.since) {
    conditions.push(sql`${featureEvents.timestamp} >= ${query.since}`);
  }
  if (query.until) {
    conditions.push(sql`${featureEvents.timestamp} <= ${query.until}`);
  }
  if (query.actions) {
    const actionList = query.actions.split(',').map(a => a.trim());
    conditions.push(inArray(featureEvents.action, actionList as any));
  }
  if (query.actorType) {
    conditions.push(sql`${featureEvents.actorType} = ${query.actorType}`);
  }
  if (query.actorId) {
    conditions.push(eq(featureEvents.actorId, query.actorId));
  }

  return and(...conditions);
}

function fetchTaskEventBatch(boardId: string, query: AuditExportQuery, offset: number): AuditRow[] {
  const db = getDb();
  const whereClause = buildConditions(boardId, query);

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
    .innerJoin(features, eq(tasks.featureId, features.id))
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

function fetchFeatureEventBatch(boardId: string, query: AuditExportQuery, offset: number): AuditRow[] {
  const db = getDb();
  const whereClause = buildFeatureConditions(boardId, query);

  const includeMetadata = query.includeMetadata === 'true';

  const rows = db
    .select({
      id: featureEvents.id,
      timestamp: featureEvents.timestamp,
      action: featureEvents.action,
      entityType: sql`'feature'`.as('entityType'),
      entityId: features.id,
      entityTitle: features.title,
      actorType: featureEvents.actorType,
      actorId: featureEvents.actorId,
      actorName: agents.name,
      fromStatus: featureEvents.fromStatus,
      toStatus: featureEvents.toStatus,
      fromColumn: featureFromColumns.name,
      toColumn: featureToColumns.name,
      ...(includeMetadata ? { metadata: featureEvents.metadata } as any : {}),
    })
    .from(featureEvents)
    .innerJoin(features, eq(featureEvents.featureId, features.id))
    .leftJoin(agents, eq(featureEvents.actorId, agents.id))
    .leftJoin(featureFromColumns, eq(featureEvents.fromColumnId, featureFromColumns.id))
    .leftJoin(featureToColumns, eq(featureEvents.toColumnId, featureToColumns.id))
    .where(whereClause)
    .orderBy(desc(featureEvents.timestamp))
    .limit(BATCH_SIZE)
    .offset(offset)
    .all();

  return rows.map((row: any) => ({
    ...row,
    entityType: 'feature',
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

export function getExportFilename(boardId: string, format: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `audit-${boardId.slice(0, 8)}-${date}.${format}`;
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
  boardId: string,
  query: AuditExportQuery,
  reply: FastifyReply
): Promise<void> {
  const format = query.format;
  const includeTasks = !query.entityTypes || query.entityTypes.includes('task');
  const includeFeatures = !query.entityTypes || query.entityTypes.includes('feature');

  reply.header('Content-Type', getExportContentType(format));
  reply.header('Content-Disposition', `attachment; filename="${getExportFilename(boardId, format)}"`);

  const collected: AuditRow[] = [];
  let taskOffset = 0;
  let featureOffset = 0;

  if (includeTasks) {
    while (true) {
      const batch = fetchTaskEventBatch(boardId, query, taskOffset);
      if (batch.length === 0) break;
      collected.push(...batch);
      taskOffset += BATCH_SIZE;
    }
  }

  if (includeFeatures) {
    while (true) {
      const batch = fetchFeatureEventBatch(boardId, query, featureOffset);
      if (batch.length === 0) break;
      collected.push(...batch);
      featureOffset += BATCH_SIZE;
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

export function getAuditSummary(boardId: string, since?: string, until?: string): AuditSummary {
  const db = getDb();

  const taskCondition = [eq(features.boardId, boardId)];
  if (since) taskCondition.push(sql`${taskEvents.timestamp} >= ${since}`);
  if (until) taskCondition.push(sql`${taskEvents.timestamp} <= ${until}`);

  const taskRows = db
    .select({
      action: taskEvents.action,
      actorType: taskEvents.actorType,
      timestamp: taskEvents.timestamp,
      featureId: features.id,
      featureTitle: features.title,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(and(...taskCondition))
    .all();

  const featureCondition = [eq(features.boardId, boardId)];
  if (since) featureCondition.push(sql`${featureEvents.timestamp} >= ${since}`);
  if (until) featureCondition.push(sql`${featureEvents.timestamp} <= ${until}`);

  const featureRows = db
    .select({
      action: featureEvents.action,
      actorType: featureEvents.actorType,
      timestamp: featureEvents.timestamp,
      featureId: features.id,
      featureTitle: features.title,
    })
    .from(featureEvents)
    .innerJoin(features, eq(featureEvents.featureId, features.id))
    .where(and(...featureCondition))
    .all();

  const allRows = [...taskRows, ...featureRows];

  const byAction: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  const byDayMap = new Map<string, number>();
  const featureMap = new Map<string, { featureId: string; featureTitle: string; count: number }>();

  for (const row of allRows) {
    byAction[row.action] = (byAction[row.action] || 0) + 1;
    byActorType[row.actorType] = (byActorType[row.actorType] || 0) + 1;

    const day = row.timestamp.slice(0, 10);
    byDayMap.set(day, (byDayMap.get(day) || 0) + 1);

    if (row.featureId) {
      const existing = featureMap.get(row.featureId);
      if (existing) {
        existing.count++;
      } else {
        featureMap.set(row.featureId, { featureId: row.featureId, featureTitle: row.featureTitle, count: 1 });
      }
    }
  }

  const byDay = Array.from(byDayMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topFeatures = Array.from(featureMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalEvents: allRows.length,
    byAction,
    byActorType,
    byDay,
    topFeatures,
  };
}

export interface AuditExportSchedule {
  id: string;
  boardId: string;
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

export function createSchedule(boardId: string, input: {
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
    VALUES (${id}, ${boardId}, ${input.name}, ${input.format}, ${JSON.stringify(input.filters ?? {})}, ${input.schedule}, 1, ${now}, 'system', ${now})
  `);

  return getScheduleById(id)!;
}

export function getScheduleById(id: string): AuditExportSchedule | null {
  const db = getDb();
  const rows = db.all(sql`SELECT * FROM audit_export_schedules WHERE id = ${id}`) as any[];
  if (rows.length === 0) return null;
  return mapScheduleRow(rows[0]);
}

export function listSchedules(boardId: string): AuditExportSchedule[] {
  const db = getDb();
  const rows = db.all(sql`SELECT * FROM audit_export_schedules WHERE habitat_id = ${boardId} ORDER BY created_at`) as any[];
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
    boardId: row.habitat_id,
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
