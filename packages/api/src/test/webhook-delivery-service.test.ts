import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Mirrors the real module surface: fetchValidated validates via the mocked
// checker, throws the (mocked) UrlRejectedError class on rejection, and
// otherwise fetches with the helper's redirect/timeout defaults.
vi.mock("../config/integrationSecurity.js", () => {
  class UrlRejectedError extends Error {
    reason: string;
    constructor(reason: string) {
      super(`URL rejected: ${reason}`);
      this.name = "UrlRejectedError";
      this.reason = reason;
    }
  }
  return {
    ...securityMocks,
    UrlRejectedError,
    fetchValidated: async (url: string, init: RequestInit = {}) => {
      const check = await securityMocks.validateOutboundUrl(url);
      if (!check.valid) throw new UrlRejectedError(check.reason);
      return fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), ...init });
    },
  };
});
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));
vi.mock("uuid", () => ({ v4: vi.fn(() => "delivery-id") }));

// The repository layer (claim/fence CAS against the real DB) has its own
// real-DB discriminator suite (webhookRetryRecovery.test.ts); this service
// suite mocks the repo boundary and asserts the service's orchestration.
const repoMocks = vi.hoisted(() => ({
  createWebhookDeliveryRecord: vi.fn(() => ({ created: true, fence: "fence-new" })),
  recordFencedWebhookDeliveryOutcome: vi.fn(() => true),
  claimWebhookDeliveryForRetry: vi.fn(() => ({ acquired: false, fence: null, delivery: null })),
  listRetryEligibleWebhookDeliveries: vi.fn(() => []),
  terminalizeWebhookDelivery: vi.fn(() => true),
  listWebhookDeliveriesForSubscription: vi.fn(
    (_subscriptionId: string, _limit?: number): Array<Record<string, unknown>> => [],
  ),
  getWebhookDeliveryById: vi.fn(() => null),
  WEBHOOK_DISPOSITION_SUBSCRIPTION_DISABLED: "Webhook delivery abandoned: subscription is disabled.",
  WEBHOOK_DISPOSITION_SUBSCRIPTION_MISSING: "Webhook delivery abandoned: subscription is missing.",
  WEBHOOK_DISPOSITION_HEADERS_MALFORMED: "Webhook delivery abandoned: subscription headers are malformed.",
  WEBHOOK_DISPOSITION_BUDGET_EXHAUSTED:
    "Webhook delivery abandoned: retry budget exhausted; outcome of the final attempt is unknown.",
}));
vi.mock("../repositories/webhookDelivery.js", () => repoMocks);

import {
  createDeliveryRecord,
  executeHttpRequest,
  getDeliveriesForSubscription,
  handleDeliveryOutcome,
  sendTestWebhook,
} from "../services/webhooks/webhook-delivery.js";

describe("webhook delivery service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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

  it("records fenced outcomes and schedules retries according to attempt number", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T10:00:00.000Z"));

    handleDeliveryOutcome("d1", "fence-1", { success: true, statusCode: 200, responseBody: "ok" }, 1);
    handleDeliveryOutcome("d2", "fence-2", { success: false, statusCode: 503, responseBody: "busy" }, 2);
    handleDeliveryOutcome("d3", "fence-3", { success: false, statusCode: 500, responseBody: "dead" }, 3);

    expect(repoMocks.recordFencedWebhookDeliveryOutcome).toHaveBeenNthCalledWith(1, {
      deliveryId: "d1",
      fence: "fence-1",
      status: "success",
      statusCode: 200,
      responseBody: "ok",
      now: "2026-05-28T10:00:00.000Z",
    });
    expect(repoMocks.recordFencedWebhookDeliveryOutcome).toHaveBeenNthCalledWith(2, {
      deliveryId: "d2",
      fence: "fence-2",
      status: "pending",
      statusCode: 503,
      responseBody: "busy",
      nextRetryAt: "2026-05-28T10:00:02.000Z",
      now: "2026-05-28T10:00:00.000Z",
    });
    expect(repoMocks.recordFencedWebhookDeliveryOutcome).toHaveBeenNthCalledWith(3, {
      deliveryId: "d3",
      fence: "fence-3",
      status: "failed",
      statusCode: 500,
      responseBody: "dead",
      now: "2026-05-28T10:00:00.000Z",
    });
  });

  it("creates and lists delivery records", () => {
    createDeliveryRecord("s1", "task.updated", '{"id":"task-1"}', "d1");

    expect(repoMocks.createWebhookDeliveryRecord).toHaveBeenCalledWith(
      "s1",
      "task.updated",
      '{"id":"task-1"}',
      "d1",
      { owner: "webhook-dispatch:d1", ttlMs: 60_000 },
    );
    repoMocks.listWebhookDeliveriesForSubscription.mockReturnValueOnce([
      { id: "d1", subscriptionId: "s1", eventType: "task.updated" },
    ]);
    expect(getDeliveriesForSubscription("s1")).toEqual([
      { id: "d1", subscriptionId: "s1", eventType: "task.updated" },
    ]);
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

  it("returns the fenced-write landing flag from handleDeliveryOutcome", () => {
    repoMocks.recordFencedWebhookDeliveryOutcome.mockReturnValueOnce(false);
    const landed = handleDeliveryOutcome("d1", "fence-1", {
      success: true,
      statusCode: 200,
      responseBody: "ok",
    }, 1);
    expect(landed).toBe(false);
  });
});
