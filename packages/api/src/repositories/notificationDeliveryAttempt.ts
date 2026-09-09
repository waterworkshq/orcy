import { getDb } from "../db/index.js";
import { notificationDeliveryAttempts } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

/** Transactional client seam — see notificationChannelState.ts. */
export type NotificationAttemptDbClient = ReturnType<typeof getDb>;
import type {
  NotificationDeliveryAttempt,
  NotificationChannel,
  NotificationAttemptStatus,
} from "@orcy/shared";

export interface CreateDeliveryAttemptInput {
  deliveryId: string;
  channel: NotificationChannel;
  destinationId?: string | null;
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
        destinationId: input.destinationId ?? null,
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
  client?: NotificationAttemptDbClient,
): NotificationDeliveryAttempt {
  const db = client ?? getDb();

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

  const updated = client
    ? (client.select().from(notificationDeliveryAttempts).where(eq(notificationDeliveryAttempts.id, id)).get() as unknown as NotificationDeliveryAttempt | undefined)
    : getDeliveryAttemptById(id);
  if (!updated) throw repositoryNotFoundError("notificationDeliveryAttempt", id);
  return updated;
}

/** Resolves EVERY stranded PENDING attempt row of a delivery with the fixed
 * cancel disposition (recipient terminal action path). */
export function markPendingAttemptsTerminalForDelivery(
  deliveryId: string,
  now: string,
  client?: NotificationAttemptDbClient,
): void {
  const db = client ?? getDb();
  db.run(sql`
    UPDATE notification_delivery_attempts
    SET status = 'failed',
        error = 'cancelled by recipient action',
        finished_at = ${now}
    WHERE delivery_id = ${deliveryId}
      AND status = 'pending'
  `);
}

/**
 * Resolves the crashed owner's stranded PENDING attempt rows for one unit
 * (delivery + base channel + destination) — used by the delivery worker on
 * lease-expiry resume and by the exhaustion janitor so a reservation's
 * attempt never stays live across owners. Historical `retry_scheduled` rows
 * are deliberately NOT selected: they are consumed evidence for a completed
 * reservation and never form a second scheduling authority (the unit scan is
 * the only selection path since the V2 restoration).
 */
export function markPendingAttemptsTerminalForUnit(
  input: {
    deliveryId: string;
    channel: NotificationChannel;
    destinationId: string | null;
    status: NotificationAttemptStatus;
    error: string;
    now: string;
  },
  client?: NotificationAttemptDbClient,
): void {
  const db = client ?? getDb();
  db.run(sql`
    UPDATE notification_delivery_attempts
    SET status = ${input.status},
        error = ${input.error},
        finished_at = ${input.now}
    WHERE delivery_id = ${input.deliveryId}
      AND channel = ${input.channel}
      AND (destination_id IS ${input.destinationId} OR (${input.destinationId} IS NULL AND destination_id IS NULL))
      AND status = 'pending'
  `);
}
