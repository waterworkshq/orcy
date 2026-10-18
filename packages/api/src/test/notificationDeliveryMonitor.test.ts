import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { users, notificationDeliveryAttempts } from "../db/schema/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";
import * as attemptRepo from "../repositories/notificationDeliveryAttempt.js";

let app: HttpRuntimeHandle;
let habitatId: string;
const prefixes = ["/api", "/api/v1"];
const adminId = "monitor-admin";
function headers(id = adminId, role = "admin") {
  return { authorization: `Bearer ${jwt.sign({ sub: id, username: id, role }, "dev-secret-change-in-production", { issuer: "orcy" })}` };
}
function seedDelivery(hid: string, recipientType: "human" | "agent", recipientId: string) {
  const event = eventRepo.createNotificationEvent({ habitatId: hid, eventType: "task.assigned", sourceType: "task", severity: "info", title: "Monitor", body: "Persisted event", createdByType: "system" });
  return deliveryRepo.createNotificationDelivery({ habitatId: hid, eventId: event.id, recipientType, recipientId, channels: ["in_app"] });
}
function monitor(prefix: string, query = "", hid = habitatId) {
  return `${prefix}/habitats/${hid}/notifications/admin/delivery-monitor${query}`;
}
beforeAll(async () => {
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  await initTestDb();
  getDb().insert(users).values({ id: adminId, username: adminId, passwordHash: "hash", role: "admin" }).run();
  habitatId = habitatRepo.createHabitat({ name: "Monitor habitat" }).id;
});
afterEach(() => closeDb());

describe.each(prefixes)("%s delivery monitor", (prefix) => {
  it("shows persisted attempts for nonempty human and agent recipients", async () => {
    const human = seedDelivery(habitatId, "human", adminId);
    const agent = seedDelivery(habitatId, "agent", "monitor-agent");
    const failed = attemptRepo.createDeliveryAttempt({ deliveryId: human.id, channel: "slack", status: "failed", statusCode: 503, error: "Provider unavailable" });
    const sent = attemptRepo.createDeliveryAttempt({ deliveryId: agent.id, channel: "webhook", status: "sent", statusCode: 204 });
    const response = await app.inject({ method: "GET", url: monitor(prefix), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempts).toEqual(expect.arrayContaining([failed, sent]));
    expect(response.json().attempts).toHaveLength(2);
  });
  it("filters by the exact base channel across all recipients, including plugin history", async () => {
    const human = seedDelivery(habitatId, "human", adminId);
    const agent = seedDelivery(habitatId, "agent", "monitor-agent");
    const wanted = attemptRepo.createDeliveryAttempt({ deliveryId: agent.id, channel: "teams", status: "failed" });
    attemptRepo.createDeliveryAttempt({ deliveryId: human.id, channel: "slack", status: "sent" });
    attemptRepo.createDeliveryAttempt({ deliveryId: agent.id, channel: "webhook", destinationId: "destination", status: "failed" });
    const response = await app.inject({ method: "GET", url: monitor(prefix, "?channel=teams"), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ attempts: [wanted] });
  });

  it("limits attempts globally by newest timestamp with descending ID ties", async () => {
    const first = seedDelivery(habitatId, "human", adminId);
    const second = seedDelivery(habitatId, "agent", "monitor-agent");
    for (const [id, deliveryId, createdAt] of [
      ["attempt-a", first.id, "2026-10-17T12:00:00.000Z"],
      ["attempt-z", second.id, "2026-10-17T12:00:00.000Z"],
      ["attempt-m", first.id, "2026-10-17T12:00:00.000Z"],
      ["attempt-zz", second.id, "2026-10-16T12:00:00.000Z"],
    ]) {
      const attempt = attemptRepo.createDeliveryAttempt({ deliveryId, channel: "slack", status: "failed" });
      getDb().update(notificationDeliveryAttempts).set({ id, createdAt }).where(eq(notificationDeliveryAttempts.id, attempt.id)).run();
    }
    const response = await app.inject({ method: "GET", url: monitor(prefix, "?limit=2"), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempts.map((attempt: { id: string }) => attempt.id)).toEqual(["attempt-z", "attempt-m"]);
  });

  it.each([
    "?limit=0", "?limit=-1", "?limit=101", "?limit=1.5", "?limit=nope", "?limit=Infinity", "?limit=", "?limit=1e2",
    "?limit=1&limit=2", "?limit=1&limit=1", "?channel=", "?channel=slack&channel=webhook",
  ])("rejects malformed or repeated monitor input: %s", async (query) => {
    const response = await app.inject({ method: "GET", url: monitor(prefix, query), headers: headers() });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("never includes attempts from another Habitat and leaves recipient history isolated", async () => {
    const otherHabitat = habitatRepo.createHabitat({ name: "Other habitat" });
    const own = seedDelivery(habitatId, "human", adminId);
    const otherHuman = seedDelivery(habitatId, "human", "another-human");
    const sameIdAgent = seedDelivery(habitatId, "agent", adminId);
    const foreign = seedDelivery(otherHabitat.id, "human", adminId);
    const attempts = [own, otherHuman, sameIdAgent, foreign].map((delivery) => attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", status: "failed" }));
    const response = await app.inject({ method: "GET", url: monitor(prefix), headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempts).toHaveLength(3);
    expect(response.json().attempts.map((attempt: { id: string }) => attempt.id)).toEqual(expect.arrayContaining(attempts.slice(0, 3).map((attempt) => attempt.id)));
    const history = await app.inject({ method: "GET", url: `${prefix}/habitats/${habitatId}/notifications/history`, headers: headers() });
    expect(history.statusCode).toBe(200);
    expect(history.json().deliveries.map((delivery: { id: string }) => delivery.id)).toEqual([own.id]);
    expect(deliveryRepo.getDeliveryHistory(habitatId, "human", "").deliveries).toEqual([]);
  });

  it("applies default and valid limit boundaries to attempts rather than deliveries", async () => {
    const delivery = seedDelivery(habitatId, "human", adminId);
    for (let i = 0; i < 105; i++) attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", status: "failed", attempt: i + 1 });
    for (const [query, count] of [["", 50], ["?limit=1", 1], ["?limit=100", 100]] as const) {
      const response = await app.inject({ method: "GET", url: monitor(prefix, query), headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json().attempts).toHaveLength(count);
    }
  });

  it("returns an empty attempt array for an empty Habitat or an unmatched channel", async () => {
    const empty = await app.inject({ method: "GET", url: monitor(prefix), headers: headers() });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ attempts: [] });
    const delivery = seedDelivery(habitatId, "human", adminId);
    attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", status: "failed" });
    const unmatched = await app.inject({ method: "GET", url: monitor(prefix, "?channel=retired-plugin"), headers: headers() });
    expect(unmatched.statusCode).toBe(200);
    expect(unmatched.json()).toEqual({ attempts: [] });
  });

  it("requires a human admin who belongs to the Habitat team", async () => {
    const org = organizationRepo.createOrganization({ name: "Monitor organization", slug: "monitor-org" });
    const team = teamRepo.createTeam({ organizationId: org.id, name: "Monitor team", slug: "monitor-team" });
    const privateHabitat = habitatRepo.createHabitat({ name: "Private monitor", teamId: team.id });
    const delivery = seedDelivery(privateHabitat.id, "human", adminId);
    attemptRepo.createDeliveryAttempt({ deliveryId: delivery.id, channel: "slack", status: "failed", error: "Private provider response" });
    const outsider = await app.inject({ method: "GET", url: monitor(prefix, "", privateHabitat.id), headers: headers() });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json().code).toBe("BOARD_ACCESS_DENIED");
    expect(outsider.body).not.toContain("Private provider response");
    memberRepo.addMember({ teamId: team.id, userId: adminId, role: "member" });
    const allowed = await app.inject({ method: "GET", url: monitor(prefix, "", privateHabitat.id), headers: headers() });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().attempts).toHaveLength(1);
    getDb().insert(users).values({ id: "monitor-editor", username: "monitor-editor", passwordHash: "hash", role: "editor" }).run();
    memberRepo.addMember({ teamId: team.id, userId: "monitor-editor", role: "owner" });
    const nonAdmin = await app.inject({ method: "GET", url: monitor(prefix, "", privateHabitat.id), headers: headers("monitor-editor", "editor") });
    expect(nonAdmin.statusCode).toBe(403);
    expect(nonAdmin.json().code).toBe("FORBIDDEN");
    expect(nonAdmin.body).not.toContain("Private provider response");
  });

  it("rejects absent credentials and local agent credentials", async () => {
    const anonymous = await app.inject({ method: "GET", url: monitor(prefix) });
    expect(anonymous.statusCode).toBe(401);
    const agent = agentRepo.createAgent({ name: "Monitor agent", type: "claude-code", domain: "fullstack", capabilities: ["typescript"] });
    const response = await app.inject({ method: "GET", url: monitor(prefix), headers: { "x-agent-api-key": agent.plainApiKey } });
    expect(response.statusCode).toBe(401);
  });

});
