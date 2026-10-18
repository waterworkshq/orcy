/** Subscription administration through the production HTTP app and native SQLite. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { closeDb, getDb, initDb } from "../db/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { users } from "../db/schema/index.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { migrateLegacyPreferences } from "../services/notificationMigrationService.js";

let app: HttpRuntimeHandle;
let directory: string;
let peer: Database.Database;

function fixture() {
  const userId = randomUUID();
  getDb().insert(users).values({ id: userId, username: userId, passwordHash: "x", role: "viewer" }).run();
  const token = jwt.sign({ sub: userId, username: userId, role: "viewer" }, getJwtSecret(), {
    issuer: "orcy", expiresIn: "1h",
  });
  const org = orgRepo.createOrganization({ name: "Subscriptions", slug: randomUUID() });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "Private", slug: randomUUID() });
  const personal = habitatRepo.createHabitat({ name: "Personal" });
  const privateHabitat = habitatRepo.createHabitat({ name: "Private", teamId: team.id });
  const foreign = subscriptionRepo.createSubscription({ habitatId: privateHabitat.id,
    scope: "habitat_default", eventType: "task.blocked", required: true,
    channels: ["in_app"], timezone: "foreign-secret-timezone" });
  return { userId, token, team, personal, privateHabitat, foreign };
}

async function call(f: ReturnType<typeof fixture>, prefix: string,
  method: "PUT" | "DELETE", habitatId: string, subscriptionId: string,
  payload?: Record<string, unknown>) {
  return app.inject({ method, url: `${prefix}/habitats/${habitatId}/notifications/admin/subscriptions/${subscriptionId}`,
    headers: { authorization: `Bearer ${f.token}` },
    ...(payload === undefined ? {} : { payload }) });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "orcy-subscription-scope-"));
  const dbPath = join(directory, "subscriptions.db");
  await initDb(dbPath);
  peer = new Database(dbPath);
  peer.pragma("foreign_keys = ON");
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
}, 30_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app?.close();
  peer?.close();
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const prefix of ["/api", "/api/v1"]) describe(prefix, () => {
  it("foreign PUT is indistinguishable from absent and preserves every foreign field", async () => {
    const f = fixture();
    const before = subscriptionRepo.getSubscriptionById(f.foreign.id);
    const denied = await call(f, prefix, "PUT", f.personal.id, f.foreign.id, { enabled: false, channels: [] });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: "Subscription not found", code: "NOT_FOUND" });
    const absent = await call(f, prefix, "PUT", f.personal.id, randomUUID(), { enabled: false, channels: [] });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toEqual(denied.json());
    expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(before);
  });
  it("foreign DELETE is indistinguishable from absent and preserves every foreign field", async () => {
    const f = fixture();
    const before = subscriptionRepo.getSubscriptionById(f.foreign.id);
    const denied = await call(f, prefix, "DELETE", f.personal.id, f.foreign.id);
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ deleted: false });
    const absent = await call(f, prefix, "DELETE", f.personal.id, randomUUID());
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual(denied.json());
    expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(before);
  });

  for (const method of ["PUT", "DELETE"] as const) {
    it(`${method} refuses a membership revoked after admission but before reservation`, async () => {
      const f = fixture();
      memberRepo.addMember({ teamId: f.team.id, userId: f.userId });
      const before = subscriptionRepo.getSubscriptionById(f.foreign.id);
      const db = getDb();
      const original = db.transaction.bind(db);
      // Bounded test-only reservation seam: commit real peer revocation before
      // the service acquires its lock; no internal collaborator is replaced.
      const reservation = vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
        expect(config?.behavior).toBe("immediate");
        peer.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
          .run(f.team.id, f.userId);
        return original(work, config);
      }) as typeof db.transaction);
      const denied = await call(f, prefix, method, f.privateHabitat.id, f.foreign.id,
        method === "PUT" ? { enabled: false } : undefined);
      expect(reservation).toHaveBeenCalledTimes(1);
      reservation.mockRestore();
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
      expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(before);
    });
  }

  for (const method of ["PUT", "DELETE"] as const) {
    it(`${method} scopes the target after a subscription moves before reservation`, async () => {
      const f = fixture();
      memberRepo.addMember({ teamId: f.team.id, userId: f.userId });
      const db = getDb();
      const original = db.transaction.bind(db);
      let moved: ReturnType<typeof subscriptionRepo.getSubscriptionById>;
      vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
        peer.prepare("UPDATE notification_subscriptions SET habitat_id = ? WHERE id = ?")
          .run(f.personal.id, f.foreign.id);
        moved = subscriptionRepo.getSubscriptionById(f.foreign.id);
        return original(work, config);
      }) as typeof db.transaction);
      const denied = await call(f, prefix, method, f.privateHabitat.id, f.foreign.id,
        method === "PUT" ? { enabled: false } : undefined);
      expect(denied.statusCode).toBe(method === "PUT" ? 404 : 200);
      expect(denied.json()).toEqual(method === "PUT"
        ? { error: "Subscription not found", code: "NOT_FOUND" } : { deleted: false });
      expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(moved!);
    });

    it(`${method} rechecks a personal Habitat moved into an inaccessible Team`, async () => {
      const f = fixture();
      const own = subscriptionRepo.createSubscription({ habitatId: f.personal.id,
        scope: "habitat_default", eventType: "task.assigned", channels: ["in_app"] });
      const before = subscriptionRepo.getSubscriptionById(own.id);
      const db = getDb();
      const original = db.transaction.bind(db);
      vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
        peer.prepare("UPDATE habitats SET team_id = ? WHERE id = ?").run(f.team.id, f.personal.id);
        return original(work, config);
      }) as typeof db.transaction);
      const denied = await call(f, prefix, method, f.personal.id, own.id,
        method === "PUT" ? { enabled: false } : undefined);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
      expect(subscriptionRepo.getSubscriptionById(own.id)).toEqual(before);
    });

    it(`${method} preserves the inaccessible URL Habitat denial`, async () => {
      const f = fixture();
      const before = subscriptionRepo.getSubscriptionById(f.foreign.id);
      const denied = await call(f, prefix, method, f.privateHabitat.id, f.foreign.id,
        method === "PUT" ? { enabled: false } : undefined);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
      expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(before);
    });
  }

  for (const shape of ["personal", "team"] as const) {
    it(`viewer preserves same-${shape}-Habitat updates, required flag protection and required deletion`, async () => {
      const f = fixture();
      if (shape === "team") memberRepo.addMember({ teamId: f.team.id, userId: f.userId });
      const habitatId = shape === "team" ? f.privateHabitat.id : f.personal.id;
      const own = subscriptionRepo.createSubscription({ habitatId, scope: "habitat_default",
        eventType: "task.assigned", required: true, channels: ["in_app"] });
      const denied = await call(f, prefix, "PUT", habitatId, own.id, { required: false });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "Only admins can change required flag", code: "FORBIDDEN" });
      expect(subscriptionRepo.getSubscriptionById(own.id)).toEqual(own);
      const allowed = await call(f, prefix, "PUT", habitatId, own.id, {
        enabled: false, channels: [], cadence: "daily", timezone: null,
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ id: own.id, habitatId, enabled: false,
        required: true, channels: [], cadence: "daily", timezone: null });
      expect(subscriptionRepo.getSubscriptionById(own.id)).toEqual(allowed.json());
      const deleted = await call(f, prefix, "DELETE", habitatId, own.id);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });
      expect(subscriptionRepo.getSubscriptionById(own.id)).toBeNull();
    });
  }

  it("keeps body validation and explicit required-flag ordering before scoped lookup", async () => {
    const f = fixture();
    const before = subscriptionRepo.getSubscriptionById(f.foreign.id);
    const malformed = await call(f, prefix, "PUT", f.personal.id, f.foreign.id, { enabled: "false" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("VALIDATION_ERROR");
    const required = await call(f, prefix, "PUT", f.personal.id, randomUUID(), { required: false });
    expect(required.statusCode).toBe(403);
    expect(required.json()).toEqual({ error: "Only admins can change required flag", code: "FORBIDDEN" });
    expect(subscriptionRepo.getSubscriptionById(f.foreign.id)).toEqual(before);
  });

  it("permits the existing admin required-flag update", async () => {
    const f = fixture();
    peer.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(f.userId);
    f.token = jwt.sign({ sub: f.userId, username: f.userId, role: "admin" }, getJwtSecret(), {
      issuer: "orcy", expiresIn: "1h",
    });
    const own = subscriptionRepo.createSubscription({ habitatId: f.personal.id,
      scope: "habitat_default", eventType: "task.assigned", required: false });
    const allowed = await call(f, prefix, "PUT", f.personal.id, own.id, { required: true });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ id: own.id, habitatId: f.personal.id, required: true });
    expect(subscriptionRepo.getSubscriptionById(own.id)).toEqual(allowed.json());
  });

  it("rolls back an update if its scoped result no longer belongs to the URL Habitat", async () => {
    const f = fixture();
    const own = subscriptionRepo.createSubscription({ habitatId: f.personal.id,
      scope: "habitat_default", eventType: "task.assigned", channels: ["in_app"] });
    // A native SQLite trigger changes scope after the UPDATE predicate. The
    // scoped response read must refuse and the service must roll back both writes.
    peer.exec(`CREATE TRIGGER issue50_move_after_update AFTER UPDATE ON notification_subscriptions
      WHEN NEW.id = '${own.id}' AND NEW.habitat_id = '${f.personal.id}'
      BEGIN UPDATE notification_subscriptions SET habitat_id = '${f.privateHabitat.id}'
      WHERE id = NEW.id; END`);
    try {
      const denied = await call(f, prefix, "PUT", f.personal.id, own.id, { enabled: false });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({ error: "Subscription not found", code: "NOT_FOUND" });
      expect(subscriptionRepo.getSubscriptionById(own.id)).toEqual(own);
    } finally {
      peer.exec("DROP TRIGGER issue50_move_after_update");
    }
  });

  it("protects an ordinary foreign row through both mutation methods", async () => {
    const f = fixture();
    const ordinary = subscriptionRepo.createSubscription({ habitatId: f.privateHabitat.id,
      scope: "recipient_override", recipientType: "human", recipientId: f.userId,
      eventType: "task.assigned", required: false, channels: ["in_app"] });
    const update = await call(f, prefix, "PUT", f.personal.id, ordinary.id, { enabled: false });
    expect(update.statusCode).toBe(404);
    expect(update.json()).toEqual({ error: "Subscription not found", code: "NOT_FOUND" });
    expect(subscriptionRepo.getSubscriptionById(ordinary.id)).toEqual(ordinary);
    const deletion = await call(f, prefix, "DELETE", f.personal.id, ordinary.id);
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json()).toEqual({ deleted: false });
    expect(subscriptionRepo.getSubscriptionById(ordinary.id)).toEqual(ordinary);
  });

});

it("preserves the trusted legacy migration updater without human scope admission", () => {
  const f = fixture();
  const own = subscriptionRepo.createSubscription({ habitatId: f.privateHabitat.id,
    scope: "recipient_override", recipientType: "human", recipientId: f.userId,
    eventType: "task.assigned", enabled: false, channels: ["in_app"] });
  const result = migrateLegacyPreferences(f.userId, f.privateHabitat.id);
  expect(result.errors).toEqual([]);
  expect(result.updated).toBe(1);
  expect(subscriptionRepo.getSubscriptionById(own.id)).toMatchObject({
    id: own.id, habitatId: f.privateHabitat.id, enabled: true, channels: ["in_app"],
  });

});
