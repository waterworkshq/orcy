import { getDb } from "../db/index.js";
import { notificationDeliveries, notificationEvents } from "../db/schema/index.js";
import { eq, and, desc, sql, ne, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationRecipientType,
  NotificationChannel,
} from "@orcy/shared";

export interface CreateNotificationDeliveryInput {
  eventId: string;
  habitatId: string;
  recipientType: NotificationRecipientType;
  recipientId: string;
  required?: boolean;
  channels?: NotificationChannel[];
  clearAfter?: string;
}

export function createNotificationDelivery(
  input: CreateNotificationDeliveryInput,
): NotificationDelivery {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationDeliveries)
      .values({
        id,
        eventId: input.eventId,
        habitatId: input.habitatId,
        recipientType: input.recipientType,
        recipientId: input.recipientId,
        status: "pending",
        required: input.required ?? false,
        channels: input.channels ?? [],
        deliveredAt: null,
        acknowledgedAt: null,
        snoozedUntil: null,
        mutedAt: null,
        clearedAt: null,
        clearAfter: input.clearAfter ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationDelivery", err as Error, id);
  }

  const created = getNotificationDeliveryById(id);
  if (!created) throw repositoryNotFoundError("notificationDelivery", id);
  return created;
}

export function getNotificationDeliveryById(id: string): NotificationDelivery | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id))
    .get();
  return row ? (row as unknown as NotificationDelivery) : null;
}

export function getDeliveriesByEvent(eventId: string): NotificationDelivery[] {
  const db = getDb();
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.eventId, eventId))
    .all() as unknown as NotificationDelivery[];
}

const ACTIVE_STATUSES: NotificationDeliveryStatus[] = ["pending", "delivered", "snoozed", "failed"];

export function getActiveInbox(
  habitatId: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
  options?: { limit?: number; offset?: number },
): { deliveries: NotificationDelivery[]; total: number } {
  const db = getDb();
  const conditions = [
    eq(notificationDeliveries.habitatId, habitatId),
    eq(notificationDeliveries.recipientType, recipientType),
    eq(notificationDeliveries.recipientId, recipientId),
    inArray(notificationDeliveries.status, ACTIVE_STATUSES),
  ];

  const where = and(...conditions);

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .where(where)
    .get();
  const total = totalResult?.count ?? 0;

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const rows = db
    .select()
    .from(notificationDeliveries)
    .where(where)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { deliveries: rows as unknown as NotificationDelivery[], total };
}

export function getDeliveryHistory(
  habitatId: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
  options?: { limit?: number; offset?: number },
): { deliveries: NotificationDelivery[]; total: number } {
  const db = getDb();
  const conditions = [
    eq(notificationDeliveries.habitatId, habitatId),
    eq(notificationDeliveries.recipientType, recipientType),
    eq(notificationDeliveries.recipientId, recipientId),
  ];

  const where = and(...conditions);

  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .where(where)
    .get();
  const total = totalResult?.count ?? 0;

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const rows = db
    .select()
    .from(notificationDeliveries)
    .where(where)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  return { deliveries: rows as unknown as NotificationDelivery[], total };
}

export function acknowledgeDelivery(deliveryId: string): NotificationDelivery {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(notificationDeliveries)
      .set({
        status: "acknowledged",
        acknowledgedAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error, deliveryId);
  }

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function snoozeDelivery(deliveryId: string, snoozedUntil: string): NotificationDelivery {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(notificationDeliveries)
      .set({
        status: "snoozed",
        snoozedUntil,
        updatedAt: now,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error, deliveryId);
  }

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function muteDelivery(deliveryId: string): NotificationDelivery {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(notificationDeliveries)
      .set({
        status: "muted",
        mutedAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error, deliveryId);
  }

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function markDeliveryDelivered(deliveryId: string): NotificationDelivery {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(notificationDeliveries)
      .set({
        status: "delivered",
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error, deliveryId);
  }

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function clearDelivery(deliveryId: string): NotificationDelivery {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(notificationDeliveries)
      .set({
        status: "cleared",
        clearedAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error, deliveryId);
  }

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function getClearanceCandidates(
  habitatId: string,
  statuses: NotificationDeliveryStatus[],
  clearBefore: string,
  options?: { limit?: number },
): NotificationDelivery[] {
  const db = getDb();
  const conditions = [
    eq(notificationDeliveries.habitatId, habitatId),
    inArray(notificationDeliveries.status, statuses),
    sql`${notificationDeliveries.clearAfter} IS NOT NULL AND ${notificationDeliveries.clearAfter} <= ${clearBefore}`,
  ];

  const limit = options?.limit ?? 100;

  return db
    .select()
    .from(notificationDeliveries)
    .where(and(...conditions))
    .limit(limit)
    .all() as unknown as NotificationDelivery[];
}

export function batchUpdateDeliveryStatus(
  deliveryIds: string[],
  status: NotificationDeliveryStatus,
  extraFields?: Partial<Record<string, unknown>>,
): number {
  const db = getDb();
  const now = new Date().toISOString();

  if (deliveryIds.length === 0) return 0;

  const set: Record<string, unknown> = { status, updatedAt: now, ...extraFields };

  try {
    const result = db
      .update(notificationDeliveries)
      .set(set)
      .where(inArray(notificationDeliveries.id, deliveryIds))
      .run();
    return result.changes;
  } catch (err) {
    throw repositoryUpdateError("notificationDelivery", err as Error);
  }
}
