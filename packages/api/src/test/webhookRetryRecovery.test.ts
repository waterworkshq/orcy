/**
 * Webhook retry restoration — lease/fence + bounded claim-budget discriminators.
 *
 * Each test discriminates one guarantee of the accepted implementation
 * contract (capability-recovery/webhook-restoration/implementation-contract):
 *
 *   1. Claim budget — reservations are consumed at claim time, exactly one
 *      per claim; a failing receiver burns exactly three reservations and
 *      never gets a fourth send.
 *   2. Legacy NULL recovery — rows with attempts=0 and NULL next_retry_at
 *      (the stranded pre-restoration shape) are due immediately.
 *   3. Live-owner exclusion — an unexpired lease blocks the worker (the
 *      grace-window rejection proof: exclusion is DB state, not elapsed time).
 *   4. Reclaimed-owner completion fencing — a stale fence can write nothing
 *      once a newer owner has re-claimed.
 *   5. Crash exhaustion — an owner that dies post-claim pre-outcome leaves a
 *      bounded row: the janitor terminalizes it without a fourth send.
 *   6. Stable-id uncertain redelivery — a lost owner after a successful
 *      remote send is re-sent with the SAME X-Kanban-Delivery id.
 *   7. Disabled / deleted targets — disabled rows get a fenced terminal
 *      disposition without consuming a reservation; subscription delete
 *      still cascades delivery rows away.
 *   8. Corrupted rows — malformed subscription headers get a fixed redacted
 *      disposition (never raw parser/header content) and the scan continues
 *      to the next row within the same pass.
 *   9. Stop/start lifetime — stop drains in-flight sends, blocks new claims,
 *      and a previous-generation pass cannot claim after stop.
 *
 * All HTTP transport is mocked (fetchValidated seam) — no external sends.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { webhookDeliveries, webhookSubscriptions } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import {
  claimWebhookDeliveryForRetry,
  createWebhookDeliveryRecord,
  getWebhookDeliveryById,
  recordFencedWebhookDeliveryOutcome,
} from "../repositories/webhookDelivery.js";
import {
  MAX_WEBHOOK_ATTEMPTS,
  processWebhookRetryQueue,
  startRetryProcessor,
  stopRetryProcessor,
} from "../services/webhooks/webhook-delivery.js";
import { executeHttpRequest } from "../services/webhooks/webhook-delivery.js";

// ---------------------------------------------------------------------------
// Transport mock — controllable fetchValidated, real filterUnsafeHeaders.
// Records every wire request so tests can assert the stable delivery id.
// ---------------------------------------------------------------------------
interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}
interface PlannedResponse {
  ok: boolean;
  status: number;
  body: string;
  delayMs?: number;
}
const transport = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  plan: [] as PlannedResponse[],
  reset() {
    transport.calls = [];
    transport.plan = [];
  },
}));
vi.mock("../config/integrationSecurity.js", async () => {
  const actual = (await vi.importActual(
    "../config/integrationSecurity.js",
  )) as Record<string, unknown>;
  return {
    ...actual,
    fetchValidated: vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      transport.calls.push({ url, headers, body: String(init.body ?? "") });
      const next = transport.plan.shift() ?? { ok: true, status: 200, body: "ok" };
      if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
      return new Response(next.body, { status: next.status });
    }),
  };
});

const T0 = "2026-01-01T00:00:00.000Z";
const T_PLUS_61S = "2026-01-01T00:01:01.000Z";
const T_PLUS_10M = "2026-01-01T00:10:00.000Z";

interface SeedOptions {
  deliveryId?: string;
  subscriptionId: string;
  attempts?: number;
  nextRetryAt?: string | null;
  status?: "pending" | "success" | "failed";
  leaseOwner?: string | null;
  leaseFence?: string | null;
  leaseExpiresAt?: string | null;
}

function seedDeliveryRow(opts: SeedOptions): string {
  const db = getDb();
  const id = opts.deliveryId ?? `delivery-${Math.random().toString(36).slice(2)}`;
  db.insert(webhookDeliveries)
    .values({
      id,
      subscriptionId: opts.subscriptionId,
      eventType: "webhook.delivery",
      payload: JSON.stringify({ id, event: "webhook.delivery", data: {} }),
      status: opts.status ?? "pending",
      attempts: opts.attempts ?? 0,
      createdAt: T0,
      nextRetryAt: opts.nextRetryAt === undefined ? null : opts.nextRetryAt,
      leaseOwner: opts.leaseOwner ?? null,
      leaseFence: opts.leaseFence ?? null,
      leaseExpiresAt: opts.leaseExpiresAt ?? null,
    })
    .run();
  return id;
}

function seedSubscription(opts: {
  id?: string;
  enabled?: number;
  headers?: string;
}): string {
  const db = getDb();
  const id = opts.id ?? `sub-${Math.random().toString(36).slice(2)}`;
  // Raw SQL: the headers column is seeded as RAW TEXT so tests can inject
  // deliberately malformed legacy JSON (the drizzle json-mode column would
  // re-serialize an object and cannot represent corrupt input).
  db.run(sql`
    INSERT INTO webhook_subscriptions
      (id, habitat_id, name, url, secret, events, headers, format, enabled, created_at, updated_at)
    VALUES
      (${id}, NULL, 'Test subscription', 'https://receiver.example.test/hook',
       'secret-value-for-signing', '[]', ${opts.headers ?? "{}"}, 'standard',
       ${opts.enabled ?? 1}, ${T0}, ${T0})
  `);
  return id;
}

function deliveriesCount(): number {
  return getDb().select({ id: webhookDeliveries.id }).from(webhookDeliveries).all().length;
}

beforeEach(async () => {
  await initTestDb();
  transport.reset();
});

afterEach(async () => {
  // Contract: teardown must not leave writes racing closeDb — the drain-aware
  // stop is awaited before the DB goes away.
  await stopRetryProcessor();
  await closeDb();
});

describe("webhook retry restoration discriminators", () => {
  it("1. claim budget: one reservation per claim; failing receiver burns exactly three, never a fourth", async () => {
    const subId = seedSubscription({});
    // Legacy stranded shape: attempts=0, NULL next_retry_at.
    const deliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 0, nextRetryAt: null });
    transport.plan = [
      { ok: false, status: 503, body: "busy" },
      { ok: false, status: 503, body: "busy" },
      { ok: false, status: 503, body: "busy" },
    ];

    // Reservation 1 (attempt 1) — legacy row due immediately at T0.
    await processWebhookRetryQueue({ now: T0 });
    expect(transport.calls).toHaveLength(1);
    let row = getWebhookDeliveryById(deliveryId)!;
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.nextRetryAt).toBe("2026-01-01T00:00:01.000Z"); // +1s backoff after attempt 1

    // Reservation 2 (attempt 2) — due after the 1s backoff.
    await processWebhookRetryQueue({ now: "2026-01-01T00:00:01.000Z" });
    expect(transport.calls).toHaveLength(2);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("pending");
    expect(row.nextRetryAt).toBe("2026-01-01T00:00:03.000Z"); // +2s backoff after attempt 2

    // Reservation 3 (attempt 3) — terminal fail on a recorded outcome.
    await processWebhookRetryQueue({ now: "2026-01-01T00:00:10.000Z" });
    expect(transport.calls).toHaveLength(3);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.attempts).toBe(3);
    expect(row.status).toBe("failed");

    // No fourth reservation — even far in the future.
    await processWebhookRetryQueue({ now: T_PLUS_10M });
    await processWebhookRetryQueue({ now: "2026-01-02T00:00:00.000Z" });
    expect(transport.calls).toHaveLength(3);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("failed");
    expect(row.leaseFence).toBeNull();
  });

  it("2. legacy NULL recovery: attempts=0 + NULL next_retry_at is due immediately", async () => {
    const subId = seedSubscription({});
    const deliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 0, nextRetryAt: null });

    await processWebhookRetryQueue({ now: T0 });

    expect(transport.calls).toHaveLength(1);
    const row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("success");
    expect(row.attempts).toBe(1);
  });

  it("3. live-owner exclusion: an unexpired lease blocks the worker entirely; expiry releases exactly one send", async () => {
    const subId = seedSubscription({});
    // Inline-dispatch shape: attempts=1, fresh unexpired lease held by the dispatcher.
    const deliveryId = seedDeliveryRow({
      subscriptionId: subId,
      attempts: 1,
      nextRetryAt: null,
      leaseOwner: "webhook-dispatch:owner",
      leaseFence: "live-fence",
      leaseExpiresAt: T_PLUS_61S,
    });

    // Ticks while the lease is live: zero sends, zero writes.
    await processWebhookRetryQueue({ now: T0 });
    await processWebhookRetryQueue({ now: "2026-01-01T00:00:30.000Z" });
    expect(transport.calls).toHaveLength(0);
    let row = getWebhookDeliveryById(deliveryId)!;
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.leaseFence).toBe("live-fence"); // lease state untouched

    // After expiry: exactly one claim + one send.
    await processWebhookRetryQueue({ now: T_PLUS_61S });
    expect(transport.calls).toHaveLength(1);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("success");
    expect(row.attempts).toBe(2);
    expect(row.leaseFence).toBeNull();
  });

  it("4. reclaimed-owner completion fencing: a stale fence writes nothing after re-claim", async () => {
    const subId = seedSubscription({});
    const deliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 1, nextRetryAt: null });

    // Owner A claims at T0 with the standard 60s lease.
    const claimA = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-A",
      now: T0,
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimA.acquired).toBe(true);

    // Lease expires; owner B re-claims under a new fence.
    const claimB = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-B",
      now: T_PLUS_61S,
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimB.acquired).toBe(true);
    expect(claimB.fence).not.toBe(claimA.fence);

    // Owner A's late outcome write: fenced out, zero effect.
    const landed = recordFencedWebhookDeliveryOutcome({
      deliveryId,
      fence: claimA.fence!,
      status: "success",
      statusCode: 200,
      responseBody: "late-from-A",
      now: T_PLUS_61S,
    });
    expect(landed).toBe(false);

    let row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("pending"); // B's state intact
    expect(row.attempts).toBe(3); // A's claim + B's claim, no double write
    expect(row.leaseFence).toBe(claimB.fence);

    // Owner B's outcome write lands.
    const landedB = recordFencedWebhookDeliveryOutcome({
      deliveryId,
      fence: claimB.fence!,
      status: "success",
      statusCode: 200,
      responseBody: "from-B",
      now: T_PLUS_61S,
    });
    expect(landedB).toBe(true);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("success");
    expect(row.responseBody).toBe("from-B");
    expect(row.attempts).toBe(3);
  });

  it("5. crash exhaustion: owner dies post-claim pre-outcome — janitor terminalizes, no fourth send", async () => {
    const subId = seedSubscription({});
    // One reservation already spent by the inline attempt.
    const deliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 1, nextRetryAt: null });

    // Worker claims reservation 2 at T0, then "crashes" (no outcome write).
    const claimA = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-A",
      now: T0,
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimA.acquired).toBe(true);

    // Reservation 3: re-claim after expiry, again crash without outcome.
    const claimB = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-B",
      now: T_PLUS_61S,
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimB.acquired).toBe(true);

    // The claim authority itself refuses to spend a fourth reservation —
    // tested AFTER B's lease expired so only the budget gate can block it.
    const claimC = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-C",
      now: "2026-01-01T00:02:30.000Z",
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimC.acquired).toBe(false);

    let row = getWebhookDeliveryById(deliveryId)!;
    expect(row.attempts).toBe(MAX_WEBHOOK_ATTEMPTS); // budget fully spent
    expect(row.status).toBe("pending"); // outcome unknown

    // Next pass: no live owner, budget exhausted → fenced terminal
    // disposition, and crucially NO send (no reservation left to spend).
    await processWebhookRetryQueue({ now: "2026-01-01T00:02:30.000Z" });
    expect(transport.calls).toHaveLength(0);
    row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_WEBHOOK_ATTEMPTS); // untouched by janitor
    expect(row.responseBody).toBe(
      "Webhook delivery abandoned: retry budget exhausted; outcome of the final attempt is unknown.",
    );
  });

  it("6. stable-id uncertain redelivery: lost owner after a successful remote send re-sends with the same delivery id", async () => {
    const subId = seedSubscription({});
    const deliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 0, nextRetryAt: null });

    // Owner A claims reservation 1, performs the ACTUAL send (it succeeds
    // remotely), then dies before the outcome write.
    const claimA = claimWebhookDeliveryForRetry({
      deliveryId,
      leaseOwner: "worker-A",
      now: T0,
      ttlMs: 60_000,
      maxAttempts: MAX_WEBHOOK_ATTEMPTS,
    });
    expect(claimA.acquired).toBe(true);
    await executeHttpRequest(
      "https://receiver.example.test/hook",
      getWebhookDeliveryById(deliveryId)!.payload,
      null,
      {},
      deliveryId,
      "webhook.delivery",
    );
    expect(transport.calls).toHaveLength(1);
    const firstId = transport.calls[0].headers["X-Kanban-Delivery"];
    expect(firstId).toBe(deliveryId);
    // (crash — no recordFencedWebhookDeliveryOutcome)

    // After lease expiry the worker re-claims (reservation 2) and re-sends.
    transport.plan = [{ ok: true, status: 200, body: "ok" }];
    await processWebhookRetryQueue({ now: T_PLUS_61S });

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1].headers["X-Kanban-Delivery"]).toBe(firstId); // stable id
    const row = getWebhookDeliveryById(deliveryId)!;
    expect(row.status).toBe("success");
    expect(row.attempts).toBe(2); // two reservations spent, budget 3 respected
  });

  it("7. disabled and deleted targets: fenced disposition without a reservation; cascade delete still removes rows", async () => {
    // Disabled: terminal disposition, no send, attempts untouched.
    const disabledSubId = seedSubscription({ enabled: 0 });
    const disabledDeliveryId = seedDeliveryRow({
      subscriptionId: disabledSubId,
      attempts: 1,
      nextRetryAt: null,
    });

    await processWebhookRetryQueue({ now: T0 });

    expect(transport.calls).toHaveLength(0);
    const row = getWebhookDeliveryById(disabledDeliveryId)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1); // no reservation consumed
    expect(row.responseBody).toBe("Webhook delivery abandoned: subscription is disabled.");

    // Deleted: the FK cascade removes delivery rows (existing behavior).
    const doomedSubId = seedSubscription({});
    seedDeliveryRow({ subscriptionId: doomedSubId, attempts: 1, nextRetryAt: null });
    expect(deliveriesCount()).toBe(2);
    getDb().delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, doomedSubId)).run();
    const remaining = getDb()
      .select({ id: webhookDeliveries.id, subscriptionId: webhookDeliveries.subscriptionId })
      .from(webhookDeliveries)
      .all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].subscriptionId).toBe(disabledSubId);
  });

  it("8. corrupted rows: fixed redacted disposition, scan continues within the same pass", async () => {
    const subId = seedSubscription({});
    const goodSubId = seedSubscription({});
    // Malformed headers containing secret-looking operator input.
    const corruptSubId = seedSubscription({ headers: '{"Authorization": "bearer sk-live-123456"' });
    const corruptDeliveryId = seedDeliveryRow({
      subscriptionId: corruptSubId,
      attempts: 1,
      nextRetryAt: null,
    });
    const goodDeliveryId = seedDeliveryRow({ subscriptionId: goodSubId, attempts: 0, nextRetryAt: null });

    // The corrupt row sorts first (created_at T0, earlier insert id ordering
    // is not guaranteed) — force it by making the good row younger.
    getDb()
      .update(webhookDeliveries)
      .set({ createdAt: "2026-01-01T00:00:05.000Z" })
      .where(eq(webhookDeliveries.id, goodDeliveryId))
      .run();

    await processWebhookRetryQueue({ now: T0 });

    // Corrupt row: terminal failed with the FIXED text; no fragment of the
    // raw malformed input and no parser error text anywhere in the row.
    const row = getWebhookDeliveryById(corruptDeliveryId)!;
    expect(row.status).toBe("failed");
    expect(row.responseBody).toBe(
      "Webhook delivery abandoned: subscription headers are malformed.",
    );
    expect(JSON.stringify(row)).not.toContain("sk-live-123456");
    expect(JSON.stringify(row)).not.toContain("Unexpected token");

    // Same pass continued: the healthy row was still claimed and sent.
    expect(transport.calls).toHaveLength(1);
    const goodRow = getWebhookDeliveryById(goodDeliveryId)!;
    expect(goodRow.status).toBe("success");
    void subId;
  });

  it("9. stop/start lifetime: stop drains in-flight sends, the cleared interval makes no new claims, restart revives under a fresh generation", async () => {
    const subId = seedSubscription({});
    const firstDeliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 0, nextRetryAt: null });
    transport.plan = [{ ok: true, status: 200, body: "slow-ok", delayMs: 60 }];

    async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for: ${what}`);
    }

    // Real production path: the interval tick drives the pass.
    startRetryProcessor(50);
    await waitFor(() => transport.calls.length === 1, 5_000, "first tick send");

    // Stop while the slow send is still in flight: stop owns it — it resolves
    // only after the send settled AND its fenced outcome write landed.
    await stopRetryProcessor();
    expect(transport.calls).toHaveLength(1);
    const firstRow = getWebhookDeliveryById(firstDeliveryId)!;
    expect(firstRow.status).toBe("success");

    // Interval cleared: a newly due row is NOT claimed by any tick.
    const secondDeliveryId = seedDeliveryRow({ subscriptionId: subId, attempts: 0, nextRetryAt: null });
    await new Promise((r) => setTimeout(r, 300));
    expect(transport.calls).toHaveLength(1);
    let secondRow = getWebhookDeliveryById(secondDeliveryId)!;
    expect(secondRow.status).toBe("pending");
    expect(secondRow.attempts).toBe(0);

    // Restart: a fresh generation claims and delivers the waiting row.
    startRetryProcessor(50);
    await waitFor(() => getWebhookDeliveryById(secondDeliveryId)!.status === "success", 5_000, "restart send");
    expect(transport.calls).toHaveLength(2);
    secondRow = getWebhookDeliveryById(secondDeliveryId)!;
    expect(secondRow.status).toBe("success");
    await stopRetryProcessor();
  }, 15_000);

  it("inline dispatch authority: lease-at-insert refuses disabled subscriptions without creating a row", async () => {
    const enabledSubId = seedSubscription({});
    const disabledSubId = seedSubscription({ enabled: 0 });

    const created = createWebhookDeliveryRecord(
      enabledSubId,
      "webhook.delivery",
      "{}",
      "delivery-inline-1",
      { owner: "webhook-dispatch:delivery-inline-1", ttlMs: 60_000, now: T0 },
    );
    expect(created.created).toBe(true);
    const row = getWebhookDeliveryById("delivery-inline-1")!;
    expect(row.attempts).toBe(1); // initial reservation spent atomically at insert
    expect(row.leaseFence).toBe(created.fence);
    expect(row.leaseExpiresAt).not.toBeNull();

    const refused = createWebhookDeliveryRecord(
      disabledSubId,
      "webhook.delivery",
      "{}",
      "delivery-inline-2",
      { owner: "webhook-dispatch:delivery-inline-2", ttlMs: 60_000, now: T0 },
    );
    expect(refused.created).toBe(false);
    expect(getWebhookDeliveryById("delivery-inline-2")).toBeNull();
  });
});
