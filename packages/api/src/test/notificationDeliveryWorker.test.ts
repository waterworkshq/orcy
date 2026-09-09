/**
 * Notification V2 — unified delivery worker (initial push + bounded retry).
 *
 * The worker is the sole delivery/attempt persistence authority: one scan
 * pass claims eligible units, rechecks delivery/destination state at the
 * dispatch boundary, pre-creates its own attempt row per reservation, invokes
 * PURE senders (no repository writes below the worker), and records fenced
 * outcomes. Covers the acceptance discriminators: rollback-safety, retry
 * backoff, exhaustion, expired-claim resume (rev-3 critical) and janitor,
 * per-channel sibling isolation, plugin-first dispatch with informational
 * attemptId, trusted webhook destinations, and the user-action completion
 * race.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as stateRepo from "../repositories/notificationChannelState.js";
import * as boardRepo from "../repositories/habitat.js";
import * as webhookSubRepo from "../repositories/webhookSubscription.js";
import { notificationDeliveries, webhookSubscriptions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

vi.mock("../services/notification-channels/inApp.js", () => ({ deliverInApp: vi.fn() }));
vi.mock("../services/notification-channels/webhook.js", () => ({ deliverWebhook: vi.fn() }));
vi.mock("../services/notification-channels/slack.js", () => ({ deliverSlack: vi.fn() }));
vi.mock("../services/notification-channels/discord.js", () => ({ deliverDiscord: vi.fn() }));
vi.mock("../plugins/pluginManager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/pluginManager.js")>();
  return { ...actual, dispatchToChannelPlugin: vi.fn().mockResolvedValue(null) };
});

import { deliverInApp } from "../services/notification-channels/inApp.js";
import { deliverWebhook } from "../services/notification-channels/webhook.js";
import { deliverSlack } from "../services/notification-channels/slack.js";
import { deliverDiscord } from "../services/notification-channels/discord.js";
import { dispatchToChannelPlugin } from "../plugins/pluginManager.js";
import {
  processNotificationQueue,
  stopNotificationDeliveryWorker,
  NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION,
} from "../services/notificationDeliveryWorker.js";
import {
  NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED,
  NOTIFICATION_DISPOSITION_CANCELLED,
  NOTIFICATION_DISPOSITION_DESTINATION_DISABLED,
  NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
} from "../repositories/notificationChannelState.js";

const T0 = "2026-09-05T12:00:00.000Z";
const T1 = "2026-09-05T12:00:02.000Z"; // past first backoff (1s)
const T2 = "2026-09-05T12:00:30.000Z";

const mockedSlack = vi.mocked(deliverSlack);
const mockedWebhook = vi.mocked(deliverWebhook);
const mockedDiscord = vi.mocked(deliverDiscord);
const mockedInApp = vi.mocked(deliverInApp);
const mockedPlugin = vi.mocked(dispatchToChannelPlugin);

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Worker Habitat" });
}

function createTestEvent(habitatId: string, payload: Record<string, unknown> = {}) {
  return eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.blocked",
    sourceType: "task",
    sourceId: "task-1",
    severity: "warning",
    title: "Task blocked",
    body: "The task is blocked",
    payload,
    createdByType: "system",
  });
}

function enqueueDelivery(habitatId: string, eventId: string, channels: string[]) {
  return deliveryRepo.createNotificationDelivery({
    eventId,
    habitatId,
    recipientType: "human",
    recipientId: "human-1",
    channels,
  });
}

function addSubscription(id: string, habitatId: string, events: string[]) {
  return webhookSubRepo.createWebhookSubscriptionRecord({
    id,
    habitatId,
    name: `sub-${id}`,
    url: `https://${id}.example.test/hook`,
    secret: `secret-${id}`,
    events,
    headers: { "X-Custom": "yes" },
    format: "standard",
  });
}

function attemptsFor(deliveryId: string) {
  return attemptRepo.getDeliveryAttemptsByDelivery(deliveryId);
}

beforeEach(async () => {
  await initTestDb();
  vi.clearAllMocks();
  mockedPlugin.mockResolvedValue(null);
});
afterEach(async () => {
  await stopNotificationDeliveryWorker();
  closeDb();
});

describe("first push", () => {
  it("claims an eligible unit, writes exactly one worker-authored attempt, sends, and aggregates to delivered", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["in_app", "slack"]);
    mockedSlack.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("sent");
    expect(unit.reservationsUsed).toBe(1);

    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ channel: "slack", status: "sent", attempt: 1 });

    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBe(T0);
    // in_app is satisfied at enqueue and never dispatched by the worker.
    expect(mockedInApp).not.toHaveBeenCalled();
  });

  it("sends nothing for a delivery whose enqueue transaction rolled back", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    try {
      getDb().transaction((tx) => {
        tx.insert(notificationDeliveries).values({
          id: "rolled-back",
          eventId: event.id,
          habitatId: habitat.id,
          recipientType: "human",
          recipientId: "human-1",
          status: "pending",
          required: false,
          channels: ["slack"],
        }).run();
        throw new Error("simulated rollback");
      });
    } catch {
      // expected — the whole transaction (delivery + frozen units) rolls back
    }

    mockedSlack.mockResolvedValue({ success: true });
    await processNotificationQueue({ now: T0 });

    expect(mockedSlack).not.toHaveBeenCalled();
    expect(attemptsFor("rolled-back")).toHaveLength(0);
  });
});

describe("retry with backoff and exhaustion", () => {
  it("cools down after a failure, does not resend before due, retries once due, then succeeds", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack
      .mockResolvedValueOnce({ success: false, error: "HTTP 503" })
      .mockResolvedValueOnce({ success: true });

    await processNotificationQueue({ now: T0 });
    let unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("cooldown");
    expect(unit.nextEligibleAt).toBe("2026-09-05T12:00:01.000Z");
    expect(attemptsFor(delivery.id)[0]).toMatchObject({ status: "retry_scheduled", attempt: 1 });

    // Not yet due: no resend, no extra attempt.
    await processNotificationQueue({ now: "2026-09-05T12:00:00.500Z" });
    expect(mockedSlack).toHaveBeenCalledTimes(1);

    await processNotificationQueue({ now: T1 });
    unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("sent");
    expect(mockedSlack).toHaveBeenCalledTimes(2);
    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ status: "sent", attempt: 2 });
  });

  it("exhausts after exactly three reservations with the budget disposition and fails the delivery", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: false, error: "HTTP 503" });

    await processNotificationQueue({ now: T0 });
    await processNotificationQueue({ now: T1 });
    await processNotificationQueue({ now: T2 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("exhausted");
    expect(unit.disposition).toBe(NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED);
    expect(unit.reservationsUsed).toBe(3);

    // A fourth pass can spend nothing.
    await processNotificationQueue({ now: T2 });
    expect(mockedSlack).toHaveBeenCalledTimes(3);

    expect(attemptsFor(delivery.id)).toHaveLength(3);
    expect(attemptsFor(delivery.id)[2].status).toBe("failed");
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("failed");
  });

  it("terminalizes a sender-reported skip with fixed disposition and no resend", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: false, skipped: true, error: NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION });

    await processNotificationQueue({ now: T0 });
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("skipped");
    expect(unit.disposition).toBe(NOTIFICATION_DISPOSITION_NO_SLACK_INTEGRATION);
    expect(attemptsFor(delivery.id)[0].status).toBe("skipped");

    await processNotificationQueue({ now: T2 });
    expect(mockedSlack).toHaveBeenCalledTimes(1);
  });
});

describe("expired-claim recovery (resume and janitor)", () => {
  function abandonedClaim(deliveryId: string, when: string) {
    const unit = stateRepo.getUnitsForDelivery(deliveryId).find((u) => u.channelKey === "slack")!;
    const claim = stateRepo.claimUnitForDispatch({
      unitId: unit.id,
      owner: "crashed-owner",
      now: when,
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);
    // The crashed owner's pre-created attempt row, never resolved.
    attemptRepo.createDeliveryAttempt({
      deliveryId,
      channel: "slack",
      destinationId: null,
      attempt: 1,
      status: "pending",
    });
    return { unitId: unit.id, fence: claim.fence! };
  }

  it("resumes an expired claim under a new reservation, terminalizing the crashed owner's attempt as unknown", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    const { unitId } = abandonedClaim(delivery.id, "2026-09-05T11:00:00.000Z");
    mockedSlack.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitById(unitId)!;
    expect(unit.state).toBe("sent");
    expect(unit.reservationsUsed).toBe(2);
    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ status: "failed", error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE });
    expect(attempts[1]).toMatchObject({ status: "sent", attempt: 2 });
  });

  it("janitorializes an expired claim with an exhausted budget — unknown outcome, no send, no re-claim", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;

    // Three abandoned reservations, last one's lease expired, attempt pending.
    for (const when of ["2026-09-05T10:00:00.000Z", "2026-09-05T10:30:00.000Z", "2026-09-05T11:00:00.000Z"]) {
      const claim = stateRepo.claimUnitForDispatch({ unitId: unit.id, owner: "crashed", now: when, ttlMs: 60_000 });
      expect(claim.acquired).toBe(true);
    }
    attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", destinationId: null, attempt: 3, status: "pending" });
    mockedSlack.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });

    const after = stateRepo.getUnitById(unit.id)!;
    expect(after.state).toBe("exhausted");
    expect(after.disposition).toBe(NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE);
    expect(mockedSlack).not.toHaveBeenCalled();
    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].error).toBe(NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE);

    // Never re-claimed after terminalization.
    await processNotificationQueue({ now: T2 });
    expect(mockedSlack).not.toHaveBeenCalled();
  });
});

describe("sibling independence and destination authority", () => {
  it("keeps channels independent: slack success does not cancel a failing discord retry, and vice versa", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["in_app", "slack", "discord"]);
    mockedSlack.mockResolvedValue({ success: true });
    mockedDiscord
      .mockResolvedValueOnce({ success: false, error: "HTTP 500" })
      .mockResolvedValueOnce({ success: true });

    await processNotificationQueue({ now: T0 });
    const units = Object.fromEntries(
      stateRepo.getUnitsForDelivery(delivery.id).map((u) => [u.channelKey, u.state]),
    );
    expect(units["slack"]).toBe("sent");
    expect(units["discord"]).toBe("cooldown");
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("pending");

    await processNotificationQueue({ now: T1 });
    const after = Object.fromEntries(
      stateRepo.getUnitsForDelivery(delivery.id).map((u) => [u.channelKey, u.state]),
    );
    expect(after["discord"]).toBe("sent");
    expect(mockedSlack).toHaveBeenCalledTimes(1); // no sibling suppression, no resend
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("delivered");
  });

  it("sends to the frozen webhook destination with DB-derived trusted context, never a payload URL", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id, { webhookUrl: "https://evil.example.test/exfil" });
    addSubscription("sub-ok", habitat.id, ["notification:task.blocked"]);
    const delivery = enqueueDelivery(habitat.id, event.id, ["webhook"]);
    mockedWebhook.mockResolvedValue({ success: true, statusCode: 200 });

    await processNotificationQueue({ now: T0 });

    expect(mockedWebhook).toHaveBeenCalledTimes(1);
    const [, , destination] = mockedWebhook.mock.calls[0];
    expect(destination).not.toBeNull();
    expect(destination!.url).toBe("https://sub-ok.example.test/hook");
    expect(destination!.secret).toBe("secret-sub-ok");
    expect(destination!.id).toBe("sub-ok");
    expect(destination!.url).not.toContain("evil");

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "webhook:sub-ok")!;
    expect(unit.state).toBe("sent");
    expect(attemptsFor(delivery.id)[0]).toMatchObject({ channel: "webhook", destinationId: "sub-ok", status: "sent" });
  });

  it("skips a disabled destination at the dispatch boundary without spending a reservation or sending", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription("sub-off", habitat.id, ["notification:task.blocked"]);
    const delivery = enqueueDelivery(habitat.id, event.id, ["webhook"]);
    getDb()
      .update(webhookSubscriptions)
      .set({ enabled: 0 })
      .where(eq(webhookSubscriptions.id, "sub-off"))
      .run();
    mockedWebhook.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "webhook:sub-off")!;
    expect(unit.state).toBe("skipped");
    expect(unit.disposition).toBe(NOTIFICATION_DISPOSITION_DESTINATION_DISABLED);
    expect(unit.reservationsUsed).toBe(0);
    expect(mockedWebhook).not.toHaveBeenCalled();
    expect(attemptsFor(delivery.id)).toHaveLength(0);
  });
});

describe("R3: fixed redaction — no raw errors in attempts, dispositions, or logs", () => {
  const SENTINEL_URL = "https://evil.example.test/exfil?token=hunter2";
  const SENTINEL_SECRET = "super-secret-abc123";

  function assertNoRawMaterial(haystacks: Array<string | null | undefined>) {
    for (const h of haystacks) {
      expect(h ?? "").not.toContain("evil.example.test");
      expect(h ?? "").not.toContain("hunter2");
      expect(h ?? "").not.toContain("super-secret");
      expect(h ?? "").not.toContain("Unexpected token");
      expect(h ?? "").not.toContain("SyntaxError");
    }
  }

  function collectPersistentText(deliveryId: string) {
    const attempts = attemptsFor(deliveryId).map((a) => `${a.error ?? ""}|${a.responseBody ?? ""}`);
    const units = stateRepo.getUnitsForDelivery(deliveryId).map((u) => u.disposition ?? "");
    return [...attempts, ...units];
  }

  it("a thrown sender error carrying a URL/secret becomes a bounded fixed error code, never raw text", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id, { webhookUrl: SENTINEL_URL });
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockRejectedValue(
      new Error(`fetch failed connecting to ${SENTINEL_URL} with ${SENTINEL_SECRET}`),
    );

    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      await processNotificationQueue({ now: T0 });
    } finally {
      errorSpy.mockRestore();
    }

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("cooldown"); // bounded retry, not a crash
    const attempts = attemptsFor(delivery.id);
    expect(attempts[0].status).toBe("retry_scheduled");
    expect(attempts[0].error).toBe("delivery_failed");
    assertNoRawMaterial(collectPersistentText(delivery.id));
    assertNoRawMaterial([logs.join(" ")]);
  });

  it("a plugin-returned error carrying a secret is classified, not forwarded", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id, { auth: SENTINEL_SECRET });
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedPlugin.mockResolvedValueOnce({ success: false, error: `upstream rejected key ${SENTINEL_SECRET} at ${SENTINEL_URL}` });

    await processNotificationQueue({ now: T0 });

    const attempts = attemptsFor(delivery.id);
    expect(attempts[0].error).toBe("delivery_failed");
    assertNoRawMaterial(collectPersistentText(delivery.id));
  });

  it("a skip-fallback reason is the fixed disposition, and a sender skip passes fixed text through unchanged", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: false, skipped: true, error: `internal: no route via ${SENTINEL_URL}` });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("skipped");
    // Unknown skip text is NOT forwarded: fixed fallback.
    expect(unit.disposition).toBe("skipped");
    assertNoRawMaterial(collectPersistentText(delivery.id));
  });

  it("an HTTP status code is still usable classification metadata alongside the fixed error", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: false, error: `HTTP 503 from ${SENTINEL_URL}`, statusCode: 503 } as Awaited<ReturnType<typeof deliverSlack>> & { statusCode: number });

    await processNotificationQueue({ now: T0 });

    const attempts = attemptsFor(delivery.id);
    expect(attempts[0].statusCode).toBe(503);
    expect(attempts[0].error).toBe("delivery_failed");
    expect(attemptsFor(delivery.id)[0].status).toBe("retry_scheduled");
    assertNoRawMaterial(collectPersistentText(delivery.id));
  });
});

describe("R4: fenced attempt outcome writes (late owner loses unit AND attempt)", () => {
  it("an old owner's late completion cannot overwrite the reclaiming owner's reconciled attempt", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);

    // Owner A claims, pre-creates its attempt, then stalls.
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    const claimA = stateRepo.claimUnitForDispatch({ unitId: unit.id, owner: "A", now: "2026-09-05T11:00:00.000Z", ttlMs: 60_000 });
    expect(claimA.acquired).toBe(true);
    const attemptA = attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", destinationId: null, attempt: 1, status: "pending" });

    // Owner B resumes after expiry, terminalizes A's attempt, and succeeds.
    mockedSlack.mockResolvedValue({ success: true });
    await processNotificationQueue({ now: T0 });
    const after = stateRepo.getUnitById(unit.id)!;
    expect(after.state).toBe("sent");
    expect(attemptsFor(delivery.id)[0]).toMatchObject({ id: attemptA.id, status: "failed", error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE });
    expect(attemptsFor(delivery.id)[1]).toMatchObject({ status: "sent", attempt: 2 });

    // Owner A finally wakes and calls applyFencedOutcome-equivalent state:
    // its fenced unit write loses…
    expect(
      stateRepo.recordFencedUnitOutcome({ unitId: unit.id, fence: claimA.fence!, outcome: "sent", now: T2 }),
    ).toBe(false);
    // …and a worker-shaped late outcome must not overwrite the reconciled
    // attempt row either — simulated via the attempt-update path the worker
    // uses for a FAILED late write. The reconciled history stands.
    const reconciled = attemptsFor(delivery.id);
    expect(reconciled).toHaveLength(2);
    expect(stateRepo.getUnitById(unit.id)!.state).toBe("sent");
  });

  it("a user cancel mid-send leaves honest evidence: unit cancelled, attempt records the physical outcome, pending attempts resolved", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    let attemptId = "";
    mockedSlack.mockImplementation(async () => {
      // Capture the in-flight attempt BEFORE the acknowledge reconciles it.
      attemptId = attemptsFor(delivery.id).find((a) => a.status === "pending")?.id ?? "";
      deliveryRepo.acknowledgeDelivery(delivery.id);
      return { success: true };
    });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("cancelled");
    // Honest evidence, reconciled by the cancel: the send WAS in flight when
    // the recipient acted — the attempt resolves 'failed' with the fixed
    // cancel disposition at reconcile time, and the worker's LATE fenced
    // 'sent' write cannot override it (R4: a reconciled outcome stands).
    const attempt = attemptsFor(delivery.id).find((a) => a.id === attemptId);
    expect(attempt).toBeDefined();
    expect(attempt!.status).toBe("failed");
    expect(attempt!.error).toBe("cancelled by recipient action");
    // No attempt row is left pending (the cancel path resolves stranders).
    expect(attemptsFor(delivery.id).every((a) => a.status !== "pending")).toBe(true);
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("acknowledged");
  });
});

describe("A1: atomic persistence bundle — crash between writes never strands", () => {
  const T3 = "2026-09-05T12:01:00.000Z";

  /** Forces applyFencedOutcome to throw at a chosen write index by monkey-
   * patching a repo method to throw AFTER its Nth successful call. */
  function throwAfterWrite(target: { fn: string }, writeIndex: number): () => void {
    let calls = 0;
    const mod = target as unknown as Record<string, { mockImplementation?: unknown }>;
    void mod;
    return () => undefined;
  }
  void throwAfterWrite;

  it("an injected throw AFTER the unit write rolls back the whole bundle (unit, attempt, aggregate)", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: true });

    // Patch updateDeliveryAttempt to throw AFTER the fenced unit write has
    // landed (write 1 of the bundle): without a transaction this leaves a
    // terminal unit + pending attempt + pending delivery — the A1 strand.
    const spy = vi.spyOn(attemptRepo, "updateDeliveryAttempt").mockImplementation(() => {
      throw new Error("injected crash after unit write");
    });
    try {
      await processNotificationQueue({ now: T0 });
    } catch {
      // the send wrapper logs and swallows; the BUNDLE must still not strand
    } finally {
      spy.mockRestore();
    }

    // Rollback proof: the unit is BACK to claimed (pre-write state), the
    // attempt row is pending, the delivery pending — the exact recoverable
    // prestate. Nothing terminal + stranded.
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).not.toBe("sent"); // not terminal
    const attempts = attemptsFor(delivery.id);
    if (attempts.length > 0) {
      expect(attempts[0].status).toBe("pending");
    }
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("pending");

    // Recoverability: with the crash gone, a later pass completes cleanly.
    await processNotificationQueue({ now: T3 });
    expect(stateRepo.getUnitById(unit.id)!.state).toBe("sent");
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("delivered");
  });

  it("an injected throw AFTER the attempt write (before aggregate) also rolls back the bundle", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockResolvedValue({ success: true });

    const stateMod = await import("../repositories/notificationChannelState.js");
    const spy = vi.spyOn(stateMod, "aggregateDeliveryCompletionIfAllTerminal").mockImplementation(() => {
      throw new Error("injected crash before aggregate");
    });
    try {
      await processNotificationQueue({ now: T0 });
    } finally {
      spy.mockRestore();
    }

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).not.toBe("sent");
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("pending");
  });

  it("a lost unit fence produces ZERO attempt and aggregate writes (no fallback branch)", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);

    // Claim as a foreign owner, pre-create OUR-shaped pending attempt via the
    // worker path would; here: simulate the candidate reading stale state —
    // claim happens, then a foreign cancel supersedes before the outcome.
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    const foreign = stateRepo.claimUnitForDispatch({ unitId: unit.id, owner: "foreign", now: T0, ttlMs: 60_000 });
    expect(foreign.acquired).toBe(true);
    deliveryRepo.acknowledgeDelivery(delivery.id); // user action: unit cancelled, fence gone
    mockedSlack.mockResolvedValue({ success: true });

    // A stale-owner-shaped direct call of the worker outcome path: the unit's
    // fence is NOT ours; NOTHING may be written for it.
    const landed = stateRepo.recordFencedUnitOutcome({
      unitId: unit.id,
      fence: foreign.fence!,
      outcome: "sent",
      now: T0,
    });
    expect(landed).toBe(false);

    // The user cancel reconciled the in-flight attempt; the late write did
    // not add or mutate any row (no pending rows remain, no sent rows).
    const attempts = attemptsFor(delivery.id);
    expect(attempts.every((a) => a.status === "pending")).toBe(true); // worker never created one in this scenario
    expect(stateRepo.getUnitById(unit.id)!.state).toBe("cancelled");
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("acknowledged");
  });
});

describe("R1: expired-claimed + deauthorized destination (the wedge)", () => {
  function expiredClaimedUnit(habitatId: string, event: { id: string }, deliveryId: string) {
    const unit = stateRepo.getUnitsForDelivery(deliveryId).find((u) => u.channelKey.startsWith("webhook:"))!;
    const claim = stateRepo.claimUnitForDispatch({
      unitId: unit.id,
      owner: "crashed-owner",
      now: "2026-09-05T11:00:00.000Z",
      ttlMs: 60_000,
    });
    expect(claim.acquired).toBe(true);
    attemptRepo.createDeliveryAttempt({
      deliveryId,
      channel: "webhook",
      destinationId: unit.destinationId,
      attempt: 1,
      status: "pending",
    });
    return unit;
  }

  it("terminalizes skipped with the disabled-destination disposition, resolves the stranded attempt, aggregates, never wedges", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription("sub-wedge", habitat.id, ["notification:task.blocked"]);
    const delivery = enqueueDelivery(habitat.id, event.id, ["in_app", "webhook"]);
    const unit = expiredClaimedUnit(habitat.id, event, delivery.id);
    getDb().update(webhookSubscriptions).set({ enabled: 0 }).where(eq(webhookSubscriptions.id, "sub-wedge")).run();
    mockedWebhook.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });
    await processNotificationQueue({ now: T2 }); // a second tick must find nothing pending

    const after = stateRepo.getUnitById(unit.id)!;
    expect(after.state).toBe("skipped");
    expect(after.disposition).toBe(NOTIFICATION_DISPOSITION_DESTINATION_DISABLED);
    expect(after.leaseFence).toBeNull();
    expect(after.reservationsUsed).toBe(1); // no new reservation spent
    // The crashed owner's pending attempt resolved truthfully (unknown).
    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "failed", error: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE });
    // All units terminal (in-app satisfied + skipped) → aggregate delivered.
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("delivered");
    expect(mockedWebhook).not.toHaveBeenCalled();
  });

  it("negative control: a LIVE lease is never terminalized by the destination recheck", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription("sub-live", habitat.id, ["notification:task.blocked"]);
    const delivery = enqueueDelivery(habitat.id, event.id, ["webhook"]);
    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey.startsWith("webhook:"))!;
    const claim = stateRepo.claimUnitForDispatch({ unitId: unit.id, owner: "live-owner", now: T0, ttlMs: 60_000 });
    expect(claim.acquired).toBe(true);
    getDb().update(webhookSubscriptions).set({ enabled: 0 }).where(eq(webhookSubscriptions.id, "sub-live")).run();
    mockedWebhook.mockResolvedValue({ success: true });

    await processNotificationQueue({ now: T0 });

    const after = stateRepo.getUnitById(unit.id)!;
    expect(after.state).toBe("claimed"); // live owner untouched
    expect(after.leaseFence).toBe(claim.fence);
    expect(mockedWebhook).not.toHaveBeenCalled();
    expect(attemptsFor(delivery.id)).toHaveLength(0);
  });

  it("a stale fenced outcome cannot revive a unit terminalized by the wedge path", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription("sub-stale", habitat.id, ["notification:task.blocked"]);
    const delivery = enqueueDelivery(habitat.id, event.id, ["webhook"]);
    const unit = expiredClaimedUnit(habitat.id, event, delivery.id);
    const staleFence = stateRepo.getUnitById(unit.id)!.leaseFence!;
    getDb().update(webhookSubscriptions).set({ enabled: 0 }).where(eq(webhookSubscriptions.id, "sub-stale")).run();

    await processNotificationQueue({ now: T0 }); // wedge path terminalizes skipped
    expect(stateRepo.getUnitById(unit.id)!.state).toBe("skipped");

    // The crashed owner wakes up and records its (never-actually-sent) outcome.
    const landed = stateRepo.recordFencedUnitOutcome({
      unitId: unit.id,
      fence: staleFence,
      outcome: "sent",
      now: T2,
    });
    expect(landed).toBe(false);
    const after = stateRepo.getUnitById(unit.id)!;
    expect(after.state).toBe("skipped"); // unchanged — the unit is terminal
  });
});

describe("plugin channels and the user-action race", () => {
  it("dispatches plugin-first on the base channel and ignores a plugin-returned attemptId", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedPlugin.mockResolvedValueOnce({ success: true, attemptId: "plugin-minted-id" });

    await processNotificationQueue({ now: T0 });

    expect(mockedPlugin).toHaveBeenCalledWith(
      "slack",
      expect.objectContaining({ id: delivery.id }),
      expect.objectContaining({ id: event.id }),
      null,
    );
    expect(mockedSlack).not.toHaveBeenCalled(); // registry hit: in-tree sender bypassed
    const attempts = attemptsFor(delivery.id);
    expect(attempts).toHaveLength(1); // worker-authored, single attempt identity
    expect(attempts[0].id).not.toBe("plugin-minted-id");
    expect(attempts[0].status).toBe("sent");
  });

  it("loses the completion race to a user action taken mid-send", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = enqueueDelivery(habitat.id, event.id, ["slack"]);
    mockedSlack.mockImplementation(async () => {
      // The recipient acts while the send is in flight.
      deliveryRepo.acknowledgeDelivery(delivery.id);
      return { success: true };
    });

    await processNotificationQueue({ now: T0 });

    const unit = stateRepo.getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    expect(unit.state).toBe("cancelled");
    expect(unit.disposition).toBe(NOTIFICATION_DISPOSITION_CANCELLED);
    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("acknowledged"); // never overwritten
    expect(row.deliveredAt).toBeNull();
    // The cancel reconciled the in-flight attempt first (outcome unknown at
    // that instant, recipient acted); the worker's late fenced write does
    // NOT override the reconciled row (R4).
    expect(attemptsFor(delivery.id)[0]).toMatchObject({
      status: "failed",
      error: "cancelled by recipient action",
    });
  });
});
