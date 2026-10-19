import { getDb } from "../db/index.js";
import { notificationDeliveryAttempts, notificationDeliveries } from "../db/schema/index.js";
import { eq, and, sql, getTableColumns, desc } from "drizzle-orm";
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

/** Administrative projection only; recipient history keeps its exact identity scope. */
export function getDeliveryAttemptsByHabitat(
  habitatId: string,
  options: { channel?: NotificationChannel; limit?: number } = {},
): NotificationDeliveryAttempt[] {
  const db = getDb();
  const limit = options.limit ?? 50;
  if (Number.isSafeInteger(limit) && limit >= 1 && limit <= 100) {
    // Deferred migrations may leave the original reader usable without these
    // additive indexes. Check current schema metadata without caching failure;
    // query/read errors remain visible rather than triggering a silent retry.
    const indexes = db.get<{ ready: number }>(sql`
      SELECT COUNT(*) AS ready FROM sqlite_master WHERE type = 'index' AND (
        (name = 'idx_notification_attempts_created_order' AND tbl_name = 'notification_delivery_attempts') OR
        (name = 'idx_notification_attempts_channel_created_order' AND tbl_name = 'notification_delivery_attempts') OR
        (name = 'idx_notification_deliveries_scope_lookup' AND tbl_name = 'notification_deliveries')
      )
    `);
    if (indexes?.ready === 3) {
      const prefixLimit = Math.max(256, 4 * limit);
      const chronologyIndex = options.channel === undefined
        ? sql.raw("idx_notification_attempts_created_order")
        : sql.raw("idx_notification_attempts_channel_created_order");
      const channelPredicate = options.channel === undefined
        ? sql``
        : sql`WHERE channel = ${options.channel}`;
      // Only lightweight recent rows enter this relation. CROSS JOIN keeps
      // those rows outermost, so Habitat filtering uses at most prefixLimit
      // covered parent lookups rather than scanning the Habitat's deliveries.
      const prefix = sql`(
        WITH recent AS MATERIALIZED (
          SELECT id, delivery_id, created_at
          FROM notification_delivery_attempts INDEXED BY ${chronologyIndex}
          ${channelPredicate}
          ORDER BY created_at DESC, id DESC
          LIMIT ${prefixLimit}
        ), matches AS MATERIALIZED (
          SELECT r.id, r.created_at
          FROM recent r
          CROSS JOIN notification_deliveries d INDEXED BY idx_notification_deliveries_scope_lookup
          WHERE d.id = r.delivery_id AND d.habitat_id = ${habitatId}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ${limit}
        )
        SELECT counts.prefix_count, m.id, m.created_at
        FROM (SELECT COUNT(*) AS prefix_count FROM recent) counts
        LEFT JOIN matches m ON 1
      ) scoped_prefix`;
      const prefixRows = db
        .select({
          prefixCount: sql<number>`scoped_prefix.prefix_count`.mapWith(Number),
          attempt: getTableColumns(notificationDeliveryAttempts),
        })
        .from(prefix)
        .leftJoin(notificationDeliveryAttempts, eq(notificationDeliveryAttempts.id, sql`scoped_prefix.id`))
        .orderBy(sql`scoped_prefix.created_at DESC`, sql`scoped_prefix.id DESC`)
        .all();
      // Fetch payloads in the same statement as the scope check and preserve
      // Drizzle's column decoding. The singleton count also represents zero
      // matches, where the left-joined attempt is null.
      const attempts = prefixRows.flatMap(row => row.attempt === null ? [] : [row.attempt]);
      if (attempts.length >= limit || prefixRows[0]!.prefixCount < prefixLimit) {
        return attempts as unknown as NotificationDeliveryAttempt[];
      }
      // A partial prefix cannot answer the query. Discard it and return one
      // complete fallback statement's snapshot; never merge the two answers.
    }
  }
  return db
    .select(getTableColumns(notificationDeliveryAttempts))
    .from(notificationDeliveryAttempts)
    .innerJoin(notificationDeliveries, eq(notificationDeliveryAttempts.deliveryId, notificationDeliveries.id))
    .where(and(
      eq(notificationDeliveries.habitatId, habitatId),
      options.channel === undefined ? undefined : eq(notificationDeliveryAttempts.channel, options.channel),
    ))
    .orderBy(desc(notificationDeliveryAttempts.createdAt), desc(notificationDeliveryAttempts.id))
    .limit(limit)
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
