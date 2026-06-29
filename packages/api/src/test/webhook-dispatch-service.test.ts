import { beforeEach, describe, expect, it, vi } from "vitest";

let subscriptionRows: Array<Record<string, unknown>> = [];

const enrichMock = vi.hoisted(() =>
  vi.fn((_habitatId, event) => ({
    habitat: { id: "habitat-1", name: "Habitat" },
    event,
    task: { id: "task-1", title: "Task" },
  })),
);

const standardFormatterMock = vi.hoisted(() =>
  vi.fn((_enrichment, eventType, deliveryId) => ({
    formatter: "standard",
    eventType,
    deliveryId,
  })),
);
const slackFormatterMock = vi.hoisted(() =>
  vi.fn((_enrichment, eventType) => ({ formatter: "slack", eventType })),
);
const discordFormatterMock = vi.hoisted(() =>
  vi.fn((_enrichment, eventType) => ({ formatter: "discord", eventType })),
);

const deliveryMocks = vi.hoisted(() => ({
  createDeliveryRecord: vi.fn(),
  executeHttpRequest: vi.fn(async () => ({ success: true, statusCode: 200, responseBody: "ok" })),
  handleDeliveryOutcome: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => subscriptionRows,
        }),
      }),
    }),
  }),
}));
vi.mock("../db/schema/index.js", () => ({
  webhookSubscriptions: { habitatId: "habitat_id", enabled: "enabled" },
}));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((left, right) => ({ type: "eq", left, right })),
    or: vi.fn((...conditions) => ({ type: "or", conditions })),
    and: vi.fn((...conditions) => ({ type: "and", conditions })),
    isNull: vi.fn((value) => ({ type: "isNull", value })),
  };
});
vi.mock("uuid", () => ({ v4: vi.fn(() => "delivery-id") }));
vi.mock("../utils/webhookSigning.js", () => ({ signPayload: vi.fn(() => "sha256=sig") }));
vi.mock("../services/eventEnricher.js", () => ({ enrichEvent: enrichMock }));
vi.mock("../services/webhook-formatters/standard.js", () => ({
  formatStandardPayload: standardFormatterMock,
}));
vi.mock("../services/webhook-formatters/slack.js", () => ({
  formatSlackPayload: slackFormatterMock,
}));
vi.mock("../services/webhook-formatters/discord.js", () => ({
  formatDiscordPayload: discordFormatterMock,
}));
vi.mock("../services/webhooks/webhook-delivery.js", () => deliveryMocks);
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));
vi.mock("../plugins/pluginManager.js", () => ({
  getFormatterHandler: vi.fn(() => undefined),
}));

import { dispatchWebhooks } from "../services/webhooks/webhook-dispatch.js";

async function flushDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("webhook dispatch service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionRows = [];
    deliveryMocks.executeHttpRequest.mockResolvedValue({
      success: true,
      statusCode: 200,
      responseBody: "ok",
    });
  });

  it("dispatches only matching subscriptions and records delivery outcomes", async () => {
    subscriptionRows = [
      {
        id: "matching",
        url: "https://example.com/matching",
        secret: "secret",
        headers: { A: "1" },
        format: "standard",
        events: ["task.updated"],
        enabled: 1,
      },
      {
        id: "global-all",
        url: "https://example.com/all",
        secret: null,
        headers: {},
        format: "slack",
        events: [],
        enabled: 1,
      },
      {
        id: "wrong-event",
        url: "https://example.com/wrong",
        secret: null,
        headers: {},
        format: "discord",
        events: ["task.created"],
        enabled: 1,
      },
    ];

    await dispatchWebhooks("habitat-1", {
      type: "task.updated",
      data: { taskId: "task-1" },
    } as any);
    await flushDispatch();

    expect(deliveryMocks.createDeliveryRecord).toHaveBeenCalledTimes(2);
    expect(deliveryMocks.createDeliveryRecord).toHaveBeenCalledWith(
      "matching",
      "task.updated",
      JSON.stringify({
        formatter: "standard",
        eventType: "task.updated",
        deliveryId: "delivery-id",
      }),
      "delivery-id",
    );
    expect(deliveryMocks.createDeliveryRecord).toHaveBeenCalledWith(
      "global-all",
      "task.updated",
      JSON.stringify({ formatter: "slack", eventType: "task.updated" }),
      "delivery-id",
    );
    expect(deliveryMocks.executeHttpRequest).toHaveBeenCalledTimes(2);
    expect(deliveryMocks.executeHttpRequest).toHaveBeenCalledWith(
      "https://example.com/matching",
      JSON.stringify({
        formatter: "standard",
        eventType: "task.updated",
        deliveryId: "delivery-id",
      }),
      "sha256=sig",
      { A: "1" },
      "delivery-id",
      "webhook.delivery",
    );
    expect(deliveryMocks.handleDeliveryOutcome).toHaveBeenCalledWith(
      "delivery-id",
      { success: true, statusCode: 200, responseBody: "ok" },
      1,
    );
    expect(discordFormatterMock).not.toHaveBeenCalled();
  });

  it("falls back to the standard formatter for unknown formats", async () => {
    subscriptionRows = [
      {
        id: "unknown-format",
        url: "https://example.com/hook",
        secret: null,
        headers: {},
        format: "mystery",
        events: ["task.updated"],
        enabled: 1,
      },
    ];

    await dispatchWebhooks("habitat-1", {
      type: "task.updated",
      data: { taskId: "task-1" },
    } as any);
    await flushDispatch();

    expect(standardFormatterMock).toHaveBeenCalled();
    expect(deliveryMocks.executeHttpRequest).toHaveBeenCalledWith(
      "https://example.com/hook",
      JSON.stringify({
        formatter: "standard",
        eventType: "task.updated",
        deliveryId: "delivery-id",
      }),
      null,
      {},
      "delivery-id",
      "webhook.delivery",
    );
  });

  it("logs dispatch errors without failing the public dispatch call", async () => {
    subscriptionRows = [
      {
        id: "bad-sub",
        url: "https://example.com/hook",
        secret: null,
        headers: {},
        format: "standard",
        events: [],
        enabled: 1,
      },
    ];
    deliveryMocks.executeHttpRequest.mockRejectedValue(new Error("network broke"));

    await expect(
      dispatchWebhooks("habitat-1", { type: "task.updated", data: {} } as any),
    ).resolves.toBeUndefined();
    await flushDispatch();

    expect(loggerMock.error).toHaveBeenCalledWith(
      { err: expect.any(Error), subscriptionId: "bad-sub" },
      "Webhook dispatch error",
    );
  });
});
