import { beforeEach, describe, expect, it, vi } from "vitest";

let updatePayloads: Array<Record<string, unknown>> = [];
let insertPayloads: Array<Record<string, unknown>> = [];
let selectRows: Array<Record<string, unknown>> = [];

const securityMocks = vi.hoisted(() => ({
  validateOutboundUrl: vi.fn(),
  filterUnsafeHeaders: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../config/integrationSecurity.js", () => securityMocks);
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));
vi.mock("uuid", () => ({ v4: vi.fn(() => "delivery-id") }));
vi.mock("../db/schema/index.js", () => ({
  webhookDeliveries: {
    id: "id",
    subscriptionId: "subscription_id",
    eventType: "event_type",
    payload: "payload",
    status: "status",
    attempts: "attempts",
    nextRetryAt: "next_retry_at",
    createdAt: "created_at",
  },
  webhookSubscriptions: {
    id: "sub_id",
    url: "url",
    secret: "secret",
    headers: "headers",
  },
}));
vi.mock("../db/index.js", () => ({
  getDb: () => ({
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => ({
          run: () => {
            updatePayloads.push(payload);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (payload: Record<string, unknown>) => ({
        run: () => {
          insertPayloads.push(payload);
        },
      }),
    }),
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        all: () => selectRows,
      };
      return chain;
    },
  }),
}));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((left, right) => ({ type: "eq", left, right })),
    and: vi.fn((...conditions) => ({ type: "and", conditions })),
    desc: vi.fn((value) => ({ type: "desc", value })),
    sql: vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({ type: "sql" })),
  };
});

import {
  createDeliveryRecord,
  executeHttpRequest,
  getDeliveriesForSubscription,
  handleDeliveryOutcome,
  sendTestWebhook,
  updateDeliveryStatus,
} from "../services/webhooks/webhook-delivery.js";

describe("webhook delivery service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    updatePayloads = [];
    insertPayloads = [];
    selectRows = [];
    securityMocks.validateOutboundUrl.mockResolvedValue({ valid: true });
    securityMocks.filterUnsafeHeaders.mockReturnValue({
      headers: { "X-Safe": "yes" },
      blocked: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 202, text: async () => "accepted" })),
    );
  });

  it("blocks invalid outbound URLs before fetch", async () => {
    securityMocks.validateOutboundUrl.mockResolvedValue({
      valid: false,
      reason: "private address",
    });

    const result = await executeHttpRequest(
      "http://127.0.0.1/hook",
      "{}",
      null,
      {},
      "d1",
      "task.updated",
    );

    expect(result).toEqual({
      success: false,
      statusCode: 0,
      responseBody: "Blocked outbound URL: private address",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends safe headers, delivery metadata, optional signature, and truncates responses", async () => {
    securityMocks.filterUnsafeHeaders.mockReturnValue({
      headers: { "X-Safe": "yes" },
      blocked: ["Authorization"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "x".repeat(1100) })),
    );

    const result = await executeHttpRequest(
      "https://example.com/hook",
      '{"ok":true}',
      "sig",
      { Authorization: "nope" },
      "d1",
      "task.updated",
    );

    expect(result).toEqual({ success: false, statusCode: 500, responseBody: "x".repeat(1024) });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { deliveryId: "d1", blocked: ["Authorization"] },
      "Blocked unsafe custom headers in delivery",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        body: '{"ok":true}',
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Safe": "yes",
          "X-Kanban-Signature": "sig",
          "X-Kanban-Event": "task.updated",
          "X-Kanban-Delivery": "d1",
        }),
      }),
    );
  });

  it("converts fetch failures into failed delivery results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      executeHttpRequest("https://example.com/hook", "{}", null, {}, "d1", "task.updated"),
    ).resolves.toEqual({ success: false, statusCode: 0, responseBody: "network down" });
  });

  it("updates delivery status and schedules retries according to attempt number", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));

    handleDeliveryOutcome("d1", { success: true, statusCode: 200, responseBody: "ok" }, 1);
    handleDeliveryOutcome("d2", { success: false, statusCode: 503, responseBody: "busy" }, 2);
    handleDeliveryOutcome("d3", { success: false, statusCode: 500, responseBody: "dead" }, 3);

    expect(updatePayloads[0]).toMatchObject({
      status: "success",
      statusCode: 200,
      responseBody: "ok",
      nextRetryAt: null,
    });
    expect(updatePayloads[1]).toMatchObject({
      status: "pending",
      statusCode: 503,
      responseBody: "busy",
      nextRetryAt: "2026-05-28T10:00:02.000Z",
    });
    expect(updatePayloads[2]).toMatchObject({
      status: "failed",
      statusCode: 500,
      responseBody: "dead",
      nextRetryAt: null,
    });
  });

  it("creates and lists delivery records", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));
    selectRows = [{ id: "d1", subscriptionId: "s1", eventType: "task.updated" }];

    createDeliveryRecord("s1", "task.updated", '{"id":"task-1"}', "d1");

    expect(insertPayloads).toEqual([
      {
        id: "d1",
        subscriptionId: "s1",
        eventType: "task.updated",
        payload: '{"id":"task-1"}',
        status: "pending",
        attempts: 0,
        createdAt: "2026-05-28T10:00:00.000Z",
      },
    ]);
    expect(getDeliveriesForSubscription("s1")).toEqual(selectRows);
  });

  it("returns test webhook latency and status, and skips invalid URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));

    await expect(
      sendTestWebhook({
        id: "s1",
        url: "https://example.com/hook",
        secret: "secret",
        headers: {},
        format: "standard",
      } as any),
    ).resolves.toEqual({ success: true, statusCode: 202, latencyMs: 0 });

    securityMocks.validateOutboundUrl.mockResolvedValueOnce({ valid: false, reason: "blocked" });
    await expect(
      sendTestWebhook({
        id: "s1",
        url: "http://localhost/hook",
        secret: null,
        headers: {},
        format: "standard",
      } as any),
    ).resolves.toEqual({ success: false, statusCode: 0, latencyMs: 0 });
  });

  it("allows direct delivery status updates with nullable fields", () => {
    updateDeliveryStatus("d1", "failed");

    expect(updatePayloads[0]).toMatchObject({
      status: "failed",
      statusCode: null,
      responseBody: null,
      nextRetryAt: null,
    });
  });
});
