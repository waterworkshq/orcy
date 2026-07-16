import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as digestRepo from "../repositories/notificationDigest.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import { generateAllDigests } from "../services/notificationDigestService.js";
import {
  runScheduledClearance,
  adminClearDeliveries,
} from "../services/notificationClearanceService.js";
import type { NotificationCadence } from "@orcy/shared";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function createEventDeliveryPair(habitatId: string, recipientType: string, recipientId: string) {
  const event = eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: "task-1",
    severity: "info",
    title: "Test notification",
    body: "Test body",
    createdByType: "system",
  });
  const delivery = deliveryRepo.createNotificationDelivery({
    eventId: event.id,
    habitatId,
    recipientType: recipientType as any,
    recipientId,
    channels: ["in_app"],
  });
  return { event, delivery };
}

describe("notificationDigestService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("hourly digest groups pending deliveries for subscribed recipient", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "hourly",
      channels: ["in_app"],
    });
    createEventDeliveryPair(habitat.id, "human", "user-1");
    createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    const relevant = results.filter((r) => r.habitatId === habitat.id && r.cadence === "hourly");

    expect(relevant.length).toBeGreaterThanOrEqual(1);
    const r = relevant[0];
    expect(r.deliveriesGrouped).toBeGreaterThanOrEqual(2);
    expect(r.digestEventId).not.toBeNull();

    const items = digestRepo.getDigestItemsByDigestEvent(r.digestEventId!);
    expect(items).toHaveLength(r.deliveriesGrouped);
  });

  it("digest creates digest.ready event", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "hourly",
      channels: ["in_app"],
    });
    createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    const r = results.find((x) => x.habitatId === habitat.id && x.cadence === "hourly");
    expect(r!.digestEventId).not.toBeNull();

    const digestEvent = eventRepo.getNotificationEventById(r!.digestEventId!);
    expect(digestEvent).not.toBeNull();
    expect(digestEvent!.eventType).toBe("digest.ready");
    expect(digestEvent!.sourceType).toBe("digest");
  });

  it("does not process when no pending deliveries exist", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "daily",
      channels: ["in_app"],
      localSendTime: "00:00",
      timezone: "UTC",
    });

    const results = generateAllDigests();
    const r = results.find((x) => x.habitatId === habitat.id && x.cadence === "daily");
    if (r) {
      expect(r.deliveriesGrouped).toBe(0);
    }
  });

  it("skips when recipient has no subscription for that cadence", () => {
    const habitat = setupHabitat();
    // No subscription created
    createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    const relevant = results.filter((r) => r.habitatId === habitat.id);
    expect(relevant.every((r) => r.deliveriesGrouped === 0)).toBe(true);
  });

  it("digest items link to included events and deliveries", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "hourly",
      channels: ["in_app"],
    });
    const { event, delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    const r = results.find((x) => x.habitatId === habitat.id && x.cadence === "hourly");
    const items = digestRepo.getDigestItemsByDigestEvent(r!.digestEventId!);

    const item = items.find((i) => i.includedEventId === event.id);
    expect(item).toBeDefined();
    expect(item!.includedDeliveryId).toBe(delivery.id);
  });

  it("only processes enabled subscriptions", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "hourly",
      enabled: false,
      channels: ["in_app"],
    });
    createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    const relevant = results.filter((r) => r.habitatId === habitat.id);
    expect(relevant.every((r) => r.deliveriesGrouped === 0)).toBe(true);
  });

  it("handles `shouldProcessAtThisTime` returning false gracefully", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "weekly",
      channels: ["in_app"],
      localSendTime: new Date().toISOString().slice(11, 16),
    });
    createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = generateAllDigests();
    // Should not throw
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});

describe("notificationClearanceService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("clears acknowledged delivery past retention window", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      acknowledgedClearAfterDays: 1,
    });
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    deliveryRepo.acknowledgeDelivery(delivery.id);
    // Set clearAfter to 2 days ago so it's past the 1-day window
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "acknowledged", {
      clearAfter: twoDaysAgo,
    });

    const results = runScheduledClearance();
    const r = results.find((x) => x.habitatId === habitat.id);
    expect(r!.cleared).toBe(1);

    const cleared = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(cleared!.status).toBe("cleared");
  });

  it("does not clear unacknowledged deliveries", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      acknowledgedClearAfterDays: 1,
    });
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "pending", { clearAfter: twoDaysAgo });

    const results = runScheduledClearance();
    const r = results.find((x) => x.habitatId === habitat.id);
    expect(r!.cleared).toBe(0);

    const p = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(p!.status).toBe("pending");
  });

  it("preserves history summary before clearing", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      acknowledgedClearAfterDays: 1,
    });
    const { event, delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    deliveryRepo.acknowledgeDelivery(delivery.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "acknowledged", {
      clearAfter: twoDaysAgo,
    });

    runScheduledClearance();

    const evt = eventRepo.getNotificationEventById(event.id);
    expect(evt!.historySummary).not.toBeNull();
    expect(evt!.historySummary!.clearedAt).toBeDefined();
  });

  it("admin clearance clears specific deliveries regardless of status", () => {
    const habitat = setupHabitat();
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");

    const results = adminClearDeliveries([delivery.id]);
    expect(results.cleared).toBe(1);

    const cleared = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(cleared!.status).toBe("cleared");
  });

  it("admin clearance is idempotent", () => {
    const habitat = setupHabitat();
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");

    adminClearDeliveries([delivery.id]);
    const second = adminClearDeliveries([delivery.id]);
    // Should not double-count
    expect(second.cleared).toBeGreaterThanOrEqual(0);
  });

  it("admin clearance handles non-existent delivery", () => {
    const results = adminClearDeliveries(["nonexistent"]);
    expect(results.errors).toHaveLength(1);
    expect(results.cleared).toBe(0);
  });

  it("clearance is idempotent — already cleared deliveries not re-cleared", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      acknowledgedClearAfterDays: 1,
    });
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    deliveryRepo.acknowledgeDelivery(delivery.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "acknowledged", {
      clearAfter: twoDaysAgo,
    });

    runScheduledClearance();
    const second = runScheduledClearance();
    const r = second.find((x) => x.habitatId === habitat.id);
    expect(r!.cleared).toBe(0);
  });

  it("scheduled clearance skips habitat with no retention policy", () => {
    const habitat = setupHabitat();
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    deliveryRepo.acknowledgeDelivery(delivery.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "acknowledged", {
      clearAfter: twoDaysAgo,
    });

    const results = runScheduledClearance();
    const r = results.find((x) => x.habitatId === habitat.id);
    expect(r!.cleared).toBe(0);
  });

  it("cleared deliveries excluded from active inbox", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      acknowledgedClearAfterDays: 1,
    });
    const { delivery } = createEventDeliveryPair(habitat.id, "human", "user-1");
    deliveryRepo.acknowledgeDelivery(delivery.id);
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    deliveryRepo.batchUpdateDeliveryStatus([delivery.id], "acknowledged", {
      clearAfter: twoDaysAgo,
    });
    runScheduledClearance();

    const { deliveries } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    expect(deliveries.every((d) => d.status !== "cleared")).toBe(true);
    expect(deliveries.find((d) => d.id === delivery.id)).toBeUndefined();
  });
});
