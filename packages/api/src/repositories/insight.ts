import { getDb } from '../db/index.js';
import { projectInsights } from '../db/schema/index.js';
import { eq, and, count, desc, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { SignalType } from './pulse.js';

export interface ProjectInsight {
  id: string;
  habitatId: string;
  sourcePulseId: string | null;
  sourceMission: string | null;
  signalType: SignalType;
  subject: string;
  body: string;
  relevanceTags: string[];
  promotedBy: string;
  promotedAt: string;
  isActive: boolean;
  createdAt: string;
}

export interface CreateInsightInput {
  habitatId: string;
  sourcePulseId?: string;
  sourceMission?: string;
  signalType: SignalType;
  subject: string;
  body?: string;
  relevanceTags?: string[];
  promotedBy: string;
}

export interface InsightFilters {
  signalType?: SignalType;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}

function rowToInsight(row: Record<string, unknown>): ProjectInsight {
  return {
    id: row.id as string,
    habitatId: row.habitat_id as string,
    sourcePulseId: (row.source_pulse_id as string | null) ?? null,
    sourceMission: (row.source_mission as string | null) ?? null,
    signalType: row.signal_type as SignalType,
    subject: row.subject as string,
    body: row.body as string,
    relevanceTags: (row.relevance_tags as string[]) ?? [],
    promotedBy: row.promoted_by as string,
    promotedAt: row.promoted_at as string,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as string,
  };
}

export function createInsight(input: CreateInsightInput): ProjectInsight {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(projectInsights).values({
    id,
    habitatId: input.habitatId,
    sourcePulseId: input.sourcePulseId ?? null,
    sourceMission: input.sourceMission ?? null,
    signalType: input.signalType,
    subject: input.subject,
    body: input.body ?? '',
    relevanceTags: input.relevanceTags ?? [],
    promotedBy: input.promotedBy,
    promotedAt: now,
    isActive: true,
    createdAt: now,
  }).run();

  return getInsightById(id)!;
}

export function getInsightById(id: string): ProjectInsight | null {
  const db = getDb();
  const rows = db.select().from(projectInsights).where(eq(projectInsights.id, id)).all();
  return rows.length > 0 ? rowToInsight(rows[0]) : null;
}

export function getInsightsByHabitat(habitatId: string, filters?: InsightFilters): { insights: ProjectInsight[]; total: number } {
  const db = getDb();
  const conditions = [eq(projectInsights.habitatId, habitatId)];

  if (filters?.signalType) {
    conditions.push(eq(projectInsights.signalType, filters.signalType));
  }
  if (filters?.isActive !== undefined) {
    conditions.push(eq(projectInsights.isActive, filters.isActive));
  }

  const where = and(...conditions);

  const totalRows = db.select({ total: count() }).from(projectInsights).where(where).all();
  const total = totalRows[0]?.total ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db.select().from(projectInsights)
    .where(where)
    .orderBy(desc(projectInsights.promotedAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { insights: rows.map(rowToInsight), total };
}

export function deactivateInsight(id: string): boolean {
  const db = getDb();
  const insight = getInsightById(id);
  if (!insight) return false;

  db.update(projectInsights).set({ isActive: false }).where(eq(projectInsights.id, id)).run();
  return true;
}

export function getRelevantInsights(habitatId: string, tags: string[], limit = 5): ProjectInsight[] {
  if (tags.length === 0) return [];
  const db = getDb();

  const tagConditions = sql.join(
    tags.map(t => sql`EXISTS (SELECT 1 FROM json_each(${projectInsights.relevanceTags}) WHERE value = ${t})`),
    sql` OR `,
  );

  const rows = db.select().from(projectInsights)
    .where(and(
      eq(projectInsights.habitatId, habitatId),
      eq(projectInsights.isActive, true),
      tagConditions,
    ))
    .limit(limit)
    .all();

  return rows.map(rowToInsight);
}
