import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import * as digestRepo from "../repositories/notificationDigest.js";
import * as boardRepo from "../repositories/board.js";
import { habitats, notificationEvents, notificationDeliveries } from "../db/schema/index.js";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Test Habitat" });
}

function createTestEvent(
  habitatId: string,
  overrides?: Partial<eventRepo.CreateNotificationEventInput>,
) {
  return eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: "task-1",
    severity: "info",
    title: "Task assigned",
    body: "You have been assigned a task",
    createdByType: "system",
    ...overrides,
  });
}

describe("notificationEvent repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a notification event", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    expect(event.id).toBeDefined();
    expect(event.habitatId).toBe(habitat.id);
    expect(event.eventType).toBe("task.assigned");
    expect(event.sourceType).toBe("task");
    expect(event.severity).toBe("info");

    const fetched = eventRepo.getNotificationEventById(event.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(event.id);
  });

  it("lists events by habitat", () => {
    const h1 = setupHabitat();
    const h2 = setupHabitat();
    createTestEvent(h1.id);
    createTestEvent(h1.id);
    createTestEvent(h2.id);

    const { events, total } = eventRepo.listNotificationEventsByHabitat(h1.id);
    expect(total).toBe(2);
    expect(events).toHaveLength(2);
  });

  it("filters events by type", () => {
    const habitat = setupHabitat();
    createTestEvent(habitat.id, { eventType: "task.assigned" });
    createTestEvent(habitat.id, { eventType: "task.blocked" });

    const { events, total } = eventRepo.listNotificationEventsByHabitat(habitat.id, {
      eventType: "task.blocked",
    });
    expect(total).toBe(1);
    expect(events[0].eventType).toBe("task.blocked");
  });

  it("filters events by source", () => {
    const habitat = setupHabitat();
    createTestEvent(habitat.id, { sourceType: "task", sourceId: "t1" });
    createTestEvent(habitat.id, { sourceType: "mission", sourceId: "m1" });

    const { events, total } = eventRepo.listNotificationEventsByHabitat(habitat.id, {
      sourceType: "task",
      sourceId: "t1",
    });
    expect(total).toBe(1);
    expect(events[0].sourceId).toBe("t1");
  });

  it("gets events by source type and id", () => {
    const habitat = setupHabitat();
    createTestEvent(habitat.id, { sourceType: "task", sourceId: "t1" });
    createTestEvent(habitat.id, { sourceType: "task", sourceId: "t2" });

    const events = eventRepo.getNotificationEventsBySource("task", "t1");
    expect(events).toHaveLength(1);
    expect(events[0].sourceId).toBe("t1");
  });

  it("updates history summary", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    const summary = { clearedCount: 5, lastClearedAt: "2026-01-01T00:00:00Z" };
    eventRepo.updateEventHistorySummary(event.id, summary);

    const updated = eventRepo.getNotificationEventById(event.id);
    expect(updated!.historySummary).toEqual(summary);
  });

  it("returns null for non-existent event", () => {
    expect(eventRepo.getNotificationEventById("nonexistent")).toBeNull();
  });
});

describe("notificationDelivery repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    expect(delivery.id).toBeDefined();
    expect(delivery.status).toBe("pending");
    expect(delivery.required).toBe(false);
    expect(delivery.recipientType).toBe("human");

    const fetched = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(delivery.id);
  });

  it("persists required flag", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "agent",
      recipientId: "agent-1",
      required: true,
      channels: ["in_app", "slack"],
    });

    expect(delivery.required).toBe(true);
    expect(delivery.channels).toEqual(["in_app", "slack"]);
  });

  it("gets active inbox for recipient", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: e2.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const { deliveries, total } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    expect(total).toBe(2);
    expect(deliveries).toHaveLength(2);
  });

  it("active inbox excludes cleared deliveries", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const d1 = deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: e2.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    deliveryRepo.clearDelivery(d1.id);

    const { deliveries, total } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    expect(total).toBe(1);
    expect(deliveries[0].id).not.toBe(d1.id);
  });

  it("active inbox excludes muted deliveries", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const d1 = deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: e2.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    deliveryRepo.muteDelivery(d1.id);

    const { total } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    expect(total).toBe(1);
  });

  it("delivery history includes all statuses", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const d1 = deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: e2.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    deliveryRepo.clearDelivery(d1.id);

    const { total } = deliveryRepo.getDeliveryHistory(habitat.id, "human", "user-1");
    expect(total).toBe(2);
  });

  it("acknowledges a delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const acked = deliveryRepo.acknowledgeDelivery(delivery.id);
    expect(acked.status).toBe("acknowledged");
    expect(acked.acknowledgedAt).not.toBeNull();
  });

  it("snoozes a delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const until = "2026-12-31T23:59:59Z";
    const snoozed = deliveryRepo.snoozeDelivery(delivery.id, until);
    expect(snoozed.status).toBe("snoozed");
    expect(snoozed.snoozedUntil).toBe(until);
  });

  it("mutes a delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const muted = deliveryRepo.muteDelivery(delivery.id);
    expect(muted.status).toBe("muted");
    expect(muted.mutedAt).not.toBeNull();
  });

  it("marks delivery as delivered", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const delivered = deliveryRepo.markDeliveryDelivered(delivery.id);
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).not.toBeNull();
  });

  it("clears a delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const cleared = deliveryRepo.clearDelivery(delivery.id);
    expect(cleared.status).toBe("cleared");
    expect(cleared.clearedAt).not.toBeNull();
  });

  it("finds clearance candidates", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const now = new Date().toISOString();

    const d1 = deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      clearAfter: "2020-01-01T00:00:00Z",
    });
    deliveryRepo.acknowledgeDelivery(d1.id);

    const d2 = deliveryRepo.createNotificationDelivery({
      eventId: e2.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      clearAfter: "2099-01-01T00:00:00Z",
    });
    deliveryRepo.acknowledgeDelivery(d2.id);

    const candidates = deliveryRepo.getClearanceCandidates(
      habitat.id,
      ["acknowledged"],
      "2026-01-01T00:00:00Z",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(d1.id);
  });

  it("gets deliveries by event", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "agent",
      recipientId: "agent-1",
    });

    const deliveries = deliveryRepo.getDeliveriesByEvent(event.id);
    expect(deliveries).toHaveLength(2);
  });

  it("separates inbox by recipient", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });
    deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-2",
    });

    const { total: t1 } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
    const { total: t2 } = deliveryRepo.getActiveInbox(habitat.id, "human", "user-2");
    expect(t1).toBe(1);
    expect(t2).toBe(1);
  });
});

describe("notificationDeliveryAttempt repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and retrieves an attempt", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const attempt = attemptRepo.createDeliveryAttempt({
      deliveryId: delivery.id,
      channel: "in_app",
      status: "sent",
      attempt: 1,
    });

    expect(attempt.id).toBeDefined();
    expect(attempt.channel).toBe("in_app");
    expect(attempt.status).toBe("sent");
    expect(attempt.attempt).toBe(1);

    const fetched = attemptRepo.getDeliveryAttemptById(attempt.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(attempt.id);
  });

  it("lists attempts by delivery", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "in_app", attempt: 1 });
    attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", attempt: 2 });

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts).toHaveLength(2);
  });

  it("updates attempt status to failed with error", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const attempt = attemptRepo.createDeliveryAttempt({
      deliveryId: delivery.id,
      channel: "webhook",
      attempt: 1,
    });

    const updated = attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "failed",
      error: "Connection refused",
      statusCode: 500,
      finishedAt: new Date().toISOString(),
    });

    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("Connection refused");
    expect(updated.statusCode).toBe(500);
    expect(updated.finishedAt).not.toBeNull();
  });

  it("schedules retry for attempt", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const attempt = attemptRepo.createDeliveryAttempt({
      deliveryId: delivery.id,
      channel: "slack",
      attempt: 1,
    });

    const retryAt = "2026-01-02T00:00:00Z";
    const updated = attemptRepo.updateDeliveryAttempt(attempt.id, {
      status: "retry_scheduled",
      nextRetryAt: retryAt,
    });

    expect(updated.status).toBe("retry_scheduled");
    expect(updated.nextRetryAt).toBe(retryAt);
  });

  it("finds retry candidates", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const a1 = attemptRepo.createDeliveryAttempt({
      deliveryId: delivery.id,
      channel: "slack",
      attempt: 1,
    });
    attemptRepo.updateDeliveryAttempt(a1.id, {
      status: "retry_scheduled",
      nextRetryAt: "2020-01-01T00:00:00Z",
    });

    const a2 = attemptRepo.createDeliveryAttempt({
      deliveryId: delivery.id,
      channel: "slack",
      attempt: 2,
    });
    attemptRepo.updateDeliveryAttempt(a2.id, {
      status: "retry_scheduled",
      nextRetryAt: "2099-01-01T00:00:00Z",
    });

    const candidates = attemptRepo.getRetryCandidates(
      "slack",
      "retry_scheduled",
      "2026-06-01T00:00:00Z",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(a1.id);
  });
});

describe("notificationSubscription repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates a habitat default subscription", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
      channels: ["in_app"],
      cadence: "immediate",
    });

    expect(sub.id).toBeDefined();
    expect(sub.scope).toBe("habitat_default");
    expect(sub.eventType).toBe("task.assigned");
    expect(sub.enabled).toBe(true);
    expect(sub.required).toBe(false);
  });

  it("creates a recipient override subscription", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "daily",
      timezone: "America/New_York",
      localSendTime: "09:00",
    });

    expect(sub.scope).toBe("recipient_override");
    expect(sub.recipientType).toBe("human");
    expect(sub.recipientId).toBe("user-1");
    expect(sub.cadence).toBe("daily");
    expect(sub.timezone).toBe("America/New_York");
    expect(sub.localSendTime).toBe("09:00");
  });

  it("gets habitat defaults by event type", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
      channels: ["in_app"],
    });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.blocked",
      channels: ["in_app", "slack"],
    });

    const defaults = subscriptionRepo.getHabitatDefaults(habitat.id, "task.assigned");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].eventType).toBe("task.assigned");
  });

  it("gets all enabled habitat defaults", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
    });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.blocked",
    });

    const defaults = subscriptionRepo.getHabitatDefaults(habitat.id);
    expect(defaults).toHaveLength(2);
  });

  it("excludes disabled defaults", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
    });
    subscriptionRepo.updateSubscription(sub.id, { enabled: false });

    const defaults = subscriptionRepo.getHabitatDefaults(habitat.id);
    expect(defaults).toHaveLength(0);
  });

  it("gets recipient overrides", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.assigned",
      cadence: "weekly",
    });

    const overrides = subscriptionRepo.getRecipientOverrides(habitat.id, "human", "user-1");
    expect(overrides).toHaveLength(1);
    expect(overrides[0].cadence).toBe("weekly");
  });

  it("updates subscription fields", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
      channels: ["in_app"],
    });

    const updated = subscriptionRepo.updateSubscription(sub.id, {
      channels: ["in_app", "slack"],
      cadence: "daily",
      muteUntil: "2026-12-31T00:00:00Z",
    });

    expect(updated.channels).toEqual(["in_app", "slack"]);
    expect(updated.cadence).toBe("daily");
    expect(updated.muteUntil).toBe("2026-12-31T00:00:00Z");
  });

  it("deletes a subscription", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
    });

    const deleted = subscriptionRepo.deleteSubscription(sub.id);
    expect(deleted).toBe(true);
    expect(subscriptionRepo.getSubscriptionById(sub.id)).toBeNull();
  });

  it("gets all subscriptions by habitat", () => {
    const habitat = setupHabitat();
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
    });
    subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "recipient_override",
      recipientType: "human",
      recipientId: "user-1",
      eventType: "task.blocked",
    });

    const all = subscriptionRepo.getAllSubscriptionsByHabitat(habitat.id);
    expect(all).toHaveLength(2);
  });

  it("required flag persists on habitat default", () => {
    const habitat = setupHabitat();
    const sub = subscriptionRepo.createSubscription({
      habitatId: habitat.id,
      scope: "habitat_default",
      eventType: "task.assigned",
      required: true,
    });

    const fetched = subscriptionRepo.getSubscriptionById(sub.id);
    expect(fetched!.required).toBe(true);
  });
});

describe("notificationRetentionPolicy repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a retention policy", () => {
    const habitat = setupHabitat();
    const policy = retentionRepo.createRetentionPolicy({ habitatId: habitat.id });

    expect(policy.id).toBeDefined();
    expect(policy.habitatId).toBe(habitat.id);
    expect(policy.acknowledgedClearAfterDays).toBe(30);
    expect(policy.resolvedClearAfterDays).toBe(30);
    expect(policy.failedClearAfterDays).toBe(90);
    expect(policy.historySummaryRetentionDays).toBeNull();

    const fetched = retentionRepo.getRetentionPolicyById(policy.id);
    expect(fetched).not.toBeNull();
  });

  it("gets policy by habitat", () => {
    const habitat = setupHabitat();
    retentionRepo.createRetentionPolicy({ habitatId: habitat.id });

    const policy = retentionRepo.getRetentionPolicyByHabitat(habitat.id);
    expect(policy).not.toBeNull();
    expect(policy!.habitatId).toBe(habitat.id);
  });

  it("getOrCreate returns existing if present", () => {
    const habitat = setupHabitat();
    const p1 = retentionRepo.createRetentionPolicy({
      habitatId: habitat.id,
      failedClearAfterDays: 60,
    });
    const p2 = retentionRepo.getOrCreateRetentionPolicy(habitat.id);

    expect(p2.id).toBe(p1.id);
    expect(p2.failedClearAfterDays).toBe(60);
  });

  it("getOrCreate creates with defaults if missing", () => {
    const habitat = setupHabitat();
    const policy = retentionRepo.getOrCreateRetentionPolicy(habitat.id);

    expect(policy).toBeDefined();
    expect(policy.acknowledgedClearAfterDays).toBe(30);
  });

  it("updates retention policy fields", () => {
    const habitat = setupHabitat();
    const policy = retentionRepo.createRetentionPolicy({ habitatId: habitat.id });

    const updated = retentionRepo.updateRetentionPolicy(policy.id, {
      acknowledgedClearAfterDays: 14,
      failedClearAfterDays: 180,
      historySummaryRetentionDays: 365,
      updatedBy: "admin-1",
    });

    expect(updated.acknowledgedClearAfterDays).toBe(14);
    expect(updated.failedClearAfterDays).toBe(180);
    expect(updated.historySummaryRetentionDays).toBe(365);
    expect(updated.updatedBy).toBe("admin-1");
  });

  it("upserts retention policy", () => {
    const habitat = setupHabitat();
    const p1 = retentionRepo.upsertRetentionPolicy(habitat.id, {
      acknowledgedClearAfterDays: 7,
    });
    expect(p1.acknowledgedClearAfterDays).toBe(7);

    const p2 = retentionRepo.upsertRetentionPolicy(habitat.id, {
      acknowledgedClearAfterDays: 14,
    });
    expect(p2.id).toBe(p1.id);
    expect(p2.acknowledgedClearAfterDays).toBe(14);
  });

  it("returns null for non-existent habitat policy", () => {
    expect(retentionRepo.getRetentionPolicyByHabitat("nonexistent")).toBeNull();
  });
});

describe("notificationDigest repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and retrieves a digest item", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id, { eventType: "digest.ready" });

    const item = digestRepo.createDigestItem({
      digestEventId: e2.id,
      includedEventId: e1.id,
    });

    expect(item.id).toBeDefined();
    expect(item.digestEventId).toBe(e2.id);
    expect(item.includedEventId).toBe(e1.id);
    expect(item.includedDeliveryId).toBeNull();

    const fetched = digestRepo.getDigestItemById(item.id);
    expect(fetched).not.toBeNull();
  });

  it("creates digest item with delivery link", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id, { eventType: "digest.ready" });
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: e1.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    const item = digestRepo.createDigestItem({
      digestEventId: e2.id,
      includedEventId: e1.id,
      includedDeliveryId: delivery.id,
    });

    expect(item.includedDeliveryId).toBe(delivery.id);
  });

  it("lists items by digest event", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const digest = createTestEvent(habitat.id, { eventType: "digest.ready" });

    digestRepo.createDigestItem({ digestEventId: digest.id, includedEventId: e1.id });
    digestRepo.createDigestItem({ digestEventId: digest.id, includedEventId: e2.id });

    const items = digestRepo.getDigestItemsByDigestEvent(digest.id);
    expect(items).toHaveLength(2);
  });

  it("lists items by included event", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const d1 = createTestEvent(habitat.id, { eventType: "digest.ready" });
    const d2 = createTestEvent(habitat.id, { eventType: "digest.ready" });

    digestRepo.createDigestItem({ digestEventId: d1.id, includedEventId: e1.id });
    digestRepo.createDigestItem({ digestEventId: d2.id, includedEventId: e1.id });

    const items = digestRepo.getDigestItemsByIncludedEvent(e1.id);
    expect(items).toHaveLength(2);
  });

  it("batch creates digest items", () => {
    const habitat = setupHabitat();
    const e1 = createTestEvent(habitat.id);
    const e2 = createTestEvent(habitat.id);
    const digest = createTestEvent(habitat.id, { eventType: "digest.ready" });

    const items = digestRepo.createDigestItems([
      { digestEventId: digest.id, includedEventId: e1.id },
      { digestEventId: digest.id, includedEventId: e2.id },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].includedEventId).toBe(e1.id);
    expect(items[1].includedEventId).toBe(e2.id);
  });
});

describe("notification compact history flow", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("preserves history summary before clearance", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id, {
      sourceType: "task",
      sourceId: "task-42",
      title: "Task blocked",
      body: "Dependency not resolved",
    });

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
    });

    deliveryRepo.acknowledgeDelivery(delivery.id);

    const summary = {
      originalTitle: event.title,
      originalBody: event.body,
      acknowledgedAt: delivery.acknowledgedAt,
      clearedAt: new Date().toISOString(),
    };
    eventRepo.updateEventHistorySummary(event.id, summary);
    deliveryRepo.clearDelivery(delivery.id);

    const fetchedEvent = eventRepo.getNotificationEventById(event.id);
    expect(fetchedEvent!.historySummary).toEqual(summary);

    const fetchedDelivery = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(fetchedDelivery!.status).toBe("cleared");
  });

  it("full lifecycle: create -> deliver -> ack -> clear", () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);

    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "agent",
      recipientId: "agent-1",
      channels: ["in_app"],
    });

    expect(delivery.status).toBe("pending");

    const delivered = deliveryRepo.markDeliveryDelivered(delivery.id);
    expect(delivered.status).toBe("delivered");

    const acked = deliveryRepo.acknowledgeDelivery(delivery.id);
    expect(acked.status).toBe("acknowledged");

    const cleared = deliveryRepo.clearDelivery(delivery.id);
    expect(cleared.status).toBe("cleared");

    const { total } = deliveryRepo.getActiveInbox(habitat.id, "agent", "agent-1");
    expect(total).toBe(0);
  });
});
