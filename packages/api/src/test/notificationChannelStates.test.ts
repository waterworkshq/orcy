/**
 * Notification V2 — per-(delivery, channel, destination) unit state machine.
 *
 * The channel-state repository is the single delivery authority below the
 * worker: it freezes the unit plan once at committed delivery creation (every
 * producer path, including direct repository inserts), scans one three-shape
 * eligibility predicate (available | cooldown-due | claimed-with-expired-
 * lease), claims reservations atomically under a lease fence, records fenced
 * outcomes (stale fences write nothing), janitorializes expired claims, and
 * aggregates delivery completion only when every unit is terminal — never
 * overwriting a user action.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as boardRepo from "../repositories/habitat.js";
import * as webhookSubRepo from "../repositories/webhookSubscription.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { enqueueNotification } from "../services/notificationCommandService.js";
import {
  claimUnitForDispatch,
  getUnitById,
  getUnitsForDelivery,
  listDueUnits,
  recordFencedUnitOutcome,
  cancelNonTerminalUnitsForDelivery,
  aggregateDeliveryCompletionIfAllTerminal,
  terminalizeExpiredClaimedUnit,
  NOTIFICATION_LEASE_TTL_MS,
  NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION,
  NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE,
  NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED,
  type DueUnitRow,
} from "../repositories/notificationChannelState.js";
import {
  notificationDeliveryChannelStates,
  notificationDeliveries,
  webhookSubscriptions,
} from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";

const NOW = "2026-09-05T12:00:00.000Z";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "States Habitat" });
}

function createTestEvent(
  habitatId: string,
  eventType: eventRepo.CreateNotificationEventInput["eventType"] = "task.blocked",
) {
  return eventRepo.createNotificationEvent({
    habitatId,
    eventType,
    sourceType: "task",
    sourceId: "task-1",
    severity: "warning",
    title: "Task blocked",
    body: "The task is blocked",
    createdByType: "system",
  });
}

function addSubscription(input: Partial<webhookSubRepo.CreateWebhookSubscriptionRecordInput> & { id: string; habitatId: string | null }) {
  return webhookSubRepo.createWebhookSubscriptionRecord({
    name: input.name ?? `sub-${input.id}`,
    url: input.url ?? "https://dest.example.test/hook",
    secret: input.secret ?? "s3cret",
    events: input.events ?? [],
    headers: input.headers ?? {},
    format: input.format ?? "standard",
    ...input,
  });
}

function seedDeliveryUnitRow(input: {
  deliveryId: string;
  channelKey: string;
  baseChannel: string | null;
  state: string;
  nextEligibleAt?: string | null;
  leaseFence?: string | null;
  leaseExpiresAt?: string | null;
  reservationsUsed?: number;
}) {
  getDb()
    .insert(notificationDeliveryChannelStates)
    .values({
      id: `unit-${input.deliveryId.slice(0, 8)}-${input.channelKey}`,
      deliveryId: input.deliveryId,
      channelKey: input.channelKey,
      baseChannel: input.baseChannel,
      state: input.state,
      reservationsTotal: 3,
      reservationsUsed: input.reservationsUsed ?? 0,
      nextEligibleAt: input.nextEligibleAt ?? null,
      leaseOwner: input.state === "claimed" ? "seed-owner" : null,
      leaseFence: input.leaseFence ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
    })
    .run();
}

function claim(unitId: string, owner = "test-owner", now = NOW) {
  return claimUnitForDispatch({ unitId, owner, now, ttlMs: NOTIFICATION_LEASE_TTL_MS });
}

describe("freezeUnitPlan at committed delivery creation", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("freezes in_app as satisfied_at_enqueue and marks the delivery 'restored'", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app"],
    });

    expect(delivery.pushEpoch).toBe("restored");
    const units = getUnitsForDelivery(delivery.id);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      channelKey: "in_app",
      baseChannel: "in_app",
      state: "satisfied_at_enqueue",
    });
  });

  it("expands the webhook channel into one unit per habitat-exact authorized destination", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    const authorized = addSubscription({ id: "sub-authorized", habitatId: habitat.id, events: ["notification:task.blocked"] });
    const otherType = addSubscription({ id: "sub-other-type", habitatId: habitat.id, events: ["notification:task.assigned"] });
    const catchAll = addSubscription({ id: "sub-catchall", habitatId: habitat.id, events: [] });
    const globalOptIn = addSubscription({ id: "sub-global", habitatId: null, events: ["notification:task.blocked"] });
    const disabled = addSubscription({ id: "sub-disabled", habitatId: habitat.id, events: ["notification:task.blocked"] });
    getDb().update(webhookSubscriptions).set({ enabled: 0 }).where(eq(webhookSubscriptions.id, "sub-disabled")).run();

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app", "webhook", "slack", "discord"],
    });

    const units = getUnitsForDelivery(delivery.id);
    const keys = units.map((u) => u.channelKey).sort();
    expect(keys).toEqual(["discord", "in_app", "slack", `webhook:${authorized.id}`].sort());
    for (const unit of units) {
      if (unit.channelKey === "in_app") {
        expect(unit.state).toBe("satisfied_at_enqueue");
      } else {
        expect(unit.state).toBe("available");
        expect(unit.reservationsTotal).toBe(3);
      }
    }
    const webhookUnit = units.find((u) => u.channelKey === `webhook:${authorized.id}`)!;
    expect(webhookUnit.baseChannel).toBe("webhook");
    expect(webhookUnit.destinationId).toBe(authorized.id);
    // Explicit non-participants: other-type opt-in, empty catch-all, global
    // NULL-habitat opt-in, disabled subscription.
    expect(keys).not.toContain(`webhook:${otherType.id}`);
    expect(keys).not.toContain(`webhook:${catchAll.id}`);
    expect(keys).not.toContain(`webhook:${globalOptIn.id}`);
    expect(keys).not.toContain(`webhook:${disabled.id}`);
  });

  it("records an honest skipped unit when the webhook channel has no authorized destination", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    // Catch-all only — never a notification opt-in.
    addSubscription({ id: "sub-catchall", habitatId: habitat.id, events: [] });

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["webhook"],
    });

    const units = getUnitsForDelivery(delivery.id);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      channelKey: "webhook",
      baseChannel: "webhook",
      state: "skipped",
      disposition: NOTIFICATION_DISPOSITION_NO_AUTHORIZED_DESTINATION,
    });
  });

  it("freezes the unit plan for direct repository producers (digest-style insert)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription({ id: "sub-direct", habitatId: habitat.id, events: ["notification:task.blocked"] });

    // Direct repo insert — NOT the command service. Same freeze, same marker.
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["webhook"],
    });

    expect(delivery.pushEpoch).toBe("restored");
    expect(getUnitsForDelivery(delivery.id).map((u) => u.channelKey)).toEqual(["webhook:sub-direct"]);
  });

  it("is frozen once: a destination authorized after enqueue gains no unit", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["webhook"],
    });
    expect(getUnitsForDelivery(delivery.id)).toHaveLength(1); // no-destination skip

    addSubscription({ id: "sub-late", habitatId: habitat.id, events: ["notification:task.blocked"] });
    expect(getUnitsForDelivery(delivery.id)).toHaveLength(1);
    expect(listDueUnits(10, NOW).map((u) => u.unitId)).not.toContain(`webhook:sub-late`);
  });
});

describe("R2: creation-time availability completion", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("an in_app-only delivery aggregates to delivered with the availability receipt at creation", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app"],
    });
    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBe(delivery.createdAt);
    expect(row.pushEpoch).toBe("restored");
  });

  it("an empty-channel delivery aggregates to delivered with the availability receipt (no units = no push owed)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: [],
    });
    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBe(delivery.createdAt);
  });

  it("a mixed-channel delivery stays pending at creation (no premature flip)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription({ id: "sub-mixed", habitatId: habitat.id, events: ["notification:task.blocked"] });
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app", "webhook", "slack"],
    });
    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("pending");
    expect(row.deliveredAt).toBeNull();
  });

  it("the command-service enqueue path completes in-app-only deliveries (producer proof)", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.blocked",
      channels: ["in_app"],
    });
    const result = enqueueNotification({
      habitatId: habitat.id,
      eventType: "task.blocked",
      sourceType: "task",
      severity: "warning",
      createdByType: "system",
      explicitRecipients: [{ recipientType: "human", recipientId: "human-1" }],
    });
    expect(result.deliveries).toHaveLength(1);
    const row = deliveryRepo.getNotificationDeliveryById(result.deliveries[0].id)!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBe(result.deliveries[0].createdAt);
  });
});

describe("fixup3: createNotificationDelivery is one atomic transaction", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns the FINAL coherent row: in-app-only deliveries return 'delivered' (matching the DB), mixed stay pending", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription({ id: "sub-final", habitatId: habitat.id, events: ["notification:task.blocked"] });

    const inAppOnly = deliveryRepo.createNotificationDelivery({
      eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-1", channels: ["in_app"],
    });
    expect(inAppOnly.status).toBe("delivered");
    expect(inAppOnly.deliveredAt).toBe(inAppOnly.createdAt);
    expect(deliveryRepo.getNotificationDeliveryById(inAppOnly.id)).toEqual(inAppOnly); // no stale object

    const mixed = deliveryRepo.createNotificationDelivery({
      eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-1", channels: ["in_app", "webhook"],
    });
    expect(mixed.status).toBe("pending");
  });

  it("a throw mid-freeze rolls back the ENTIRE delivery + plan (direct repo producer, no outer tx)", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    addSubscription({ id: "sub-crash", habitatId: habitat.id, events: ["notification:task.blocked"] });

    const stateMod = await import("../repositories/notificationChannelState.js");
    const spy = vi.spyOn(stateMod, "freezeUnitPlanForDelivery").mockImplementation(() => {
      throw new Error("injected crash mid-freeze");
    });
    try {
      expect(() =>
        deliveryRepo.createNotificationDelivery({
          eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-1", channels: ["webhook"],
        }),
      ).toThrow();
    } finally {
      spy.mockRestore();
    }

    // The whole delivery is gone — no orphan row, no partial unit plan.
    expect(deliveryRepo.getDeliveriesByEvent(event.id)).toHaveLength(0);
    expect(getUnitsForDelivery.length).toBeTypeOf("number"); // helper exists
    expect(getDb().select().from(notificationDeliveryChannelStates).all()).toHaveLength(0);
  });

  it("a throw pre-aggregate (after freeze) also rolls back everything", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const stateMod = await import("../repositories/notificationChannelState.js");
    const spy = vi.spyOn(stateMod, "aggregateDeliveryCompletionIfAllTerminal").mockImplementation(() => {
      throw new Error("injected crash pre-aggregate");
    });
    try {
      expect(() =>
        deliveryRepo.createNotificationDelivery({
          eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-1", channels: ["in_app"],
        }),
      ).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(deliveryRepo.getDeliveriesByEvent(event.id)).toHaveLength(0);
    expect(getDb().select().from(notificationDeliveryChannelStates).all()).toHaveLength(0);
  });

  it("nested drizzle outer transaction: raw-BEGIN join used, creation discards with outer rollback (tx authority discriminator)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    // An outer RAW BEGIN (the withImmediateLifecycleTransaction shape):
    // drizzle cannot see it; the creation must join via savepoint.
    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    try {
      deliveryRepo.createNotificationDelivery({
        eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-n1", channels: ["in_app"],
      });
      // Visible inside the raw tx before commit.
      const inTx = db.select().from(notificationDeliveries).all();
      expect(inTx.some((r) => (r as { recipientId?: string }).recipientId === "human-n1")).toBe(true);
      db.run(sql`ROLLBACK`);
    } catch (err) {
      db.run(sql`ROLLBACK`);
      throw err;
    }

    // The whole creation (delivery + frozen units + receipt) vanished WITH
    // the outer rollback — the savepoint joined the outer transaction; the
    // creation never committed independently.
    expect(getDb().select().from(notificationDeliveries).all().some((r) => (r as { recipientId?: string }).recipientId === "human-n1")).toBe(false);
    expect(getDb().select().from(notificationDeliveryChannelStates).all()).toHaveLength(0);
  });

  it("nested drizzle outer transaction: same behavior through db.transaction nesting", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const db = getDb();
    expect(() =>
      db.transaction((tx) => {
        tx.insert(notificationDeliveries).values({ id: "outer-2", eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "h9", status: "pending", channels: [] }).run();
        deliveryRepo.createNotificationDelivery({
          eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-n2", channels: ["in_app"],
        });
        throw new Error("outer rollback");
      }),
    ).toThrow();
    const rows = db.select().from(notificationDeliveries).all();
    expect(rows.some((r) => (r as { recipientId?: string }).recipientId === "human-n2")).toBe(false);
    expect(getDb().select().from(notificationDeliveryChannelStates).all()).toHaveLength(0);
  });

  it("a nested outer-transaction rollback discards the whole creation (savepoint semantics)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    expect(() =>
      getDb().transaction((tx) => {
        tx.insert(notificationDeliveries).values({ id: "tx-probe", eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-1", status: "pending", channels: [] }).run();
        // Real creation INSIDE the outer tx (digest-style producer wrapping).
        deliveryRepo.createNotificationDelivery({
          eventId: event.id, habitatId: habitat.id, recipientType: "human", recipientId: "human-2", channels: ["in_app"],
        });
        throw new Error("outer rollback");
      }),
    ).toThrow();

    // Neither the probe nor the nested creation survived.
    expect(deliveryRepo.getNotificationDeliveryById("tx-probe")).toBeNull();
    const rows = getDb().select().from(notificationDeliveries).all();
    expect(rows.some((r) => (r as { recipientId?: string }).recipientId === "human-2")).toBe(false);
  });
});

describe("scanDueUnits — one scan, three eligible shapes", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  function setupDeliveryWithUnits() {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    // A real available `slack` unit keeps the delivery pending and
    // scannable (an empty plan now completes at creation as an availability
    // receipt and would leave the scan). Specific extra shapes are seeded
    // explicitly below with non-colliding keys.
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack"],
    });
    return { habitat, event, delivery };
  }

  it("selects available units and cooldown-due units, excludes not-yet-due cooldown and unexpired claims", () => {
    const { delivery } = setupDeliveryWithUnits();
    // The helper's own `slack` unit IS the available shape.
    expect(listDueUnits(20, NOW).map((u) => u.channelKey)).toContain("slack");

    const other = setupDeliveryWithUnits();
    // not-yet-due cooldown (slack-tomorrow — the helper's own slack stays the available shape)
    seedDeliveryUnitRow({ deliveryId: other.delivery.id, channelKey: "slack-tomorrow", baseChannel: "slack", state: "cooldown", nextEligibleAt: "2026-09-05T12:00:01.000Z" });
    // due cooldown
    seedDeliveryUnitRow({ deliveryId: other.delivery.id, channelKey: "discord", baseChannel: "discord", state: "cooldown", nextEligibleAt: "2026-09-05T11:59:59.000Z" });
    // NOTE: the helper's own slack unit for `other` is the available shape.
    seedDeliveryUnitRow({ deliveryId: other.delivery.id, channelKey: "webhook:w", baseChannel: "webhook", state: "claimed", leaseFence: "f1", leaseExpiresAt: "2026-09-05T12:30:00.000Z" });
    seedDeliveryUnitRow({ deliveryId: other.delivery.id, channelKey: "webhook:x", baseChannel: "webhook", state: "claimed", leaseFence: "f2", leaseExpiresAt: "2026-09-05T11:00:00.000Z" });

    const eligible = listDueUnits(20, NOW)
      .filter((u) => u.deliveryId === other.delivery.id)
      .map((u) => u.channelKey)
      .sort();
    // available slack + cooldown-due discord + expired claim webhook:x —
    // not the not-yet-due cooldown or the unexpired claim.
    expect(eligible).toEqual(["discord", "slack", "webhook:x"]);
  });

  it("never reselects terminal states or legacy-epoch deliveries", () => {
    const { delivery } = setupDeliveryWithUnits();
    for (const state of ["sent", "skipped", "exhausted", "cancelled", "backlog_not_attempted", "satisfied_at_enqueue"]) {
      seedDeliveryUnitRow({ deliveryId: delivery.id, channelKey: `slack-${state}`, baseChannel: "slack", state });
    }
    // Terminal states are never reselected; the helper's own available
    // `slack` unit remains the only selectable shape for this delivery.
    const selected = listDueUnits(20, NOW).filter((u) => u.deliveryId === delivery.id);
    expect(selected.map((u) => u.channelKey)).toEqual(["slack"]);

    // A unit whose delivery is legacy-epoch is never eligible even when available.
    getDb()
      .update(notificationDeliveries)
      .set({ pushEpoch: "legacy" })
      .where(eq(notificationDeliveries.id, delivery.id))
      .run();
    seedDeliveryUnitRow({ deliveryId: delivery.id, channelKey: "slack-legacy", baseChannel: "slack", state: "available" });
    expect(listDueUnits(20, NOW).filter((u) => u.deliveryId === delivery.id)).toEqual([]);
  });
});

describe("claimUnitForDispatch — atomic reservation spend", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  function availableUnit() {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack"],
    });
    const units = getUnitsForDelivery(delivery.id);
    const unit = units.find((u) => u.channelKey === "slack")!;
    return { delivery, unitId: unit.id };
  }

  it("claims an available unit, spending one reservation under a fresh fence", () => {
    const { unitId } = availableUnit();
    const claim1 = claim(unitId);
    expect(claim1.acquired).toBe(true);
    expect(claim1.fence).toBeTruthy();
    const unit = getUnitById(unitId)!;
    expect(unit.reservationsUsed).toBe(1);
    expect(unit.state).toBe("claimed");
    expect(unit.leaseFence).toBe(claim1.fence);
    expect(unit.leaseExpiresAt! > NOW).toBe(true); // ISO strings compare lexicographically
  });

  it("refuses a second claim while the lease is live and a not-yet-due cooldown", () => {
    const { unitId, delivery } = availableUnit();
    expect(claim(unitId).acquired).toBe(true);
    expect(claim(unitId, "other-owner").acquired).toBe(false);

    // Release into a future cooldown: not claimable until due.
    const fence = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!.leaseFence!;
    expect(
      recordFencedUnitOutcome({
        unitId,
        fence,
        outcome: "cooldown",
        nextEligibleAt: "2026-09-05T12:00:02.000Z",
        now: NOW,
      }),
    ).toBe(true);
    expect(claim(unitId).acquired).toBe(false);
  });

  it("resumes a claim after lease expiry and enforces the 3-reservation budget", () => {
    const { unitId, delivery } = availableUnit();

    // Reservation 1, abandoned owner, lease expired.
    expect(claim(unitId, "owner-1", "2026-09-05T10:00:00.000Z").acquired).toBe(true);
    // Reservation 2 (resume under a new fence).
    const claim2 = claim(unitId, "owner-2", "2026-09-05T11:00:00.000Z");
    expect(claim2.acquired).toBe(true);
    // Reservation 3 (second expiry resume).
    const claim3 = claim(unitId, "owner-3", "2026-09-05T11:59:00.000Z");
    expect(claim3.acquired).toBe(true);
    let unit = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!;
    expect(unit.reservationsUsed).toBe(3);

    // Budget exhausted: no fourth reservation even after expiry.
    expect(claim(unitId, "owner-4", "2026-09-05T13:00:00.000Z").acquired).toBe(false);

    // The janitor terminalizes the exhausted expired claim with the
    // unknown-outcome disposition.
    expect(
      terminalizeExpiredClaimedUnit({ unitId, state: "exhausted", disposition: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE, now: "2026-09-05T13:00:01.000Z" }),
    ).toBe(true);
    unit = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!;
    expect(unit.state).toBe("exhausted");
    expect(unit.disposition).toBe(NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE);
    expect(unit.leaseFence).toBeNull();
  });

  it("does not janitorialize an expired-claimed unit while the lease is still live", () => {
    const { unitId, delivery } = availableUnit();
    expect(claim(unitId).acquired).toBe(true);
    expect(
      terminalizeExpiredClaimedUnit({ unitId, state: "exhausted", disposition: NOTIFICATION_DISPOSITION_UNKNOWN_AFTER_LEASE, now: NOW }),
    ).toBe(false);
    const unit = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!;
    expect(unit.state).toBe("claimed");
  });
});

describe("recordFencedUnitOutcome — fenced terminal/cooldown writes", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  function claimedUnit() {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack"],
    });
    const unit = getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    const claimResult = claim(unit.id);
    return { delivery, unitId: unit.id, fence: claimResult.fence! };
  }

  it("terminalizes sent under the current fence and releases the lease", () => {
    const { unitId, delivery, fence } = claimedUnit();
    expect(recordFencedUnitOutcome({ unitId, fence, outcome: "sent", now: NOW })).toBe(true);
    const unit = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!;
    expect(unit.state).toBe("sent");
    expect(unit.leaseFence).toBeNull();
  });

  it("writes nothing for a stale fence", () => {
    const { unitId, delivery } = claimedUnit();
    expect(
      recordFencedUnitOutcome({ unitId, fence: "stale-fence", outcome: "sent", now: NOW }),
    ).toBe(false);
    const unit = getUnitsForDelivery(delivery.id).find((u) => u.id === unitId)!;
    expect(unit.state).toBe("claimed"); // untouched
  });

  it("terminalizes exhausted on the last reservation with the budget disposition", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack"],
    });
    const unitId = getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!.id;

    // Three sequential reservations: initial claim, then two lease-expired resumes.
    expect(claim(unitId, "owner-1", "2026-09-05T10:00:00.000Z").acquired).toBe(true);
    expect(claim(unitId, "owner-2", "2026-09-05T11:00:00.000Z").acquired).toBe(true);
    const last = claim(unitId, "owner-3", NOW);
    expect(last.acquired).toBe(true);
    const unit = getUnitById(unitId)!;
    expect(unit.reservationsUsed).toBe(3);
    expect(unit.leaseFence).toBe(last.fence);

    // A fenced FAILURE on the last reservation terminalizes with the budget
    // disposition (this is a recorded exhaustion, not an unknown outcome).
    expect(
      recordFencedUnitOutcome({
        unitId,
        fence: last.fence!,
        outcome: "exhausted",
        disposition: NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED,
        now: NOW,
      }),
    ).toBe(true);
    const after = getUnitById(unitId)!;
    expect(after.state).toBe("exhausted");
    expect(after.disposition).toBe(NOTIFICATION_DISPOSITION_BUDGET_EXHAUSTED);
  });
});

describe("user actions cancel pending units; aggregate completion coherence", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("cancels pending units on user action, terminal units untouched", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app", "slack", "discord"],
    });
    const units = getUnitsForDelivery(delivery.id);
    const slack = units.find((u) => u.channelKey === "slack")!;
    expect(recordFencedUnitOutcome({ unitId: slack.id, fence: (claim(slack.id).fence)!, outcome: "sent", now: NOW })).toBe(true);

    expect(cancelNonTerminalUnitsForDelivery(delivery.id, NOW)).toBeGreaterThan(0);
    const after = getUnitsForDelivery(delivery.id);
    const byKey = Object.fromEntries(after.map((u) => [u.channelKey, u.state]));
    expect(byKey["slack"]).toBe("sent"); // terminal survives
    expect(byKey["in_app"]).toBe("satisfied_at_enqueue"); // terminal survives
    expect(byKey["discord"]).toBe("cancelled");
  });

  it("flips pending→delivered when all units are terminal and any sent, with deliveredAt at transition time", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app", "slack"],
    });
    const slack = getUnitsForDelivery(delivery.id).find((u) => u.channelKey === "slack")!;
    recordFencedUnitOutcome({ unitId: slack.id, fence: claim(slack.id).fence!, outcome: "sent", now: NOW });

    expect(aggregateDeliveryCompletionIfAllTerminal(delivery.id, NOW)).toBe(true);
    const after = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).toBe(NOW);
  });

  it("uses createdAt as deliveredAt for an in-app-only satisfaction (availability receipt)", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app"],
    });
    // Creation itself completes the in-app-only delivery (R2): the aggregate
    // at the creation seam already landed the availability receipt.
    const after = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).toBe(delivery.createdAt);
    // A later explicit call is a no-op — the CAS only wins from pending.
    expect(aggregateDeliveryCompletionIfAllTerminal(delivery.id, NOW)).toBe(false);
  });

  it("flips pending→failed when all terminal and none sent; leaves non-terminal pending untouched; never overwrites user actions", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const failedDelivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack"],
    });
    const slack = getUnitsForDelivery(failedDelivery.id).find((u) => u.channelKey === "slack")!;
    recordFencedUnitOutcome({ unitId: slack.id, fence: claim(slack.id).fence!, outcome: "skipped", disposition: "no enabled slack integration", now: NOW });
    expect(aggregateDeliveryCompletionIfAllTerminal(failedDelivery.id, NOW)).toBe(true);
    expect(deliveryRepo.getNotificationDeliveryById(failedDelivery.id)!.status).toBe("failed");

    // Non-terminal snapshot: no flip.
    const openDelivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["slack", "discord"],
    });
    const d1 = getUnitsForDelivery(openDelivery.id).find((u) => u.channelKey === "slack")!;
    recordFencedUnitOutcome({ unitId: d1.id, fence: claim(d1.id).fence!, outcome: "sent", now: NOW });
    expect(aggregateDeliveryCompletionIfAllTerminal(openDelivery.id, NOW)).toBe(false);
    expect(deliveryRepo.getNotificationDeliveryById(openDelivery.id)!.status).toBe("pending");

    // User action wins the race: CAS only flips pending.
    const acked = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "human-1",
      channels: ["in_app"],
    });
    deliveryRepo.acknowledgeDelivery(acked.id);
    // All units terminal (in-app satisfied) but the delivery is no longer
    // pending: the CAS loses by design — no flip, no deliveredAt.
    expect(aggregateDeliveryCompletionIfAllTerminal(acked.id, NOW)).toBe(false);
    const ackedRow = deliveryRepo.getNotificationDeliveryById(acked.id)!;
    expect(ackedRow.status).toBe("acknowledged");
    // The availability receipt timestamp (createdAt) is truthful history and
    // survives the acknowledge; what the CAS guarantees is that the STATUS
    // was never overwritten.
    expect(ackedRow.deliveredAt).toBe(acked.createdAt);
  });
});
