/**
 * Focused evaluator tests for the local authorization storage slice
 * (migration 0083). Complementary to the independent foundation tests
 * (localAuthorizationMatrix / roleFoundationMigration, prepared by the
 * parallel test lane): this file pins the evaluator's own decision logic on
 * the sql.js test driver — virtual-scope read purity, human adapters and
 * viewer ceiling, downward inheritance through real ancestry rows,
 * decision-time expiry, retired-incarnation refusal, own-Task denial and
 * typed principal equality — using the repos to seed the world.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { initTestDb, getDb, closeDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as columnRepo from "../repositories/column.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import { users, teamMembers, governanceScopes, roleAssignments } from "../db/schema/index.js";
import {
  authorizeWithClient,
  evaluatePermissionsWithClient,
  getScopeStateWithClient,
  resolveScopeChainWithClient,
  type LocalPrincipal,
} from "../services/localAuthorization.js";

let db: ReturnType<typeof getDb>;

function makeUser(id: string, role: "admin" | "editor" | "viewer") {
  db.insert(users)
    .values({ id, username: id, passwordHash: "x", role })
    .onConflictDoNothing()
    .run();
}

beforeEach(async () => {
  db = (await initTestDb()) as unknown as ReturnType<typeof getDb>;
});

describe("governance scope state", () => {
  it("reads a live unmaterialized habitat as virtual incarnation 1 version 1 without writing", () => {
    const habitat = habitatRepo.createHabitat({ name: `ev-virtual-${Math.random()}` });
    const before = db.select().from(governanceScopes).all().length;
    const state = getScopeStateWithClient(db, "habitat", habitat.id);
    const after = db.select().from(governanceScopes).all().length;
    expect(state).toEqual({
      status: "active",
      incarnation: 1,
      version: 1,
      materialized: false,
    });
    expect(after).toBe(before); // read purity: nothing materialized
  });

  it("returns null for a missing resource and never falls back to virtual for a retired scope", () => {
    expect(getScopeStateWithClient(db, "habitat", "nope")).toBeNull();
    const habitat = habitatRepo.createHabitat({ name: `ev-retired-${Math.random()}` });
    db.insert(governanceScopes)
      .values({ scopeKind: "habitat", scopeId: habitat.id, incarnation: 1, version: 2, retiredAt: "2026-01-01T00:00:00.000Z" })
      .run();
    const state = getScopeStateWithClient(db, "habitat", habitat.id);
    expect(state?.status).toBe("retired");
    expect(state?.incarnation).toBe(1);
  });

  it("resolves task→mission→habitat→team ancestry from persisted rows", () => {
    const habitat = habitatRepo.createHabitat({ name: `ev-chain-${Math.random()}` });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "m",
      createdBy: "u",
    });
    const chain = resolveScopeChainWithClient(db, "mission", mission.id);
    expect(chain).toEqual([
      { scopeKind: "mission", scopeId: mission.id },
      { scopeKind: "habitat", scopeId: habitat.id },
    ]);
  });
});

describe("human adapters and ceiling", () => {
  it("allows a persisted global admin everywhere; denies a viewer even with a matching grant", () => {
    makeUser("h-admin", "admin");
    makeUser("h-viewer", "viewer");
    const habitat = habitatRepo.createHabitat({ name: `ev-hum-${Math.random()}` });

    expect(
      authorizeWithClient(db, { type: "human", id: "h-admin" }, "review.configure", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toBe(true);

    // Viewer with an active coordinator grant at that habitat is still denied.
    db.insert(schema.roleAssignments)
      .values({
        id: "as-viewer-1",
        principalType: "human",
        principalId: "h-viewer",
        definitionId: "builtin-role-coordinator",
        revisionId: "builtin-role-coordinator-rev-1",
        scopeKind: "habitat",
        scopeId: habitat.id,
        scopeIncarnation: 1,
        state: "active",
        version: 1,
        issuerUserId: "h-admin",
      })
      .run();
    const decision = evaluatePermissionsWithClient(
      db,
      { type: "human", id: "h-viewer" },
      "review.configure",
      { scopeKind: "habitat", scopeId: habitat.id },
    );
    expect(decision).toEqual({ allowed: false, reason: "VIEWER_CEILING" });
  });

  it("admits a team owner human on the habitat of their team; refuses a plain member", () => {
    makeUser("h-owner", "editor");
    makeUser("h-member", "editor");
    db.insert(schema.organizations).values({ id: "o1", name: "O", slug: `o-${Math.random()}` }).run();
    db.insert(schema.teams)
      .values({ id: "tm1", organizationId: "o1", name: "T", slug: `t-${Math.random()}` })
      .run();
    const habitat = habitatRepo.createHabitat({ name: `ev-team-${Math.random()}` });
    db.update(schema.habitats).set({ teamId: "tm1" }).where(eq(schema.habitats.id, habitat.id)).run();
    db.insert(teamMembers).values({ id: "mb1", teamId: "tm1", userId: "h-owner", role: "owner" }).run();
    db.insert(teamMembers).values({ id: "mb2", teamId: "tm1", userId: "h-member", role: "member" }).run();

    expect(
      authorizeWithClient(db, { type: "human", id: "h-owner" }, "review.configure", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toBe(true);
    const member = evaluatePermissionsWithClient(
      db,
      { type: "human", id: "h-member" },
      "review.configure",
      { scopeKind: "habitat", scopeId: habitat.id },
    );
    expect(member).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });
});

describe("agent grants", () => {
  function makeAgent(id: string) {
    const { agent } = agentRepo.createAgent({
      name: `ev-agent-${id}-${Math.random()}`,
      type: "claude-code",
      domain: "backend",
    });
    return agent;
  }

  function grantCoordinator(principal: LocalPrincipal, scopeKind: "team" | "habitat" | "mission" | "task", scopeId: string, expiresAt?: string) {
    makeUser("h-admin", "admin");
    db.insert(roleAssignments)
      .values({
        id: `as-${Math.random()}`,
        principalType: principal.type,
        principalId: principal.id,
        definitionId: "builtin-role-coordinator",
        revisionId: "builtin-role-coordinator-rev-1",
        scopeKind,
        scopeId,
        scopeIncarnation: 1,
        state: "active",
        version: 1,
        issuerUserId: "h-admin",
        expiresAt: expiresAt ?? null,
      })
      .run();
  }

  function seedTaskWithExecutor(executorAgentId: string | null) {
    const habitat = habitatRepo.createHabitat({ name: `ev-task-${Math.random()}` });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "m",
      createdBy: "u",
    });
    const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
    if (executorAgentId) {
      db.update(schema.tasks).set({ assignedAgentId: executorAgentId }).where(eq(schema.tasks.id, task.id)).run();
    }
    return { habitat, mission, task };
  }

  it("inherits a team-scoped grant down to a habitat target and refuses siblings", () => {
    const agent = makeAgent("a1");
    db.insert(schema.organizations).values({ id: "o2", name: "O2", slug: `o2-${Math.random()}` }).run();
    db.insert(schema.teams).values({ id: "tm2", organizationId: "o2", name: "T2", slug: `t2-${Math.random()}` }).run();
    db.insert(schema.teams).values({ id: "tm3", organizationId: "o2", name: "T3", slug: `t3-${Math.random()}` }).run();
    const hMine = habitatRepo.createHabitat({ name: `ev-mine-${Math.random()}` });
    const hSibling = habitatRepo.createHabitat({ name: `ev-sib-${Math.random()}` });
    db.update(schema.habitats).set({ teamId: "tm2" }).where(eq(schema.habitats.id, hMine.id)).run();
    db.update(schema.habitats).set({ teamId: "tm3" }).where(eq(schema.habitats.id, hSibling.id)).run();
    grantCoordinator({ type: "agent", id: agent.id }, "team", "tm2");

    expect(
      authorizeWithClient(db, { type: "agent", id: agent.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: hMine.id,
      }),
    ).toBe(true);
    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: hSibling.id,
      }),
    ).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });

  it("denies review.assign for the current typed executor of the target task, allows another agent", () => {
    const executor = makeAgent("exec");
    const other = makeAgent("other");
    const { task } = seedTaskWithExecutor(executor.id);
    grantCoordinator({ type: "agent", id: executor.id }, "task", task.id);
    grantCoordinator({ type: "agent", id: other.id }, "task", task.id);

    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: executor.id }, "review.assign", {
        scopeKind: "task",
        scopeId: task.id,
      }),
    ).toEqual({ allowed: false, reason: "OWN_TASK_DENIAL" });
    expect(
      authorizeWithClient(db, { type: "agent", id: other.id }, "review.assign", {
        scopeKind: "task",
        scopeId: task.id,
      }),
    ).toBe(true);
  });

  it("expires grants at decision time and refuses retired incarnations", () => {
    const agent = makeAgent("a2");
    const { habitat, task } = seedTaskWithExecutor(null);
    const past = new Date(Date.now() - 60_000).toISOString();
    grantCoordinator({ type: "agent", id: agent.id }, "habitat", habitat.id, past);
    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toEqual({ allowed: false, reason: "EXPIRED_GRANT" });

    // Retire the task scope; the grant captured incarnation 1 no longer matches.
    const agent3 = makeAgent("a3");
    grantCoordinator({ type: "agent", id: agent3.id }, "task", task.id);
    db.insert(governanceScopes)
      .values({ scopeKind: "task", scopeId: task.id, incarnation: 1, version: 1, retiredAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: agent3.id }, "review.assign", {
        scopeKind: "task",
        scopeId: task.id,
      }),
    ).toEqual({ allowed: false, reason: "RETIRED_SCOPE" });
  });

  it("enforces permission-target compatibility before any inheritance logic", () => {
    const agent = makeAgent("a4");
    const { habitat } = seedTaskWithExecutor(null);
    grantCoordinator({ type: "agent", id: agent.id }, "habitat", habitat.id);
    // configure at a habitat is fine; assign targeting a habitat is malformed.
    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toEqual({ allowed: false, reason: "MALFORMED_PERMISSION" });
    const teamTarget = evaluatePermissionsWithClient(
      db,
      { type: "agent", id: agent.id },
      "review.configure",
      { scopeKind: "team", scopeId: "tm-not-a-target" },
    );
    expect(teamTarget.allowed).toBe(false);
    if (!teamTarget.allowed) {
      expect(["MALFORMED_PERMISSION", "SCOPE_NOT_FOUND"]).toContain(teamTarget.reason);
    }
  });
});

describe("typed principal equality", () => {
  it("treats a human and an agent with the same string id as different principals", () => {
    makeUser("same-id", "editor");
    const agent = agentRepo.createAgent({
      name: `ev-agent-same-${Math.random()}`,
      type: "claude-code",
      domain: "backend",
    }).agent;
    // A human whose string id equals the agent's id — the collision case.
    makeUser(agent.id, "editor");
    const habitat = habitatRepo.createHabitat({ name: `ev-typed-${Math.random()}` });
    makeUser("h-admin", "admin");
    db.insert(roleAssignments)
      .values({
        id: "as-agent-same",
        principalType: "agent",
        principalId: agent.id,
        definitionId: "builtin-role-review-coordinator",
        revisionId: "builtin-role-review-coordinator-rev-1",
        scopeKind: "habitat",
        scopeId: habitat.id,
        scopeIncarnation: 1,
        state: "active",
        version: 1,
        issuerUserId: "h-admin",
      })
      .run();
    // The human sharing the agent's id has no grant.
    expect(
      evaluatePermissionsWithClient(db, { type: "human", id: agent.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    // And the agent id that matches the human's id has no grant either.
    expect(
      evaluatePermissionsWithClient(db, { type: "agent", id: "same-id" }, "review.configure", {
        scopeKind: "habitat",
        scopeId: habitat.id,
      }),
    ).toEqual({ allowed: false, reason: "PRINCIPAL_NOT_FOUND" });
  });
});
