import { getDb } from "../db/index.js";
import { notificationEvents } from "../db/schema/index.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  NotificationEvent,
  NotificationEventType,
  NotificationSourceType,
  NotificationTargetType,
  NotificationSeverity,
  NotificationActorType,
} from "@orcy/shared";

export interface CreateNotificationEventInput {
  habitatId: string;
  eventType: NotificationEventType;
  sourceType: NotificationSourceType;
  sourceId?: string;
  targetType?: NotificationTargetType;
  targetId?: string;
  severity: NotificationSeverity;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  createdByType: NotificationActorType;
  createdById?: string;
}

export function createNotificationEvent(input: CreateNotificationEventInput): NotificationEvent {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationEvents)
      .values({
        id,
        habitatId: input.habitatId,
        eventType: input.eventType,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        severity: input.severity,
        title: input.title,
        body: input.body,
        payload: input.payload ?? {},
        createdByType: input.createdByType,
        createdById: input.createdById ?? null,
        createdAt: now,
        historySummary: null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationEvent", err as Error, id);
  }

  const created = getNotificationEventById(id);
  if (!created) throw repositoryNotFoundError("notificationEvent", id);
  return created;
}

export function getNotificationEventById(id: string): NotificationEvent | null {
  const db = getDb();
  const row = db.select().from(notificationEvents).where(eq(notificationEvents.id, id)).get();
  return row ? (row as unknown as NotificationEvent) : null;
}

export interface ListNotificationEventsFilters {
  eventType?: NotificationEventType;
  sourceType?: NotificationSourceType;
  sourceId?: string;
  targetType?: NotificationTargetType;
  targetId?: string;
  severity?: NotificationSeverity;
  limit?: number;
  offset?: number;
}

export function listNotificationEventsByHabitat(
  habitatId: string,
  filters?: ListNotificationEventsFilters,
): { events: NotificationEvent[]; total: number } {
  const db = getDb();
  const conditions = [eq(notificationEvents.habitatId, habitatId)];

  if (filters?.eventType) conditions.push(eq(notificationEvents.eventType, filters.eventType));
  if (filters?.sourceType) conditions.push(eq(notificationEvents.sourceType, filters.sourceType));
  if (filters?.sourceId) conditions.push(eq(notificationEvents.sourceId, filters.sourceId));
  if (filters?.targetType) conditions.push(eq(notificationEvents.targetType, filters.targetType));
  if (filters?.targetId) conditions.push(eq(notificationEvents.targetId, filters.targetId));
  if (filters?.severity) conditions.push(eq(notificationEvents.severity, filters.severity));

  const where = and(...conditions);

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(notificationEvents)
    .where(where)
    .get();
  const total = totalResult?.count ?? 0;

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = db
    .select()
    .from(notificationEvents)
    .where(where)
    .orderBy(desc(notificationEvents.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { events: rows as unknown as NotificationEvent[], total };
}

export function getNotificationEventsBySource(
  sourceType: NotificationSourceType,
  sourceId: string,
): NotificationEvent[] {
  const db = getDb();
  return db
    .select()
    .from(notificationEvents)
    .where(
      and(eq(notificationEvents.sourceType, sourceType), eq(notificationEvents.sourceId, sourceId)),
    )
    .orderBy(desc(notificationEvents.createdAt))
    .all() as unknown as NotificationEvent[];
}

export function updateEventHistorySummary(
  eventId: string,
  historySummary: Record<string, unknown>,
): void {
  const db = getDb();
  try {
    db.update(notificationEvents)
      .set({ historySummary })
      .where(eq(notificationEvents.id, eventId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationEvent", err as Error, eventId);
  }
}
