import { v4 as uuid } from "uuid";
import { signPayload } from "../../utils/webhookSigning.js";
import { fetchValidated, filterUnsafeHeaders, UrlRejectedError } from "../../config/integrationSecurity.js";
import { logger } from "../../lib/logger.js";
import type { WebhookSubscription } from "./webhook-subscriptions.js";
import {
  claimWebhookDeliveryForRetry,
  createWebhookDeliveryRecord,
  listRetryEligibleWebhookDeliveries,
  listWebhookDeliveriesForSubscription,
  recordFencedWebhookDeliveryOutcome,
  terminalizeWebhookDelivery,
  WEBHOOK_DISPOSITION_BUDGET_EXHAUSTED,
  WEBHOOK_DISPOSITION_HEADERS_MALFORMED,
  WEBHOOK_DISPOSITION_SUBSCRIPTION_DISABLED,
  WEBHOOK_DISPOSITION_SUBSCRIPTION_MISSING,
  type RetryEligibleWebhookDeliveryRow,
} from "../../repositories/webhookDelivery.js";

/** Represents a single webhook delivery attempt and its outcome. */
export interface WebhookDelivery {
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
}

/**
 * Total send attempts (reservations) a delivery may ever spend, consumed at
 * claim/insert time — NOT at outcome time. A lost-owner window can therefore
 * never spend budget without a send being authorized, and once the budget is
 * spent the row terminalizes (outcome unknown disposition when no live owner
 * remains). This bounds physical sends; it does not promise three SUCCESSFUL
 * sends, nor unconditional at-least-once delivery.
 */
export const MAX_WEBHOOK_ATTEMPTS = 3;

/**
 * Lease TTL: exclusive DB-state ownership window. Chosen ≥ the 10s
 * fetchValidated cap plus scheduling slack, aligned to the worker tick.
 * While a lease is unexpired no other authority can claim or send the row.
 */
export const WEBHOOK_LEASE_TTL_MS = 60_000;

/** Worker cadence (spacing between scan passes). */
export const WEBHOOK_RETRY_TICK_MS = 60_000;

/** Backoff after a failed attempt N (index N-1). Attempt 3 terminalizes. */
export const WEBHOOK_RETRY_BACKOFF_MS = [1_000, 2_000] as const;

/** Error indicating that a webhook URL was rejected by outbound URL validation. */
export class OutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundUrlError";
  }
}

/** Sends a signed webhook payload via POST and returns the response summary. */
export async function executeHttpRequest(
  url: string,
  payloadString: string,
  signature: string | null,
  headers: Record<string, string>,
  deliveryId: string,
  eventType: string,
): Promise<{ success: boolean; statusCode: number; responseBody: string }> {
  const { headers: safeHeaders, blocked } = filterUnsafeHeaders(headers);
  if (blocked.length > 0) {
    logger.warn({ deliveryId, blocked }, "Blocked unsafe custom headers in delivery");
  }

  try {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...safeHeaders,
    };

    if (signature) {
      requestHeaders["X-Kanban-Signature"] = signature;
    }
    requestHeaders["X-Kanban-Event"] = eventType;
    requestHeaders["X-Kanban-Delivery"] = deliveryId;

    // fetchValidated = canonical SSRF check + fetch PINNED to the validated
    // resolution + fail-closed redirects + 10s timeout, in one resolution.
    const response = await fetchValidated(url, {
      method: "POST",
      headers: requestHeaders,
      body: payloadString,
    });

    const body = await response.text();
    return {
      success: response.ok,
      statusCode: response.status,
      responseBody: body.slice(0, 1024),
    };
  } catch (err) {
    if (err instanceof UrlRejectedError) {
      return {
        success: false,
        statusCode: 0,
        responseBody: `Blocked outbound URL: ${err.reason}`,
      };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      success: false,
      statusCode: 0,
      responseBody: message,
    };
  }
}

/**
 * Records a delivery outcome through the FENCED completion write (the only
 * outcome path): success terminalizes; failure terminalizes once the claim
 * budget is spent; otherwise the row is scheduled for its next claim after a
 * fixed backoff. `attemptNumber` is the reservation number consumed by the
 * CURRENT owner's claim/insert (attempts are claimed, never re-counted at
 * outcome time). Returns whether the fenced write landed (a stale owner
 * superseded by a newer claim writes nothing).
 */
export function handleDeliveryOutcome(
  deliveryId: string,
  fence: string,
  result: { success: boolean; statusCode: number; responseBody: string },
  attemptNumber: number,
  nowOverride?: string,
): boolean {
  const now = nowOverride ?? new Date().toISOString();
  if (result.success) {
    return recordFencedWebhookDeliveryOutcome({
      deliveryId,
      fence,
      status: "success",
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      now,
    });
  }
  if (attemptNumber >= MAX_WEBHOOK_ATTEMPTS) {
    return recordFencedWebhookDeliveryOutcome({
      deliveryId,
      fence,
      status: "failed",
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      now,
    });
  }
  const delay = WEBHOOK_RETRY_BACKOFF_MS[attemptNumber - 1];
  const nextRetryAt = new Date(new Date(now).getTime() + delay).toISOString();
  return recordFencedWebhookDeliveryOutcome({
    deliveryId,
    fence,
    status: "pending",
    statusCode: result.statusCode,
    responseBody: result.responseBody,
    nextRetryAt,
    now,
  });
}

/**
 * Creates a pending delivery record for a webhook event, holding its OWN
 * lease from the instant it exists (lease-at-insert: no unclaimed window) and
 * having consumed its initial send reservation (`attempts = 1`). Returns
 * `created: false` when the subscription is disabled/missing at the insert
 * authority boundary — the caller must not send.
 */
export function createDeliveryRecord(
  subscriptionId: string,
  eventType: string,
  payload: string,
  deliveryId: string,
): { created: boolean; fence: string } {
  return createWebhookDeliveryRecord(subscriptionId, eventType, payload, deliveryId, {
    owner: `webhook-dispatch:${deliveryId}`,
    ttlMs: WEBHOOK_LEASE_TTL_MS,
  });
}

/** Returns recent webhook deliveries for a subscription. */
export function getDeliveriesForSubscription(
  subscriptionId: string,
  limit = 25,
): WebhookDelivery[] {
  return listWebhookDeliveriesForSubscription(subscriptionId, limit);
}

/** Sends a test payload to a subscription URL and reports the result. */
export async function sendTestWebhook(
  subscription: WebhookSubscription,
): Promise<{ success: boolean; statusCode: number; latencyMs: number }> {
  const deliveryId = uuid();
  const testPayload = {
    id: deliveryId,
    timestamp: new Date().toISOString(),
    event: "test",
    data: {
      habitatName: "Test Habitat",
      task: {
        id: "test-task-id",
        title: "Test Task",
        status: "pending",
        priority: "medium",
        assignedAgentId: null,
        assignedAgentName: undefined,
        result: null,
        artifacts: [],
      },
    },
  };

  const payloadString = JSON.stringify(testPayload);
  const signature = subscription.secret ? signPayload(payloadString, subscription.secret) : null;

  const startTime = Date.now();

  const result = await executeHttpRequest(
    subscription.url,
    payloadString,
    signature,
    subscription.headers,
    deliveryId,
    "webhook.test",
  );

  return {
    success: result.success,
    latencyMs: Date.now() - startTime,
    statusCode: result.statusCode,
  };
}

// ---------------------------------------------------------------------------
// Retry worker — two-branch scan + claim/fence + bounded budget
// ---------------------------------------------------------------------------

let retryInterval: ReturnType<typeof setInterval> | null = null;
/** Bumped by every stop/start: a pass started under an older generation must
 * not claim rows once a newer generation (or a stop) supersedes it. */
let generation = 0;
/** In-flight sends of the CURRENT lifetime; drained (bounded) by stop. */
const inFlightSends = new Set<Promise<void>>();
/** Drain bound: the 10s fetch cap plus slack — a send cannot outlive this. */
const STOP_DRAIN_BOUND_MS = 15_000;

function processRetryRow(
  row: RetryEligibleWebhookDeliveryRow,
  leaseOwner: string,
  now: string | undefined,
): Promise<void> | null {
  const effectiveNow = now ?? new Date().toISOString();

  // Branch 1 — orphaned delivery (subscription row missing): the LEFT JOIN
  // kept it visible; terminalize without consuming a reservation.
  if (row.url === null || row.enabled === null) {
    terminalizeWebhookDelivery({
      deliveryId: row.id,
      disposition: WEBHOOK_DISPOSITION_SUBSCRIPTION_MISSING,
      now: effectiveNow,
    });
    return null;
  }

  // Branch 2 — disabled subscription: fixed truthful disposition, no send,
  // no reservation. (The FK cascade already removes rows on delete; disabled
  // subscriptions persist, so this is the path that must not strand them.)
  if (row.enabled !== 1) {
    terminalizeWebhookDelivery({
      deliveryId: row.id,
      disposition: WEBHOOK_DISPOSITION_SUBSCRIPTION_DISABLED,
      now: effectiveNow,
    });
    return null;
  }

  // Branch 3 — malformed subscription headers: terminalize with FIXED
  // redacted text (raw input/parser errors can embed operator secrets).
  // Parsed BEFORE claiming so a corrupt row never burns a reservation.
  let headers: Record<string, string>;
  try {
    const parsed = JSON.parse(row.headers) as unknown;
    headers = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    terminalizeWebhookDelivery({
      deliveryId: row.id,
      disposition: WEBHOOK_DISPOSITION_HEADERS_MALFORMED,
      now: effectiveNow,
    });
    return null;
  }

  // Branch 4 — budget exhausted: if the last owner is gone (lease free or
  // expired) and the outcome was never recorded, terminalize truthfully.
  // A live owner is skipped — its fenced outcome is still pending.
  if (row.attempts >= MAX_WEBHOOK_ATTEMPTS) {
    if (row.leaseExpiresAt !== null && row.leaseExpiresAt > effectiveNow) return null;
    terminalizeWebhookDelivery({
      deliveryId: row.id,
      disposition: WEBHOOK_DISPOSITION_BUDGET_EXHAUSTED,
      now: effectiveNow,
    });
    return null;
  }

  // Branch 5 — claim exactly one reservation (the CAS rechecks lease state,
  // budget, due-ness and current subscription `enabled` at the authority
  // boundary), then perform at most this one HTTP invocation.
  const claim = claimWebhookDeliveryForRetry({
    deliveryId: row.id,
    leaseOwner,
    now: effectiveNow,
    ttlMs: WEBHOOK_LEASE_TTL_MS,
    maxAttempts: MAX_WEBHOOK_ATTEMPTS,
  });
  if (!claim.acquired || claim.fence === null || claim.delivery === null) return null;
  const attemptNumber = claim.delivery.attempts;
  const claimFence = claim.fence;
  const targetUrl = row.url;
  const payload = row.payload;
  const secret = row.secret;

  const send: Promise<void> = (async () => {
    const signature = secret ? signPayload(payload, secret) : null;
    const result = await executeHttpRequest(
      targetUrl,
      payload,
      signature,
      headers,
      row.id,
      "webhook.delivery",
    );
    try {
      handleDeliveryOutcome(row.id, claimFence, result, attemptNumber, now);
    } catch (writeErr) {
      // A send that outlived the drain bound (or teardown) must not crash
      // the process; its row remains recoverable via the exhaustion path.
      logger.error(
        { deliveryId: row.id },
        "Webhook delivery outcome write failed after send",
      );
    }
  })();
  inFlightSends.add(send);
  void send
    .catch((err) => {
      logger.error({ err, deliveryId: row.id }, "Webhook retry send failed");
    })
    .finally(() => {
      inFlightSends.delete(send);
    });
  return send;
}

/**
 * One retry-worker pass. Scans pending due rows (LEFT-JOINed to their current
 * subscription — disabled/orphaned rows stay in the disposition path) and
 * processes each row in isolation: a failing or corrupt row never blocks the
 * rest of the scan. The pass captures the current generation and stops
 * claiming rows the moment a stop/start supersedes it.
 */
export async function processWebhookRetryQueue(
  opts: { now?: string; leaseOwner?: string } = {},
): Promise<void> {
  const passGeneration = generation;
  const leaseOwner = opts.leaseOwner ?? `webhook-retry:${passGeneration}`;
  const rows = listRetryEligibleWebhookDeliveries(50, opts.now);
  const launched: Promise<void>[] = [];

  for (const row of rows) {
    if (passGeneration !== generation) {
      // Superseded by stop/restart: claims stop here. Sends already launched
      // by this pass still settle below (their owners legitimately hold them).
      break;
    }
    try {
      const send = processRetryRow(row, leaseOwner, opts.now);
      if (send) launched.push(send);
    } catch (err) {
      logger.error({ err, deliveryId: row.id }, "Webhook retry pass row failed");
      // Per-row isolation: leave the row for the next pass; never starve the scan.
    }
  }

  // A pass owns the sends it launched: it resolves only once their fenced
  // outcome writes landed (allSettled — a rejected send must not unwind the
  // pass; its row stays recoverable).
  await Promise.allSettled(launched);
}

/**
 * Starts the background interval that processes pending webhook retries.
 * The first pass fires one tick after start (never synchronously — the boot
 * callback may run before the DB is initialized).
 */
export function startRetryProcessor(intervalMs: number = WEBHOOK_RETRY_TICK_MS): void {
  if (retryInterval) return;
  generation += 1;
  retryInterval = setInterval(() => {
    void processWebhookRetryQueue().catch((err) => {
      logger.error({ err }, "Webhook retry tick failed");
    });
  }, intervalMs);
}

/**
 * Stops the retry processor: no new interval ticks, no new claims from any
 * pass of the superseded generation, and every in-flight send is OWNED —
 * this resolves only after the sends of the current lifetime settled (their
 * fenced outcome writes included) or the bounded drain window elapsed.
 * Await it before closing the DB so teardown never races outcome writes.
 */
export async function stopRetryProcessor(): Promise<void> {
  generation += 1; // revokes in-pass generation callbacks; prevents revival of old ticks
  if (retryInterval) {
    clearInterval(retryInterval);
    retryInterval = null;
  }
  const pending = [...inFlightSends];
  if (pending.length === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_DRAIN_BOUND_MS);
    void Promise.allSettled(pending).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
