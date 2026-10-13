/**
 * Review-governance command service — real-HTTP proofs (review-governance
 * ticket, first operational consumer of the local authorization foundation).
 *
 * Covers: rule update/delete optional CAS (fresh 200/204, stale 409 with no
 * write, omitted legacy LWW), reviewer add/remove optional token CAS (fresh
 * + duplicate + cross-type + typed + anti-self, stale token 409 with no
 * write, omitted legacy), roster-token determinism, and audit row
 * append/rollback shape on the real production assembly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { initDb } from "../db/index.js";
import { eq, and, sql, inArray, getTableName } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import {
  governanceAudit,
  habitats,
  organizations,
  reviewRules,
  taskReviewers,
  taskReviewRequirements,
  tasks,
  teams,
  users,
  agents,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import { createTask as createTaskRepo } from "../repositories/taskCrud.js";
import {
  computeReviewersToken,
  createRuleCommand,
  updateRuleCommand,
  deleteRuleCommand,
  addReviewerCommand,
  removeReviewerCommand,
  listReviewersWithToken,
} from "../services/reviewGovernance.js";
import {
  createDefinitionWithClient,
  insertAssignmentWithClient,
  materializeScopeWithClient,
} from "../repositories/roleFoundation.js";
import { LOCAL_PERMISSION_CATALOGUE_VERSION } from "../services/localAuthorization.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";
import {
  roleAssignments,
  roleDefinitions,
  roleRevisions,
  governanceScopes,
} from "../db/schema/index.js";
import {
  getRequirementWithClient,
  projectReviewersWithClient,
} from "../repositories/reviewSafety.js";

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
  const now = new Date().toISOString();
  userRepo.createUser({
    id,
    username: `u-${id.slice(0, 12)}`,
    passwordHash: "x",
    role,
    createdAt: now,
    updatedAt: now,
  });
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

function makePersonalHabitat(ownerId?: string): string {
  const id = habitatRepo.createHabitat({ name: `h-${uuid().slice(0, 8)}`, teamId: null }).id;
  if (ownerId) {
    // Set the personal owner so the governance adapter admits the owner.
    getDb().update(habitats).set({ ownerUserId: ownerId }).where(eq(habitats.id, id)).run();
  }
  return id;
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
  agentApiKey?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (actor) headers.authorization = `Bearer ${await login(actor)}`;
  if (agentApiKey) headers["x-agent-api-key"] = agentApiKey;
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

function ruleVersion(ruleId: string): number {
  return getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get()!.version;
}

function reviewerRows(taskId: string): number {
  return getDb()
    .select()
    .from(taskReviewers)
    .where(eq(taskReviewers.taskId, taskId))
    .all().length;
}

function auditRowsFor(op: string): number {
  return (
    getDb()
      .select({ id: governanceAudit.id })
      .from(governanceAudit)
      .where(eq(governanceAudit.operation, op))
      .all().length
  );
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
// Rule update/delete CAS
// ---------------------------------------------------------------------------

describe("review-rule CAS (0083 optional expectedVersion)", () => {
  it("omitted = legacy last-write-wins; fresh expectation succeeds; stale expectation 409s with no write", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const ruleId = getDb()
      .insert(reviewRules)
      .values({
        id: uuid(),
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
      .returning({ id: reviewRules.id })
      .get()!.id;

    const before = ruleVersion(ruleId);

    // Omitted expectation: legacy LWW — succeeds regardless.
    const lww = await call(
      "PATCH",
      `/api/review-rules/${ruleId}`,
      admin,
      { name: "renamed" },
    );
    expect(lww.statusCode).toBe(200);
    expect(ruleVersion(ruleId)).toBe(before + 1);

    // Fresh expectation: succeeds and bumps again.
    const fresh = await call(
      "PATCH",
      `/api/review-rules/${ruleId}`,
      admin,
      { name: "fresh", expectedVersion: before + 1 },
    );
    expect(fresh.statusCode).toBe(200);
    expect(ruleVersion(ruleId)).toBe(before + 2);

    // Stale expectation (pre-update version): 409, row unchanged.
    const stale = await call(
      "PATCH",
      `/api/review-rules/${ruleId}`,
      admin,
      { name: "stale", expectedVersion: before },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ code: "REVIEW_RULE_VERSION_CONFLICT" });
    const row = getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get()!;
    expect((row as { name: string }).name).toBe("fresh");
    expect(rowVersion_stale(row)).toBe(before + 2);

    // Stale delete: 409, rule still exists.
    const staleDel = await call(
      "DELETE",
      `/api/review-rules/${ruleId}?expectedVersion=${before}`,
      admin,
    );
    expect(staleDel.statusCode).toBe(409);
    expect(
      getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get(),
    ).toBeDefined();

    // Fresh delete: 204, rule gone, audit row appended.
    const del = await call(
      "DELETE",
      `/api/review-rules/${ruleId}?expectedVersion=${before + 2}`,
      admin,
    );
    expect(del.statusCode).toBe(204);
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get()).toBeUndefined();
    expect(auditRowsFor("review_rule.delete")).toBeGreaterThanOrEqual(1);
  });

  function rowVersion_stale(row: { version: number }): number {
    return row.version;
  }

  it("denied actor 403 with no write (viewers never govern)", async () => {
    const admin = makeUser("admin");
    const viewer = makeUser("viewer");
    void admin;
    const habitatId = makePersonalHabitat();
    const ruleId = getDb()
      .insert(reviewRules)
      .values({
        id: uuid(),
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
      .returning({ id: reviewRules.id })
      .get()!.id;

    const res = await call("PATCH", `/api/review-rules/${ruleId}`, viewer, { name: "x" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get()!.name).toBe("r");
    expect(auditRowsFor("review_rule.update")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reviewer token CAS
// ---------------------------------------------------------------------------

describe("reviewer roster token CAS (0083 optional expectedReviewersToken)", () => {
  function seededReviewerRows(
    habitatId: string,
    taskId: string,
    reviewerId: string,
    reviewerType: "human" | "agent",
  ): void {
    getDb()
      .insert(taskReviewers)
      .values({
        id: uuid(),
        taskId,
        reviewerType,
        reviewerId,
        status: "pending",
        assignedAt: new Date().toISOString(),
        reviewedAt: null,
        reviewNote: null,
      })
      .run();
  }

  it("fresh token succeeds; stale token 409s with no write; duplicate + cross-type preserved", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);
    const user = makeUser("editor");
    seededReviewerRows(habitatId, taskId, user, "human");

    const before = reviewerRows(taskId);
    expect(before).toBe(1);

    // GET carries the token.
    const list = await call("GET", `/api/tasks/${taskId}/reviewers`, admin);
    expect(list.statusCode).toBe(200);
    const token = (list.body as { reviewersToken: string }).reviewersToken;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Determinism: a second identical read produces the same token.
    const tokenDirect = computeReviewersToken(getDb() as never, taskId);
    expect(token).toBe(tokenDirect);

    // Stale token: 409, no new row.
    const stale = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      {
        reviewerId: user,
        reviewerType: "agent",
        expectedReviewersToken: "0".repeat(64),
      },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ code: "REVIEWERS_TOKEN_CONFLICT" });
    expect(reviewerRows(taskId)).toBe(1); // seeded human row only

    // Fresh token + duplicate human: idempotent 200, no new row.
    const dup = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      { reviewerId: user, reviewerType: "human", expectedReviewersToken: token },
    );
    expect(dup.statusCode).toBe(200);
    expect(reviewerRows(taskId)).toBe(1);

    // Fresh token + new agent reviewer: 201.
    const agent = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 8)}`,
      type: "opencode",
      domain: "backend",
    }).agent;
    const add = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      {
        reviewerId: agent.id,
        reviewerType: "agent",
        expectedReviewersToken: computeReviewersToken(getDb() as never, taskId),
      },
    );
    expect(add.statusCode).toBe(201);
    expect(reviewerRows(taskId)).toBe(2); // human + agent rows

    // Cross-type: an id present in BOTH registries with existing rows of one
    // type → 409 REVIEWER_TYPE_CONFLICT (registry checks pass for both types).
    const dualId = uuid();
    userRepo.createUser({
      id: dualId, username: `dual-${dualId.slice(0, 8)}`, passwordHash: "x",
      role: "editor", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // Force the registry-id collision the cross-type check is about:
    // register the agent row under the human's id string via raw insert
    // (the repo create() mints its own uuid; raw insert pins the id).
    getDb()
      .insert(agents)
      .values({
        id: dualId,
        name: `dual-${dualId.slice(0, 8)}`,
        type: "opencode",
        domain: "backend",
        status: "offline",
        apiKey: "x",
        capabilities: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never)
      .run();
    getDb()
      .insert(taskReviewers)
      .values({
        id: uuid(), taskId, reviewerType: "agent", reviewerId: dualId,
        status: "pending", assignedAt: new Date().toISOString(), reviewedAt: null, reviewNote: null,
      })
      .run();
    const cross = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      { reviewerId: dualId, reviewerType: "human" },
    );
    expect(cross.statusCode).toBe(409);
    expect(cross.body).toMatchObject({ code: "REVIEWER_TYPE_CONFLICT" });

    // Remove with fresh token: 204, row gone, token shifts.
    const tokenBeforeRemoval = computeReviewersToken(getDb() as never, taskId);
    const del = await call(
      "DELETE",
      `/api/tasks/${taskId}/reviewers/${agent.id}?expectedReviewersToken=${tokenBeforeRemoval}`,
      admin,
    );
    expect(del.statusCode).toBe(204);
    expect(reviewerRows(taskId)).toBe(2); // agent row removed; human + dual-agent rows remain

    // Stale remove token: 409.
    const staleRemoval = await call(
      "DELETE",
      `/api/tasks/${taskId}/reviewers/${user}?expectedReviewersToken=${"1".repeat(64)}`,
      admin,
    );
    expect(staleRemoval.statusCode).toBe(409);
    expect(staleRemoval.body).toMatchObject({ code: "REVIEWERS_TOKEN_CONFLICT" });
    expect(reviewerRows(taskId)).toBe(2); // no change on 409
  });

  it("typed anti-self + unknown reviewer registry denials", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);

    // Agent reviewer naming a non-existent agent id: 400.
    const unknownAgent = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      { reviewerId: "not-an-agent", reviewerType: "agent" },
    );
    expect(unknownAgent.statusCode).toBe(400);

    // Agent reviewer naming a non-existent user id: 400.
    const unknownUser = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      { reviewerId: "not-a-user", reviewerType: "human" },
    );
    expect(unknownUser.statusCode).toBe(400);

    expect(reviewerRows(taskId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Audit append inside the reservation
// ---------------------------------------------------------------------------

describe("audit append inside the reservation", () => {
  it("a successful add appends a governance_audit row for that operation", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);
    const user = makeUser("editor");

    const add = await call(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      admin,
      {
        reviewerId: user,
        reviewerType: "human",
        expectedReviewersToken: computeReviewersToken(getDb() as never, taskId),
      },
    );
    expect(add.statusCode).toBe(201);
    expect(reviewerRows(taskId)).toBe(1);

    const row = getDb()
      .select()
      .from(governanceAudit)
      .where(eq(governanceAudit.operation, "reviewer.add"))
      .all();
    expect(row.length).toBe(1);
    expect(row[0]).toMatchObject({
      actorType: "human",
      actorId: admin,
      scopeKind: "task",
      scopeId: taskId,
      objectKind: "reviewer_assignment",
    });
  });
});

// ---------------------------------------------------------------------------
// Proof-coverage ceiling items (recovery-scope rev 2): MCP-agent-coordinator
// positive, granted-agent positive, revocation/expiry between admission and
// mutation, audit-fault rollback for review ops, executor own-Task denial,
// governed create, and the GET single-read-snapshot property.
// ---------------------------------------------------------------------------

describe("review-governance proof-coverage ceiling (rev-2 items)", () => {
  /** Grant an explicit operational permission to a typed agent at the habitat scope. */
  function grantAgentPermission(
    agentId: string,
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
        principalType: "agent",
        principalId: agentId,
        definitionId: revision.definitionId,
        revisionId: revision.id,
        scopeKind: "habitat",
        scopeId: habitatId,
        scopeIncarnation: 1,
        issuerUserId,
      });
    });
  }

  it("granted AGENT creates a rule via local_actor transport (explicit-grant positive)", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantAgentPermission(agent.id, "review.configure", habitatId, admin);

    // Agent key, not a JWT: the local_actor transport admits it and the
    // evaluator authorizes via the explicit operational grant.
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/review-rules`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "granted-agent-rule" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { reviewRule: { habitatId: string; version: number } };
    expect(body.reviewRule.habitatId).toBe(habitatId);
    expect(body.reviewRule.version).toBe(1);
    expect(auditRowsFor("review_rule.create")).toBe(1);
    expect(
      getDb().select().from(governanceAudit).where(eq(governanceAudit.operation, "review_rule.create")).all()[0],
    ).toMatchObject({ actorType: "agent", actorId: agent.id });
  });

  it("agent key WITHOUT a grant is 403 on create (never 401 — no human-only gate left)", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/review-rules`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "denied" },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "AUTHORIZATION_DENIED" });
    // No rule, no audit — the refusal is total.
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.habitatId, habitatId)).all().length).toBe(0);
    expect(auditRowsFor("review_rule.create")).toBe(0);
  });

  it("viewer team member create → 403 (G3: the legacy viewer-member 201 is retired)", async () => {
    const owner = makeUser("editor");
    const teamId = makeTeam(owner);
    const habitatId = makeTeamHabitat(teamId);
    const viewer = makeUser("viewer");
    teamMemberRepo.addMember({ teamId, userId: viewer, role: "member" });

    const res = await call("POST", `/api/habitats/${habitatId}/review-rules`, viewer, { name: "v" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.habitatId, habitatId)).all().length).toBe(0);

    // Positive control: the team owner (persisted governor) creates fine.
    const ok = await call("POST", `/api/habitats/${habitatId}/review-rules`, owner, { name: "ok" });
    expect(ok.statusCode).toBe(201);
  });

  it("revocation between admission and mutation refuses the SAME actor at mutation time", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantAgentPermission(agent.id, "review.configure", habitatId, admin);

    const create = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/review-rules`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "will-update" },
    });
    expect(create.statusCode).toBe(201);
    const ruleId = (JSON.parse(create.body) as { reviewRule: { id: string } }).reviewRule.id;

    // Revoke the grant directly; the next command re-evaluates authority
    // inside its own reservation and must refuse.
    const row = getDb()
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.principalId, agent.id), eq(roleAssignments.state, "active")))
      .all();
    expect(row.length).toBeGreaterThan(0);
    getDb()
      .update(roleAssignments)
      .set({ state: "revoked", revokedAt: new Date().toISOString(), version: row[0]!.version + 1 })
      .where(eq(roleAssignments.id, row[0]!.id))
      .run();

    const update = await app.inject({
      method: "PATCH",
      url: `/api/review-rules/${ruleId}`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "revoked-try" },
    });
    expect(update.statusCode).toBe(403);
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.id, ruleId)).get()!.name).toBe("will-update");
  });

  it("expired grant refuses at mutation time (expiry evaluated at decision)", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantAgentPermission(agent.id, "review.configure", habitatId, admin);
    // Force the stored expiry into the past.
    getDb()
      .update(roleAssignments)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(roleAssignments.principalId, agent.id))
      .run();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/review-rules`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { name: "expired-try" },
    });
    expect(res.statusCode).toBe(403);
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.habitatId, habitatId)).all().length).toBe(0);
  });

  it("audit-fault rollback for a review op: the rule create rolls back completely", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const db = getDb() as unknown as { transaction: (cb: (tx: unknown) => unknown, cfg?: unknown) => unknown };
    const original = db.transaction;
    const rulesBefore = getDb().select().from(reviewRules).where(eq(reviewRules.habitatId, habitatId)).all().length;
    const auditBefore = auditRowsFor("review_rule.create");

    db.transaction = function faulting(cb: (tx: unknown) => unknown, cfg?: unknown) {
      return original.call(db, (tx) => cb(new FailingDbClient(tx as never, { failAtWriteN: null, failAtTableName: "governance_audit" })), cfg);
    };
    let threw = false;
    try {
      createRuleCommand({
        habitatId,
        actor: { type: "human", id: admin },
        fields: { name: "audit-fault" },
      });
    } catch {
      threw = true;
    } finally {
      db.transaction = original;
    }
    expect(threw).toBe(true);
    expect(getDb().select().from(reviewRules).where(eq(reviewRules.habitatId, habitatId)).all().length).toBe(rulesBefore);
    expect(auditRowsFor("review_rule.create")).toBe(auditBefore);
  });

  it("executor own-Task denial: the task's CURRENT ASSIGNEE agent cannot manage reviewers", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    // Make the agent the task's current executor.
    getDb().update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, taskId)).run();
    // Grant review.assign so the ONLY failing check is the executor denial.
    grantAgentPermission(agent.id, "review.assign", habitatId, admin);

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/reviewers`,
      headers: { "x-agent-api-key": plainApiKey },
      payload: { reviewerId: admin, reviewerType: "human" },
    });
    expect(res.statusCode).toBe(403);
    expect(reviewerRows(taskId)).toBe(0);
  });

  it("GET single-read snapshot: the served token is a pure function of the served rows", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);
    const reviewer = makeUser("editor");
    const add = await call("POST", `/api/tasks/${taskId}/reviewers`, admin, {
      reviewerId: reviewer,
      reviewerType: "human",
    });
    expect(add.statusCode).toBe(201);

    const res = await call("GET", `/api/tasks/${taskId}/reviewers`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.body as { reviewers: unknown[]; reviewersToken: string };
    expect(typeof body.reviewersToken).toBe("string");
    // The GET's own returned rows + the same requirement/projection inputs
    // must reproduce the token — pins that view and token derive from ONE
    // read (a second re-read could diverge under a concurrent writer).
    const requirement = getRequirementWithClient(getDb() as never, taskId);
    const projected = requirement
      ? projectReviewersWithClient(getDb() as never, taskId, requirement)
      : [];
    const recomputed = computeReviewersToken(
      getDb() as never,
      taskId,
      { rows: body.reviewers as never[], requirement, projected },
    );
    expect(recomputed).toBe(body.reviewersToken);
  });
});

// ---------------------------------------------------------------------------
// Mandatory proof batch (coordinator grant, production HELD):
//   A. cross-process GET-snapshot discriminator
//   B. SAME-request admission→mutation window (revocation/expiry landing
//      between authentication/admission and the command's reservation)
//   C. audit-fault rollback across ALL FIVE real commands
// All use production source under proof: no copied SQL expression, no
// production hook, no test model of the operation.
// ---------------------------------------------------------------------------

/** Grant an explicit operational permission to a typed agent at the habitat scope. */
function grantForAgent(
  agentId: string,
  permission: "review.configure" | "review.assign",
  habitatId: string,
  issuerUserId: string,
): void {
  getDb().transaction((tx: unknown) => {
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
      principalType: "agent",
      principalId: agentId,
      definitionId: revision.definitionId,
      revisionId: revision.id,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      issuerUserId,
    });
  });
}

const RACE_WORKER = join(import.meta.dirname, "fixtures", "rule-counter-race-worker.ts");

interface WorkerMsg {
  type?: string;
  kind?: string;
  version?: number | null;
  message?: string;
  status?: number;
  body?: string;
  driver?: string;
}

/** Forked real-command worker. Rejects on abnormal early exit; disposes cleanly. */
function forkCommandWorker(
  dbPath: string,
  ruleId: string,
  mode: string,
  arg?: string,
  gateDir?: string,
  gateRelease?: string,
  env?: Record<string, string>,
): {
  child: ChildProcess;
  /** Last DRIVER line the worker printed (file/journal/fk receipt). */
  driverReceipt: () => string | null;
  /** True once the worker reported READY (post-initDb). */
  isReady: () => boolean;
  /** True once an admwait worker's HTTP server reported LISTENING. */
  isListening: () => boolean;
  next: () => Promise<WorkerMsg>;
  send: (m: { type: string }) => void;
  dispose: () => Promise<void>;
} {
  const args = [dbPath, ruleId, mode];
  if (gateDir) args.push(gateDir, gateRelease!);
  else if (arg) args.push(arg);
  const child = fork(RACE_WORKER, args, {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  let driverReceipt: string | null = null;
  let ready = false;
  let listening = false;
  const queue: WorkerMsg[] = [];
  const waiters: { resolve: (m: WorkerMsg) => void; reject: (e: Error) => void }[] = [];
  let exitInfo: { code: number | null } | null = null;
  // Buffer across pipe chunk boundaries: keep the last partial line and
  // only accept a receipt once the full "file=… journal=… fk=…" shape is
  // present — a mid-line chunk boundary must not produce a truncated receipt.
  let stdoutTail = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdoutTail += d.toString();
    const m = /DRIVER (file=\S+ journal=\S+ fk=\d)/.exec(stdoutTail);
    if (m) driverReceipt = m[1]!;
    if (stdoutTail.length > 4096) stdoutTail = stdoutTail.slice(-2048);
  });
  child.on("message", (msg: WorkerMsg) => {
    if (msg.type === "READY") {
      ready = true;
      return;
    }
    // Progress notifications (admwait's LISTENING) never satisfy next().
    if (msg.type === "LISTENING") {
      listening = true;
      return;
    }
    if (waiters.length > 0) waiters.shift()!.resolve(msg);
    else queue.push(msg);
  });
  child.on("exit", (code) => {
    exitInfo = { code };
    // REJECT pending waits — resolving with an Error object leaves consumers
    // reading undefined fields off the Error (the silent-harness-failure trap).
    while (waiters.length > 0) {
      waiters
        .shift()!
        .reject(new Error(`worker ${mode} exited early (code ${code}); ${queue.length} result(s) queued`));
    }
  });
  const exited = new Promise<void>((resolve) => {
    if (exitInfo) resolve();
    else child.on("exit", () => resolve());
  });
  return {
    child,
    /** Last DRIVER line the worker printed (file/journal/fk receipt). */
    driverReceipt: () => driverReceipt,
    /** True once the worker reported READY (post-initDb). */
    isReady: () => ready,
    /** True once an admwait worker's HTTP server reported LISTENING. */
    isListening: () => listening,
    next: () =>
      new Promise<WorkerMsg>((resolve, reject) => {
        if (exitInfo && queue.length === 0) {
          reject(new Error(`worker ${mode} already exited (code ${exitInfo.code})`));
          return;
        }
        if (queue.length > 0) resolve(queue.shift()!);
        else waiters.push({ resolve, reject });
      }),
    send: (m) => void child.send(m),
    dispose: async () => {
      if (!exitInfo) {
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
        if (!exitInfo) child.kill("SIGKILL");
      }
      await exited;
    },
  };
}

/** Poll until `pred` holds, so no assertion depends on a fixed sleep. */
async function waitFor(what: string, pred: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("A. cross-process GET-snapshot discriminator (reviewGovernanceCommands)", () => {
  let fileDir: string;
  let fileDbPath: string;

  beforeEach(async () => {
    await closeDb();
    fileDir = mkdtempSync(join(tmpdir(), "rg-getsnap-"));
    fileDbPath = join(fileDir, "getsnap.db");
    await initDb(fileDbPath);
  });

  afterEach(async () => {
    await closeDb();
    rmSync(fileDir, { recursive: true, force: true });
  });

  it("peer commits INSIDE the GET's read window: served roster+token stay one held pre-state snapshot", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);

    // Seed one reviewer row so the pre-state roster is nonempty; the peer's
    // commit will add a SECOND row and bump the requirement round.
    const seededReviewer = makeUser("editor");
    getDb()
      .insert(taskReviewers)
      .values({
        id: uuid(), taskId, reviewerType: "human", reviewerId: seededReviewer,
        status: "pending", assignedAt: new Date().toISOString(), reviewedAt: null, reviewNote: null,
      })
      .run();
    // Materialize the requirement row so the peer's bumpReviewRoundWithClient
    // (round + requirementVersion change — hashed by the token, absent from
    // the roster rows) actually changes token-relevant state.
    getDb()
      .insert(taskReviewRequirements)
      .values({
        taskId, origin: "ordinary", state: "uncaptured", nonOverriddenFloor: null,
        knownPolicyFloor: 0, effectiveCount: null, requirementVersion: 1,
        reviewGeneration: 0, reviewRound: 0, claimantType: null, claimantId: null,
        approvedGeneration: null, activeOverrideId: null, selectedRuleId: null,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    // Peer writer: a typed agent granted review.assign at the habitat so its
    // REAL addReviewerCommand is authorized through production authority.
    const { agent } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantForAgent(agent.id, "review.assign", habitatId, admin);
    const peerReviewer = makeUser("viewer");

    const gateDirA = join(fileDir, "getgate");
    mkdirSync(gateDirA, { recursive: true });
    const releaseA = `release-${Math.random()}`;

    const peer = forkCommandWorker(fileDbPath, taskId, "rosterwait", undefined, gateDirA, releaseA, {
      WORKER_REVIEWER_ID: peerReviewer,
      WORKER_ACTOR_ID: agent.id,
    });
    try {
      // Peer completes initDb (WAL/FK on the production file) before the GET
      // opens its read transaction — handshake is READY, not a spawned guess.
      await waitFor("peer READY after initDb", peer.isReady, 30_000);
      peer.send({ type: "GO" });
      await waitFor("peer to block at its gate", () => existsSync(join(gateDirA, "entered")));

      // TEST-OWNED seam, exactly-once: the GET's FIRST roster read
      // (listReviewersWithToken's first taskReviewers select) executes, then
      // the frame blocks — the read transaction is OPEN with its snapshot
      // held while the peer commits on its own connection.
      const db = getDb() as unknown as {
        select: (...a: unknown[]) => { from: (t: unknown) => { where: (w: unknown) => { all: () => unknown[] } } };
      };
      const originalSelect = db.select.bind(db);
      let seamHit = false;
      db.select = function interceptedSelect(...a: unknown[]) {
        const builder = originalSelect(...a);
        if (!seamHit) {
          const wrapped = {
            from: (t: unknown) => {
              const b1 = builder.from(t) as never as { where: (w: unknown) => { all: () => unknown[] } };
              return {
                where: (w: unknown) => {
                  const b2 = b1.where(w);
                  return {
                    all: () => {
                      const out = b2.all(); // ← the REAL first roster read executes
                      seamHit = true;
                      writeFileSync(join(gateDirA, "seam-hit"), "1");
                      // The read transaction is OPEN with its snapshot held.
                      // Release the peer (its gate file is THIS release file),
                      // then block on its peer-commit marker — bounded
                      // filesystem polling, no parent IPC while blocked.
                      writeFileSync(join(gateDirA, releaseA), "1");
                      const deadline = Date.now() + 60_000;
                      while (!existsSync(join(gateDirA, "peer-commit"))) {
                        if (Date.now() > deadline) throw new Error("peer commit timeout inside GET seam");
                        spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);"], { timeout: 1000 });
                      }
                      return out;
                    },
                  };
                },
              };
            },
          };
          return wrapped;
        }
        return builder;
      };
      try {
        const served = listReviewersWithToken(taskId, habitatId);
        expect(seamHit).toBe(true);

        // Exactly-once marker AND peer commit receipts: the peer's real
        // round-bump + reviewer-add committed after the roster read, while
        // this frame held the open read transaction.
        expect(existsSync(join(gateDirA, "peer-commit"))).toBe(true);

        // Discriminator, part 1 — internal consistency: the served token must
        // be reproducible from the SERVED rows + the requirement state the
        // SAME transaction held. A two-read GET would serve the roster from
        // the held pre-state but a token hashed from the post-commit re-read.
        // The held pre-state requirement: the seeded row with its pre-peer
        // round/version (0/1). Re-reading NOW would observe the peer's
        // post-bump state and would not be a held-snapshot recomputation.
        const postReqForHeld = getRequirementWithClient(getDb() as never, taskId);
        const heldRequirement = {
          ...postReqForHeld!,
          reviewRound: 0,
          requirementVersion: 1,
        };
        const recomputed = computeReviewersToken(getDb() as never, taskId, {
          rows: served.reviewers as never[],
          requirement: heldRequirement as never,
          projected: [],
        });

        // Part 2 — the snapshot really was held: the served roster is the
        // PRE-state (1 row), while a fresh post-GET read sees the peer's
        // committed effect (2 rows, round bumped).
        expect(served.reviewers.length).toBe(1);
        expect(reviewerRows(taskId)).toBe(2);
        const postReq = getRequirementWithClient(getDb() as never, taskId);
        expect(postReq!.reviewRound).toBe(1);
        expect(postReq!.requirementVersion).toBe(2);

        // Part 3 — cross-process visibility: the peer's row is durably
        // committed on the canonical file by a real second connection.
        const rows = getDb().select().from(taskReviewers).where(eq(taskReviewers.taskId, taskId)).all();
        expect(rows.some((r) => r.reviewerId === peerReviewer)).toBe(true);

        // The token over the held pre-state must differ from a token over the
        // post-commit state (round/version changed) — otherwise the schedule
        // would not discriminate one-read from two-read.
        const postToken = computeReviewersToken(getDb() as never, taskId);
        expect(recomputed).toBe(served.token);
        expect(served.token).not.toBe(postToken);

        // Driver identity: both processes opened the SAME canonical file in
        // WAL with FK enforcement (production initDb configuration).
        const peerReceipt = peer.driverReceipt();
        expect(peerReceipt).toMatch(/^file=\S+getsnap\.db journal=wal fk=1$/);
      } finally {
        db.select = originalSelect;
      }
    } finally {
      // Release the peer gate if this frame threw before releasing it.
      writeFileSync(join(gateDirA, releaseA), "1");
      await peer.dispose();
    }
  }, 60_000);
});

describe("B. SAME-request admission→mutation window (reviewGovernanceCommands)", () => {
  let fileDir: string;
  let fileDbPath: string;
  let gateDir: string;
  let gateRelease: string;

  beforeEach(async () => {
    await closeDb();
    fileDir = mkdtempSync(join(tmpdir(), "rg-admission-"));
    fileDbPath = join(fileDir, "admission.db");
    gateDir = join(fileDir, "gate");
    mkdirSync(gateDir, { recursive: true });
    gateRelease = `release-${Math.random()}`;
    await initDb(fileDbPath);
  });

  afterEach(async () => {
    await closeDb();
    rmSync(fileDir, { recursive: true, force: true });
  });

  /** Spin the admitted-request carrier: a REAL API-key-authenticated HTTP
   *  PATCH through the production assembly, held before its reservation.
   *  Resolves once the request is ADMITTED (LISTENING + gate entered). */
  async function admittedHeldRequest(
    ruleId: string,
    apiKey: string,
    gateD: string,
    release: string,
    port: number,
  ) {
    const carrier = forkCommandWorker(fileDbPath, ruleId, "admwait", undefined, gateD, release, {
      WORKER_HTTP_PORT: String(port),
      WORKER_API_KEY: apiKey,
    });
    await waitFor("carrier READY after initDb", carrier.isReady, 30_000);
    carrier.send({ type: "GO" });
    // LISTENING = server up; entered = request held at its seam.
    await waitFor(
      "carrier server listening and request held",
      () => existsSync(join(gateD, "entered")),
      30_000,
    );
    return carrier;
  }

  /** Grab a free loopback port. */
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(p));
      });
      srv.on("error", reject);
    });
  }

  it("grant revoked on an independent connection while the SAME authenticated request is held: refused, no write", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantForAgent(agent.id, "review.configure", habitatId, admin);

    const rule = createRuleCommand({
      habitatId,
      actor: { type: "human", id: admin },
      fields: { name: "admission-window" },
    });
    const assignmentId = getDb()
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.principalId, agent.id), eq(roleAssignments.state, "active")))
      .get()!.id;

    // Positive control: the SAME key+route+payload shape succeeds through
    // the same production assembly when nothing intervenes — the held
    // request rides a live-grant path, not a doomed-from-admission one.
    const okPort = await freePort();
    const okApp = (await import("../httpApp.js")).createHttpApplication;
    const okServer = await okApp({ logger: false });
    await okServer.installPluginRoutes([]);
    await okServer.finalize();
    await okServer.listen({ port: okPort, host: "127.0.0.1" });
    const okRes = await fetch(`http://127.0.0.1:${okPort}/api/review-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-agent-api-key": plainApiKey },
      body: JSON.stringify({ name: "positive-control-ok" }),
    });
    await okServer.close();
    expect(okRes.status).toBe(200);

    const port = await freePort();
    const carrier = await admittedHeldRequest(rule.id, plainApiKey, gateDir, gateRelease, port);
    try {
      // The request is admitted and held. Revoke the grant on an INDEPENDENT
      // connection while the SAME request waits.
      const revoker = forkCommandWorker(fileDbPath, rule.id, "revoke", undefined, undefined, undefined, {
        WORKER_ASSIGNMENT_ID: assignmentId,
      });
      try {
        revoker.send({ type: "GO" });
        const revoked = await revoker.next();
        expect(revoked.kind).toBe("ok");
        expect(typeof revoked.version).toBe("number");
      } finally {
        await revoker.dispose();
      }
      expect(
        getDb().select().from(roleAssignments).where(eq(roleAssignments.id, assignmentId)).get()!.state,
      ).toBe("revoked");

      // Release: the SAME request enters its reservation, reads authority
      // fresh, and must be refused.
      writeFileSync(join(gateDir, gateRelease), "1");
      const result = await carrier.next();
      expect(result.kind).toBe("http");
      expect(result.status).toBe(403);
      expect(result.body).toContain("AUTHORIZATION_DENIED");

      // Total refusal: unchanged from the positive control's committed state
      // (name/version set by the unfaulted control PATCH), and the held
      // request added NO audit row — count stays at the control's 1.
      const row = getDb().select().from(reviewRules).where(eq(reviewRules.id, rule.id)).get()!;
      expect(row.name).toBe("positive-control-ok");
      expect(row.version).toBe(2);
      expect(
        getDb().select().from(governanceAudit).where(eq(governanceAudit.operation, "review_rule.update")).all().length,
      ).toBe(1);
    } finally {
      writeFileSync(join(gateDir, gateRelease), "1");
      await carrier.dispose();
    }
  }, 60_000);

  it("wall clock crosses the grant's UNCHANGED stored deadline while the SAME authenticated request is held: refused, no write, bytes identical", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const { agent, plainApiKey } = agentRepo.createAgent({
      name: `a-${uuid().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    });
    grantForAgent(agent.id, "review.configure", habitatId, admin);
    const assignmentId = getDb()
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.principalId, agent.id), eq(roleAssignments.state, "active")))
      .get()!.id;

    // SHORT FUTURE deadline with startup margin: +8s. Carrier fork +
    // initDb + Fastify assembly + socket admission historically lands in
    // ~2-4s, so 8s leaves room while keeping the bounded wait short. If
    // admission somehow eats the whole margin, the admission-instant check
    // below FAILS the fixture — an initially-expired denial never counts.
    const deadlineMs = Date.now() + 8_000;
    const storedExpiry = new Date(deadlineMs).toISOString();
    getDb()
      .update(roleAssignments)
      .set({ expiresAt: storedExpiry })
      .where(eq(roleAssignments.id, assignmentId))
      .run();

    const rule = createRuleCommand({
      habitatId,
      actor: { type: "human", id: admin },
      fields: { name: "expiry-window" },
    });

    // FULL assignment row frozen BEFORE the request starts — byte-level
    // identity is asserted at admission and again after the refusal.
    const assignmentBefore = JSON.stringify(
      getDb().select().from(roleAssignments).where(eq(roleAssignments.id, assignmentId)).get(),
    );
    expect(JSON.parse(assignmentBefore).expiresAt).toBe(storedExpiry);

    const port = await freePort();
    const carrier = await admittedHeldRequest(rule.id, plainApiKey, gateDir, gateRelease, port);
    try {
      // Admission gate: the SAME request was authenticated and held while
      // now < deadline — otherwise this fixture proves nothing.
      expect(Date.now(), "admission must precede the stored deadline").toBeLessThan(deadlineMs);
      expect(
        JSON.stringify(getDb().select().from(roleAssignments).where(eq(roleAssignments.id, assignmentId)).get()),
      ).toBe(assignmentBefore);

      // Deadline crossing, NO expiry rewrite: the waitonly waiter sleeps
      // until the stored deadline on wall clock and signals via the existing
      // marker protocol. The grant's bytes are never touched.
      const waiter = forkCommandWorker(fileDbPath, rule.id, "waitonly", undefined, gateDir, `x-${Math.random()}`, {
        WORKER_CROSS_AT: String(deadlineMs),
      });
      try {
        waiter.send({ type: "GO" });
        const crossed = await waiter.next();
        expect(crossed.kind).toBe("ok");
      } finally {
        await waiter.dispose();
      }
      expect(Date.now(), "deadline must have genuinely passed").toBeGreaterThanOrEqual(deadlineMs);

      // Release: the SAME request enters its reservation; the evaluator
      // compares the UNCHANGED stored deadline against the now-later wall
      // clock and must refuse.
      writeFileSync(join(gateDir, gateRelease), "1");
      const result = await carrier.next();
      expect(result.kind).toBe("http");
      expect(result.status).toBe(403);
      expect(result.body).toContain("AUTHORIZATION_DENIED");

      // No mutation: rule frozen, no audit for the attempt, and the FULL
      // assignment row — expiresAt bytes included — identical throughout.
      const row = getDb().select().from(reviewRules).where(eq(reviewRules.id, rule.id)).get()!;
      expect(row.name).toBe("expiry-window");
      expect(row.version).toBe(1);
      expect(
        getDb().select().from(governanceAudit).where(eq(governanceAudit.operation, "review_rule.update")).all().length,
      ).toBe(0);
      expect(
        JSON.stringify(getDb().select().from(roleAssignments).where(eq(roleAssignments.id, assignmentId)).get()),
      ).toBe(assignmentBefore);
    } finally {
      writeFileSync(join(gateDir, gateRelease), "1");
      await carrier.dispose();
    }
  }, 60_000);
});

describe("C. audit-fault rollback across ALL FIVE real commands (reviewGovernanceCommands)", () => {
  /** Complete affected-state snapshot: every table any of the five commands
   *  writes — full rule rows, full reviewer rows (identity/status), the task
   *  governance-scope ledger, and the full audit ledger. */
  function affectedState(ruleId: string, taskIds: string[]) {
    return JSON.stringify({
      rules: getDb().select().from(reviewRules).orderBy(reviewRules.id).all(),
      reviewers: getDb()
        .select()
        .from(taskReviewers)
        .where(inArray(taskReviewers.taskId, taskIds))
        .orderBy(taskReviewers.id)
        .all(),
      scopes: getDb()
        .select()
        .from(governanceScopes)
        .where(inArray(governanceScopes.scopeId, [ruleId, ...taskIds]))
        .orderBy(governanceScopes.scopeKind, governanceScopes.scopeId)
        .all(),
      audit: getDb().select().from(governanceAudit).orderBy(governanceAudit.id).all(),
    });
  }

  /** Same fault as withAuditFault, but hands the callback's FailingDbClient
   *  back to the caller (writeCount/writes survive the throw) so the test can
   *  assert fault-reach evidence. */
  function withAuditFaultCapturing(fn: () => unknown, out: { client: FailingDbClient | null }): void {
    const db = getDb() as unknown as {
      transaction: (cb: (tx: unknown) => unknown, cfg?: unknown) => unknown;
    };
    const original = db.transaction;
    db.transaction = function faulting(cb: (tx: unknown) => unknown, cfg?: unknown) {
      return original.call(db, (tx) => {
        const failing = new FailingDbClient(tx as never, {
          failAtWriteN: null,
          failAtTableName: "governance_audit",
          tableFaultError: new Error("Injected failure at governance_audit write"),
        });
        out.client = failing;
        return cb(failing);
      }, cfg);
    };
    try {
      fn();
    } finally {
      db.transaction = original;
    }
  }

  function auditRowsAll(): number {
    return getDb().select({ id: governanceAudit.id }).from(governanceAudit).all().length;
  }

  it("all five commands roll back completely under a governance_audit fault, each with an identical-input positive control", async () => {
    const admin = makeUser("admin");
    const habitatId = makePersonalHabitat(admin);
    const taskId = makeTaskInHabitat(habitatId);

    // Distinct reviewers so ADD and REMOVE fault cases get virgin inputs and
    // the positive controls get virgin inputs of their own.
    const addReviewerHuman = makeUser("editor");
    const removeReviewerHuman = makeUser("viewer");

    // Seed the rule + removable reviewer under the SAME real commands (these
    // seeds are also the update/delete/remove positive controls' proof the
    // commands commit unfaulted).
    const rule = createRuleCommand({
      habitatId,
      actor: { type: "human", id: admin },
      fields: { name: "fault-seed" },
    });
    addReviewerCommand({
      taskId,
      reviewerId: removeReviewerHuman,
      reviewerType: "human",
      actor: { type: "human", id: admin },
    });

    let seq = 0;
    const RULE_SENTINEL = "Injected failure at governance_audit write";

    // Each case: FAULTED invocation (must throw the exact sentinel AFTER the
    // expected mutation write reached the wrapper and one audit insert was
    // attempted) followed by an UNFAULTED twin with the SAME input, which
    // must commit the expected mutation and audit row.
    const cases: Array<{
      label: string;
      faulted: () => void;
      twin: () => void;
    }> = [
      {
        label: "createRuleCommand",
        faulted: () =>
        createRuleCommand({
          habitatId,
          actor: { type: "human", id: admin },
          fields: { name: `twin-create-${(seq += 1)}` },
        }),

        twin: () => {
          const created = createRuleCommand({
            habitatId,
            actor: { type: "human", id: admin },
            fields: { name: `twin-create-${seq}` },
          });
          expect(created.name).toBe(`twin-create-${seq}`);
          deleteRuleCommand({ ruleId: created.id, actor: { type: "human", id: admin } });
        },
      },
      {
        label: "updateRuleCommand",
        faulted: () =>
        updateRuleCommand({
          ruleId: rule.id,
          actor: { type: "human", id: admin },
          fields: { name: `twin-update-${(seq += 1)}` },
        }),

        twin: () => {
          const updated = updateRuleCommand({
            ruleId: rule.id,
            actor: { type: "human", id: admin },
            fields: { name: `twin-update-${seq}` },
          });
          expect(updated.name).toBe(`twin-update-${seq}`);
          expect(updated.version).toBeGreaterThan(1);
        },
      },
      {
        label: "deleteRuleCommand",
        faulted: () =>
        deleteRuleCommand({
          ruleId: rule.id,
          expectedVersion: undefined,
          actor: { type: "human", id: admin },
        }),

        twin: () => {
          const doomed = createRuleCommand({
            habitatId,
            actor: { type: "human", id: admin },
            fields: { name: `twin-delete-${(seq += 1)}` },
          });
          deleteRuleCommand({ ruleId: doomed.id, actor: { type: "human", id: admin } });
          expect(getDb().select().from(reviewRules).where(eq(reviewRules.id, doomed.id)).get()).toBeUndefined();
        },
      },
      {
        label: "addReviewerCommand",
        faulted: () =>
        addReviewerCommand({
          taskId,
          reviewerId: addReviewerHuman,
          reviewerType: "human",
          actor: { type: "human", id: admin },
        }),

        twin: () => {
          const added = addReviewerCommand({
            taskId,
            reviewerId: addReviewerHuman,
            reviewerType: "human",
            actor: { type: "human", id: admin },
          });
          expect(added.duplicate).toBe(false);
        },
      },
      {
        label: "removeReviewerCommand",
        faulted: () =>
        removeReviewerCommand({
          taskId,
          reviewerId: removeReviewerHuman,
          actor: { type: "human", id: admin },
        }),

        twin: () => {
          removeReviewerCommand({
            taskId,
            reviewerId: removeReviewerHuman,
            actor: { type: "human", id: admin },
          });
          expect(
            getDb()
              .select()
              .from(taskReviewers)
              .where(and(eq(taskReviewers.taskId, taskId), eq(taskReviewers.reviewerId, removeReviewerHuman)))
              .get(),
          ).toBeUndefined();
        },
      },
    ];

    for (const { label, faulted, twin } of cases) {
      const baseline = affectedState(rule.id, [taskId]);

      // --- FAULTED: the command's own reservation receives a FailingDbClient
      // faulting the governance_audit table.
      const captured: { client: FailingDbClient | null } = { client: null };
      let threw: unknown = null;
      try {
        withAuditFaultCapturing(faulted, captured);
      } catch (err) {
        threw = err;
      }
      // Exact sentinel identity: the throw IS the injected audit fault.
      expect(String(threw), `${label} must throw the audit fault`).toContain(RULE_SENTINEL);
      // Fault reach: the wrapper recorded the expected MUTATION write first,
      // then the fault fired at the audit insert — never before the mutation.
      expect(captured.client, `${label} must have captured the faulting wrapper`).not.toBeNull();
      const writes = captured.client!.writes.map((w) => ({
        kind: w.kind,
        table: getTableName(w.table as never),
      }));
      // FailingDbClient records THEN throws, so the wrapper's log shows the
      // expected mutation write(s) followed by the faulted audit insert as
      // the FINAL boundary — the fault was reached at the audit sink, after
      // the mutation.
      const mutationWrites = writes.filter((w) => w.table !== "governance_audit");
      expect(mutationWrites.length, `${label} mutation write must reach the wrapper first`).toBeGreaterThanOrEqual(1);
      expect(writes[writes.length - 1]!.table, `${label} fault must fire at the audit insert`).toBe("governance_audit");
      // And no audit row survived (the insert threw before executing).
      expect(
        getDb().select().from(governanceAudit).all().length,
      ).toBe(JSON.parse(baseline).audit.length);

      // Complete rollback: full affected-state equality.
      expect(affectedState(rule.id, [taskId])).toBe(baseline);

      // --- TWIN: the SAME command with the SAME input, unfaulted, commits
      // the expected mutation and its audit row.
      const auditBefore = auditRowsAll();
      twin();
      expect(auditRowsAll()).toBeGreaterThan(auditBefore);
    }
  }, 60_000);
});
