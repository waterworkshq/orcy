import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { deliverNotification } from "../services/notificationDeliveryService.js";
import type { NotificationEvent, NotificationDelivery, NotificationChannel } from "@orcy/shared";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function createTestEvent(habitatId: string): NotificationEvent {
  return eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    sourceId: "task-1",
    severity: "info",
    title: "Test notification",
    body: "This is a test notification for channel delivery",
    createdByType: "system",
  });
}

function createTestDelivery(
  habitatId: string,
  eventId: string,
  channels: NotificationChannel[],
): NotificationDelivery {
  subscriptionRepo.createSubscription({
    habitatId,
    scope: "habitat_default",
    eventType: "task.assigned",
    channels,
  });

  return deliveryRepo.createNotificationDelivery({
    eventId,
    habitatId,
    recipientType: "human",
    recipientId: "user-1",
    channels,
  });
}

describe("notification channels - in_app", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("delivers in-app and creates attempt record", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("in_app");
    expect(result.results[0].success).toBe(true);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].channel).toBe("in_app");
    expect(attempts[0].status).toBe("sent");

    const updated = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(updated!.status).toBe("delivered");
  });
});

describe("notification channels - webhook", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("fails when no webhook URL is configured", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["webhook"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results[0].channel).toBe("webhook");
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("webhook URL");
  });
});

describe("notification channels - slack", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("skips when no Slack integration exists", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["slack"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results[0].channel).toBe("slack");
    expect(result.results[0].success).toBe(false);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("skipped");
    expect(attempts[0].error).toContain("No enabled Slack");
  });
});

describe("notification channels - discord", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("skips when no Discord integration exists", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["discord"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results[0].channel).toBe("discord");
    expect(result.results[0].success).toBe(false);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("skipped");
    expect(attempts[0].error).toContain("No enabled Discord");
  });
});

describe("notificationDeliveryService dispatcher", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("returns empty results for non-existent delivery", async () => {
    const result = await deliverNotification("nonexistent");
    expect(result.results).toEqual([]);
  });

  it("dispatches to all channels in delivery", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app", "slack", "discord"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.channel).sort()).toEqual(["discord", "in_app", "slack"]);
  });

  it("in_app succeeds while external channels skip when absent", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app", "slack"]);

    const result = await deliverNotification(delivery.id);

    const inAppResult = result.results.find((r) => r.channel === "in_app")!;
    expect(inAppResult.success).toBe(true);

    const slackResult = result.results.find((r) => r.channel === "slack")!;
    expect(slackResult.success).toBe(false);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts).toHaveLength(2);
    const appAttempt = attempts.find((a) => a.channel === "in_app")!;
    expect(appAttempt.status).toBe("sent");
    const slackAttempt = attempts.find((a) => a.channel === "slack")!;
    expect(slackAttempt.status).toBe("skipped");
  });

  it("records distinct error for each failed channel", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["webhook", "slack"]);

    const result = await deliverNotification(delivery.id);

    for (const r of result.results) {
      expect(r.success).toBe(false);
      expect(r.error).toBeDefined();
    }
  });
});

describe("attempt status transitions", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("records skipped status with reason", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["slack"]);

    await deliverNotification(delivery.id);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts[0].status).toBe("skipped");
    expect(attempts[0].error).toContain("No enabled Slack");
  });

  it("records sent status for in-app", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app"]);

    await deliverNotification(delivery.id);

    const attempts = attemptRepo.getDeliveryAttemptsByDelivery(delivery.id);
    expect(attempts[0].status).toBe("sent");
  });
});

describe("delivery status after channel dispatch", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("marks delivery as delivered after in_app", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app"]);

    await deliverNotification(delivery.id);

    const updated = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(updated!.status).toBe("delivered");
    expect(updated!.deliveredAt).not.toBeNull();
  });

  it("does NOT mark delivery as delivered when channel fails", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["slack"]);

    await deliverNotification(delivery.id);

    const updated = deliveryRepo.getNotificationDeliveryById(delivery.id);
    // Delivery status only changes to "delivered" from in-app channel
    expect(updated!.status).toBe("pending");
  });
});
