import { getDb } from "../db/index.js";
import { notificationDeliveryAttempts } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";
import type {
  NotificationDeliveryAttempt,
  NotificationChannel,
  NotificationAttemptStatus,
} from "@orcy/shared";

export interface CreateDeliveryAttemptInput {
  deliveryId: string;
  channel: NotificationChannel;
  attempt?: number;
  status?: NotificationAttemptStatus;
  statusCode?: number;
  error?: string;
  responseBody?: string;
  nextRetryAt?: string;
}

export function createDeliveryAttempt(
  input: CreateDeliveryAttemptInput,
): NotificationDeliveryAttempt {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(notificationDeliveryAttempts)
      .values({
        id,
        deliveryId: input.deliveryId,
        channel: input.channel,
        status: input.status ?? "pending",
        attempt: input.attempt ?? 1,
        statusCode: input.statusCode ?? null,
        error: input.error ?? null,
        responseBody: input.responseBody ?? null,
        nextRetryAt: input.nextRetryAt ?? null,
        createdAt: now,
        finishedAt: null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("notificationDeliveryAttempt", err as Error, id);
  }

  const created = getDeliveryAttemptById(id);
  if (!created) throw repositoryNotFoundError("notificationDeliveryAttempt", id);
  return created;
}

export function getDeliveryAttemptById(id: string): NotificationDeliveryAttempt | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDeliveryAttempts)
    .where(eq(notificationDeliveryAttempts.id, id))
    .get();
  return row ? (row as unknown as NotificationDeliveryAttempt) : null;
}

export function getDeliveryAttemptsByDelivery(deliveryId: string): NotificationDeliveryAttempt[] {
  const db = getDb();
  return db
    .select()
    .from(notificationDeliveryAttempts)
    .where(eq(notificationDeliveryAttempts.deliveryId, deliveryId))
    .all() as unknown as NotificationDeliveryAttempt[];
}

export function updateDeliveryAttempt(
  id: string,
  updates: {
    status?: NotificationAttemptStatus;
    statusCode?: number | null;
    error?: string | null;
    responseBody?: string | null;
    nextRetryAt?: string | null;
    finishedAt?: string | null;
  },
): NotificationDeliveryAttempt {
  const db = getDb();

  const set: Record<string, unknown> = {};
  if (updates.status !== undefined) set.status = updates.status;
  if (updates.statusCode !== undefined) set.statusCode = updates.statusCode;
  if (updates.error !== undefined) set.error = updates.error;
  if (updates.responseBody !== undefined) set.responseBody = updates.responseBody;
  if (updates.nextRetryAt !== undefined) set.nextRetryAt = updates.nextRetryAt;
  if (updates.finishedAt !== undefined) set.finishedAt = updates.finishedAt;

  try {
    db.update(notificationDeliveryAttempts)
      .set(set)
      .where(eq(notificationDeliveryAttempts.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("notificationDeliveryAttempt", err as Error, id);
  }

  const updated = getDeliveryAttemptById(id);
  if (!updated) throw repositoryNotFoundError("notificationDeliveryAttempt", id);
  return updated;
}

export function getRetryCandidates(
  channel: NotificationChannel,
  status: NotificationAttemptStatus,
  beforeTime: string,
  options?: { limit?: number },
): NotificationDeliveryAttempt[] {
  const db = getDb();
  const limit = options?.limit ?? 50;

  return db
    .select()
    .from(notificationDeliveryAttempts)
    .where(
      and(
        eq(notificationDeliveryAttempts.channel, channel),
        eq(notificationDeliveryAttempts.status, status),
        sql`${notificationDeliveryAttempts.nextRetryAt} IS NOT NULL AND ${notificationDeliveryAttempts.nextRetryAt} <= ${beforeTime}`,
      ),
    )
    .limit(limit)
    .all() as unknown as NotificationDeliveryAttempt[];
}
