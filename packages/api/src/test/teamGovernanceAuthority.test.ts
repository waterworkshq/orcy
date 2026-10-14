/** Real production SQLite + Fastify root error assembly for Team administration. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { users, governanceScopes, roleAssignments, roleDefinitions } from "../db/schema/index.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import { createTask } from "../repositories/taskCrud.js";

// Admission interposition is test-owned because prehandlers and writers are
// synchronous on one event loop. Production exposes no test authority bypass.
const seam = vi.hoisted(() => ({ afterAdmission: null as null | (() => void) }));
vi.mock("../middleware/team.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/team.js")>();
  return { ...actual, teamAdminOrOwner: async function teamAdminOrOwner(
    ...args: Parameters<typeof actual.teamAdminOrOwner>
  ) {
    await actual.teamAdminOrOwner(...args);
    seam.afterAdmission?.();
  } };
});

let app: HttpRuntimeHandle;
let directory: string;
let peer: Database.Database;

function makeUser(role: "admin" | "editor" | "viewer") {
  const id = randomUUID();
  getDb().insert(users).values({ id, username: id, passwordHash: "x", role }).run();
  return id;
}

function token(id: string, role: "admin" | "editor" | "viewer") {
  return jwt.sign({ sub: id, username: id, role }, getJwtSecret(), {
    issuer: "orcy", expiresIn: "1h",
  });
}

function fixture(ownerRole: "owner" | "admin" = "owner") {
  const ownerId = makeUser("editor");
  const targetId = makeUser("editor");
  const org = orgRepo.createOrganization({ name: "Authority", slug: randomUUID() });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "Team", slug: randomUUID() });
  memberRepo.addMember({ teamId: team.id, userId: ownerId, role: ownerRole });
  memberRepo.addMember({ teamId: team.id, userId: targetId, role: "member" });
  const habitat = habitatRepo.createHabitat({ name: "Habitat", teamId: team.id });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id,
    title: "Mission", createdBy: ownerId });
  const task = createTask({ missionId: mission.id, title: "Task", createdBy: ownerId });
  for (const [scopeKind, scopeId] of [
    ["team", team.id], ["habitat", habitat.id], ["mission", mission.id], ["task", task.id],
  ] as const) {
    getDb().insert(governanceScopes).values({ scopeKind, scopeId, incarnation: 1, version: 7 }).run();
    getDb().insert(roleAssignments).values({ id: randomUUID(), principalType: "human",
      principalId: targetId, definitionId: "builtin-role-review-coordinator",
      revisionId: "builtin-role-review-coordinator-rev-1", scopeKind, scopeId,
      scopeIncarnation: 1, state: "active", version: 1, issuerUserId: ownerId,
      issuedAt: new Date().toISOString() }).run();
  }
  getDb().insert(roleDefinitions).values({ id: randomUUID(), namespaceKind: "team",
    namespaceScopeId: team.id, namespaceIncarnation: 1, name: "Team role",
    latestRevision: 1 }).run();
  return { teamId: team.id, ownerId, targetId, habitatId: habitat.id, missionId: mission.id,
    taskId: task.id };
}

// Snapshot the whole protected aggregate, including retained custody history,
// namespace definitions, grants, member rows and audit. Peer authority changes
// happen before this snapshot, so those expected changes are not counted as writes.
function snapshot() {
  const tables = ["teams", "team_members", "habitats", "columns", "missions", "tasks",
    "governance_scopes", "role_definitions", "role_revisions", "role_assignments", "governance_audit"];
  return Object.fromEntries(tables.map(name => [name, peer.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

async function call(method: "DELETE" | "POST" | "PATCH", path: string, jwtToken: string,
  payload?: Record<string, unknown>, prefix = "/api/v1") {
  return app.inject({ method, url: prefix + path,
    headers: { authorization: `Bearer ${jwtToken}` },
    ...(payload === undefined ? {} : { payload }) });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "orcy-team-governance-"));
  const dbPath = join(directory, "authority.db");
  await initDb(dbPath);
  peer = new Database(dbPath);
  peer.pragma("foreign_keys = ON");
  peer.pragma("busy_timeout = 1000");
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
}, 30_000);

afterEach(() => { seam.afterAdmission = null; vi.restoreAllMocks(); });
afterAll(async () => {
  await app?.close();
  peer?.close();
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

type Fixture = ReturnType<typeof fixture>;
const operations = ["team-delete", "member-add", "member-role", "member-remove"] as const;
type Operation = typeof operations[number];
function input(operation: Operation, f: Fixture) {
  switch (operation) {
    case "team-delete": return { method: "DELETE" as const, path: `/teams/${f.teamId}`, status: 204 };
    case "member-add": return { method: "POST" as const, path: `/teams/${f.teamId}/members`,
      payload: { userId: makeUser("editor"), role: "admin" }, status: 201 };
    case "member-role": return { method: "PATCH" as const, path: `/teams/${f.teamId}/members/${f.targetId}`,
      payload: { role: "owner" }, status: 200 };
    case "member-remove": return { method: "DELETE" as const, path: `/teams/${f.teamId}/members/${f.targetId}`, status: 204 };
  }
}
async function send(i: ReturnType<typeof input>, actorToken: string, prefix = "/api/v1") {
  return call(i.method, i.path, actorToken, "payload" in i ? i.payload : undefined, prefix);
}

describe("current Team governor authority", () => {
  it("stale admin JWT cannot delete after persisted editor demotion", async () => {
    const f = fixture();
    const actorId = makeUser("admin");
    const oldToken = token(actorId, "admin");
    getDb().update(users).set({ role: "editor" }).where(eq(users.id, actorId)).run();
    const before = snapshot();
    const denied = await call("DELETE", `/teams/${f.teamId}`, oldToken);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(snapshot()).toEqual(before);
    // Same actor/token/input succeeds when the live persisted role permits it.
    getDb().update(users).set({ role: "admin" }).where(eq(users.id, actorId)).run();
    const allowed = await call("DELETE", `/teams/${f.teamId}`, oldToken);
    expect(allowed.statusCode).toBe(204);
  });
  it("same admitted Team delete refuses after owner demotion before reservation", async () => {
    const f = fixture();
    const ownerToken = token(f.ownerId, "editor");
    const db = getDb();
    const original = db.transaction.bind(db);
    let before: ReturnType<typeof snapshot> | undefined;
    let admissions = 0;
    // Test-owned bounded pre-reservation seam: the route's early prehandler
    // already admitted this request. No SQLite IMMEDIATE lock has been taken.
    // A separate real connection commits the demotion BEFORE original() runs;
    // this is deterministic reservation-time visibility, not lock contention.
    const reservation = vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
      admissions += 1;
      expect(config?.behavior).toBe("immediate");
      peer.transaction(() => peer.prepare(
        "UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?",
      ).run(f.teamId, f.ownerId)).immediate();
      before = snapshot();
      return original(work, config);
    }) as typeof db.transaction);
    const denied = await call("DELETE", `/teams/${f.teamId}`, ownerToken);
    reservation.mockRestore();
    expect(admissions).toBe(1);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(snapshot()).toEqual(before);
    memberRepo.updateMemberRole(f.teamId, f.ownerId, "owner");
    expect((await call("DELETE", `/teams/${f.teamId}`, ownerToken)).statusCode).toBe(204);
  });

  it("same admitted member add refuses after governor demotion", async () => {
    const f = fixture();
    const newUserId = makeUser("editor");
    const ownerToken = token(f.ownerId, "editor");
    let before: ReturnType<typeof snapshot> | undefined;
    let admissions = 0;
    seam.afterAdmission = () => {
      admissions += 1;
      peer.transaction(() => peer.prepare(
        "UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?",
      ).run(f.teamId, f.ownerId)).immediate();
      before = snapshot();
    };
    const payload = { userId: newUserId, role: "admin" };
    const denied = await call("POST", `/teams/${f.teamId}/members`, ownerToken, payload);
    seam.afterAdmission = null;
    expect(admissions).toBe(1);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(snapshot()).toEqual(before);
    memberRepo.updateMemberRole(f.teamId, f.ownerId, "owner");
    expect((await call("POST", `/teams/${f.teamId}/members`, ownerToken, payload)).statusCode).toBe(201);
  });

  it.each(["PATCH", "DELETE"] as const)(
    "same admitted member %s refuses after governor removal",
    async (method) => {
      const f = fixture();
      const ownerToken = token(f.ownerId, "editor");
      let before: ReturnType<typeof snapshot> | undefined;
      let admissions = 0;
      seam.afterAdmission = () => {
        admissions += 1;
        peer.transaction(() => peer.prepare(
          "DELETE FROM team_members WHERE team_id = ? AND user_id = ?",
        ).run(f.teamId, f.ownerId)).immediate();
        before = snapshot();
      };
      const path = `/teams/${f.teamId}/members/${f.targetId}`;
      const payload = method === "PATCH" ? { role: "owner" } : undefined;
      const denied = await call(method, path, ownerToken, payload);
      seam.afterAdmission = null;
      expect(admissions).toBe(1);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(snapshot()).toEqual(before);
      memberRepo.addMember({ teamId: f.teamId, userId: f.ownerId, role: "owner" });
      expect((await call(method, path, ownerToken, payload)).statusCode).toBe(method === "PATCH" ? 200 : 204);
    },
  );

  it.each(operations.flatMap(operation => (["editor", "viewer", "deleted"] as const).map(state =>
    ({ operation, state }))))("$operation denies old admin JWT for persisted $state", async ({ operation, state }) => {
    const f = fixture();
    const actorId = makeUser("admin");
    const oldToken = token(actorId, "admin");
    if (state === "deleted") getDb().delete(users).where(eq(users.id, actorId)).run();
    else getDb().update(users).set({ role: state }).where(eq(users.id, actorId)).run();
    const i = input(operation, f);
    const before = snapshot();
    const denied = await send(i, oldToken);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(snapshot()).toEqual(before);
    if (state === "deleted") getDb().insert(users).values({ id: actorId, username: actorId, passwordHash: "x", role: "admin" }).run();
    else getDb().update(users).set({ role: "admin" }).where(eq(users.id, actorId)).run();
    expect((await send(i, oldToken)).statusCode).toBe(i.status);
  });

  it.each(operations.flatMap(operation => (["owner", "admin"] as const).map(teamRole =>
    ({ operation, teamRole }))))("$operation denies persisted viewer retaining Team $teamRole", async ({ operation, teamRole }) => {
    const f = fixture(teamRole);
    getDb().update(users).set({ role: "viewer" }).where(eq(users.id, f.ownerId)).run();
    const oldToken = token(f.ownerId, "editor");
    const i = input(operation, f);
    const before = snapshot();
    expect((await send(i, oldToken)).statusCode).toBe(403);
    expect(snapshot()).toEqual(before);
    getDb().update(users).set({ role: "editor" }).where(eq(users.id, f.ownerId)).run();
    expect((await send(i, oldToken)).statusCode).toBe(i.status);
  });

  it.each(operations.flatMap(operation => (["owner", "admin", "global-admin"] as const).map(governor =>
    ({ operation, governor }))))("$operation permits live $governor with stale viewer JWT role", async ({ operation, governor }) => {
    const f = fixture(governor === "admin" ? "admin" : "owner");
    const actorId = governor === "global-admin" ? makeUser("admin") : f.ownerId;
    const i = input(operation, f);
    const prefix = governor === "admin" ? "/api" : "/api/v1";
    expect((await send(i, token(actorId, "viewer"), prefix)).statusCode).toBe(i.status);
  });

  it.each(operations.flatMap(operation => (["owner", "admin"] as const).flatMap(teamRole =>
    (["demoted", "removed"] as const).map(change => ({ operation, teamRole, change })))))
    ("$operation refuses SAME request when $teamRole is $change before reservation", async ({ operation, teamRole, change }) => {
      const f = fixture(teamRole);
      const actorToken = token(f.ownerId, "editor");
      const i = input(operation, f);
      const db = getDb();
      const original = db.transaction.bind(db);
      let before: ReturnType<typeof snapshot> | undefined;
      let reservations = 0;
      const intercepted = vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
        reservations += 1;
        expect(config?.behavior).toBe("immediate");
        peer.transaction(() => peer.prepare(change === "removed"
          ? "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
          : "UPDATE team_members SET role = 'member' WHERE team_id = ? AND user_id = ?"
        ).run(f.teamId, f.ownerId)).immediate();
        before = snapshot();
        return original(work, config);
      }) as typeof db.transaction);
      const denied = await send(i, actorToken, teamRole === "admin" ? "/api" : "/api/v1");
      intercepted.mockRestore();
      expect(reservations).toBe(1);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(snapshot()).toEqual(before);
      if (change === "removed") memberRepo.addMember({ teamId: f.teamId, userId: f.ownerId, role: teamRole });
      else memberRepo.updateMemberRole(f.teamId, f.ownerId, teamRole);
      expect((await send(i, actorToken)).statusCode).toBe(i.status);
    });

  it.each(operations)("%s denies operational grants to a nongovernor human", async operation => {
    const f = fixture(); // targetId holds real active operational grants.
    const before = snapshot();
    const i = input(operation, f);
    expect((await send(i, token(f.targetId, "editor"))).statusCode).toBe(403);
    expect(snapshot()).toEqual(before);
    expect((await send(i, token(f.ownerId, "editor"))).statusCode).toBe(i.status);
  });

  it("authorized Team delete retires custody, revokes grants and audits the real actor", async () => {
    const f = fixture();
    expect((await call("DELETE", `/teams/${f.teamId}`, token(f.ownerId, "editor"))).statusCode).toBe(204);
    expect(teamRepo.getTeamById(f.teamId)).toBeNull();
    expect(habitatRepo.getHabitatById(f.habitatId)?.teamId).toBeNull();
    expect(memberRepo.listMembers(f.teamId)).toEqual([]);
    for (const scopeId of [f.teamId, f.habitatId, f.missionId, f.taskId]) {
      const scopes = getDb().select().from(governanceScopes).where(eq(governanceScopes.scopeId, scopeId)).all();
      expect(scopes.find(row => row.incarnation === 1)).toMatchObject({ version: 8, retiredAt: expect.any(String) });
      if (scopeId !== f.teamId) expect(scopes.find(row => row.incarnation === 2)).toMatchObject({ version: 1, retiredAt: null });
      else expect(scopes).toHaveLength(1);
      const grants = getDb().select().from(roleAssignments).where(eq(roleAssignments.scopeId, scopeId)).all();
      expect(grants).toHaveLength(1);
      expect(grants[0]?.state).toBe("revoked");
      const audit = peer.prepare("SELECT actor_id, actor_type FROM governance_audit WHERE object_id = ?").all(scopeId);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit).toEqual(audit.map(() => ({ actor_id: f.ownerId, actor_type: "human" })));
    }
    const defs = getDb().select().from(roleDefinitions).where(eq(roleDefinitions.namespaceScopeId, f.teamId)).all();
    expect(defs).toHaveLength(1);
    expect(defs[0]?.retiredAt).toEqual(expect.any(String));
  });

  it("preserves source-specific missing Team, no-op remove and validation errors", async () => {
    const adminId = makeUser("admin");
    const editorId = makeUser("editor");
    const missing = randomUUID();
    expect((await call("DELETE", `/teams/${missing}`, token(adminId, "admin"))).statusCode).toBe(404);
    expect((await call("DELETE", `/teams/${missing}`, token(editorId, "editor"))).statusCode).toBe(403);
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const path = `/teams/${missing}/members` + (method === "POST" ? "" : `/${editorId}`);
      expect((await call(method, path, token(editorId, "editor"))).statusCode).toBe(404);
    }
    const f = fixture();
    const actor = token(f.ownerId, "editor");
    const before = snapshot();
    expect((await call("DELETE", `/teams/${f.teamId}/members/${randomUUID()}`, actor)).statusCode).toBe(204);
    expect((await call("PATCH", `/teams/${f.teamId}/members/${randomUUID()}`, actor, { role: "owner" })).statusCode).toBe(404);
    expect((await call("POST", `/teams/${f.teamId}/members`, actor, { userId: f.targetId })).statusCode).toBe(409);
    expect((await call("POST", `/teams/${f.teamId}/members`, actor, { userId: "invalid" })).statusCode).toBe(400);
    expect((await call("PATCH", `/teams/${f.teamId}/members/${f.targetId}`, actor, { role: "viewer" })).statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
    // Ordinary Team reads retain their human-authenticated policy.
    expect((await app.inject({ method: "GET", url: `/api/v1/teams/${f.teamId}`,
      headers: { authorization: `Bearer ${token(makeUser("viewer"), "viewer")}` } })).statusCode).toBe(200);
  });

  it.each([
    { operation: "team-delete" as const, change: "deleted" as const },
    { operation: "member-role" as const, change: "viewer" as const },
  ])("$operation rereads persisted user $change inside the reservation", async ({ operation, change }) => {
    const f = fixture();
    const actorId = change === "deleted" ? makeUser("admin") : f.ownerId;
    const actorToken = token(actorId, change === "deleted" ? "admin" : "editor");
    const i = input(operation, f);
    const db = getDb();
    const original = db.transaction.bind(db);
    let before: ReturnType<typeof snapshot> | undefined;
    let reservations = 0;
    const intercepted = vi.spyOn(db, "transaction").mockImplementation(((work, config) => {
      reservations += 1;
      expect(config?.behavior).toBe("immediate");
      peer.transaction(() => peer.prepare(change === "deleted"
        ? "DELETE FROM users WHERE id = ?" : "UPDATE users SET role = 'viewer' WHERE id = ?"
      ).run(actorId)).immediate();
      before = snapshot();
      return original(work, config);
    }) as typeof db.transaction);
    const denied = await send(i, actorToken);
    intercepted.mockRestore();
    expect(reservations).toBe(1);
    expect(denied.statusCode).toBe(403);
    expect(snapshot()).toEqual(before);
    if (change === "deleted") getDb().insert(users).values({ id: actorId, username: actorId, passwordHash: "x", role: "admin" }).run();
    else getDb().update(users).set({ role: "editor" }).where(eq(users.id, actorId)).run();
    expect((await send(i, actorToken)).statusCode).toBe(i.status);
  });

});
