import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import {
  notificationDeliveryChannelStates,
  notificationDeliveries,
  webhookSubscriptions,
} from "../db/schema/index.js";
import { and, eq, sql, asc } from "drizzle-orm";
import * as eventRepo from "./notificationEvent.js";
import * as webhookSubRepo from "./webhookSubscription.js";
import * as attemptRepo from "./notificationDeliveryAttempt.js";

/**
 * Transactional client seam (the repo's `...WithClient` convention): every
 * state-machine write below accepts an optional drizzle client so callers
 * compose the unit CAS/outcome, attempt reconciliation, and delivery
 * aggregate in ONE transaction (A1). Defaults to the ambient connection.
 */
export type NotificationStateDbClient = ReturnType<typeof getDb>;

/**
 * Notification delivery units — the per-(delivery, channel, destination)
 * state machine that is the single scheduling authority for push and retry
 * (contract: one scanner, no competing first/retry loops).
 *
 * A unit is one base channel for the delivery, except the webhook channel,
 * which freezes one unit per authorized destination under the namespaced key
 * `webhook:<subscriptionId>`; the worker splits that key back into base
 * channel + destination so plugin dispatch keys on the BASE channel.
 */

/** Total send reservations a unit may ever spend, consumed at CLAIM time. */
export const NOTIFICATION_RESERVATIONS_TOTAL = 3;

/** Lease TTL: exclusive DB-state ownership window for a claimed unit. */
export const NOTIFICATION_LEASE_TTL_MS = 60_000;

/** Backoff after a failed reservation N (index N-1). The last terminalizes. */
export const NOTIFICATION_RETRY_BACKOFF_MS = [1_000, 2_000] as const;

/** Worker cadence (spacing between scan passes). */
export const NOTIFICATION_WORKER_TICK_MS = 60_000;

/**
 * Fixed, truthful disposition text. Never raw parser/error text, never a
 * destination URL, never a secret — dispositions are user-visible.
 */
export const NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION =
  "no authorized webhook destination at enqueue";
export const NOTIFICATION_DISPOSITION_DESTINATION_DISABLED =
  "destination disabled";
export const NOTIFICATION_DISPOSITION_DESTINATION_REMOVED =
  "destination removed";
export const NOTIFICATION_DISPOSITION_DESTINATION_AUTHORIZATION_REMOVED =
  "destination no longer subscribed to this notification type";
export const NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION =
  "no enabled slack integration";
export const NOTIFICATION_DISPOSITION_NO_DISCORD_INTEGRATION =
  "no enabled discord integration";
export const NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED =
  "delivery budget exhausted";
export const NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE =
  "outcome unknown after lease expiry";
export const NOTIFICATION_DISPOSITION_CANCELLED =
  "cancelled by recipient action";

export type NotificationUnitState =
  | "available"
  | "claimed"
  | "cooldown"
  | "sent"
  | "skipped"
  | "exhausted"
  | "cancelled"
  | "backlog_not_attempted"
  | "satisfied_at_enqueue";

const NON_TERMINAL_UNIT_STATES: NotificationUnitState[] = [
  "available",
  "claimed",
  "cooldown",
];

export interface NotificationChannelStateRow {
  id: string;
  deliveryId: string;
  channelKey: string;
  baseChannel: string | null;
  destinationId: string | null;
  state: NotificationUnitState;
  reservationsTotal: number;
  reservationsUsed: number;
  leaseOwner: string | null;
  leaseFence: string | null;
  leaseExpiresAt: string | null;
  nextEligibleAt: string | null;
  disposition: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One scan row for the delivery worker: unit joined to its delivery, event, and (for webhook-destination units) current subscription. */
export interface DueUnitRow {
  unitId: string;
  deliveryId: string;
  channelKey: string;
  baseChannel: string | null;
  destinationId: string | null;
  state: NotificationUnitState;
  reservationsUsed: number;
  reservationsTotal: number;
  deliveryStatus: string;
  deliveryCreatedAt: string;
  eventType: string;
  /** Live subscription fields for a destination unit — null when the subscription row is gone. */
  destination: {
    enabled: number | null;
    url: string | null;
    secret: string | null;
    /** Raw headers JSON text (parsed defensively by the worker). */
    headers: string | null;
    /** Raw events JSON text. */
    events: string | null;
  } | null;
}

export function getUnitById(unitId: string): NotificationChannelStateRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(notificationDeliveryChannelStates)
    .where(eq(notificationDeliveryChannelStates.id, unitId))
    .get();
  return (row as unknown as NotificationChannelStateRow) ?? null;
}

export function getUnitsForDelivery(
  deliveryId: string,
): NotificationChannelStateRow[] {
  const db = getDb();
  return db
    .select()
    .from(notificationDeliveryChannelStates)
    .where(eq(notificationDeliveryChannelStates.deliveryId, deliveryId))
    .orderBy(asc(notificationDeliveryChannelStates.createdAt))
    .all() as unknown as NotificationChannelStateRow[];
}

/**
 * Habitat-exact authorized notification destinations for an event type:
 * enabled `webhook_subscriptions` rows of THIS habitat whose events list
 * contains the namespaced `notification:<type>` opt-in. Deliberately NOT the
 * board lister (which ORs in NULL-habitat globals) — a global subscription's
 * namespaced entry must not aggregate every habitat's notifications. The
 * empty-events catch-all receives board events only and never opts in here.
 */
export function listAuthorizedNotificationDestinationIds(
  habitatId: string,
  eventType: string,
): string[] {
  const entries = webhookSubRepo.listEnabledHabitatScopedWebhookSubscriptionRecords(
    habitatId,
  );
  const optIn = `notification:${eventType}`;
  return entries
    .filter((row) => Array.isArray(row.events) && row.events.includes(optIn))
    .map((row) => row.id);
}

/**
 * Freezes the delivery's unit plan ONCE, at committed creation — the same
 * synchronous block as the delivery INSERT, so every producer path (command
 * service, digest service, any future direct repository insert) freezes the
 * same way and no destination authorized later can receive this delivery.
 * in_app is satisfied by the inbox row itself; the webhook channel expands to
 * its authorized destinations (or an honest skipped unit when none exist).
 */
export function freezeUnitPlanForDelivery(
  input: {
    deliveryId: string;
    habitatId: string;
    eventId: string;
    channels: string[];
    now: string;
  },
  client?: NotificationStateDbClient,
): void {
  const db = client ?? getDb();
  const event = eventRepo.getNotificationEventById(input.eventId);
  const destinationIds = event
    ? listAuthorizedNotificationDestinationIds(input.habitatId, event.eventType)
    : [];

  const seen = new Set<string>();
  const rows: Array<typeof notificationDeliveryChannelStates.$inferInsert> = [];
  for (const channel of input.channels ?? []) {
    if (seen.has(channel)) continue;
    seen.add(channel);

    if (channel === "in_app") {
      rows.push({
        id: uuid(),
        deliveryId: input.deliveryId,
        channelKey: "in_app",
        baseChannel: "in_app",
        destinationId: null,
        state: "satisfied_at_enqueue",
        reservationsTotal: 0,
        reservationsUsed: 0,
        createdAt: input.now,
        updatedAt: input.now,
      });
      continue;
    }

    if (channel === "webhook") {
      if (destinationIds.length === 0) {
        rows.push({
          id: uuid(),
          deliveryId: input.deliveryId,
          channelKey: "webhook",
          baseChannel: "webhook",
          destinationId: null,
          state: "skipped",
          reservationsTotal: 0,
          reservationsUsed: 0,
          disposition: NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION,
          createdAt: input.now,
          updatedAt: input.now,
        });
        continue;
      }
      for (const destinationId of destinationIds) {
        rows.push({
          id: uuid(),
          deliveryId: input.deliveryId,
          channelKey: `webhook:${destinationId}`,
          baseChannel: "webhook",
          destinationId,
          state: "available",
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
      continue;
    }

    rows.push({
      id: uuid(),
      deliveryId: input.deliveryId,
      channelKey: channel,
      baseChannel: channel,
      destinationId: null,
      state: "available",
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  if (rows.length === 0) return;
  db.insert(notificationDeliveryChannelStates)
    .values(rows)
    .onConflictDoNothing()
    .run();
}

/** Tx-scoped single-row read (the client-aware `getNotificationDeliveryById`
 * seam — inside a transaction the ambient getter would see uncommitted
 * state only by connection luck; this makes the delivery row's transactional
 * read explicit). */
export function getNotificationDeliveryRowWithClient(
  id: string,
  client: NotificationStateDbClient,
): NotificationDeliveryRowLike | null {
  return (
    client
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, id))
      .get() as unknown as NotificationDeliveryRowLike | null
  );
}

/** Minimal structural type of a notification delivery row (avoids importing
 * the shared type here — the repositories own persistence shapes). */
export type NotificationDeliveryRowLike = {
  id: string;
  status: string;
  createdAt: string;
  deliveredAt: string | null;
  pushEpoch?: string;
  [key: string]: unknown;
};

/**
 * Worker claim CAS — spends exactly one reservation atomically with lease
 * acquisition. Claimable shapes mirror the scan exactly:
 *
 *   - `available`;
 *   - `cooldown` whose `next_eligible_at` is due;
 *   - `claimed` whose lease has EXPIRED (the crashed-owner resume shape —
 *     the caller terminalizes the abandoned owner's non-terminal attempt row
 *     before creating the new one).
 *
 * Terminal states, a not-yet-due cooldown, a live (unexpired) lease, and an
 * exhausted budget all yield zero rows: `acquired: false`.
 */
export function claimUnitForDispatch(input: {
  unitId: string;
  owner: string;
  now: string;
  ttlMs: number;
}): { acquired: boolean; fence: string | null } {
  const db = getDb();
  const fence = uuid();
  const expiresAt = new Date(new Date(input.now).getTime() + input.ttlMs).toISOString();

  const result = db.run(sql`
    UPDATE notification_delivery_channel_states
    SET state = 'claimed',
        reservations_used = reservations_used + 1,
        lease_owner = ${input.owner},
        lease_fence = ${fence},
        lease_expires_at = ${expiresAt},
        updated_at = ${input.now}
    WHERE id = ${input.unitId}
      AND reservations_used < reservations_total
      AND (
        state = 'available'
        OR (state = 'cooldown' AND (next_eligible_at IS NULL OR next_eligible_at <= ${input.now}))
        OR (state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${input.now})
      )
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  let acquired: boolean;
  if (typeof changes === "number") {
    acquired = changes === 1;
  } else {
    // sql.js / mocks: only the winner's write leaves our just-minted fence.
    const probe = getUnitById(input.unitId);
    acquired = probe != null && probe.leaseFence === fence && probe.state === "claimed";
  }
  return { acquired, fence: acquired ? fence : null };
}

/**
 * Fenced outcome write — the ONLY way a claimed unit records its result
 * (`sent` | `cooldown` | `exhausted` | `skipped`). Requires the current fence
 * AND `state = 'claimed'`, so a stale owner writes zero rows. Always releases
 * the lease; never touches reservations (claim-time budget only).
 */
export function recordFencedUnitOutcome(
  input: {
    unitId: string;
    fence: string;
    outcome: "sent" | "cooldown" | "exhausted" | "skipped" | "cancelled";
    nextEligibleAt?: string | null;
    disposition?: string | null;
    now: string;
  },
  client?: NotificationStateDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE notification_delivery_channel_states
    SET state = ${input.outcome},
        next_eligible_at = ${input.nextEligibleAt ?? null},
        disposition = ${input.disposition ?? null},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        updated_at = ${input.now}
    WHERE id = ${input.unitId}
      AND lease_fence = ${input.fence}
      AND state = 'claimed'
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = getUnitById(input.unitId);
  return (
    probe != null &&
    probe.state === input.outcome &&
    probe.leaseFence === null &&
    probe.updatedAt === input.now
  );
}

/**
 * Fenced terminalization for an EXPIRED claimed unit — the janitor path
 * (budget exhausted, owner gone: outcome unknown) and nothing else. Never
 * fires while a lease is live.
 */
export function terminalizeExpiredClaimedUnit(
  input: {
    unitId: string;
    state: "exhausted" | "cancelled";
    disposition: string;
    now: string;
  },
  client?: NotificationStateDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE notification_delivery_channel_states
    SET state = ${input.state},
        disposition = ${input.disposition},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        updated_at = ${input.now}
    WHERE id = ${input.unitId}
      AND state = 'claimed'
      AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = getUnitById(input.unitId);
  return (
    probe != null &&
    probe.state === input.state &&
    probe.disposition === input.disposition &&
    probe.leaseFence === null
  );
}

/**
 * Fenced terminalization for a unit whose destination failed the
 * dispatch-boundary recheck (disabled / removed / de-authorized / malformed
 * headers): skips WITHOUT consuming a reservation or sending. Covers
 * non-claimed units AND a claimed unit whose owner's lease has EXPIRED (the
 * crashed-owner + deauthorized-destination intersection — without this the
 * unit wedges: unclaimable because the recheck returns first, unjanitorable
 * because its budget is unspent). CAS-protected — a LIVE lease (its owner's
 * fenced outcome is still pending) or an already-terminal unit is left alone.
 */
export function terminalizeUnitForDisposition(
  input: {
    unitId: string;
    state: "skipped";
    disposition: string;
    now: string;
  },
  client?: NotificationStateDbClient,
): boolean {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE notification_delivery_channel_states
    SET state = ${input.state},
        disposition = ${input.disposition},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        updated_at = ${input.now}
    WHERE id = ${input.unitId}
      AND state IN ('available', 'cooldown', 'claimed')
      AND (lease_fence IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = getUnitById(input.unitId);
  return (
    probe != null &&
    probe.state === input.state &&
    probe.disposition === input.disposition &&
    probe.leaseFence === null
  );
}

/**
 * Recipient terminal actions (acknowledge/snooze/mute/clear) cancel every
 * non-terminal unit of the delivery — authoritative, regardless of a live
 * lease (the owner's fenced outcome then writes nothing: state ≠ 'claimed').
 * Terminal units keep their evidence.
 */
export function cancelNonTerminalUnitsForDelivery(
  deliveryId: string,
  now: string,
  client?: NotificationStateDbClient,
): number {
  const db = client ?? getDb();
  const result = db.run(sql`
    UPDATE notification_delivery_channel_states
    SET state = 'cancelled',
        disposition = ${NOTIFICATION_DISPOSITION_CANCELLED},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL,
        updated_at = ${now}
    WHERE delivery_id = ${deliveryId}
      AND state IN ('available', 'cooldown', 'claimed')
  `);
  // Resolve any in-flight owner's stranded PENDING attempt rows with the
  // same fixed truthful text — a cancel must not leave pending attempt
  // evidence behind (the owner's late fenced write will no longer match the
  // claimed-state gate and cannot reconcile them itself).
  attemptRepo.markPendingAttemptsTerminalForDelivery(deliveryId, now, db);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes;
  const remaining = db
    .select({ id: notificationDeliveryChannelStates.id })
    .from(notificationDeliveryChannelStates)
    .where(
      and(
        eq(notificationDeliveryChannelStates.deliveryId, deliveryId),
        sql`${notificationDeliveryChannelStates.state} IN ('available', 'cooldown', 'claimed')`,
      ),
    )
    .all();
  return remaining.length === 0 ? 1 : 0;
}

/**
 * One scan, three eligible shapes — the ONLY selection path for first push
 * and retries:
 *
 *   state = 'available'
 *   OR (state = 'cooldown' AND next_eligible_at <= now)
 *   OR (state = 'claimed' AND lease_expires_at <= now)   -- expired owner
 *
 * Scoped to post-epoch (`push_epoch = 'restored'`) deliveries that are still
 * `pending`; user actions and legacy rows are excluded by delivery state, not
 * elapsed-time inference. Terminal units are never reselected.
 */
export function listDueUnits(
  limit = 50,
  now: string = new Date().toISOString(),
): DueUnitRow[] {
  const db = getDb();
  const rows = db
    .select({
      unitId: notificationDeliveryChannelStates.id,
      deliveryId: notificationDeliveryChannelStates.deliveryId,
      channelKey: notificationDeliveryChannelStates.channelKey,
      baseChannel: notificationDeliveryChannelStates.baseChannel,
      destinationId: notificationDeliveryChannelStates.destinationId,
      state: notificationDeliveryChannelStates.state,
      reservationsUsed: notificationDeliveryChannelStates.reservationsUsed,
      reservationsTotal: notificationDeliveryChannelStates.reservationsTotal,
      deliveryStatus: notificationDeliveries.status,
      deliveryCreatedAt: notificationDeliveries.createdAt,
      eventType: sql<string>`(SELECT event_type FROM notification_events WHERE id = ${notificationDeliveries.eventId})`,
      subEnabled: webhookSubscriptions.enabled,
      subUrl: webhookSubscriptions.url,
      subSecret: webhookSubscriptions.secret,
      // RAW text, deliberately NOT the json-mode mapper: malformed legacy
      // JSON must not throw inside the SELECT — the worker parses per row.
      subHeaders: sql<string | null>`${webhookSubscriptions.headers}`,
      subEvents: sql<string | null>`${webhookSubscriptions.events}`,
    })
    .from(notificationDeliveryChannelStates)
    .innerJoin(
      notificationDeliveries,
      eq(notificationDeliveryChannelStates.deliveryId, notificationDeliveries.id),
    )
    .leftJoin(
      webhookSubscriptions,
      eq(notificationDeliveryChannelStates.destinationId, webhookSubscriptions.id),
    )
    .where(
      and(
        eq(notificationDeliveries.pushEpoch, "restored"),
        eq(notificationDeliveries.status, "pending"),
        sql`(
          ${notificationDeliveryChannelStates.state} = 'available'
          OR (${notificationDeliveryChannelStates.state} = 'cooldown' AND (${notificationDeliveryChannelStates.nextEligibleAt} IS NULL OR ${notificationDeliveryChannelStates.nextEligibleAt} <= ${now}))
          OR (${notificationDeliveryChannelStates.state} = 'claimed' AND ${notificationDeliveryChannelStates.leaseExpiresAt} IS NOT NULL AND ${notificationDeliveryChannelStates.leaseExpiresAt} <= ${now})
        )`,
      ),
    )
    .orderBy(asc(notificationDeliveryChannelStates.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    unitId: row.unitId,
    deliveryId: row.deliveryId,
    channelKey: row.channelKey,
    baseChannel: row.baseChannel,
    destinationId: row.destinationId,
    state: row.state as NotificationUnitState,
    reservationsUsed: row.reservationsUsed,
    reservationsTotal: row.reservationsTotal,
    deliveryStatus: row.deliveryStatus,
    deliveryCreatedAt: row.deliveryCreatedAt,
    eventType: row.eventType,
    destination:
      row.destinationId != null
        ? {
            enabled: row.subEnabled ?? null,
            url: row.subUrl ?? null,
            secret: row.subSecret ?? null,
            headers: row.subHeaders ?? null,
            events: row.subEvents ?? null,
          }
        : null,
  }));
}

/**
 * Aggregate delivery completion — coherent only when EVERY unit is terminal.
 * Any `sent` or `satisfied_at_enqueue` → CAS `pending → delivered`
 * (`deliveredAt` = transition time; for an in-app-only satisfaction it is the
 * availability receipt: `createdAt`, never a fabricated push receipt).
 * All terminal, none sent → CAS `pending → failed` (inbox-visible fallback).
 * The CAS only ever wins from `pending` — an acknowledged/snoozed/muted/
 * cleared delivery is never overwritten by async completion.
 */
export function aggregateDeliveryCompletionIfAllTerminal(
  deliveryId: string,
  now: string,
  client?: NotificationStateDbClient,
): boolean {
  const db = client ?? getDb();
  const units = db
    .select()
    .from(notificationDeliveryChannelStates)
    .where(eq(notificationDeliveryChannelStates.deliveryId, deliveryId))
    .orderBy(asc(notificationDeliveryChannelStates.createdAt))
    .all() as unknown as NotificationChannelStateRow[];
  // An EMPTY frozen unit set is a coherent availability receipt: no push work
  // is owed (in-app-only or no channels), so "all units terminal, none sent"
  // cannot mean failure — the delivery became readable at creation. Reached
  // from the creation seam for post-epoch deliveries; legacy rows have their
  // own evidence units and never call this with an empty set.
  const emptyReceipt = units.length === 0;
  if (!emptyReceipt && units.some((u) => NON_TERMINAL_UNIT_STATES.includes(u.state))) return false;

  const anySent = emptyReceipt
    ? true
    : units.some((u) => u.state === "sent" || u.state === "satisfied_at_enqueue");

  if (anySent) {
    const onlyAvailability = units.every((u) => u.state === "satisfied_at_enqueue");
    const delivery = db
      .select({ createdAt: notificationDeliveries.createdAt })
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    const deliveredAt = onlyAvailability
      ? (delivery?.createdAt ?? now)
      : now;
    const result = db.run(sql`
      UPDATE notification_deliveries
      SET status = 'delivered', delivered_at = ${deliveredAt}, updated_at = ${now}
      WHERE id = ${deliveryId} AND status = 'pending'
    `);
    return changesOrProbe(result, deliveryId, "delivered", now);
  }

  const result = db.run(sql`
    UPDATE notification_deliveries
    SET status = 'failed', updated_at = ${now}
    WHERE id = ${deliveryId} AND status = 'pending'
  `);
  return changesOrProbe(result, deliveryId, "failed", now);
}

function changesOrProbe(
  result: unknown,
  deliveryId: string,
  status: string,
  now: string,
): boolean {
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const row = getDb()
    .select({ status: notificationDeliveries.status, updatedAt: notificationDeliveries.updatedAt })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId))
    .get();
  return row != null && row.status === status && row.updatedAt === now;
}
