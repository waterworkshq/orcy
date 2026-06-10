import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as retentionRepo from "../repositories/notificationRetentionPolicy.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as notificationMigrationService from "../services/notificationMigrationService.js";
import * as clearanceService from "../services/notificationClearanceService.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function createEventDelivery(habitatId: string, userId: string) {
  const event = eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: "task-1",
    severity: "info",
    title: "Test",
    body: "Test body",
    createdByType: "system",
  });
  const delivery = deliveryRepo.createNotificationDelivery({
    eventId: event.id,
    habitatId,
    recipientType: "human",
    recipientId: userId,
    channels: ["in_app"],
  });
  return { event, delivery };
}

describe("notification route handlers (service layer)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("recipient isolation", () => {
    it("active inbox returns only own deliveries", () => {
      const habitat = setupHabitat();
      createEventDelivery(habitat.id, "user-1");
      createEventDelivery(habitat.id, "user-2");

      const user1 = deliveryRepo.getActiveInbox(habitat.id, "human", "user-1");
      expect(user1.total).toBe(1);
      expect(user1.deliveries[0].recipientId).toBe("user-1");
    });

    it("history returns own deliveries", () => {
      const habitat = setupHabitat();
      createEventDelivery(habitat.id, "user-1");
      createEventDelivery(habitat.id, "user-2");

      const user1 = deliveryRepo.getDeliveryHistory(habitat.id, "human", "user-1");
      expect(user1.total).toBe(1);
    });
  });

  describe("ack / snooze / clear", () => {
    it("acknowledges delivery", () => {
      const habitat = setupHabitat();
      const { delivery } = createEventDelivery(habitat.id, "user-1");

      const acked = deliveryRepo.acknowledgeDelivery(delivery.id);
      expect(acked.status).toBe("acknowledged");
      expect(acked.acknowledgedAt).not.toBeNull();
    });

    it("snoozes delivery", () => {
      const habitat = setupHabitat();
      const { delivery } = createEventDelivery(habitat.id, "user-1");
      const future = new Date(Date.now() + 3600000).toISOString();

      const snoozed = deliveryRepo.snoozeDelivery(delivery.id, future);
      expect(snoozed.status).toBe("snoozed");
      expect(snoozed.snoozedUntil).toBe(future);
    });

    it("clears own delivery", () => {
      const habitat = setupHabitat();
      const { delivery } = createEventDelivery(habitat.id, "user-1");

      const cleared = deliveryRepo.clearDelivery(delivery.id);
      expect(cleared.status).toBe("cleared");
    });
  });

  describe("subscription management", () => {
    it("getRecipientOverrides returns user subscriptions", () => {
      const habitat = setupHabitat();
      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "recipient_override",
        recipientType: "human",
        recipientId: "user-1",
        eventType: "task.assigned",
        channels: ["in_app"],
      });

      const overrides = subscriptionRepo.getRecipientOverrides(habitat.id, "human", "user-1");
      expect(overrides).toHaveLength(1);
      expect(overrides[0].eventType).toBe("task.assigned");
    });

    it("getHabitatDefaults returns habitat defaults", () => {
      const habitat = setupHabitat();
      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "task.assigned",
        channels: ["in_app"],
      });

      const defaults = subscriptionRepo.getHabitatDefaults(habitat.id);
      expect(defaults).toHaveLength(1);
    });

    it("getAllSubscriptionsByHabitat returns all", () => {
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
        eventType: "task.assigned",
      });

      const all = subscriptionRepo.getAllSubscriptionsByHabitat(habitat.id);
      expect(all).toHaveLength(2);
    });

    it("creates subscription via service", () => {
      const habitat = setupHabitat();
      const sub = subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "task.assigned",
        channels: ["in_app"],
        createdBy: "admin-1",
      });
      expect(sub.id).toBeDefined();
      expect(sub.scope).toBe("habitat_default");
    });

    it("updates subscription", () => {
      const habitat = setupHabitat();
      const sub = subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "task.assigned",
      });

      const updated = subscriptionRepo.updateSubscription(sub.id, {
        enabled: false,
        channels: ["webhook"],
      });
      expect(updated.enabled).toBe(false);
      expect(updated.channels).toEqual(["webhook"]);
    });

    it("deletes subscription", () => {
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
  });

  describe("retention policy", () => {
    it("getOrCreate creates default policy", () => {
      const habitat = setupHabitat();
      const policy = retentionRepo.getOrCreateRetentionPolicy(habitat.id);
      expect(policy.acknowledgedClearAfterDays).toBe(30);
      expect(policy.resolvedClearAfterDays).toBe(30);
      expect(policy.failedClearAfterDays).toBe(90);
    });

    it("upsert updates existing policy", () => {
      const habitat = setupHabitat();
      const policy = retentionRepo.getOrCreateRetentionPolicy(habitat.id);
      const updated = retentionRepo.upsertRetentionPolicy(habitat.id, {
        acknowledgedClearAfterDays: 7,
      });
      expect(updated.acknowledgedClearAfterDays).toBe(7);
      expect(updated.resolvedClearAfterDays).toBe(30);
    });
  });

  describe("admin clearance", () => {
    it("adminClearDeliveries clears by ID", () => {
      const habitat = setupHabitat();
      const { delivery } = createEventDelivery(habitat.id, "user-1");
      const result = clearanceService.adminClearDeliveries([delivery.id]);
      expect(result.cleared).toBe(1);
    });
  });

  describe("legacy migration", () => {
    it("migration service exports are importable", () => {
      expect(notificationMigrationService.migrateLegacyPreferences).toBeDefined();
      expect(notificationMigrationService.isLegacyMigrationComplete).toBeDefined();
      expect(notificationMigrationService.getMigrationTargetEvents).toBeDefined();
    });

    it("migration target events are correct", () => {
      const events = notificationMigrationService.getMigrationTargetEvents();
      expect(events).toContain("task.assigned");
      expect(events).toContain("task.review_requested");
    });
  });
});

describe("automation route handlers (service layer)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("lists rules by habitat", () => {
    const habitat = setupHabitat();
    ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "R1",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "user-1",
    });

    const list = ruleRepo.listAutomationRulesByHabitat(habitat.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("R1");
  });

  it("creates rule with validation-equivalent input", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "New Rule",
      trigger: { type: "event", eventType: "task.overdue" } as any,
      actions: [{ type: "create_signal", content: "Alert" }],
      createdBy: "user-1",
    });
    expect(rule.id).toBeDefined();
    expect(rule.name).toBe("New Rule");
  });

  it("updates rule", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Old Name",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });

    const updated = ruleRepo.updateAutomationRule(rule.id, { name: "New Name" });
    expect(updated.name).toBe("New Name");
  });

  it("deletes rule", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "To Delete",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });

    const deleted = ruleRepo.deleteAutomationRule(rule.id);
    expect(deleted).toBe(true);
    expect(ruleRepo.getAutomationRuleById(rule.id)).toBeNull();
  });

  it("enables and disables rule", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "Toggle",
      enabled: false,
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });

    const enabled = ruleRepo.setRuleEnabled(rule.id, true);
    expect(enabled.enabled).toBe(true);

    const disabled = ruleRepo.setRuleEnabled(rule.id, false);
    expect(disabled.enabled).toBe(false);
  });

  it("lists rule runs", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "R1",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });

    runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      triggerEventId: "evt-1",
    });
    runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
      triggerEventId: "evt-2",
    });

    const { runs, total } = runRepo.listRunsByRule(rule.id);
    expect(total).toBe(2);
    expect(runs).toHaveLength(2);
  });

  it("lists runs by habitat", () => {
    const habitat = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitat.id,
      name: "R1",
      trigger: { type: "event", eventType: "task.rejected" } as any,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "X" }],
      createdBy: "user-1",
    });
    runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const { total } = runRepo.listRunsByHabitat(habitat.id);
    expect(total).toBe(1);
  });
});
