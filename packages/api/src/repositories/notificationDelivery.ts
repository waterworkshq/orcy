import { getDb } from "../db/index.js";
import { notificationDeliveries } from "../db/schema/index.js";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import {
  aggregateDeliveryCompletionIfAllTerminal,
  freezeUnitPlanForDelivery,
  cancelNonTerminalUnitsForDelivery,
  getNotificationDeliveryRowWithClient,
} from "./notificationChannelState.js";
import * as stateRepo from "./notificationChannelState.js";
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
  // ONE transaction (contract: freeze is atomic with the INSERT for ALL
  // producers): delivery INSERT → frozen unit plan → creation-time aggregate
  // all commit together or not at all. A failure mid-freeze rolls back the
  // ENTIRE plan + delivery — no orphan row, no partial plan a later-authorized
  // destination could join. Nested inside an outer producer transaction this
  // becomes a savepoint, so an outer rollback discards the whole creation.
  // The FINAL row is re-read after commit so callers never see the stale
  // pre-aggregate object (in-app-only creations return `delivered`).
  const id = uuid();
  const now = new Date().toISOString();
  const db = getDb();

  runCreateAtomically(db, input, id, now);

/**
 * Runs the delivery creation atomically, transaction-context aware:
 *
 *  - No active transaction → drizzle `db.transaction` (BEGIN…COMMIT).
 *  - An active RAW transaction (e.g. `withImmediateLifecycleTransaction`'s
 *    `BEGIN IMMEDIATE`, which drizzle cannot see) → SAVEPOINT join: the
 *    savepoint gives the creation its own all-or-nothing rollback scope
 *    while committing atomically with the enclosing producer transaction.
 *    Blindly calling `db.transaction` there would issue a nested BEGIN and
 *    fail ("cannot start a transaction within a transaction").
 *
 * Active-transaction detection: a bare `BEGIN` probe fails iff a transaction
 * is already active on the connection (SQLite allows only one); the probe
 * transaction is rolled back immediately when it succeeds, so detection
 * never leaves one open.
 */
function runCreateAtomically(
  db: ReturnType<typeof getDb>,
  input: CreateNotificationDeliveryInput,
  id: string,
  now: string,
): void {
  // Active-transaction detection: bare `BEGIN` fails iff a transaction is
  // already active on the connection. When the probe BEGIN succeeds we are
  // NOT in a transaction — roll the probe back and use the drizzle path.
  let rawActive: boolean;
  try {
    db.run(sql`BEGIN`);
    db.run(sql`ROLLBACK`);
    rawActive = false;
  } catch {
    rawActive = true;
  }
  if (!rawActive) {
    db.transaction((tx) => runCreateInTx(tx, input, id, now));
    return;
  }
  const sp = `orcy_create_${id.replace(/-/g, "")}`;
  db.run(sql`SAVEPOINT ${sql.raw(`"${sp}"`)}`);
  try {
    runCreateInTx(db, input, id, now);
    db.run(sql`RELEASE SAVEPOINT ${sql.raw(`"${sp}"`)}`);
  } catch (err) {
    try {
      db.run(sql`ROLLBACK TO SAVEPOINT ${sql.raw(`"${sp}"`)}`);
      db.run(sql`RELEASE SAVEPOINT ${sql.raw(`"${sp}"`)}`);
    } catch {
      // enclosing raw tx will roll back wholesale on its own error path
    }
    throw err;
  }
}

function runCreateInTx(
  tx: ReturnType<typeof getDb>,
  input: CreateNotificationDeliveryInput,
  id: string,
  now: string,
): void {
  try {
    tx.insert(notificationDeliveries)
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

  const created = stateRepo.getNotificationDeliveryRowWithClient(id, tx);
  if (!created) throw repositoryNotFoundError("notificationDelivery", id);

  // Unit-plan freeze: ONE frozen unit set, same transaction as the INSERT —
  // every producer path (command service, digest service, direct repository
  // callers) freezes identically; no destination authorized later receives
  // this delivery.
  freezeUnitPlanForDelivery(
    {
      deliveryId: id,
      habitatId: input.habitatId,
      eventId: input.eventId,
      channels: input.channels ?? [],
      now,
    },
    tx,
  );

  // Coherent creation-time completion for RESTORED deliveries whose frozen
  // plan is already all-terminal (in-app-only, or no channels at all): the
  // availability receipt (`delivered` with `deliveredAt = createdAt`) — not
  // a push receipt. Legacy rows are excluded (epoch is INSERT-only).
  if (created.pushEpoch === "restored") {
    aggregateDeliveryCompletionIfAllTerminal(id, now, tx);
  }
}

  const final = getNotificationDeliveryById(id);
  if (!final) throw repositoryNotFoundError("notificationDelivery", id);
  return final;
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
  return db.transaction((tx) => acknowledgeDeliveryInTx(deliveryId, tx));
}

function acknowledgeDeliveryInTx(
  deliveryId: string,
  tx: ReturnType<typeof getDb>,
) {
  const db = tx;
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

  // A terminal recipient action cancels every non-terminal push unit —
  // pending/retrying work stops; the completion CAS can no longer win.
  cancelNonTerminalUnitsForDelivery(deliveryId, now, tx);

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function snoozeDelivery(deliveryId: string, snoozedUntil: string): NotificationDelivery {
  const db = getDb();
  return db.transaction((tx) => snoozeDeliveryInTx(deliveryId, tx, snoozedUntil));
}

function snoozeDeliveryInTx(
  deliveryId: string,
  tx: ReturnType<typeof getDb>,
  snoozedUntil: string,
) {
  const db = tx;
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

  // A terminal recipient action cancels every non-terminal push unit —
  // pending/retrying work stops; the completion CAS can no longer win.
  cancelNonTerminalUnitsForDelivery(deliveryId, now, tx);

  const updated = getNotificationDeliveryById(deliveryId);
  if (!updated) throw repositoryNotFoundError("notificationDelivery", deliveryId);
  return updated;
}

export function muteDelivery(deliveryId: string): NotificationDelivery {
  const db = getDb();
  return db.transaction((tx) => muteDeliveryInTx(deliveryId, tx));
}

function muteDeliveryInTx(
  deliveryId: string,
  tx: ReturnType<typeof getDb>,
) {
  const db = tx;
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

  // A terminal recipient action cancels every non-terminal push unit —
  // pending/retrying work stops; the completion CAS can no longer win.
  cancelNonTerminalUnitsForDelivery(deliveryId, now, tx);

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
  return db.transaction((tx) => clearDeliveryInTx(deliveryId, tx));
}

function clearDeliveryInTx(
  deliveryId: string,
  tx: ReturnType<typeof getDb>,
) {
  const db = tx;
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

  // A terminal recipient action cancels every non-terminal push unit —
  // pending/retrying work stops; the completion CAS can no longer win.
  cancelNonTerminalUnitsForDelivery(deliveryId, now, tx);

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
