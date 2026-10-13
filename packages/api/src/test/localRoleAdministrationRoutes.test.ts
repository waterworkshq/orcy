/**
 * Local role administration routes — real-HTTP proofs (administration ticket).
 *
 * Real Fastify root error handler + real production surface: the 13
 * governance commands over inject() with real JWT login. Covers the
 * acceptance matrix: positive governor flows, viewer/member/outsider/agent
 * denials, missing-target 404 BEFORE governor 403 (no existence leak),
 * stale incarnation/scope/object CAS with exact conflict codes and no
 * partial writes, regrant disposition, revision pinning, built-in
 * immutability, expiry normalization, owner set/clear global-admin-only,
 * Team-binding create (UI compat), and custody transitions (team delete
 * reenroll, habitat/mission/task/agent).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import {
  governanceAudit,
  governanceScopes,
  habitats,
  organizations,
  roleAssignments,
  roleDefinitions,
  teams,
  users,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { createTask as createTaskRepo } from "../repositories/taskCrud.js";
import { deleteTask } from "../services/tasks/index.js";
import { deleteMission } from "../services/missionService.js";
import {
  evaluatePermissionsWithClient,
  getScopeStateWithClient,
} from "../services/localAuthorization.js";

type App = {
  inject: (o: unknown) => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
  installPluginRoutes: (c: unknown[]) => Promise<void>;
  finalize: () => Promise<void>;
};

let app: App;
const tokens = new Map<string, string>();

function makeUser(role: "admin" | "editor" | "viewer"): string {
  const id = uuid();
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", role })
    .run();
  return id;
}

function makeTeam(ownerUserId: string): string {
  const orgId = uuid();
  getDb().insert(organizations).values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` }).run();
  const teamId = uuid();
  getDb()
    .insert(teams)
    .values({ id: teamId, organizationId: orgId, name: `t-${teamId}`, slug: `t-${teamId}` })
    .run();
  teamMemberRepo.addMember({ teamId, userId: ownerUserId, role: "owner" });
  return teamId;
}

function makeTeamHabitat(teamId: string): string {
  return habitatRepo.createHabitat({ name: `h-${uuid().slice(0, 8)}`, teamId }).id;
}

function seedDescendants(habitatId: string): { missionId: string; taskId: string } {
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "m",
    createdBy: "u",
  });
  const task = createTaskRepo({ missionId: mission.id, title: "t", createdBy: "u" });
  return { missionId: mission.id, taskId: task.id };
}

async function login(userId: string): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;
  const { hash } = (await import("bcryptjs")) as { hash: (p: string, s: number) => Promise<string> };
  const u = getDb().select().from(users).where(eq(users.id, userId)).get()!;
  getDb()
    .update(users)
    .set({ passwordHash: await hash("pw-admin-t", 4) })
    .where(eq(users.id, userId))
    .run();
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: u.username, password: "pw-admin-t" },
  });
  const token = (JSON.parse(res.body) as { token: string }).token;
  tokens.set(userId, token);
  return token;
}

async function call(
  method: string,
  url: string,
  actor: string | null,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (actor) headers.authorization = `Bearer ${await login(actor)}`;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* 204 no body */
  }
  return { statusCode: res.statusCode, body };
}

function auditCount(objectId: string): number {
  return (
    getDb()
      .select({ id: governanceAudit.id })
      .from(governanceAudit)
      .where(eq(governanceAudit.objectId, objectId))
      .all().length
  );
}

/** The active ledger version for a habitat scope, or undefined if virtual. */
function scopeVersionFor(habitatId: string): number | undefined {
  return getDb()
    .select({ version: governanceScopes.version })
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, "habitat"), eq(governanceScopes.scopeId, habitatId)))
    .all()[0]?.version;
}

function scopeRows(kind: string, id: string) {
  return getDb()
    .select()
    .from(governanceScopes)
    .where(
      and(eq(governanceScopes.scopeKind, kind as never), eq(governanceScopes.scopeId, id)),
    )
    .all();
}

beforeEach(async () => {
  await initTestDb();
  const { createHttpApplication } = await import("../httpApp.js");
  app = (await createHttpApplication({ logger: false })) as unknown as App;
  await app.installPluginRoutes([]);
  await app.finalize();
});

afterEach(async () => {
  await app.close();
  await closeDb();
});

// ---------------------------------------------------------------------------
// 1. GET /permissions
// ---------------------------------------------------------------------------

describe("GET /permissions", () => {
  it("serves the fixed catalogue to any authenticated human; 401 unauthenticated", async () => {
    const editor = makeUser("editor");
    const res = await call("GET", "/api/v1/permissions", editor);
    expect(res.statusCode).toBe(200);
    expect(res.body.catalogueVersion).toBe(1);
    expect(res.body.permissions).toEqual(["review.configure", "review.assign"]);

    const anon = await call("GET", "/api/v1/permissions", null);
    expect(anon.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2-8. Definition lifecycle
// ---------------------------------------------------------------------------

describe("definitions", () => {
  it("governor creates → mints → retires with CAS and audit at each step", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);

    const create = await call("POST", `/api/v1/teams/${teamId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Auditor",
      permissions: ["review.configure"],
    });
    expect(create.statusCode).toBe(201);
    const def = create.body.definition as Record<string, unknown>;
    expect(def.latestRevision).toBe(1);
    expect(auditCount(def.id as string)).toBeGreaterThanOrEqual(1);

    // Virtual scope materialized at (1,1), now version 2.
    const roles = await call("GET", `/api/v1/roles?scopeKind=team&scopeId=${teamId}`, owner);
    expect(roles.statusCode).toBe(200);
    expect(roles.body.incarnation).toBe(1);
    expect(roles.body.version).toBe(2);

    const mint = await call("POST", `/api/v1/role-definitions/${def.id}/revisions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedLatestRevision: 1,
      permissions: ["review.configure", "review.assign"],
    });
    expect(mint.statusCode).toBe(201);
    expect((mint.body.revision as Record<string, unknown>).ordinal).toBe(2);

    const retire = await call("POST", `/api/v1/role-definitions/${def.id}/retire`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
      expectedLatestRevision: 2,
      reason: "obsolete",
    });
    expect(retire.statusCode).toBe(200);
    expect(retire.body.revokedAssignments).toBe(0);
    expect((retire.body.definition as Record<string, unknown>).retiredAt).not.toBeNull();
  });

  it("stale scope version CAS → 409 GOVERNANCE_VERSION_CONFLICT, nothing written", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const stale = await call("POST", `/api/v1/teams/${teamId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 5, // virtual scope is at 1
      name: "Ghost",
      permissions: ["review.assign"],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("GOVERNANCE_VERSION_CONFLICT");
    // Rollback proof: no definition row, ledger never materialized.
    expect(
      getDb().select().from(roleDefinitions).where(eq(roleDefinitions.name, "Ghost")).all(),
    ).toHaveLength(0);
    expect(scopeRows("team", teamId)).toHaveLength(0);
  });

  it("stale incarnation → 409 even at matching version", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const res = await call("POST", `/api/v1/teams/${teamId}/role-definitions`, owner, {
      scopeIncarnation: 2,
      expectedScopeVersion: 1,
      name: "WrongInc",
      permissions: ["review.assign"],
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("GOVERNANCE_VERSION_CONFLICT");
  });

  it("member/viewer/outsider denied 403 AUTHORIZATION_DENIED; missing team 404 for anyone", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const member = makeUser("editor");
    teamMemberRepo.addMember({ teamId, userId: member, role: "member" });
    const viewer = makeUser("viewer"); // global viewer ceiling
    const outsider = makeUser("editor");
    const body = {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Nope",
      permissions: ["review.assign"],
    };
    for (const actor of [member, viewer, outsider]) {
      const res = await call("POST", `/api/v1/teams/${teamId}/role-definitions`, actor, body);
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("AUTHORIZATION_DENIED");
    }
    // Missing team: 404 BEFORE governor check — a global admin and a
    // non-member both see 404, never a 403 existence leak.
    const admin = makeUser("admin");
    expect(
      (await call("POST", `/api/v1/teams/${uuid()}/role-definitions`, admin, body)).statusCode,
    ).toBe(404);
    expect(
      (await call("POST", `/api/v1/teams/${uuid()}/role-definitions`, outsider, body)).statusCode,
    ).toBe(404);
  });

  it("built-in definitions are immutable (mint/retire → 409 ROLE_REVISION_CONFLICT)", async () => {
    const admin = makeUser("admin");
    const mint = await call(
      "POST",
      "/api/v1/role-definitions/builtin-role-coordinator/revisions",
      admin,
      {
        scopeIncarnation: 1,
        expectedScopeVersion: 1,
        expectedLatestRevision: 1,
        permissions: ["review.assign"],
      },
    );
    expect(mint.statusCode).toBe(409);
    expect(mint.body.code).toBe("ROLE_REVISION_CONFLICT");

    const retire = await call(
      "POST",
      "/api/v1/role-definitions/builtin-role-coordinator/retire",
      admin,
      { scopeIncarnation: 1, expectedScopeVersion: 1, expectedLatestRevision: 1, reason: "no" },
    );
    expect(retire.statusCode).toBe(409);
  });

  it("GET /role-definitions/:id shows built-ins to any human with revision history", async () => {
    const viewer = makeUser("viewer");
    const res = await call("GET", "/api/v1/role-definitions/builtin-role-coordinator", viewer);
    expect(res.statusCode).toBe(200);
    const def = res.body.definition as Record<string, unknown>;
    expect(def.isBuiltin).toBe(true);
    expect((res.body.revisions as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(res.body.namespace).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9-11. Assignment commands
// ---------------------------------------------------------------------------

describe("assignments", () => {
  async function seedGrant(): Promise<{
    owner: string;
    teamId: string;
    habitatId: string;
    revisionId: string;
    definitionId: string;
    agentId: string;
  }> {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `Custom-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    expect(def.statusCode).toBe(201);
    return {
      owner,
      teamId,
      habitatId,
      revisionId: (def.body.revision as Record<string, string>).id,
      definitionId: (def.body.definition as Record<string, string>).id,
      agentId: agentRepo.createAgent({
        name: `a-${uuid().slice(0, 6)}`,
        type: "claude-code",
        domain: "backend",
      }).agent.id,
    };
  }

  it("governor assigns to agent; regrant revokes old row and mints a fresh ID", async () => {
    const s = await seedGrant();
    const mk = (version: number, expiresAt?: string) =>
      call("POST", "/api/v1/role-assignments", s.owner, {
        principalType: "agent",
        principalId: s.agentId,
        revisionId: s.revisionId,
        scopeKind: "habitat",
        scopeId: s.habitatId,
        scopeIncarnation: 1,
        expectedScopeVersion: version,
        ...(expiresAt ? { expiresAt } : {}),
      });
    const first = await mk(2);
    expect(first.statusCode).toBe(201);
    const a1 = first.body.assignment as Record<string, unknown>;
    expect(a1.state).toBe("active");
    expect(a1.version).toBe(1);

    // Regrant with a new expiry in the same tuple → old revoked("regranted"),
    // fresh ID at version 1.
    const second = await mk(3, "2999-01-01T00:00:00.000Z");
    expect(second.statusCode).toBe(201);
    const a2 = second.body.assignment as Record<string, unknown>;
    expect(a2.id).not.toBe(a1.id);

    const after = await call(
      "GET",
      `/api/v1/role-assignments?scopeKind=habitat&scopeId=${s.habitatId}`,
      s.owner,
    );
    const rows = after.body.assignments as Array<Record<string, unknown>>;
    const oldRow = rows.find((x) => x.id === a1.id)!;
    expect(oldRow.state).toBe("revoked");
    expect(oldRow.revokeReason).toBe("regranted");
    expect(rows.find((x) => x.id === a2.id)!.state).toBe("active");
  });

  it("offset expiry is normalized to canonical UTC before storage; malformed/date-only refused 400 with no writes", async () => {
    const s = await seedGrant();
    // A definition carrying `review.configure` — the permission whose SERVED
    // target is the habitat itself (review.assign is served only against a
    // task), so the evaluator's expiry verdict can be observed here.
    const cfg = await call("POST", `/api/v1/habitats/${s.habitatId}/role-definitions`, s.owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      name: `Configure-${uuid().slice(0, 6)}`,
      permissions: ["review.configure"],
    });
    expect(cfg.statusCode).toBe(201);
    const cfgRevision = (cfg.body.revision as Record<string, string>).id;

    const base = {
      principalType: "agent",
      principalId: s.agentId,
      revisionId: cfgRevision,
      scopeKind: "habitat",
      scopeId: s.habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
    };

    // R5: a valid ISO instant carrying an OFFSET is a legal public input; it
    // is canonicalized to UTC before storage (the evaluator requires
    // canonical UTC on stored strings, which is a STORAGE rule, not an input
    // rule). 2020-01-01T00:00:00+02:00 is the same instant as
    // 2019-12-31T22:00:00.000Z.
    const offset = await call("POST", "/api/v1/role-assignments", s.owner, {
      ...base,
      expiresAt: "2020-01-01T00:00:00+02:00",
    });
    expect(offset.statusCode).toBe(201);
    const stored = (offset.body.assignment as Record<string, unknown>).expiresAt;
    expect(stored).toBe("2019-12-31T22:00:00.000Z");

    // The stored canonical form is what the evaluator reads back: the grant is
    // in the past relative to now, so it contributes no authority.
    const expiredDecision = evaluatePermissionsWithClient(
      getDb(),
      { type: "agent", id: s.agentId },
      "review.configure",
      { scopeKind: "habitat", scopeId: s.habitatId },
    );
    expect(expiredDecision.allowed).toBe(false);
    expect(expiredDecision.allowed === false ? expiredDecision.reason : null).toBe("EXPIRED_GRANT");

    // Positive control on the SAME evaluator: a future expiry IS honored, so
    // the denial above is caused by the stored (correctly normalized) instant,
    // not by the evaluator refusing agent grants outright.
    const future = await call("POST", "/api/v1/role-assignments", s.owner, {
      ...base,
      expectedScopeVersion: 4,
      expiresAt: "2999-01-01T02:00:00+03:00",
    });
    expect(future.statusCode).toBe(201);
    const liveDecision = evaluatePermissionsWithClient(
      getDb(),
      { type: "agent", id: s.agentId },
      "review.configure",
      { scopeKind: "habitat", scopeId: s.habitatId },
    );
    expect(liveDecision.allowed).toBe(true);

    // Inputs that are NOT instants are still refused at the boundary, and the
    // refusal writes nothing: date-only (no timezone/offset), prose, malformed
    // text, and an impossible calendar instant.
    const versionBefore = 5; // configure-def (2->3), offset grant (3->4), future grant (4->5)
    const refusals: Array<[string, string]> = [
      ["date-only", "2020-01-01"],
      ["prose", "next tuesday"],
      ["malformed", "2020/01/01 00:00"],
      ["impossible-day", "2020-02-31T00:00:00Z"],
      ["impossible-hour", "2020-01-01T25:00:00Z"],
    ];
    for (const [label, value] of refusals) {
      const before = getDb().select().from(roleAssignments).all().length;
      const res = await call("POST", "/api/v1/role-assignments", s.owner, {
        ...base,
        expectedScopeVersion: versionBefore,
        expiresAt: value,
      });
      expect(`${label}:${res.statusCode}`).toBe(`${label}:400`);
      // No partial write on a refused expiry.
      expect(getDb().select().from(roleAssignments).all().length).toBe(before);
    }
    // Ledger untouched by all five refusals.
    expect(scopeVersionFor(s.habitatId)).toBe(versionBefore);
  });

  it("missing typed principal 404 before governor 403; namespace mismatch 400", async () => {
    const s = await seedGrant();
    // Unknown agent principal: scope exists, principal row missing → 404
    // even for the governor.
    const noPrincipal = await call("POST", "/api/v1/role-assignments", s.owner, {
      principalType: "agent",
      principalId: "agent-does-not-exist",
      revisionId: s.revisionId,
      scopeKind: "habitat",
      scopeId: s.habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(noPrincipal.statusCode).toBe(404);

    // Team-namespace definition assigned at a habitat OUTSIDE that team → 400.
    // The actor must clear the governor gate first (global admin governs any
    // habitat), otherwise 403 fires before the namespace check.
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const def = await call("POST", `/api/v1/teams/${teamId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `TeamOnly-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const personal = habitatRepo.createHabitat({ name: `p-${uuid().slice(0, 6)}` });
    const res = await call("POST", "/api/v1/role-assignments", makeUser("admin"), {
      principalType: "human",
      principalId: owner,
      revisionId: (def.body.revision as Record<string, string>).id,
      scopeKind: "habitat",
      scopeId: personal.id,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(res.statusCode).toBe(400);
  });

  it("repin CAS (ROLE_ASSIGNMENT_VERSION_CONFLICT) and revoke → 204 retained row", async () => {
    const s = await seedGrant();
    const mint = await call(
      "POST",
      `/api/v1/role-definitions/${s.definitionId}/revisions`,
      s.owner,
      {
        scopeIncarnation: 1,
        expectedScopeVersion: 2,
        expectedLatestRevision: 1,
        permissions: ["review.assign", "review.configure"],
      },
    );
    expect(mint.statusCode).toBe(201);
    const rev2 = (mint.body.revision as Record<string, string>).id;

    const assign = await call("POST", "/api/v1/role-assignments", s.owner, {
      principalType: "agent",
      principalId: s.agentId,
      revisionId: s.revisionId,
      scopeKind: "habitat",
      scopeId: s.habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
    });
    expect(assign.statusCode).toBe(201);
    const a = assign.body.assignment as Record<string, unknown>;

    // Stale assignment version → exact conflict code.
    const stale = await call("POST", `/api/v1/role-assignments/${a.id}/revisions`, s.owner, {
      revisionId: rev2,
      scopeIncarnation: 1,
      expectedScopeVersion: 4,
      expectedAssignmentVersion: 99,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("ROLE_ASSIGNMENT_VERSION_CONFLICT");

    const ok = await call("POST", `/api/v1/role-assignments/${a.id}/revisions`, s.owner, {
      revisionId: rev2,
      scopeIncarnation: 1,
      expectedScopeVersion: 4,
      expectedAssignmentVersion: 1,
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.body.assignment as Record<string, unknown>).revisionId).toBe(rev2);

    const revoke = await call("DELETE", `/api/v1/role-assignments/${a.id}`, s.owner, {
      reason: "done",
      scopeIncarnation: 1,
      expectedScopeVersion: 5,
      expectedAssignmentVersion: 2,
    });
    expect(revoke.statusCode).toBe(204);
    const row = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, a.id as string))
      .get()!;
    expect(row.state).toBe("revoked");
    expect(row.revokeReason).toBe("done");
  });

  it("assignment listing: governor 200, outsider 403, missing scope 404", async () => {
    const s = await seedGrant();
    const outsider = makeUser("editor");
    expect(
      (
        await call(
          "GET",
          `/api/v1/role-assignments?scopeKind=habitat&scopeId=${s.habitatId}`,
          s.owner,
        )
      ).statusCode,
    ).toBe(200);
    const denied = await call(
      "GET",
      `/api/v1/role-assignments?scopeKind=habitat&scopeId=${s.habitatId}`,
      outsider,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body.code).toBe("AUTHORIZATION_DENIED");
    expect(
      (
        await call(
          "GET",
          "/api/v1/role-assignments?scopeKind=habitat&scopeId=hab-missing",
          makeUser("admin"),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("minting a new revision never auto-upgrades existing assignments (pinning)", async () => {
    const s = await seedGrant();
    const assign = await call("POST", "/api/v1/role-assignments", s.owner, {
      principalType: "agent",
      principalId: s.agentId,
      revisionId: s.revisionId,
      scopeKind: "habitat",
      scopeId: s.habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(assign.statusCode).toBe(201); // a non-201 pins rev 1 for the wrong reason
    const a = assign.body.assignment as Record<string, string>;
    const mint = await call("POST", `/api/v1/role-definitions/${s.definitionId}/revisions`, s.owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
      expectedLatestRevision: 1,
      permissions: ["review.configure"],
    });
    expect(mint.statusCode).toBe(201); // a failed mint leaves nothing new to pin against
    expect((mint.body.revision as Record<string, unknown>).ordinal).toBe(2);
    const row = getDb().select().from(roleAssignments).where(eq(roleAssignments.id, a.id)).get()!;
    expect(row.revisionId).toBe(s.revisionId); // still pinned to rev 1
  });

  it("issuance refuses a permission/scope pair outside the fixed catalogue — review.configure at a Task scope is 400 with no write, not an inert 201", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { taskId } = seedDescendants(habitatId);
    const agentId = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;

    // A custom revision carrying ONLY review.configure (valid at Team/Habitat,
    // not assignable at Task).
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `CfgOnly-${uuid().slice(0, 6)}`,
      permissions: ["review.configure"],
    });
    expect(def.statusCode).toBe(201);
    const revisionId = (def.body.revision as Record<string, string>).id;

    // Issuance at a Task scope: the catalogue pair (review.configure, task) is
    // invalid → 400. A 201 here would mean the row is accepted but inert (the
    // evaluator's MALFORMED_PERMISSION filter silently drops it), which is the
    // exact issuance-contract defect: acceptance must not precede refusal.
    const beforeAssignments = getDb().select().from(roleAssignments).all().length;
    const beforeVersion = scopeVersionFor(habitatId);
    const res = await call("POST", "/api/v1/role-assignments", makeUser("admin"), {
      principalType: "agent",
      principalId: agentId,
      revisionId,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(res.statusCode).toBe(400);

    // No row, no ledger bump — the refusal is clean under the reservation.
    expect(getDb().select().from(roleAssignments).all().length).toBe(beforeAssignments);
    expect(scopeVersionFor(habitatId)).toBe(beforeVersion);
  });

  it("DELETE /role-assignments enforces the assignment-object CAS: a stale expectedAssignmentVersion is 409 with no row touched", async () => {
    const s = await seedGrant();
    const assign = await call("POST", "/api/v1/role-assignments", s.owner, {
      principalType: "agent",
      principalId: s.agentId,
      revisionId: s.revisionId,
      scopeKind: "habitat",
      scopeId: s.habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(assign.statusCode).toBe(201);
    const a = assign.body.assignment as Record<string, unknown>;
    expect(a.version).toBe(1);

    // The object-version CAS is mandatory on this command: supplying the
    // WRONG assignment version (a concurrent writer already bumped it to 2
    // via the repin below) must refuse — before the scope CAS, before any
    // row write. Scope CAS alone is not a substitute for the object check.
    const repin = await call("POST", `/api/v1/role-assignments/${a.id}/revisions`, s.owner, {
      revisionId: s.revisionId,
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
      expectedAssignmentVersion: 1,
    });
    expect(repin.statusCode).toBe(200);
    expect((repin.body.assignment as Record<string, unknown>).version).toBe(2);

    const beforeRow = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, a.id as string))
      .get()!;
    expect(beforeRow.state).toBe("active");

    // Stale object version → 409 ROLE_ASSIGNMENT_VERSION_CONFLICT.
    const auditBefore = auditCount(a.id as string);
    const stale = await call("DELETE", `/api/v1/role-assignments/${a.id}`, s.owner, {
      reason: "stale object version",
      scopeIncarnation: 1,
      expectedScopeVersion: 4,
      expectedAssignmentVersion: 1, // the OLD version — no longer current
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("ROLE_ASSIGNMENT_VERSION_CONFLICT");

    // The row is untouched: still active, still version 2, no bump leaked,
    // and no audit row appeared for the refused command.
    const afterRow = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, a.id as string))
      .get()!;
    expect(afterRow.state).toBe("active");
    expect(afterRow.version).toBe(2);
    expect(afterRow.revokeReason).toBeNull();
    expect(auditCount(a.id as string)).toBe(auditBefore);

    // Correct object version succeeds and bumps to 3.
    const ok = await call("DELETE", `/api/v1/role-assignments/${a.id}`, s.owner, {
      reason: "done",
      scopeIncarnation: 1,
      expectedScopeVersion: 4,
      expectedAssignmentVersion: 2,
    });
    expect(ok.statusCode).toBe(204);
    const finalRow = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, a.id as string))
      .get()!;
    expect(finalRow.state).toBe("revoked");
    expect(finalRow.version).toBe(3);
  });

  it("adoption refuses a revision whose permissions are not all assignable at the assignment scope — assign-only Task assignment adopting a configure-containing revision is 400 with no assignment/version/scope/audit changes", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { taskId } = seedDescendants(habitatId);
    const agentId = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;

    // Revision 1 carries ONLY review.assign (valid at Task). Revision 2 adds
    // review.configure (NOT assignable at Task) — a "mixed" revision.
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `Adopt-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    expect(def.statusCode).toBe(201);
    const definitionId = (def.body.definition as Record<string, string>).id;
    const rev1Id = (def.body.revision as Record<string, string>).id;
    const mint = await call("POST", `/api/v1/role-definitions/${definitionId}/revisions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedLatestRevision: 1,
      permissions: ["review.assign", "review.configure"],
    });
    expect(mint.statusCode).toBe(201);
    const rev2Id = (mint.body.revision as Record<string, string>).id;

    // Grant review.assign at the Task scope (assign-only at Task is valid).
    // The assignment scope is the TASK, whose ledger is virtual at (1,1) —
    // the scope CAS targets the Task scope, not the habitat.
    const assign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agentId,
      revisionId: rev1Id,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(assign.statusCode).toBe(201);
    const a = assign.body.assignment as Record<string, unknown>;
    const assignmentId = a.id as string;

    // Snapshot pre-adoption state for the no-partial-write assertion. The
    // adoption scope is the Task scope (version 2 after the grant's bump).
    const rowBefore = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, assignmentId))
      .get()!;
    const taskScopeBefore = scopeRows("task", taskId);
    const auditBefore = auditCount(assignmentId);

    // Adoption of the mixed revision at the Task scope: 400. A 200 here would
    // silently widen the grant past the fixed catalogue — the exact
    // adoption-contract defect.
    const adopt = await call("POST", `/api/v1/role-assignments/${assignmentId}/revisions`, owner, {
      revisionId: rev2Id,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedAssignmentVersion: 1,
    });
    expect(adopt.statusCode).toBe(400);

    // No assignment/version/scope/audit change on refusal.
    const rowAfter = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, assignmentId))
      .get()!;
    expect(rowAfter.revisionId).toBe(rev1Id); // still pinned to rev 1
    expect(rowAfter.version).toBe(rowBefore.version); // object version untouched
    expect(scopeRows("task", taskId)).toEqual(taskScopeBefore); // task scope version untouched
    expect(auditCount(assignmentId)).toBe(auditBefore); // no audit row for refused command
  });

  it("adoption positive: an assign-only Task assignment can adopt another assign-only revision (valid at Task)", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { taskId } = seedDescendants(habitatId);
    const agentId = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;

    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `OkAdopt-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const definitionId = (def.body.definition as Record<string, string>).id;
    const rev1Id = (def.body.revision as Record<string, string>).id;
    // Mint a SECOND assign-only revision (different permission set shape, but
    // still assign-only → still valid at Task).
    const mint = await call("POST", `/api/v1/role-definitions/${definitionId}/revisions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedLatestRevision: 1,
      permissions: ["review.assign"],
    });
    expect(mint.statusCode).toBe(201);
    const rev2Id = (mint.body.revision as Record<string, string>).id;
    expect(rev2Id).not.toBe(rev1Id);

    const assign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agentId,
      revisionId: rev1Id,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1, // task scope is virtual at 1
    });
    expect(assign.statusCode).toBe(201);
    const a = assign.body.assignment as Record<string, unknown>;

    const adopt = await call("POST", `/api/v1/role-assignments/${a.id as string}/revisions`, owner, {
      revisionId: rev2Id,
      scopeIncarnation: 1,
      expectedScopeVersion: 2, // task scope bumped to 2 by the grant
      expectedAssignmentVersion: 1,
    });
    expect(adopt.statusCode).toBe(200);
    expect((adopt.body.assignment as Record<string, unknown>).revisionId).toBe(rev2Id);
    expect((adopt.body.assignment as Record<string, unknown>).version).toBe(2);
  });

  it("adoption positive: assign-only at Mission scope succeeds; configure-containing revision adoption succeeds at Habitat scope (both valid catalogue pairs)", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { missionId } = seedDescendants(habitatId);
    const agentId = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;

    // A definition that starts assign-only, then mints a mixed revision.
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `PosAdopt-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const definitionId = (def.body.definition as Record<string, string>).id;
    const rev1Id = (def.body.revision as Record<string, string>).id;
    const mint = await call("POST", `/api/v1/role-definitions/${definitionId}/revisions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedLatestRevision: 1,
      permissions: ["review.assign", "review.configure"],
    });
    const rev2MixedId = (mint.body.revision as Record<string, string>).id;

    // Positive 1: assign-only Mission-scoped assignment adopting an assign-only
    // revision (review.assign IS assignable at Mission). Mission scope is
    // virtual at 1; the grant bumps it to 2; the adoption CASes against 2.
    const missionAssign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agentId,
      revisionId: rev1Id,
      scopeKind: "mission",
      scopeId: missionId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(missionAssign.statusCode).toBe(201);
    const m = missionAssign.body.assignment as Record<string, unknown>;
    const missionAdopt = await call(
      "POST",
      `/api/v1/role-assignments/${m.id as string}/revisions`,
      owner,
      {
        revisionId: rev1Id, // same assign-only revision — a no-op-ish but legal re-pin
        scopeIncarnation: 1,
        expectedScopeVersion: 2,
        expectedAssignmentVersion: 1,
      },
    );
    expect(missionAdopt.statusCode).toBe(200);

    // Positive 2: Habitat-scoped assignment adopting the MIXED revision
    // succeeds — review.configure IS assignable at Habitat. The habitat scope
    // is at version 3 after the definition-create (1→2) and mint (2→3); the
    // grant bumps to 4; the adoption CASes against 4.
    const habitatAssign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agentId,
      revisionId: rev1Id,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
    });
    expect(habitatAssign.statusCode).toBe(201);
    const h = habitatAssign.body.assignment as Record<string, unknown>;
    const habitatAdopt = await call(
      "POST",
      `/api/v1/role-assignments/${h.id as string}/revisions`,
      owner,
      {
        revisionId: rev2MixedId,
        scopeIncarnation: 1,
        expectedScopeVersion: 4,
        expectedAssignmentVersion: 1,
      },
    );
    expect(habitatAdopt.statusCode).toBe(200);
    expect((habitatAdopt.body.assignment as Record<string, unknown>).revisionId).toBe(rev2MixedId);
  });
});

// ---------------------------------------------------------------------------
// 12-13. Personal owner commands
// ---------------------------------------------------------------------------

describe("personal owner commands", () => {
  it("global admin sets/transfers/clears; non-admin 403; team habitat 409; stale CAS 409; missing 404", async () => {
    const admin = makeUser("admin");
    const owner = makeUser("editor");
    const personal = habitatRepo.createHabitat({ name: `po-${uuid().slice(0, 6)}` });

    const set = await call("PUT", `/api/v1/habitats/${personal.id}/owner`, admin, {
      ownerUserId: owner,
      reason: "initial assignment",
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(set.statusCode).toBe(200);
    expect(
      getDb()
        .select({ o: habitats.ownerUserId })
        .from(habitats)
        .where(eq(habitats.id, personal.id))
        .get()?.o,
    ).toBe(owner);

    // The personal owner themself is NOT a global admin → 403.
    const selfSet = await call("PUT", `/api/v1/habitats/${personal.id}/owner`, owner, {
      ownerUserId: owner,
      reason: "self",
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(selfSet.statusCode).toBe(403);

    // Stale CAS.
    const stale = await call("DELETE", `/api/v1/habitats/${personal.id}/owner`, admin, {
      reason: "clearing",
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("GOVERNANCE_VERSION_CONFLICT");

    // Viewer target rejected 400.
    const viewer = makeUser("viewer");
    const viewerTarget = await call("PUT", `/api/v1/habitats/${personal.id}/owner`, admin, {
      ownerUserId: viewer,
      reason: "no viewers",
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(viewerTarget.statusCode).toBe(400);

    // Team-bound habitat refused with 409.
    const teamOwner = makeUser("editor");
    const teamId = makeTeam(teamOwner);
    const teamHabitat = makeTeamHabitat(teamId);
    const teamAttempt = await call("PUT", `/api/v1/habitats/${teamHabitat}/owner`, admin, {
      ownerUserId: owner,
      reason: "nope",
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(teamAttempt.statusCode).toBe(409);

    // Missing habitat 404.
    expect(
      (
        await call("PUT", "/api/v1/habitats/hab-missing/owner", admin, {
          ownerUserId: owner,
          reason: "x",
          scopeIncarnation: 1,
          expectedScopeVersion: 1,
        })
      ).statusCode,
    ).toBe(404);

    const clear = await call("DELETE", `/api/v1/habitats/${personal.id}/owner`, admin, {
      reason: "done",
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(clear.statusCode).toBe(204);
    expect(
      getDb()
        .select({ o: habitats.ownerUserId })
        .from(habitats)
        .where(eq(habitats.id, personal.id))
        .get()?.o,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Team-binding habitat creation (UI compatibility path)
// ---------------------------------------------------------------------------

describe("team-binding habitat creation", () => {
  it("governor 201 with expectation; missing 400; stale 409 no partial; member 403; personal unchanged", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);

    const noExp = await call("POST", "/api/v1/habitats", owner, {
      name: "NeedsExp",
      teamId,
    });
    expect(noExp.statusCode).toBe(400);

    const stale = await call("POST", "/api/v1/habitats", owner, {
      name: "StaleBind",
      teamId,
      expectedTeamVersion: 4,
      teamScopeIncarnation: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("GOVERNANCE_VERSION_CONFLICT");
    expect(
      getDb().select().from(habitats).where(eq(habitats.name, "StaleBind")).all(),
    ).toHaveLength(0);

    const ok = await call("POST", "/api/v1/habitats", owner, {
      name: "BoundOk",
      teamId,
      expectedTeamVersion: 1,
      teamScopeIncarnation: 1,
    });
    expect(ok.statusCode).toBe(201);
    // Team ledger bumped to version 2 (UI re-fetch sees the fresh expectation).
    const roles = await call("GET", `/api/v1/roles?scopeKind=team&scopeId=${teamId}`, owner);
    expect(roles.body.version).toBe(2);

    // Plain member cannot bind.
    const member = makeUser("editor");
    teamMemberRepo.addMember({ teamId, userId: member, role: "member" });
    const memberTry = await call("POST", "/api/v1/habitats", member, {
      name: "MemberBound",
      teamId,
      expectedTeamVersion: 2,
      teamScopeIncarnation: 1,
    });
    expect(memberTry.statusCode).toBe(403);
    expect(
      getDb().select().from(habitats).where(eq(habitats.name, "MemberBound")).all(),
    ).toHaveLength(0);

    // Personal creation unchanged (no expectations needed).
    expect(
      (await call("POST", "/api/v1/habitats", member, { name: "PersonalOk" })).statusCode,
    ).toBe(201);
  });

  it("agents cannot create team-bound habitats (403); personal agent create still works", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const { plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/agent",
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "AgentBound", teamId },
    });
    expect(res.statusCode).toBe(403);
    expect(
      getDb().select().from(habitats).where(eq(habitats.name, "AgentBound")).all(),
    ).toHaveLength(0);

    const personal = await app.inject({
      method: "POST",
      url: "/api/v1/habitats/agent",
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "AgentPersonal" },
    });
    expect(personal.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Custody transitions
// ---------------------------------------------------------------------------

describe("custody transitions", () => {
  it("team delete: habitats SET NULL, retired team ledger, fresh habitat incarnations, authority handover", async () => {
    const owner = makeUser("editor");
    const admin = makeUser("admin");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    seedDescendants(habitatId);

    const del = await call("DELETE", `/api/v1/teams/${teamId}`, owner);
    expect(del.statusCode).toBe(204);

    // Habitat survives, now personal.
    const row = getDb().select().from(habitats).where(eq(habitats.id, habitatId)).get()!;
    expect(row.teamId).toBeNull();

    // Habitat scope: retired incarnation 1 + fresh active incarnation 2 @ v1.
    const habRows = scopeRows("habitat", habitatId);
    expect(habRows.some((r) => r.retiredAt !== null && r.incarnation === 1)).toBe(true);
    const state = getScopeStateWithClient(getDb(), "habitat", habitatId);
    expect(state).toMatchObject({ status: "active", incarnation: 2, version: 1 });

    // Global admin now governs; the old team owner does not (personal, unowned).
    expect(
      (await call("GET", `/api/v1/roles?scopeKind=habitat&scopeId=${habitatId}`, admin))
        .statusCode,
    ).toBe(200);
    const oldOwner = await call(
      "GET",
      `/api/v1/roles?scopeKind=habitat&scopeId=${habitatId}`,
      owner,
    );
    expect(oldOwner.statusCode).toBe(403);

    // Team row gone → every team-namespace command 404s (no reuse).
    expect(
      (
        await call("POST", `/api/v1/teams/${teamId}/role-definitions`, admin, {
          scopeIncarnation: 1,
          expectedScopeVersion: 1,
          name: "Revive",
          permissions: ["review.assign"],
        })
      ).statusCode,
    ).toBe(404);
  });

  it("task and mission delete retire their ledgers with revoked grants retained", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { missionId, taskId } = seedDescendants(habitatId);

    // Governor assigns at task scope, then deletes the task.
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `Del-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const agentId = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;
    const assign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agentId,
      revisionId: (def.body.revision as Record<string, string>).id,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(assign.statusCode).toBe(201);
    const assignmentId = (assign.body.assignment as Record<string, string>).id;

    expect(deleteTask(taskId).success).toBe(true);
    const taskRows = scopeRows("task", taskId);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].retiredAt).not.toBeNull();
    const grantRow = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, assignmentId))
      .get()!;
    expect(grantRow.state).toBe("revoked");

    expect(deleteMission(missionId).success).toBe(true);
    expect(scopeRows("mission", missionId)[0].retiredAt).not.toBeNull();
  });

  it("agent delete revokes its typed assignments in the same reservation", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `AgDel-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const { agent } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    const assign = await call("POST", "/api/v1/role-assignments", owner, {
      principalType: "agent",
      principalId: agent.id,
      revisionId: (def.body.revision as Record<string, string>).id,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    const assignmentId = (assign.body.assignment as Record<string, string>).id;

    const { deleteAgent } = await import("../services/agentService.js");
    deleteAgent(agent.id);
    const row = getDb()
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, assignmentId))
      .get()!;
    expect(row.state).toBe("revoked");
  });

  it("habitat delete retires namespace definitions + descendant ledgers atomically", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const { missionId } = seedDescendants(habitatId);
    const def = await call("POST", `/api/v1/habitats/${habitatId}/role-definitions`, owner, {
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: `HabDel-${uuid().slice(0, 6)}`,
      permissions: ["review.assign"],
    });
    const definitionId = (def.body.definition as Record<string, string>).id;

    const admin = makeUser("admin");
    const del = await call("DELETE", `/api/v1/habitats/${habitatId}`, admin);
    expect(del.statusCode).toBe(204);

    // Namespace definition retired, descendant mission ledger retired,
    // habitat ledger retired — all before the cascade.
    const defRow = getDb()
      .select()
      .from(roleDefinitions)
      .where(eq(roleDefinitions.id, definitionId))
      .get()!;
    expect(defRow.retiredAt).not.toBeNull();
    expect(scopeRows("mission", missionId)[0].retiredAt).not.toBeNull();
    expect(scopeRows("habitat", habitatId)[0].retiredAt).not.toBeNull();
  });
});
