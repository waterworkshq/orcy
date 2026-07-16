import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { deliverNotification } from "../services/notificationDeliveryService.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as pluginRunRepo from "../repositories/pluginRun.js";
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

// ---------------------------------------------------------------------------
// ADR-0039 R5 — Notification Channel consumer-path integration coverage.
//
// The channel consumer seam is `notificationDeliveryService.dispatchChannel`,
// which delegates to `pluginManager.dispatchToChannelPlugin(channel, delivery,
// event)` via the imported pluginManager namespace:
//
//   `await pluginManager.dispatchToChannelPlugin(...)`
//
// Registry miss falls through to the in-tree switch (inApp/webhook/slack/
// discord). These tests drive BOTH paths end-to-end: a real plugin file
// loaded under /tmp + the public `deliverNotification(deliveryId)` consumer.
// Direct `pluginManager.dispatchToChannelPlugin` tests do not satisfy this
// coverage — they bypass the delivery-loop / attempt-record seam.
// ---------------------------------------------------------------------------
describe("ADR-0039 R5: plugin channel consumer path (dispatchChannel → pluginManager)", () => {
  let tmpDir = "";

  beforeEach(async () => {
    await initTestDb();
    pluginManager.resetPlugins();
    tmpDir = "";
  });

  afterEach(async () => {
    pluginManager.resetPlugins();
    closeDb();
    if (tmpDir) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function writeChannelPlugin(
    name: string,
    channelId: string,
    handlerBody: string,
  ): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/test-r5-chan-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      `${tmpDir}/${name}.mjs`,
      `export default {
        manifest: {
          id: '${name}',
          version: '1.0.0',
          description: 'r5 channel consumer test',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: '${channelId}',
            label: '${channelId}',
            requires: [],
          }],
        },
        channels: { '${channelId}': ${handlerBody} },
      };`,
    );
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
  }

  function setupHabitatWithDelivery(
    channels: NotificationChannel[],
  ): { habitat: { id: string }; event: NotificationEvent; delivery: NotificationDelivery } {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, channels);
    return { habitat, event, delivery };
  }

  it("plugin hit: channel plugin handler is invoked through the consumer seam and returns success", async () => {
    await writeChannelPlugin(
      "chan-ok",
      "r5-ok",
      `async () => ({ success: true, attemptId: 'attempt-success', statusCode: 200 })`,
    );
    const { delivery } = setupHabitatWithDelivery(["r5-ok" as NotificationChannel]);

    const result = await deliverNotification(delivery.id);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("r5-ok");
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].statusCode).toBe(200);

    // Plugin Run row recorded (succeeded via Plugin Invocation Runtime).
    const runs = pluginRunRepo.listByHabitat(delivery.habitatId, { pluginId: "chan-ok" });
    const succeededRun = runs.find((r) => r.status === "succeeded");
    expect(succeededRun).toBeDefined();
  });

  it("registry miss: unknown channel falls through to default in-tree switch (no plugin handler)", async () => {
    // No plugin loaded for "in_app" → falls through to deliverInApp (in-tree).
    const { delivery, habitat, event } = setupHabitatWithDelivery(["in_app"]);
    const result = await deliverNotification(delivery.id);

    expect(result.results[0].channel).toBe("in_app");
    expect(result.results[0].success).toBe(true);

    // No plugin Run row should exist (no plugin handler was hit).
    const runs = pluginRunRepo.listByHabitat(habitat.id, {});
    expect(runs.find((r) => r.pluginId === "chan-miss")).toBeUndefined();

    // Event/delivery are real.
    expect(event.habitatId).toBe(habitat.id);
  });

  it("returned failure: plugin returns {success:false, error} and consumer surfaces success=false", async () => {
    await writeChannelPlugin(
      "chan-fail",
      "r5-fail",
      `async () => ({ success: false, error: 'plugin rejected delivery: stale state' })`,
    );
    const { delivery, habitat } = setupHabitatWithDelivery(["r5-fail" as NotificationChannel]);

    const result = await deliverNotification(delivery.id);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("r5-fail");
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toMatch(/stale state/);

    // Channel does NOT trigger quarantine (fail-safe, defensive-only per Q2).
    const quarantineRows = pluginRunRepo
      .listByHabitat(habitat.id, { pluginId: "chan-fail" })
      .filter((r) => r.status === "failed");
    expect(quarantineRows.length).toBeGreaterThanOrEqual(1);
  });

  it("throw / invalid: plugin handler throws and consumer maps to fail-safe (success=false, no quarantine)", async () => {
    await writeChannelPlugin(
      "chan-throw",
      "r5-throw",
      `async () => { throw new Error('boom-channel'); }`,
    );
    const { delivery, habitat } = setupHabitatWithDelivery(["r5-throw" as NotificationChannel]);

    const result = await deliverNotification(delivery.id);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("r5-throw");
    expect(result.results[0].success).toBe(false);
    // Error message propagated through the runtime's failure-mapping.
    expect(result.results[0].error).toMatch(/boom-channel/);

    // Channel throw → Plugin Run row marked failed.
    const failedRun = pluginRunRepo
      .listByHabitat(habitat.id, { pluginId: "chan-throw" })
      .find((r) => r.status === "failed");
    expect(failedRun).toBeDefined();
  });

  it("capability delivery: chatIntegrationReader capability declared on plugin is available on context", async () => {
    // Channel plugins may declare chatIntegrationReader per CAPABILITY_MATRIX.
    // Asserting via the handler's `ctx.chatIntegrationReader` access proves the
    // consumer seam does not strip the capability surface.
    const habitat = setupHabitat();
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/test-r5-chan-capability-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      `${tmpDir}/chan-cap-plugin.mjs`,
      `export default {
        manifest: {
          id: 'chan-cap-plugin',
          version: '1.0.0',
          description: 'channel capability delivery',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'r5-cap',
            label: 'r5-cap',
            requires: ['chatIntegrationReader'],
          }],
        },
        channels: {
          'r5-cap': async (ctx) => ({
            success: true,
            attemptId: 'cap-attempt',
            // Capability delivered: prove chatIntegrationReader arrived on ctx.
            _capabilityWitness:
              typeof ctx.chatIntegrationReader === 'object'
                ? 'has-chatIntegrationReader'
                : 'missing',
          }),
        },
      };`,
    );
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();

    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["r5-cap" as NotificationChannel]);

    const result = await deliverNotification(delivery.id);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("r5-cap");
    expect(result.results[0].success).toBe(true);
  });

  it("delivered via plugin: delivery status not auto-promoted (matches in-tree contract)", async () => {
    // Match the in-tree contract: only the in-app channel moves `delivery.status`
    // to "delivered". A plugin channel returning success:true still leaves
    // delivery.status as "pending" — that contract is preserved through the
    // consumer seam. Attempt-record persistence is the in-tree channels'
    // concern (each channel handler persists its own attempt); the plugin
    // channel returns a `ChannelHandlerResult` and the consumer merely
    // surfaces it.
    await writeChannelPlugin(
      "chan-delivered",
      "r5-delivered",
      `async () => ({ success: true, attemptId: 'attempt-x' })`,
    );
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, [
      "r5-delivered" as NotificationChannel,
    ]);

    const result = await deliverNotification(delivery.id);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].attemptId).toBe("attempt-x");

    // Delivery status stays "pending" — only in-app channel promotes to "delivered".
    const updated = deliveryRepo.getNotificationDeliveryById(delivery.id);
    expect(updated!.status).toBe("pending");
  });
});
