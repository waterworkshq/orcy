/**
 * Webhook subscriptions as notification destinations — the authoring path.
 *
 * The namespaced `notification:<type>` opt-in is the sole way a subscription
 * becomes a notification destination. The REST validator (create AND update)
 * derives supported names from the OWNING catalog (the 15-type V18
 * notification event catalog) — closed form, never open string acceptance:
 * unknown namespaced types are rejected with the existing error shape, and a
 * namespaced entry on a non-standard subscription format is rejected at
 * configuration rather than silently sending a wrong payload shape.
 * Operator contract is REST/CLI only (no webhooks UI exists).
 *
 * Real Fastify inject + real database; only the outbound-URL SSRF boundary is
 * mocked (system boundary — not the behavior under test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { webhookRoutes } from "../routes/webhookOutgoing.js";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as webhookSubRepo from "../repositories/webhookSubscription.js";
import type { WebhookSubscriptionRecord } from "../repositories/webhookSubscription.js";

vi.mock("../config/integrationSecurity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/integrationSecurity.js")>();
  return {
    ...actual,
    validateOutboundUrl: vi.fn().mockResolvedValue({ valid: true }),
    filterUnsafeHeaders: vi.fn((h: Record<string, string>) => ({ headers: h, blocked: [] })),
  };
});

const JWT_SECRET = "notification-validator-test-secret";

function adminToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

async function buildApp(): Promise<FastifyInstance> {
  setJwtSecret(JWT_SECRET);
  const f = Fastify({ logger: false });
  await registerErrorHandler(f);
  await f.register(webhookRoutes);
  await f.ready();
  return f;
}

let app: FastifyInstance;
let habitatId: string;

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST" as const,
    url: "/webhooks",
    headers: { authorization: `Bearer ${adminToken()}` },
    payload: {
      habitatId: null,
      name: "Notification destination",
      url: "https://dest.example.test/hook",
      format: "standard",
      events: ["notification:task.blocked"],
      headers: {},
      ...overrides,
    },
  };
}

beforeEach(async () => {
  await initTestDb();
  app = await buildApp();
  habitatId = boardRepo.createHabitat({ name: "Validator Habitat" }).id;
});
afterEach(async () => {
  await app.close();
  closeDb();
});

describe("POST /webhooks — notification:<type> event entries", () => {
  it("accepts namespaced entries for valid catalog types, mixed with board events", async () => {
    const res = await app.inject({
      ...createBody({ habitatId, events: ["notification:task.blocked", "task.created"] }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toEqual(["notification:task.blocked", "task.created"]);
    const stored = webhookSubRepo.getWebhookSubscriptionRecordById(body.id);
    expect(stored?.events).toContain("notification:task.blocked");
  });

  it("rejects unknown namespaced types with the existing error shape (400)", async () => {
    const res = await app.inject({
      ...createBody({ habitatId, events: ["notification:not_a_catalog_type"] }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("Invalid event type: notification:not_a_catalog_type");
    expect(webhookSubRepo.listWebhookSubscriptionRecords(habitatId)).toHaveLength(0);
  });

  it("rejects a namespaced entry on a non-standard subscription format at configuration", async () => {
    const res = await app.inject({
      ...createBody({ habitatId, format: "slack", events: ["notification:task.blocked"] }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain("notification event entries");
  });

  it("still accepts board-only events unchanged (existing semantics preserved)", async () => {
    const res = await app.inject({
      ...createBody({ habitatId, events: ["task.completed"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual(["task.completed"]);
  });
});

describe("PUT /webhooks/:id — update validation", () => {
  let sub: WebhookSubscriptionRecord;

  beforeEach(() => {
    sub = webhookSubRepo.createWebhookSubscriptionRecord({
      id: "sub-update",
      habitatId,
      name: "Updatable",
      url: "https://dest.example.test/hook",
      secret: "s3cret",
      events: [],
      headers: {},
      format: "standard",
    });
  });

  it("accepts adding namespaced entries on update", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/webhooks/${sub.id}`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { events: ["notification:digest.ready", "notification:release.activated"] },
    });
    expect(res.statusCode).toBe(200);
    expect(webhookSubRepo.getWebhookSubscriptionRecordById(sub.id)?.events).toEqual([
      "notification:digest.ready",
      "notification:release.activated",
    ]);
  });

  it("rejects unknown namespaced types on update (400)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/webhooks/${sub.id}`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { events: ["notification:bogus.type"] },
    });
    expect(res.statusCode).toBe(400);
    expect(webhookSubRepo.getWebhookSubscriptionRecordById(sub.id)?.events).toEqual([]);
  });

  it("rejects switching a namespaced-carrying subscription to a non-standard format", async () => {
    webhookSubRepo.updateWebhookSubscriptionRecord(sub.id, {
      name: "Updatable",
      url: "https://dest.example.test/hook",
      format: "standard",
      events: ["notification:task.blocked"],
      headers: {},
      enabled: 1,
    });
    const res = await app.inject({
      method: "PUT",
      url: `/webhooks/${sub.id}`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { format: "discord" },
    });
    expect(res.statusCode).toBe(400);
  });
});
