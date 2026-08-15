/**
 * Fastify `app.inject` tests for the automation inbox operator routes
 * (`GET /habitats/:habitatId/automation-inbox`, waive, retry).
 *
 * The service-level outcomes were already covered by
 * `automationInboxRecovery.test.ts`; these tests exercise the HTTP surface —
 * the typed status codes clients actually see:
 *
 *   - disposition state races → 409 CONFLICT (not 400 VALIDATION_ERROR)
 *   - inbox pagination (`limit`/`offset`) keeps older attention-required
 *     entries reachable beyond the newest 100
 *   - malformed pagination query → 400
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import {
  admitReleaseShippedEventToInbox,
  waiveAutomationDelivery,
  LEGACY_PROVED_NO_RECEIPT_DISPOSITION,
} from "../services/automationInboxService.js";
import { closeDb, initTestDb } from "../db/index.js";
import { automationRoutes } from "../routes/automationRules.js";

const JWT_SECRET = "dev-secret-change-in-production";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z";

function adminToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(automationRoutes);
  await f.ready();
  return f;
}

function setupHabitat(name = "Inbox Habitat") {
  const h = boardRepo.createHabitat({ name });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function createReleaseRule(habitatId: string) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Release Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: { type: "always" } as never,
    actions: [{ type: "mark_risk", level: "high", reason: "inject" }] as never,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "test",
  });
}

function admit(habitatId: string, eventId: string) {
  return admitReleaseShippedEventToInbox({ habitatId, eventId, payload: { eventId } });
}

function seedAttentionDelivery(habitatId: string, eventId: string): string {
  admit(habitatId, eventId);
  const inboxId = deliveryRepo.listInboxEntriesForHabitat(habitatId)[0].id;
  const deliveryId = deliveryRepo.listDeliveriesForInbox(inboxId)[0].id;
  const lease = deliveryRepo.leaseDelivery({
    deliveryId,
    leaseOwner: "crashed-worker",
    now: T0,
    ttlMs: 60_000,
  });
  if (!lease.acquired) throw new Error("seed lease failed");
  const marked = deliveryRepo.markStaleDeliveryAttention({
    deliveryId,
    fence: lease.fence,
    now: T1,
    reason: "seed",
    proofClassification: "unprovable",
  });
  if (!marked) throw new Error("seeding attention state failed");
  return deliveryId;
}

describe("automation inbox operator routes (inject)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    await initTestDb();
    setJwtSecret(JWT_SECRET);
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    closeDb();
    vi.restoreAllMocks();
  });

  it("waive state race returns 409 CONFLICT, not 400 VALIDATION_ERROR", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    const deliveryId = seedAttentionDelivery(h.id, "rel-waive-race");

    // First waive succeeds; a second waive (or a concurrent state change)
    // must surface as a conflict, not as if the request were malformed.
    const first = await app.inject({
      method: "POST",
      url: `/automation-deliveries/${deliveryId}/waive`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { reason: "externally reconciled" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/automation-deliveries/${deliveryId}/waive`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { reason: "again" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CONFLICT");
  });

  it("retry from a non-attention state returns 409 CONFLICT", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    const deliveryId = seedAttentionDelivery(h.id, "rel-retry-race");

    // Waive first so the delivery is terminal, then attempt a successor.
    const waived = waiveAutomationDelivery({
      deliveryId,
      actorType: "human",
      actorId: "admin-1",
      reason: "reconciled",
    });
    expect(waived.outcome).not.toBe("conflict");

    const res = await app.inject({
      method: "POST",
      url: `/automation-deliveries/${deliveryId}/retry`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { reason: "retry", ackDuplicateRisk: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("CONFLICT");
  });

  it("inbox listing paginates with limit/offset so older entries stay reachable", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    admit(h.id, "rel-page-1");
    admit(h.id, "rel-page-2");
    admit(h.id, "rel-page-3");

    const auth = { authorization: `Bearer ${adminToken()}` };
    const all = await app.inject({
      method: "GET",
      url: `/habitats/${h.id}/automation-inbox`,
      headers: auth,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toHaveLength(3);

    const page1 = await app.inject({
      method: "GET",
      url: `/habitats/${h.id}/automation-inbox?limit=2`,
      headers: auth,
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json()).toHaveLength(2);

    const page2 = await app.inject({
      method: "GET",
      url: `/habitats/${h.id}/automation-inbox?limit=2&offset=2`,
      headers: auth,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json()).toHaveLength(1);

    // No overlap between pages (admittedAt DESC ordering is stable between
    // calls; the ids must partition the full set).
    const ids = new Set([...page1.json(), ...page2.json()].map((o) => o.inbox.id));
    expect(ids.size).toBe(3);
  });

  it("DISCRIMINATOR: legacy no-receipt delivery unlocks a successor only with the explicit ack", async () => {
    const h = setupHabitat();
    createReleaseRule(h.id);
    admit(h.id, "rel-legacy-route");
    const inboxId = deliveryRepo.listInboxEntriesForHabitat(h.id)[0].id;
    const deliveryId = deliveryRepo.listDeliveriesForInbox(inboxId)[0].id;

    // Crash after leasing, flag one checkpoint as a historically-proved
    // no-receipt row, then mark the delivery attention_required.
    const lease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "crashed-worker",
      now: T0,
      ttlMs: 60_000,
    });
    if (!lease.acquired) throw new Error("seed lease failed");
    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId);
    if (!revision) throw new Error("seed revision missing");
    const checkpoint = deliveryRepo.ensureCheckpointRow({
      deliveryId,
      actionIndex: 0,
      actionKey: deliveryRepo.computeActionKey(revision.actions[0]),
      actionType: String(revision.actions[0].type),
      now: T0,
    });
    const seeded = deliveryRepo.recordCheckpointOutcome({
      checkpointId: checkpoint.id,
      deliveryId,
      fence: lease.fence,
      state: "failed",
      terminalDisposition: LEGACY_PROVED_NO_RECEIPT_DISPOSITION,
      now: T0,
    });
    if (!seeded) throw new Error("legacy checkpoint seeding failed");
    if (
      !deliveryRepo.markStaleDeliveryAttention({
        deliveryId,
        fence: lease.fence,
        now: T1,
        reason: "legacy route seed",
        proofClassification: "unprovable",
      })
    ) {
      throw new Error("marking attention failed");
    }

    const auth = { authorization: `Bearer ${adminToken()}` };
    // Generic duplicate-risk ack alone is rejected (the action already fired).
    const blocked = await app.inject({
      method: "POST",
      url: `/automation-deliveries/${deliveryId}/retry`,
      headers: auth,
      payload: { reason: "retry", ackDuplicateRisk: true },
    });
    expect(blocked.statusCode).toBe(400);
    expect(JSON.parse(blocked.body).error).toContain("ackLegacyProvedNoReceipt");

    // The explicit legacy ack unlocks the successor.
    const allowed = await app.inject({
      method: "POST",
      url: `/automation-deliveries/${deliveryId}/retry`,
      headers: auth,
      payload: {
        reason: "operator confirmed re-firing is safe",
        ackDuplicateRisk: true,
        ackLegacyProvedNoReceipt: true,
      },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("malformed pagination query returns 400 VALIDATION_ERROR", async () => {
    const h = setupHabitat();
    const res = await app.inject({
      method: "GET",
      url: `/habitats/${h.id}/automation-inbox?limit=not-a-number`,
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});
