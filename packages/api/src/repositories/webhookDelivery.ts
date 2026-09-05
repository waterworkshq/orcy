import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema/index.js";
import { and, asc, eq, sql } from "drizzle-orm";

export interface WebhookDeliveryRecord {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseFence: string | null;
  leaseExpiresAt: string | null;
}

/** One scan row for the retry worker: delivery joined to its CURRENT subscription. */
export interface RetryEligibleWebhookDeliveryRow {
  id: string;
  subscriptionId: string;
  payload: string;
  attempts: number;
  nextRetryAt: string | null;
  leaseExpiresAt: string | null;
  /** Null when the subscription row is missing (orphaned delivery). */
  url: string | null;
  secret: string | null;
  /** Raw headers JSON text from the subscription (may be malformed legacy input). */
  headers: string;
  /** Null when the subscription row is missing; 0 when disabled. */
  enabled: number | null;
}

/**
 * Fenced, terminal-disposition text constants. These are FIXED strings by
 * contract: dispositions are user-visible and must never embed raw malformed
 * header input or parser error text (both can carry operator-supplied secrets).
 */
export const WEBHOOK_DISPOSITION_SUBSCRIPTION_DISABLED =
  "Webhook delivery abandoned: subscription is disabled.";
export const WEBHOOK_DISPOSITION_SUBSCRIPTION_MISSING =
  "Webhook delivery abandoned: subscription is missing.";
export const WEBHOOK_DISPOSITION_HEADERS_MALFORMED =
  "Webhook delivery abandoned: subscription headers are malformed.";
export const WEBHOOK_DISPOSITION_BUDGET_EXHAUSTED =
  "Webhook delivery abandoned: retry budget exhausted; outcome of the final attempt is unknown.";

export function getWebhookDeliveryById(deliveryId: string): WebhookDeliveryRecord | null {
  const db = getDb();
  const row = db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get();
  return row ?? null;
}

/**
 * Lease-at-insert delivery creation for the inline first attempt. The INSERT
 * carries its own lease AND its initial send reservation (`attempts = 1`),
 * so ownership is atomic by construction — there is no unclaimed window and
 * no crash gap between "row exists" and "someone owns it".
 *
 * Rechecks subscription existence + `enabled` in the same synchronous block
 * (the dispatch authority boundary): a subscription disabled between the
 * caller's list read and this insert yields `created: false` and no row.
 */
export function createWebhookDeliveryRecord(
  subscriptionId: string,
  eventType: string,
  payload: string,
  deliveryId: string,
  lease: { owner: string; ttlMs: number; now?: string },
): { created: boolean; fence: string } {
  const db = getDb();
  const now = lease.now ?? new Date().toISOString();
  const fence = uuid();
  const expiresAt = new Date(new Date(now).getTime() + lease.ttlMs).toISOString();

  const subscription = db
    .select({ enabled: webhookSubscriptions.enabled })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, subscriptionId))
    .get();
  if (!subscription || subscription.enabled !== 1) {
    return { created: false, fence };
  }

  db.insert(webhookDeliveries)
    .values({
      id: deliveryId,
      subscriptionId,
      eventType,
      payload,
      status: "pending",
      attempts: 1,
      createdAt: now,
      leaseOwner: lease.owner,
      leaseFence: fence,
      leaseExpiresAt: expiresAt,
    })
    .run();
  return { created: true, fence };
}

/**
 * Worker claim CAS — consumes exactly one send reservation (`attempts + 1`)
 * atomically with lease acquisition. One winner per row per lease epoch:
 *
 *   - `pending` + budget remaining + lease-free (or expired) + due + enabled
 *     subscription → claimed under a fresh unique fence;
 *   - a live lease, an exhausted budget, a not-yet-due row, or a
 *     disabled/missing subscription → zero rows affected, `acquired: false`.
 *
 * The `enabled` subquery rechecks current authorization at the claim boundary
 * (the scan may be stale); legacy stranded rows (`attempts = 0` or NULL
 * `next_retry_at`) are due immediately.
 */
export function claimWebhookDeliveryForRetry(input: {
  deliveryId: string;
  leaseOwner: string;
  now: string;
  ttlMs: number;
  maxAttempts: number;
}): { acquired: boolean; fence: string | null; delivery: WebhookDeliveryRecord | null } {
  const db = getDb();
  const fence = uuid();
  const expiresAt = new Date(new Date(input.now).getTime() + input.ttlMs).toISOString();

  const result = db.run(sql`
    UPDATE webhook_deliveries
    SET attempts = attempts + 1,
        lease_owner = ${input.leaseOwner},
        lease_fence = ${fence},
        lease_expires_at = ${expiresAt},
        last_attempt_at = ${input.now}
    WHERE id = ${input.deliveryId}
      AND status = 'pending'
      AND attempts < ${input.maxAttempts}
      AND (lease_fence IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
      AND (attempts = 0 OR next_retry_at IS NULL OR next_retry_at <= ${input.now})
      AND (SELECT enabled FROM webhook_subscriptions WHERE id = webhook_deliveries.subscription_id) = 1
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  let acquired: boolean;
  if (typeof changes === "number") {
    acquired = changes === 1;
  } else {
    // sql.js / mocks: post-update probe — only the winner's write can leave
    // our just-minted fence on the row.
    const probe = db
      .select({ fence: webhookDeliveries.leaseFence })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, input.deliveryId))
      .get();
    acquired = probe != null && probe.fence === fence;
  }

  const delivery = getWebhookDeliveryById(input.deliveryId);
  return { acquired, fence: acquired ? fence : null, delivery };
}

/**
 * Fenced completion write — the ONLY way a claimed delivery records its
 * outcome. Requires BOTH the current fence AND `status = 'pending'`, so a
 * stale owner (superseded or expired fence) writes zero rows and cannot
 * overwrite a newer owner's or a terminal state. Never touches `attempts`
 * (reservations are consumed at claim time only) and always releases the
 * lease: terminal states clear it; a scheduled retry frees the row for the
 * next claim after its backoff.
 */
export function recordFencedWebhookDeliveryOutcome(input: {
  deliveryId: string;
  fence: string;
  status: "success" | "failed" | "pending";
  statusCode?: number | null;
  responseBody?: string | null;
  nextRetryAt?: string | null;
  now: string;
}): boolean {
  const db = getDb();
  const result = db.run(sql`
    UPDATE webhook_deliveries
    SET status = ${input.status},
        status_code = ${input.statusCode ?? null},
        response_body = ${input.responseBody ?? null},
        last_attempt_at = ${input.now},
        next_retry_at = ${input.nextRetryAt ?? null},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL
    WHERE id = ${input.deliveryId}
      AND lease_fence = ${input.fence}
      AND status = 'pending'
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  // sql.js / mocks: post-update probe. A landed write clears the fence and
  // stamps our now/status; a stale owner's zero-row update cannot reproduce
  // this combination while a newer owner holds a different fence.
  const probe = getWebhookDeliveryById(input.deliveryId);
  return (
    probe != null &&
    probe.status === input.status &&
    probe.lastAttemptAt === input.now &&
    probe.leaseFence === null &&
    probe.nextRetryAt === (input.nextRetryAt ?? null)
  );
}

/**
 * Fenced terminal disposition for rows that must stop being retried WITHOUT
 * consuming a send reservation: disabled subscriptions, orphaned rows,
 * malformed subscription headers, and budget-exhausted rows whose owner is
 * gone (outcome unknown). CAS-protected — never overwrites a live lease or a
 * terminal state.
 */
export function terminalizeWebhookDelivery(input: {
  deliveryId: string;
  disposition: string;
  now: string;
}): boolean {
  const db = getDb();
  const result = db.run(sql`
    UPDATE webhook_deliveries
    SET status = 'failed',
        response_body = ${input.disposition},
        last_attempt_at = ${input.now},
        lease_owner = NULL,
        lease_fence = NULL,
        lease_expires_at = NULL
    WHERE id = ${input.deliveryId}
      AND status = 'pending'
      AND (lease_fence IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
  `);
  const changes = (result as { changes?: number } | undefined)?.changes;
  if (typeof changes === "number") return changes === 1;
  const probe = getWebhookDeliveryById(input.deliveryId);
  return (
    probe != null &&
    probe.status === "failed" &&
    probe.responseBody === input.disposition &&
    probe.lastAttemptAt === input.now
  );
}

/**
 * One scan for the retry worker: pending, due delivery rows LEFT-JOINed to
 * their CURRENT subscription. Deliberately NO `enabled` (or existence) filter
 * in the WHERE clause — disabled and orphaned rows stay in the scan so the
 * worker can terminalize them; filtering them out would strand them invisibly
 * (the defect this shape exists to prevent). The caller branches per row.
 */
export function listRetryEligibleWebhookDeliveries(
  limit = 50,
  now: string = new Date().toISOString(),
): RetryEligibleWebhookDeliveryRow[] {
  const db = getDb();

  const rows = db
    .select({
      id: webhookDeliveries.id,
      subscriptionId: webhookDeliveries.subscriptionId,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      nextRetryAt: webhookDeliveries.nextRetryAt,
      leaseExpiresAt: webhookDeliveries.leaseExpiresAt,
      url: webhookSubscriptions.url,
      secret: webhookSubscriptions.secret,
      // RAW text, deliberately NOT the json-mode column mapper: legacy rows can
      // hold malformed headers JSON, and the mapper would throw inside the
      // SELECT — the exact corrupt-row starvation this worker must survive.
      // The worker parses per row and terminalizes failures with fixed text.
      headers: sql<string>`${webhookSubscriptions.headers}`,
      enabled: webhookSubscriptions.enabled,
    })
    .from(webhookDeliveries)
    .leftJoin(webhookSubscriptions, eq(webhookDeliveries.subscriptionId, webhookSubscriptions.id))
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        sql`(${webhookDeliveries.attempts} = 0 OR ${webhookDeliveries.nextRetryAt} IS NULL OR ${webhookDeliveries.nextRetryAt} <= ${now})`,
      ),
    )
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    payload: row.payload,
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt,
    leaseExpiresAt: row.leaseExpiresAt,
    url: row.url ?? null,
    secret: row.secret ?? null,
    headers: typeof row.headers === "string" ? row.headers : JSON.stringify(row.headers ?? {}),
    enabled: row.enabled ?? null,
  }));
}

export function listWebhookDeliveriesForSubscription(
  subscriptionId: string,
  limit = 25,
): WebhookDeliveryRecord[] {
  const db = getDb();
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(sql`${webhookDeliveries.createdAt} DESC`)
    .limit(limit)
    .all();
}
