/**
 * REC-07 family 1 — notification recipient self-service (agent principals).
 *
 * Real HTTP route tests (Fastify inject with the production auth-policy
 * guards installed by `applyDeclaredAuthPolicies` inside `notificationRoutes`):
 * all 7 recipient routes accept a local agent principal; ownership is
 * type-true (recipientId AND recipientType AND habitat); the agent
 * getDelivery event response is the bounded realtime `NotificationEventData`
 * projection (exact allowlist, never the raw payload); the human response
 * stays the raw event row. Admin routes still refuse agents; remote
 * credentials are not admitted by the recipient routes.
 *
 * Deliveries are seeded through the real enqueue path
 * (`enqueueNotificationForRecipients`), not repo-direct inserts.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { notificationRoutes } from "../routes/notifications.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as agentRepo from "../repositories/agent.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { enqueueNotificationForRecipients } from "../services/notificationCommandService.js";
import { users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = "dev-secret-change-in-production";
const HUMAN_ID = "notif-selfservice-human";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function ensureUser(userId: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username: userId,
        passwordHash: "hash",
        displayName: userId,
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

let app: FastifyInstance;
let habitatA: { id: string };
let habitatB: { id: string };
let agentAKey: string;
let agentAId: string;
let agentBKey: string;
let humanToken: string;

function agentHeaders(key: string) {
  return { "x-agent-api-key": key };
}
function humanHeaders() {
  return { authorization: `Bearer ${humanToken}` };
}

function seedDelivery(
  habitatId: string,
  recipientType: "human" | "agent",
  recipientId: string,
  payload?: Record<string, unknown>,
  options?: { title?: string; body?: string; severity?: "info" | "warning" },
) {
  const result = enqueueNotificationForRecipients(
    habitatId,
    "task.assigned",
    "task",
    "info",
    [{ recipientType, recipientId }],
    { payload, title: options?.title, body: options?.body },
  );
  expect(result.deliveries.length).toBe(1);
  return result.deliveries[0];
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(notificationRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await initTestDb();
  habitatA = habitatRepo.createHabitat({ name: "Habitat A" });
  habitatB = habitatRepo.createHabitat({ name: "Habitat B" });
  // Habitat default subscription (required) so explicit recipients resolve to
  // real deliveries — the production shape (no_default suppresses).
  for (const h of [habitatA, habitatB]) {
    subscriptionRepo.createSubscription({
      habitatId: h.id,
      scope: "habitat_default",
      eventType: "task.assigned",
      required: true,
      channels: ["in_app"],
    });
  }
  ensureUser(HUMAN_ID);
  humanToken = makeToken({ sub: HUMAN_ID, username: "Notif Human", role: "admin" });

  const a = agentRepo.createAgent({
    name: `notif-agent-a-${Date.now()}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentAId = a.agent.id;
  agentAKey = a.plainApiKey;

  const b = agentRepo.createAgent({
    name: `notif-agent-b-${Date.now()}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  agentBKey = b.plainApiKey;
});

afterEach(() => closeDb());

describe("agent recipient self-service — 7 routes admit local agents", () => {
  it("getInbox returns only the agent's own deliveries", async () => {
    const own = seedDelivery(habitatA.id, "agent", agentAId, { taskId: "t-1" });
    seedDelivery(habitatA.id, "agent", "some-other-agent", { taskId: "t-2" });
    seedDelivery(habitatA.id, "human", HUMAN_ID, { taskId: "t-3" });

    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/inbox`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.deliveries[0].id).toBe(own.id);
    expect(body.deliveries[0].recipientType).toBe("agent");
  });

  it("getHistory returns only the agent's own past deliveries", async () => {
    seedDelivery(habitatA.id, "agent", agentAId);
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/history`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });

  it("getDelivery returns own delivery with the NotificationEventData projection", async () => {
    seedDelivery(habitatA.id, "agent", agentAId);
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${seedDelivery(habitatA.id, "agent", agentAId).id}`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.recipientType).toBe("agent");
  });

  it("ack acknowledges the agent's own delivery", async () => {
    const d = seedDelivery(habitatA.id, "agent", agentAId);
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}/ack`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("acknowledged");
  });

  it("snooze defers the agent's own delivery", async () => {
    const d = seedDelivery(habitatA.id, "agent", agentAId);
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}/snooze`,
      headers: agentHeaders(agentAKey),
      payload: { snoozedUntil: "2099-01-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("snoozed");
  });

  it("clear removes the agent's own delivery from the active path", async () => {
    const d = seedDelivery(habitatA.id, "agent", agentAId);
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}/clear`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cleared");
  });

  it("getSubscriptions returns the agent's overrides and habitat defaults", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/subscriptions`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overrides).toEqual([]);
    expect(Array.isArray(body.defaults)).toBe(true);
  });
});

describe("agent getDelivery event projection — canonical row fields + exact payload allowlist", () => {
  it("returns canonical eventType/severity/title/body from the row plus exactly the 10 allowlisted payload keys; payload cannot override row fields; no payload/createdBy/historySummary leak", async () => {
    const d = seedDelivery(
      habitatA.id,
      "agent",
      agentAId,
      {
        taskId: "task-1",
        missionId: "mission-1",
        actorId: "actor-1",
        reason: "rejected: tests",
        mentionedUserId: "user-9",
        mentionedByName: "Nine",
        commentContent: "please fix",
        oldPriority: "low",
        newPriority: "high",
        reviewerId: "rev-1",
        // poisoned row-field keys — must NOT override the stored row
        eventType: "task.rejected",
        severity: "critical",
        title: "POISON title",
        body: "POISON body",
        // hostile extras that must NEVER surface on the agent path
        createdById: "creator-secret",
        historySummary: { note: "internal" },
        secret: "leak-me-not",
        nested: { taskId: "evil" },
      },
      { title: "Canonical title", body: "Canonical body" },
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    const event = res.json().event;
    expect(event).toEqual({
      eventType: "task.assigned",
      severity: "info",
      title: "Canonical title",
      body: "Canonical body",
      taskId: "task-1",
      missionId: "mission-1",
      actorId: "actor-1",
      reason: "rejected: tests",
      mentionedUserId: "user-9",
      mentionedByName: "Nine",
      commentContent: "please fix",
      oldPriority: "low",
      newPriority: "high",
      reviewerId: "rev-1",
    });
    // exact-key sentinel: none of the excluded fields may appear
    for (const banned of [
      "payload",
      "createdByType",
      "createdById",
      "historySummary",
      "secret",
      "nested",
      "sourceType",
      "sourceId",
      "targetType",
      "targetId",
      "habitatId",
    ]) {
      expect(event).not.toHaveProperty(banned);
    }
  });

  it("omits allowlisted payload keys whose stored value is not a string; canonical row fields always present", async () => {
    const d = seedDelivery(
      habitatA.id,
      "agent",
      agentAId,
      { taskId: 42, actorId: { id: "evil" }, reason: "kept" },
      { title: "T", body: "B" },
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toEqual({
      eventType: "task.assigned",
      severity: "info",
      title: "T",
      body: "B",
      reason: "kept",
    });
  });
});

describe("human path unchanged", () => {
  it("getDelivery returns the raw event row for humans", async () => {
    const d = seedDelivery(habitatA.id, "human", HUMAN_ID, {
      taskId: "task-1",
      secret: "human-visible",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}`,
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const event = res.json().event;
    expect(event.payload).toEqual({ taskId: "task-1", secret: "human-visible" });
    expect(event.eventType).toBe("task.assigned");
    expect(event).toHaveProperty("createdByType");
  });

  it("inbox/history/subscriptions still serve the human principal", async () => {
    seedDelivery(habitatA.id, "human", HUMAN_ID);
    for (const path of ["inbox", "history", "subscriptions"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/habitats/${habitatA.id}/notifications/${path}`,
        headers: humanHeaders(),
      });
      expect(res.statusCode, path).toBe(200);
    }
  });
});

describe("ownership enforcement", () => {
  it("other agent's delivery → 403 on get/ack/snooze/clear", async () => {
    const d = seedDelivery(habitatA.id, "agent", agentAId);
    const paths: Array<{
      method: "GET" | "POST";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "" },
      { method: "POST", url: "/ack" },
      { method: "POST", url: "/snooze", payload: { snoozedUntil: "2099-01-01T00:00:00.000Z" } },
      { method: "POST", url: "/clear" },
    ];
    for (const p of paths) {
      const res = await app.inject({
        method: p.method,
        url: `/api/habitats/${habitatA.id}/notifications/deliveries/${d.id}${p.url}`,
        headers: agentHeaders(agentBKey),
        ...(p.payload ? { payload: p.payload } : {}),
      });
      expect(res.statusCode, `${p.method} ${p.url || "get"}`).toBe(403);
    }
  });

  it("same owner, wrong habitat → 404 on delivery routes; empty lists under the other habitat", async () => {
    const d = seedDelivery(habitatA.id, "agent", agentAId);
    for (const suffix of ["", "/ack", "/snooze", "/clear"]) {
      const res = await app.inject({
        method: (suffix === "" ? "GET" : "POST") as "GET" | "POST",
        url: `/api/habitats/${habitatB.id}/notifications/deliveries/${d.id}${suffix}`,
        headers: agentHeaders(agentAKey),
        ...(suffix === "/snooze" ? { payload: { snoozedUntil: "2099-01-01T00:00:00.000Z" } } : {}),
      });
      expect(res.statusCode, suffix || "get").toBe(404);
    }
    const inbox = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatB.id}/notifications/inbox`,
      headers: agentHeaders(agentAKey),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toEqual({ deliveries: [], total: 0 });
    const subs = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatB.id}/notifications/subscriptions`,
      headers: agentHeaders(agentAKey),
    });
    expect(subs.statusCode).toBe(200);
    expect(subs.json().overrides).toEqual([]);
  });

  it("cross-TYPE same-uuid → 403 both directions (agent id on human delivery; human id on agent delivery)", async () => {
    // delivery addressed to a HUMAN whose id equals the agent's id
    const asHuman = seedDelivery(habitatA.id, "human", agentAId);
    const agentRes = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${asHuman.id}`,
      headers: agentHeaders(agentAKey),
    });
    expect(agentRes.statusCode).toBe(403);

    // delivery addressed to an AGENT whose id equals the human's id
    const asAgent = seedDelivery(habitatA.id, "agent", HUMAN_ID);
    const humanRes = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/deliveries/${asAgent.id}`,
      headers: humanHeaders(),
    });
    expect(humanRes.statusCode).toBe(403);
  });

  it("cross-TYPE same-uuid mutations → 403 (ack/snooze/clear)", async () => {
    const asHuman = seedDelivery(habitatA.id, "human", agentAId);
    for (const suffix of ["/ack", "/snooze", "/clear"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitatA.id}/notifications/deliveries/${asHuman.id}${suffix}`,
        headers: agentHeaders(agentAKey),
        ...(suffix === "/snooze" ? { payload: { snoozedUntil: "2099-01-01T00:00:00.000Z" } } : {}),
      });
      expect(res.statusCode, suffix).toBe(403);
    }
  });
});

describe("negative admission", () => {
  it("admin routes refuse agent credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/admin/subscriptions`,
      headers: agentHeaders(agentAKey),
    });
    expect(res.statusCode).toBe(401);
  });

  it("remote credentials are not admitted on recipient routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/inbox`,
      headers: { "x-orcy-remote-key": "some-remote-credential" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("no credential → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatA.id}/notifications/inbox`,
    });
    expect(res.statusCode).toBe(401);
  });
});
