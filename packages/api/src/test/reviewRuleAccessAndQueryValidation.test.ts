/**
 * Review authority and concurrency-input regression proofs:
 *
 * - membership gate removal on reviewer MUTATIONS: a non-member human with
 *   an active review.assign grant adds/removes via the evaluator; the same
 *   actor ungranted stays 403; GET (roster read) stays membership-scoped
 *   and remains 403 for the non-member either way.
 * - DELETE /review-rules/:id query validation: the COMPLETE raw query value
 *   is validated — empty string, fractional ('1.5'), trailing junk
 *   ('1junk'), and repeated parameters (Fastify delivers an array) are all
 *   400 with the rule row retained; only absence means legacy LWW.
 *
 * Not covered here (owned by other batches/tests): MCP client transport,
 * task-crud canonical ID, custody audit actor/incarnation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import {
  governanceScopes as governanceScopesTable,
  habitats,
  organizations,
  reviewRules,
  roleAssignments as roleAssignmentsTable,
  roleRevisions,
  teams,
  users,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import { createTask as createTaskRepo } from "../repositories/taskCrud.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import {
  createDefinitionWithClient,
  insertAssignmentWithClient,
  materializeScopeWithClient,
} from "../repositories/roleFoundation.js";
import { LOCAL_PERMISSION_CATALOGUE_VERSION } from "../services/localAuthorization.js";
import { createCustomDefinition } from "../services/localRoleAdministration.js";

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
  getDb()
    .insert(organizations)
    .values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` })
    .run();
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

function makeTaskInHabitat(habitatId: string): string {
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "m",
    createdBy: "u",
  });
  return createTaskRepo({ missionId: mission.id, title: "t", createdBy: "u" }).id;
}

/** Grant an explicit operational permission to a typed human at habitat scope. */
function grantHumanPermission(
  userId: string,
  permission: "review.configure" | "review.assign",
  habitatId: string,
  issuerUserId: string,
): void {
  getDb().transaction((tx) => {
    const db = tx as never;
    materializeScopeWithClient(db, "habitat", habitatId);
    const { revision } = createDefinitionWithClient(db, {
      name: `grant-${permission}-${uuid().slice(0, 6)}`,
      namespaceKind: "habitat",
      namespaceScopeId: habitatId,
      namespaceIncarnation: 1,
      permissions: [permission],
      catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
    });
    insertAssignmentWithClient(db, {
      principalType: "human",
      principalId: userId,
      definitionId: revision.definitionId,
      revisionId: revision.id,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      issuerUserId,
    });
  });
}

async function login(userId: string): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;
  const { hash } = (await import("bcryptjs")) as {
    hash: (p: string, s: number) => Promise<string>;
  };
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

describe("reviewer mutations: membership gate removal (granted non-member)", () => {
  it("granted non-member human adds and removes a reviewer; ungranted non-member stays 403; GET stays 403", async () => {
    const owner = makeUser("admin");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const taskId = makeTaskInHabitat(habitatId);
    const targetUser = makeUser("editor");

    // Non-member WITH an active review.assign grant at the habitat scope.
    const grantedOutsider = makeUser("editor");
    grantHumanPermission(grantedOutsider, "review.assign", habitatId, owner);

    // Ungranted non-member control.
    const plainOutsider = makeUser("editor");

    // Before any grant the granted outsider is also just a non-member — both
    // GET (membership-scoped roster read) must 403.
    const getGranted = await call("GET", `/api/tasks/${taskId}/reviewers`, grantedOutsider);
    expect(getGranted.statusCode).toBe(403);
    const getPlain = await call("GET", `/api/tasks/${taskId}/reviewers`, plainOutsider);
    expect(getPlain.statusCode).toBe(403);

    // Granted non-member adds a human reviewer: 201 through the evaluator.
    const add = await call("POST", `/api/tasks/${taskId}/reviewers`, grantedOutsider, {
      reviewerId: targetUser,
      reviewerType: "human",
    });
    expect(add.statusCode).toBe(201);

    // Ungranted non-member cannot add: 403, no row.
    const deniedAdd = await call("POST", `/api/tasks/${taskId}/reviewers`, plainOutsider, {
      reviewerId: targetUser,
      reviewerType: "human",
    });
    expect(deniedAdd.statusCode).toBe(403);
    expect(deniedAdd.body).toMatchObject({ code: "AUTHORIZATION_DENIED" });

    // Granted non-member removes the reviewer: 204, row gone.
    const remove = await call(
      "DELETE",
      `/api/tasks/${taskId}/reviewers/${targetUser}`,
      grantedOutsider,
    );
    expect(remove.statusCode).toBe(204);
    expect(
      getDb()
        .select()
        .from((await import("../db/schema/index.js")).taskReviewers)
        .where(eq((await import("../db/schema/index.js")).taskReviewers.taskId, taskId))
        .all().length,
    ).toBe(0);

    // Ungranted non-member cannot remove (re-add first so a 204 would be
    // observable if the gate were wrongly dropped without authority).
    const readd = await call("POST", `/api/tasks/${taskId}/reviewers`, grantedOutsider, {
      reviewerId: targetUser,
      reviewerType: "human",
    });
    expect(readd.statusCode).toBe(201);
    const deniedRemove = await call(
      "DELETE",
      `/api/tasks/${taskId}/reviewers/${targetUser}`,
      plainOutsider,
    );
    expect(deniedRemove.statusCode).toBe(403);
    expect(deniedRemove.body).toMatchObject({ code: "AUTHORIZATION_DENIED" });
    // Row survives the denied removal.
    expect(
      getDb()
        .select()
        .from((await import("../db/schema/index.js")).taskReviewers)
        .where(eq((await import("../db/schema/index.js")).taskReviewers.taskId, taskId))
        .all().length,
    ).toBe(1);

    // GET is STILL membership-scoped for the granted non-member (roster read
    // is not part of the mutation-gate removal).
    const getAfter = await call("GET", `/api/tasks/${taskId}/reviewers`, grantedOutsider);
    expect(getAfter.statusCode).toBe(403);
  });
});

describe("DELETE /review-rules/:id expectedVersion whole-value validation", () => {
  function seedRule(habitatId: string): string {
    const ruleId = uuid();
    getDb()
      .insert(reviewRules)
      .values({
        id: ruleId,
        habitatId,
        name: "r",
        enabled: 1,
        priority: 0,
        matchDomain: null,
        matchLabels: [],
        matchPriority: null,
        assignmentStrategy: "domain_expert",
        requiredReviews: 1,
        antiSelfReview: 1,
        fixedReviewerIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    return ruleId;
  }

  it("malformed supplied values (empty, fractional, junk, repeated param) are 400 with the row retained; absent stays LWW-eligible", async () => {
    const admin = makeUser("admin");
    const habitatId = habitatRepo.createHabitat({
      name: `h-${uuid().slice(0, 8)}`,
      teamId: null,
    }).id;
    getDb().update(habitats).set({ ownerUserId: admin }).where(eq(habitats.id, habitatId)).run();
    const ruleId = seedRule(habitatId);

    const rowExists = () =>
      getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get();

    // Explicit empty string is a SUPPLIED value → 400.
    const empty = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=`, admin);
    expect(empty.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();

    // Fractional → 400 (parseInt previously truncated to 1).
    const frac = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=1.5`, admin);
    expect(frac.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();

    // Trailing junk → 400 (parseInt previously truncated to 1).
    const junk = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=1junk`, admin);
    expect(junk.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();

    // Zero / negative / non-numeric → 400.
    const zero = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=0`, admin);
    expect(zero.statusCode).toBe(400);
    const neg = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=-2`, admin);
    expect(neg.statusCode).toBe(400);
    const prose = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=abc`, admin);
    expect(prose.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();
    const unsafe = await call(
      "DELETE",
      `/api/review-rules/${ruleId}?expectedVersion=9007199254740993`,
      admin,
    );
    expect(unsafe.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();

    // Repeated parameter (Fastify delivers an array) → 400, never silently
    // treated as absent.
    const repeated = await call(
      "DELETE",
      `/api/review-rules/${ruleId}?expectedVersion=1&expectedVersion=2`,
      admin,
    );
    expect(repeated.statusCode).toBe(400);
    expect(rowExists()).toBeDefined();

    // Valid positive integer on a stale version → 409 (validated, then CAS).
    const stale = await call("DELETE", `/api/review-rules/${ruleId}?expectedVersion=99`, admin);
    expect(stale.statusCode).toBe(409);
    expect(rowExists()).toBeDefined();

    // Absent → legacy LWW path: admin owner deletes for real.
    const del = await call("DELETE", `/api/review-rules/${ruleId}`, admin);
    expect(del.statusCode).toBe(204);
    expect(rowExists()).toBeUndefined();
  });
});

describe("assertRevisionAssignableAtScope bounded parse (storage trust boundary)", () => {
  it("malformed stored permissions (invalid JSON / non-array / empty array / non-string items) fail closed as 400", async () => {
    const admin = makeUser("admin");
    const habitatId = habitatRepo.createHabitat({
      name: `h-${uuid().slice(0, 8)}`,
      teamId: null,
    }).id;
    getDb().update(habitats).set({ ownerUserId: admin }).where(eq(habitats.id, habitatId)).run();

    // A real definition to graft malformed revisions onto (route through the
    // public command so the scope ledger is set up).
    const created = createCustomDefinition({
      actorUserId: admin,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Malformed Carrier",
      permissions: ["review.configure"],
    });
    const defId = created.definition.id;

    let graftOrdinal = 90;
    const seedAssignment = (
      revPermissions: string,
      catalogueVersion = LOCAL_PERMISSION_CATALOGUE_VERSION,
    ): string => {
      const revId = uuid();
      getDb()
        .insert(roleRevisions)
        .values({
          id: revId,
          definitionId: defId,
          ordinal: graftOrdinal++,
          permissions: revPermissions,
          catalogueVersion,
          createdAt: new Date().toISOString(),
        })
        .run();
      return revId;
    };

    // The managed parser is exercised through the public assignment command
    // (createAssignment re-validates the pinned revision): each malformed
    // stored shape must refuse 400 — never a raw JSON.parse throw-through —
    // and never write an assignment row.
    const { createAssignment } = await import("../services/localRoleAdministration.js");
    const beforeAssignments = getDb().select().from(roleAssignmentsTable).all().length;

    // Values that pass the length>2 CHECK but are not a valid nonempty
    // string array: these reach the managed parser, which must refuse 400
    // (storage CHECK would reject shorter blobs like '2', '{}', '[]' itself).
    for (const bad of ["not json", '"x"', "[1, 2]", '["a", 5]', "[ ]"]) {
      const revId = seedAssignment(bad);
      let statusCode = -1;
      let thrownMessage = "";
      try {
        const scope = getDb()
          .select()
          .from(governanceScopesTable)
          .where(
            and(
              eq(governanceScopesTable.scopeKind, "habitat"),
              eq(governanceScopesTable.scopeId, habitatId),
            ),
          )
          .get()!;
        createAssignment({
          actorUserId: admin,
          principalType: "human",
          principalId: admin,
          revisionId: revId,
          scopeKind: "habitat",
          scopeId: habitatId,
          scopeIncarnation: scope.incarnation,
          expectedScopeVersion: scope.version,
        });
        statusCode = 201;
      } catch (err) {
        statusCode = (err as { statusCode?: number }).statusCode ?? -1;
        thrownMessage = String((err as { message?: string }).message ?? err);
      }
      expect(statusCode).toBe(400);
      expect(thrownMessage).toMatch(/malformed|assignable/i);
    }
    // Nothing was written through the malformed path.
    expect(getDb().select().from(roleAssignmentsTable).all().length).toBe(beforeAssignments);
    const unsupported = seedAssignment(
      '["review.configure"]',
      LOCAL_PERMISSION_CATALOGUE_VERSION + 1,
    );
    expect(() =>
      createAssignment({
        actorUserId: admin,
        principalType: "human",
        principalId: admin,
        revisionId: unsupported,
        scopeKind: "habitat",
        scopeId: habitatId,
        scopeIncarnation: 1,
        expectedScopeVersion: 2,
      }),
    ).toThrow(/catalogue version is unsupported/);
    expect(getDb().select().from(roleAssignmentsTable).all().length).toBe(beforeAssignments);
  });
});

describe("governance command input and descendant ledger changes", () => {
  it("an expired configure-only grant does not explain an assign-permission denial", async () => {
    const admin = makeUser("admin");
    const habitatId = habitatRepo.createHabitat({ name: "expiry qualification" }).id;
    const taskId = makeTaskInHabitat(habitatId);
    const editor = makeUser("editor");
    grantHumanPermission(editor, "review.configure", habitatId, admin);
    getDb()
      .update(roleAssignmentsTable)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(roleAssignmentsTable.principalId, editor))
      .run();
    const { evaluatePermissionsWithClient } = await import("../services/localAuthorization.js");
    expect(
      evaluatePermissionsWithClient(getDb(), { type: "human", id: editor }, "review.assign", {
        scopeKind: "task",
        scopeId: taskId,
      }),
    ).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });

  it("rejects Team expectations on personal creation and blank role names", async () => {
    const admin = makeUser("admin");
    const before = getDb().select().from(habitats).all().length;
    for (const payload of [
      { name: "invalid", expectedTeamVersion: 1 },
      { name: "invalid", teamId: null, teamScopeIncarnation: 1 },
    ]) {
      expect((await call("POST", "/api/habitats", admin, payload)).statusCode).toBe(400);
    }
    expect(getDb().select().from(habitats).all().length).toBe(before);
    const habitatId = habitatRepo.createHabitat({ name: "roles" }).id;
    expect(
      (
        await call("POST", `/api/habitats/${habitatId}/role-definitions`, admin, {
          name: "   ",
          permissions: ["review.assign"],
          scopeIncarnation: 1,
          expectedScopeVersion: 1,
        })
      ).statusCode,
    ).toBe(400);
    const valid = await call("POST", `/api/habitats/${habitatId}/role-definitions`, admin, {
      name: "  Reviewers  ",
      permissions: ["review.assign"],
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(valid.statusCode).toBe(201);
    expect((valid.body.definition as { name: string }).name).toBe("Reviewers");
  });

  it("retiring a definition advances each affected descendant scope once without double-bumping its namespace", async () => {
    const admin = makeUser("admin");
    const habitatId = habitatRepo.createHabitat({ name: "retirement" }).id;
    const taskId = makeTaskInHabitat(habitatId);
    const other = makeUser("editor");
    const { definition, revision } = createCustomDefinition({
      actorUserId: admin,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Retiring",
      permissions: ["review.assign"],
    });
    getDb().transaction((tx) => {
      for (const principalId of [admin, other]) {
        insertAssignmentWithClient(tx as never, {
          principalType: "human",
          principalId,
          definitionId: definition.id,
          revisionId: revision.id,
          scopeKind: "task",
          scopeId: taskId,
          scopeIncarnation: 1,
          issuerUserId: admin,
        });
      }
    });
    const result = await call("POST", `/api/role-definitions/${definition.id}/retire`, admin, {
      reason: "retire",
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
      expectedLatestRevision: 1,
    });
    expect(result.statusCode).toBe(200);
    const ledger = getDb().select().from(governanceScopesTable).all();
    expect(ledger.find((r) => r.scopeKind === "habitat" && r.scopeId === habitatId)?.version).toBe(
      3,
    );
    expect(ledger.find((r) => r.scopeKind === "task" && r.scopeId === taskId)?.version).toBe(2);
    expect(
      getDb()
        .select()
        .from(roleAssignmentsTable)
        .where(eq(roleAssignmentsTable.definitionId, definition.id))
        .all()
        .every((r) => r.state === "revoked"),
    ).toBe(true);
    const replacement = createCustomDefinition({
      actorUserId: admin,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 3,
      name: "Replacement",
      permissions: ["review.assign"],
    });
    const stale = await call("POST", "/api/role-assignments", admin, {
      principalType: "human",
      principalId: other,
      revisionId: replacement.revision.id,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.code).toBe("GOVERNANCE_VERSION_CONFLICT");
    const current = await call("POST", "/api/role-assignments", admin, {
      principalType: "human",
      principalId: other,
      revisionId: replacement.revision.id,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: 1,
      expectedScopeVersion: 2,
    });
    expect(current.statusCode).toBe(201);
  });
});
