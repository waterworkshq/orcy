import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb } from "../db/index.js";
import { remoteWebhookRoutes } from "../routes/remoteWebhooks.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as boardRepo from "../repositories/habitat.js";
import * as podRepo from "../repositories/remotePod.js";
import * as endpointRepo from "../repositories/remoteWebhookEndpoint.js";
import * as deliveryRepo from "../repositories/remoteWebhookDelivery.js";
import {
  buildCompactRemoteWebhookPayload,
  signCompactRemoteWebhookPayload,
} from "../services/compactRemoteWebhookPayload.js";
import {
  dispatchCompactRemoteEvent,
  registerEndpointPlaintextSecret,
  forgetEndpointPlaintextSecret,
} from "../services/compactRemoteWebhookDispatcher.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = "dev-secret-change-in-production";
const ORIGINAL_ENV = { ...process.env };

function makeAdminToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Phase E Webhook Test" });
}

function setupActivePod(habitatId: string) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  return podRepo.activateRemotePod(pod.id) ?? pod;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(remoteWebhookRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

describe("Phase E — Remote webhook endpoint management routes", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
    process.env = ORIGINAL_ENV;
    // Clear the in-memory secret cache between tests
    // (we don't have direct access; the cache is module-scoped)
  });

  it("returns 401 for anonymous requests", async () => {
    const habitat = setupHabitat();
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for viewer role", async () => {
    const habitat = setupHabitat();
    const token = jwt.sign({ sub: "v-1", username: "v", role: "viewer" }, JWT_SECRET, {
      issuer: "orcy",
    });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates endpoint with status=pending and returns plaintext secret (admin only)", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: {
        remotePodId: pod.id,
        url: "https://example.com/webhook",
        description: "Test endpoint",
        events: ["task.assigned", "pulse.signal_posted"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.endpoint.status).toBe("pending");
    expect(body.plaintextSecret).toBeDefined();
    expect(body.plaintextSecret.length).toBeGreaterThan(0);
  });

  it("rejects invalid URL on create", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: {
        remotePodId: pod.id,
        url: "not-a-url",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects remotePodId from a different habitat", async () => {
    const habitat = setupHabitat();
    const other = setupHabitat();
    const otherPod = setupActivePod(other.id);
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: {
        remotePodId: otherPod.id,
        url: "https://example.com/webhook",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists endpoints for the habitat", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.endpoints).toHaveLength(1);
    expect(body.endpoints[0].id).toBe(created.id);
  });

  it("approves endpoint (pending → approved)", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}/approve`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("approved");
    expect(body.approvedBy).toBe("admin-1");
  });

  it("enables endpoint (approved → enabled)", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    endpointRepo.approveRemoteWebhookEndpoint(created.id, "admin-1");
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}/enable`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("enabled");
  });

  it("rejects enable from pending (must approve first)", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}/enable`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with reject reason", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}/reject`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: { rejectReason: "Misconfigured" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("rejected");
    expect(body.rejectReason).toBe("Misconfigured");
  });

  it("disables enabled endpoint", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    endpointRepo.approveRemoteWebhookEndpoint(created.id, "admin-1");
    endpointRepo.enableRemoteWebhookEndpoint(created.id, "admin-1");
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}/disable`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
      payload: { reason: "Rotating secret" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("disabled");
  });

  it("deletes endpoint", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const created = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    const res = await app!.inject({
      method: "DELETE",
      url: `/api/habitats/${habitat.id}/remote-access/webhook-endpoints/${created.id}`,
      headers: { authorization: `Bearer ${makeAdminToken()}` },
    });
    expect(res.statusCode).toBe(204);
    expect(endpointRepo.getRemoteWebhookEndpointById(created.id)).toBeNull();
  });
});

describe("Phase E — Compact remote webhook payload", () => {
  it("builds payload with all spec fields", () => {
    const payload = buildCompactRemoteWebhookPayload({
      eventType: "task.assigned",
      occurredAt: "2026-06-14T10:00:00.000Z",
      habitatId: "h-1",
      missionId: "m-1",
      taskId: "t-1",
      actor: {
        type: "remote_orcy",
        id: "p-1",
        displayName: "Remote Worker",
        podId: "pod-1",
        podName: "Pod A",
      },
      standing: "remote_contributor",
      actionKind: "execution",
      grantId: "g-1",
      title: "Task claimed",
      body: "Worker claimed the task",
      apiBase: "https://orcy.example.com/api/shared",
      followUpPath: "/api/shared/tasks/t-1",
      followUpDescription: "Fetch the task for full details",
    });
    expect(payload.schemaVersion).toBe(1);
    expect(payload.eventType).toBe("task.assigned");
    expect(payload.scope.missionId).toBe("m-1");
    expect(payload.scope.taskId).toBe("t-1");
    expect(payload.actor.podId).toBe("pod-1");
    expect(payload.grantContext.standing).toBe("remote_contributor");
    expect(payload.grantContext.actionKind).toBe("execution");
    expect(payload.grantContext.grantId).toBe("g-1");
    expect(payload.summary.title).toBe("Task claimed");
    expect(payload.followUp.path).toBe("/api/shared/tasks/t-1");
  });

  it("omits optional fields when not provided", () => {
    const payload = buildCompactRemoteWebhookPayload({
      eventType: "pulse.signal_posted",
      occurredAt: "2026-06-14T10:00:00.000Z",
      habitatId: "h-1",
      actor: {
        type: "remote_human",
        id: "p-1",
        displayName: "Reviewer",
        podId: "pod-1",
        podName: "Pod B",
      },
      standing: "remote_observer",
      actionKind: "advisory",
      title: "Pulse posted",
      apiBase: "https://orcy.example.com/api/shared",
      followUpPath: "/api/shared/me",
      followUpDescription: "Fetch the participant",
    });
    expect(payload.scope.missionId).toBeUndefined();
    expect(payload.scope.taskId).toBeUndefined();
    expect(payload.scope.pulseId).toBeUndefined();
    expect(payload.summary.body).toBeUndefined();
    expect(payload.grantContext.grantId).toBeUndefined();
  });

  it("signs and verifies the same payload consistently", () => {
    const payload = buildCompactRemoteWebhookPayload({
      eventType: "task.assigned",
      occurredAt: "2026-06-14T10:00:00.000Z",
      habitatId: "h-1",
      taskId: "t-1",
      actor: {
        type: "remote_orcy",
        id: "p-1",
        displayName: "Worker",
        podId: "pod-1",
        podName: "Pod",
      },
      standing: "remote_contributor",
      actionKind: "advisory",
      title: "T",
      apiBase: "https://orcy.example.com/api/shared",
      followUpPath: "/api/shared/tasks/t-1",
      followUpDescription: "Fetch",
    });
    const secret = "orcy_secret_abc123";
    const sig1 = signCompactRemoteWebhookPayload(payload, secret);
    const sig2 = signCompactRemoteWebhookPayload(payload, secret);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("Phase E — Compact remote webhook dispatcher", () => {
  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    closeDb();
    process.env = ORIGINAL_ENV;
  });

  it("returns zero counts when no enabled endpoints exist", async () => {
    const habitat = setupHabitat();
    const result = await dispatchCompactRemoteEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      apiBase: "https://orcy.example.com/api/shared",
      payload: {
        eventType: "task.assigned",
        occurredAt: new Date().toISOString(),
        habitatId: habitat.id,
        taskId: "t-1",
        actor: { type: "remote_orcy", id: "p-1", displayName: "W", podId: "pod-1", podName: "P" },
        standing: "remote_contributor",
        actionKind: "advisory",
        title: "T",
        apiBase: "https://orcy.example.com/api/shared",
        followUpPath: "/api/shared/tasks/t-1",
        followUpDescription: "Fetch",
      },
    });
    expect(result.dispatched).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("skips endpoints that don't subscribe to the event type", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const endpoint = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
      events: ["pulse.signal_posted"],
    });
    endpointRepo.approveRemoteWebhookEndpoint(endpoint.id, "admin-1");
    endpointRepo.enableRemoteWebhookEndpoint(endpoint.id, "admin-1");
    const secret = "orcy_secret_abc";
    registerEndpointPlaintextSecret(endpoint.id, secret);

    const result = await dispatchCompactRemoteEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      apiBase: "https://orcy.example.com/api/shared",
      payload: {
        eventType: "task.assigned",
        occurredAt: new Date().toISOString(),
        habitatId: habitat.id,
        actor: { type: "remote_orcy", id: "p-1", displayName: "W", podId: "pod-1", podName: "P" },
        standing: "remote_contributor",
        actionKind: "advisory",
        title: "T",
        apiBase: "https://orcy.example.com/api/shared",
        followUpPath: "/api/shared/me",
        followUpDescription: "Fetch",
      },
    });
    expect(result.skipped).toBe(1);
    expect(result.dispatched).toBe(0);
    forgetEndpointPlaintextSecret(endpoint.id);
  });

  it("records failed delivery when endpoint has no secret registered", async () => {
    const habitat = setupHabitat();
    const pod = setupActivePod(habitat.id);
    const endpoint = endpointRepo.createRemoteWebhookEndpoint({
      remotePodId: pod.id,
      habitatId: habitat.id,
      url: "https://example.com/webhook",
    });
    endpointRepo.approveRemoteWebhookEndpoint(endpoint.id, "admin-1");
    endpointRepo.enableRemoteWebhookEndpoint(endpoint.id, "admin-1");
    // No registerEndpointPlaintextSecret call — secret is unknown

    const result = await dispatchCompactRemoteEvent({
      habitatId: habitat.id,
      eventType: "task.assigned",
      apiBase: "https://orcy.example.com/api/shared",
      payload: {
        eventType: "task.assigned",
        occurredAt: new Date().toISOString(),
        habitatId: habitat.id,
        actor: { type: "remote_orcy", id: "p-1", displayName: "W", podId: "pod-1", podName: "P" },
        standing: "remote_contributor",
        actionKind: "advisory",
        title: "T",
        apiBase: "https://orcy.example.com/api/shared",
        followUpPath: "/api/shared/me",
        followUpDescription: "Fetch",
      },
    });
    expect(result.failed).toBe(1);
    const deliveries = deliveryRepo.listRemoteWebhookDeliveriesForEndpoint(endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].responseBody).toContain("no secret registered");
  });
});
