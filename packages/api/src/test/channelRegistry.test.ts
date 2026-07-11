/**
 * Phase 6 — channel registry lookup surface (ADR-0017).
 *
 * Verifies the `dispatchChannel` registry-first / switch-fallback wiring:
 *  - Registry miss falls through to the existing 4-case switch (regression-free).
 *  - Registry hit invokes the plugin handler and short-circuits the switch.
 *  - Plugin handler exceptions are caught and surfaced as `{ success: false }`
 *    rather than propagating to the dispatcher.
 *
 * Per ADR-0017, the existing in-tree channels (`in_app`, `webhook`, `slack`,
 * `discord`) MUST work unchanged when no channel plugins are loaded — the
 * common v0.22.0 deployment shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { deliverNotification } from "../services/notificationDeliveryService.js";
import type { NotificationEvent, NotificationDelivery } from "@orcy/shared";

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../repositories/pluginEnrollment.js", () => ({
  listEnabledByHabitat: vi.fn().mockReturnValue([]),
}));

vi.mock("../repositories/pluginRun.js", () => ({
  startRun: vi.fn().mockReturnValue({ id: "run-1" }),
  finishRun: vi.fn(),
}));

vi.mock("../services/pulseService.js", () => ({ onPulseCreated: vi.fn() }));
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Channel Registry Test Habitat" });
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
    title: "Registry test",
    body: "channel registry surface test",
    createdByType: "system",
  });
}

function createTestDelivery(habitatId: string, eventId: string, channels: string[]) {
  subscriptionRepo.createSubscription({
    habitatId,
    scope: "habitat_default",
    eventType: "task.assigned",
    channels: channels as never,
  });
  return deliveryRepo.createNotificationDelivery({
    eventId,
    habitatId,
    recipientType: "human",
    recipientId: "user-1",
    channels: channels as never,
  });
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-channel-registry-${name}-${Date.now()}`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
}

describe("channelRegistry: registry miss falls through to existing switch (regression)", () => {
  beforeEach(async () => {
    await initTestDb();
    pluginManager.resetPlugins();
  });
  afterEach(() => {
    pluginManager.resetPlugins();
    closeDb();
  });

  it("in_app delivery still succeeds when no plugins are loaded", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["in_app"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].channel).toBe("in_app");
    expect(result.results[0].success).toBe(true);
  });

  it("slack delivery still hits the in-tree 'no integration' path when no plugins loaded", async () => {
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = createTestDelivery(habitat.id, event.id, ["slack"]);

    const result = await deliverNotification(delivery.id);
    expect(result.results[0].channel).toBe("slack");
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("No enabled Slack");
  });
});

describe("channelRegistry: registry hit short-circuits the switch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initTestDb();
    pluginManager.resetPlugins();
  });
  afterEach(async () => {
    pluginManager.resetPlugins();
    closeDb();
    if (tmpDir) await cleanup(tmpDir);
  });

  it("dispatchToChannelPlugin returns null when no plugin registered for the channel", async () => {
    pluginManager.resetPlugins();
    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app" as never],
    });
    const result = await pluginManager.dispatchToChannelPlugin(
      "teams",
      delivery as NotificationDelivery,
      event,
    );
    expect(result).toBeNull();
  });

  it("a registered channel plugin handler is invoked via dispatchToChannelPlugin", async () => {
    tmpDir = await writePlugin(
      "test-chan",
      `{
        manifest: {
          id: 'test-chan',
          version: '1.0.0',
          description: 'x',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'testcustom',
            label: 'Test Custom',
            requires: [],
          }],
        },
        channels: {
          testcustom: async (_ctx, payload) => ({
            success: true,
            attemptId: 'att-' + payload.event.id,
          }),
        },
      }`,
    );

    expect(pluginManager.getChannelHandler("testcustom")).toBeTypeOf("function");

    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app" as never],
    });

    const result = await pluginManager.dispatchToChannelPlugin(
      "testcustom",
      delivery as NotificationDelivery,
      event,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.attemptId).toBe(`att-${event.id}`);
  });

  it("a registered channel plugin handler that throws is caught and surfaced as failure", async () => {
    tmpDir = await writePlugin(
      "crash-chan",
      `{
        manifest: {
          id: 'crash-chan',
          version: '1.0.0',
          description: 'x',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'crashing',
            label: 'Crashing',
            requires: [],
          }],
        },
        channels: {
          crashing: async () => { throw new Error('boom'); },
        },
      }`,
    );

    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app" as never],
    });

    const result = await pluginManager.dispatchToChannelPlugin(
      "crashing",
      delivery as NotificationDelivery,
      event,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("boom");
  });

  it("dispatchToChannelPlugin forwards the manifest's declared `requires` into PluginContext", async () => {
    // Regression: previously `requires: []` was hardcoded in the dispatcher,
    // so a channel plugin declaring `requires: ['chatIntegrationReader']`
    // received a PluginContext without `chatIntegrationReader` even though
    // the manifest declared it (and contributionAdapters.ts:165-167 lists
    // it as the only allowed capability for notificationChannel).
    tmpDir = await writePlugin(
      "chan-requires",
      `{
        manifest: {
          id: 'chan-requires',
          version: '1.0.0',
          description: 'channel that requires chatIntegrationReader',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'requires-ch',
            label: 'Requires Chat',
            requires: ['chatIntegrationReader'],
          }],
        },
        channels: {
          'requires-ch': async (ctx) => { (globalThis.__capCtx = ctx); return { success: true }; },
        },
      }`,
    );

    const habitat = setupHabitat();
    const event = createTestEvent(habitat.id);
    const delivery = deliveryRepo.createNotificationDelivery({
      eventId: event.id,
      habitatId: habitat.id,
      recipientType: "human",
      recipientId: "user-1",
      channels: ["in_app" as never],
    });

    const result = await pluginManager.dispatchToChannelPlugin(
      "requires-ch",
      delivery as NotificationDelivery,
      event,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    const capturedCtx = (globalThis as { __capCtx?: { chatIntegrationReader?: unknown } })
      .__capCtx ?? null;
    expect(capturedCtx).not.toBeNull();
    // `chatIntegrationReader` is the only allowed capability for
    // notificationChannel; if the dispatcher dropped `requires`, this would
    // be undefined.
    expect(capturedCtx!.chatIntegrationReader).toBeDefined();
    delete (globalThis as { __capCtx?: unknown }).__capCtx;
  });
});
