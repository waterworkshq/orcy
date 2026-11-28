/**
 * #322 — the admin clearance receipt counts DISTINCT deliveries that newly
 * transitioned to `cleared` on the request.
 *
 * Served route (`POST /habitats/:hid/notifications/admin/clear`, human JWT +
 * admin role + habitat access), synthetic in-memory database, deliveries
 * seeded through the repository writer (no enqueue, no channel fan-out) — the
 * fixture asserts no delivery attempt is ever written, so no notification is
 * dispatched.
 *
 * Cases: first eligible clear reports one; the exact repeat reports zero and
 * leaves the persisted row untouched; duplicate ids of an initially eligible
 * delivery report one transition and change one row; a mixed
 * eligible/ineligible/unknown request keeps the established per-id error and
 * the route's admission outcomes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { users } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";

const prefixes = ["/api", "/api/v1"];
const ADMIN_ID = "clear-admin";
const VIEWER_ID = "clear-viewer";

let app: HttpRuntimeHandle;
let habitatId: string;

function token(id: string, role: string) {
  return jwt.sign({ sub: id, username: id, role }, "dev-secret-change-in-production", {
    issuer: "orcy",
  });
}

function adminHeaders() {
  return { authorization: `Bearer ${token(ADMIN_ID, "admin")}` };
}

/** Seeds one delivery through the repository writer — in-app only, so nothing
 * can be dispatched off this fixture. */
function seedDelivery(recipientId = "recipient-1") {
  const event = eventRepo.createNotificationEvent({
    habitatId,
    eventType: "task.assigned",
    sourceType: "task",
    severity: "info",
    title: "Clearance fixture",
    body: "Clearance fixture body",
    createdByType: "system",
  });
  const delivery = deliveryRepo.createNotificationDelivery({
    habitatId,
    eventId: event.id,
    recipientType: "human",
    recipientId,
    channels: ["in_app"],
  });
  return { event, delivery };
}

function clearUrl(prefix: string) {
  return `${prefix}/habitats/${habitatId}/notifications/admin/clear`;
}

function clear(
  prefix: string,
  deliveryIds: string[],
  headers: Record<string, string> = adminHeaders(),
) {
  return app.inject({
    method: "POST",
    url: clearUrl(prefix),
    headers,
    payload: { deliveryIds },
  });
}

beforeAll(async () => {
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});
afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await initTestDb();
  getDb()
    .insert(users)
    .values([
      { id: ADMIN_ID, username: ADMIN_ID, passwordHash: "hash", role: "admin" },
      { id: VIEWER_ID, username: VIEWER_ID, passwordHash: "hash", role: "viewer" },
    ])
    .run();
  habitatId = habitatRepo.createHabitat({ name: "Clearance habitat" }).id;
});
afterEach(() => closeDb());

describe.each(prefixes)("%s admin clearance receipt", (prefix) => {
  it("reports one transition for the first eligible clear", async () => {
    const { delivery } = seedDelivery();

    const response = await clear(prefix, [delivery.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().cleared).toBe(1);
    expect(response.json().errors).toEqual([]);
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("cleared");
  });

  it("reports zero for an exact repeat and leaves the persisted row untouched", async () => {
    const { event, delivery } = seedDelivery();
    await clear(prefix, [delivery.id]);
    const afterFirst = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    const summaryAfterFirst = eventRepo.getNotificationEventById(event.id)!.historySummary;

    const repeat = await clear(prefix, [delivery.id]);

    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().cleared).toBe(0);
    expect(repeat.json().errors).toEqual([]);
    const afterRepeat = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(afterRepeat.status).toBe("cleared");
    expect(afterRepeat.clearedAt).toBe(afterFirst.clearedAt);
    expect(afterRepeat.updatedAt).toBe(afterFirst.updatedAt);
    expect(eventRepo.getNotificationEventById(event.id)!.historySummary).toEqual(summaryAfterFirst);
  });

  it("reports one transition for duplicate ids of an initially eligible delivery", async () => {
    const { delivery } = seedDelivery();

    const response = await clear(prefix, [delivery.id, delivery.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().cleared).toBe(1);
    expect(response.json().errors).toEqual([]);
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("cleared");
  });

  it("keeps the established errors for a mixed eligible/ineligible/unknown request", async () => {
    const eligible = seedDelivery("recipient-eligible");
    const ineligible = seedDelivery("recipient-ineligible");
    await clear(prefix, [ineligible.delivery.id]);
    const ineligibleAfter = deliveryRepo.getNotificationDeliveryById(ineligible.delivery.id)!;

    const response = await clear(prefix, [
      eligible.delivery.id,
      ineligible.delivery.id,
      "no-such-delivery",
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json().cleared).toBe(1);
    expect(response.json().errors).toEqual(["Delivery not found: no-such-delivery"]);
    expect(deliveryRepo.getNotificationDeliveryById(eligible.delivery.id)!.status).toBe("cleared");
    const ineligibleNow = deliveryRepo.getNotificationDeliveryById(ineligible.delivery.id)!;
    expect(ineligibleNow.status).toBe(ineligibleAfter.status);
    expect(ineligibleNow.clearedAt).toBe(ineligibleAfter.clearedAt);
    expect(ineligibleNow.updatedAt).toBe(ineligibleAfter.updatedAt);
  });

  it("keeps the route's admission outcomes", async () => {
    const { delivery } = seedDelivery();

    const anonymous = await clear(prefix, [delivery.id], {});
    expect(anonymous.statusCode).toBe(401);

    const nonAdmin = await clear(prefix, [delivery.id], {
      authorization: `Bearer ${token(VIEWER_ID, "viewer")}`,
    });
    expect(nonAdmin.statusCode).toBe(403);

    const empty = await clear(prefix, []);
    expect(empty.statusCode).toBe(400);
  });

  it("dispatches no notification while clearing", async () => {
    const { delivery } = seedDelivery();

    await clear(prefix, [delivery.id]);

    expect(attemptRepo.getDeliveryAttemptsByHabitat(habitatId, { limit: 50 })).toEqual([]);
  });
});

describe("admin clearance receipt (repository transition)", () => {
  it("clears a delivery once and refuses a repeat transition", async () => {
    const { delivery } = seedDelivery();

    expect(deliveryRepo.transitionDeliveryToCleared(delivery.id)).toBe(true);
    expect(deliveryRepo.transitionDeliveryToCleared(delivery.id)).toBe(false);
    expect(deliveryRepo.getNotificationDeliveryById(delivery.id)!.status).toBe("cleared");
  });
});

describe("clearance receipt persistence", () => {
  it("keeps the delivery row and the event summary consistent", async () => {
    const { event, delivery } = seedDelivery();

    await app.inject({
      method: "POST",
      url: clearUrl("/api/v1"),
      headers: adminHeaders(),
      payload: { deliveryIds: [delivery.id] },
    });

    const row = deliveryRepo.getNotificationDeliveryById(delivery.id)!;
    expect(row.status).toBe("cleared");
    expect(row.clearedAt).not.toBeNull();
    const stored = eventRepo.getNotificationEventById(event.id)!;
    expect(stored.historySummary).not.toBeNull();
    expect(stored.historySummary!.clearedAt).toBeDefined();
  });
});
