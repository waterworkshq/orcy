import { getDb } from '../../db/index.js';
import { featureEvents, features } from '../../db/schema/index.js';
import { eq, and, count, asc, desc, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { FeatureEvent, ActorType, FeatureEventAction, FeatureStatus } from '../../models/index.js';

export interface CreateFeatureEventInput {
  featureId: string;
  actorType: ActorType;
  actorId: string;
  action: FeatureEventAction;
  fromColumnId?: string | null;
  toColumnId?: string | null;
  fromStatus?: FeatureStatus | null;
  toStatus?: FeatureStatus | null;
  metadata?: Record<string, unknown>;
}

export function createFeatureEvent(input: CreateFeatureEventInput): FeatureEvent {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(featureEvents)
    .values({
      id,
      featureId: input.featureId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      fromColumnId: input.fromColumnId ?? null,
      toColumnId: input.toColumnId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: input.metadata ?? {},
      timestamp: now,
    })
    .run();

  return getFeatureEventById(id)!;
}

export function getFeatureEventById(id: string): FeatureEvent | null {
  const db = getDb();
  const row = db
    .select()
    .from(featureEvents)
    .where(eq(featureEvents.id, id))
    .get();
  return (row as FeatureEvent) ?? null;
}

export function getFeatureEventsByFeatureId(
  featureId: string,
  limit = 50,
  offset = 0,
): { events: FeatureEvent[]; total: number } {
  const db = getDb();
  const result = db
    .select()
    .from(featureEvents)
    .where(eq(featureEvents.featureId, featureId))
    .orderBy(desc(featureEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as FeatureEvent[];

  const totalResult = db
    .select({ count: count() })
    .from(featureEvents)
    .where(eq(featureEvents.featureId, featureId))
    .get();

  return { events: result, total: totalResult?.count ?? 0 };
}

export function getFeatureEventsByBoardId(
  boardId: string,
  limit = 50,
  offset = 0,
): { events: FeatureEvent[]; total: number } {
  const db = getDb();

  const featureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all()
    .map(r => r.id);

  if (featureIds.length === 0) return { events: [], total: 0 };

  const result = db
    .select()
    .from(featureEvents)
    .where(inArray(featureEvents.featureId, featureIds))
    .orderBy(desc(featureEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as FeatureEvent[];

  const totalResult = db
    .select({ count: count() })
    .from(featureEvents)
    .where(inArray(featureEvents.featureId, featureIds))
    .get();

  return { events: result, total: totalResult?.count ?? 0 };
}
