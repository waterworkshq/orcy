import { getDb } from "../db/index.js";
import { notificationSubscriptions } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";
import type {
  NotificationSubscription,
  NotificationSubscriptionScope,
  NotificationRecipientType,
  NotificationCadence,
  NotificationChannel,
} from "@orcy/shared";

export interface CreateSubscriptionInput {
  habitatId: string;
  scope: NotificationSubscriptionScope;
  recipientType?: NotificationRecipientType;
  recipientId?: string;
  eventType: string;
  enabled?: boolean;
  required?: boolean;
  channels?: NotificationChannel[];
  cadence?: NotificationCadence;
  timezone?: string;
  localSendTime?: string;
  muteUntil?: string;
  createdBy?: string;
}

export function createSubscription(input: CreateSubscriptionInput): NotificationSubscription {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationSubscriptions)
      .values({
        id,
        habitatId: input.habitatId,
        scope: input.scope,
        recipientType: input.recipientType ?? null,
        recipientId: input.recipientId ?? null,
        eventType: input.eventType,
        enabled: input.enabled ?? true,
        required: input.required ?? false,
        channels: input.channels ?? [],
        cadence: input.cadence ?? "immediate",
        timezone: input.timezone ?? null,
        localSendTime: input.localSendTime ?? null,
        muteUntil: input.muteUntil ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationSubscription", err as Error, id);
  }

  const created = getSubscriptionById(id);
  if (!created) throw repositoryNotFoundError("notificationSubscription", id);
  return created;
}

export function getSubscriptionById(id: string): NotificationSubscription | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationSubscriptions)
    .where(eq(notificationSubscriptions.id, id))
    .get();
  return row ? (row as unknown as NotificationSubscription) : null;
}

export function getHabitatDefaults(
  habitatId: string,
  eventType?: string,
): NotificationSubscription[] {
  const db = getDb();
  const conditions = [
    eq(notificationSubscriptions.habitatId, habitatId),
    eq(notificationSubscriptions.scope, "habitat_default"),
    eq(notificationSubscriptions.enabled, true),
  ];

  if (eventType) {
    conditions.push(eq(notificationSubscriptions.eventType, eventType));
  }

  return db
    .select()
    .from(notificationSubscriptions)
    .where(and(...conditions))
    .all() as unknown as NotificationSubscription[];
}

export function getRecipientOverrides(
  habitatId: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
  eventType?: string,
): NotificationSubscription[] {
  const db = getDb();
  const conditions = [
    eq(notificationSubscriptions.habitatId, habitatId),
    eq(notificationSubscriptions.scope, "recipient_override"),
    eq(notificationSubscriptions.recipientType, recipientType),
    eq(notificationSubscriptions.recipientId, recipientId),
  ];

  if (eventType) {
    conditions.push(eq(notificationSubscriptions.eventType, eventType));
  }

  return db
    .select()
    .from(notificationSubscriptions)
    .where(and(...conditions))
    .all() as unknown as NotificationSubscription[];
}

export function getSubscriptionsForRecipientType(
  habitatId: string,
  recipientType: NotificationRecipientType,
  recipientId: string,
): NotificationSubscription[] {
  const db = getDb();
  return db
    .select()
    .from(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.habitatId, habitatId),
        eq(notificationSubscriptions.recipientType, recipientType),
        eq(notificationSubscriptions.recipientId, recipientId),
      ),
    )
    .all() as unknown as NotificationSubscription[];
}

export function updateSubscription(
  id: string,
  updates: {
    enabled?: boolean;
    required?: boolean;
    channels?: NotificationChannel[];
    cadence?: NotificationCadence;
    timezone?: string | null;
    localSendTime?: string | null;
    muteUntil?: string | null;
  },
): NotificationSubscription {
  const db = getDb();
  const now = new Date().toISOString();

  const set: Record<string, unknown> = { updatedAt: now };
  if (updates.enabled !== undefined) set.enabled = updates.enabled;
  if (updates.required !== undefined) set.required = updates.required;
  if (updates.channels !== undefined) set.channels = updates.channels;
  if (updates.cadence !== undefined) set.cadence = updates.cadence;
  if (updates.timezone !== undefined) set.timezone = updates.timezone;
  if (updates.localSendTime !== undefined) set.localSendTime = updates.localSendTime;
  if (updates.muteUntil !== undefined) set.muteUntil = updates.muteUntil;

  try {
    db.update(notificationSubscriptions).set(set).where(eq(notificationSubscriptions.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("notificationSubscription", err as Error, id);
  }

  const updated = getSubscriptionById(id);
  if (!updated) throw repositoryNotFoundError("notificationSubscription", id);
  return updated;
}

export function deleteSubscription(id: string): boolean {
  const db = getDb();
  try {
    const result = db
      .delete(notificationSubscriptions)
      .where(eq(notificationSubscriptions.id, id))
      .run();
    return result.changes === undefined || result.changes > 0;
  } catch (err) {
    throw repositoryDeleteError("notificationSubscription", err as Error, id);
  }
}

export function getAllSubscriptionsByHabitat(habitatId: string): NotificationSubscription[] {
  const db = getDb();
  return db
    .select()
    .from(notificationSubscriptions)
    .where(eq(notificationSubscriptions.habitatId, habitatId))
    .all() as unknown as NotificationSubscription[];
}
