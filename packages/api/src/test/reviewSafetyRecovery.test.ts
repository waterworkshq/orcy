/**
 * Independent human recovery (review safety) — the ONLY unknown→known exit
 * and the ONLY positive-baseline reduction. Persisted-role authorization with
 * the global viewer ceiling, independence refusals, stale-version refusals,
 * and the override-expiry restore (release/reset without a next claim).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  users,
  teams,
  teamMembers,
  organizations,
  taskReviewRequirements,
  habitats,
  tasks,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskService from "../services/tasks/index.js";
import { resolveTaskReviewRequirement } from "../services/reviewRecoveryService.js";
import { getRequirementWithClient } from "../repositories/reviewSafety.js";
import { v4 as uuid } from "uuid";

let habitatId: string;
let missionId: string;

function seedWorld(name: string): { teamId: string | null } {
  const habitat = habitatRepo.createHabitat({
    name: `rs-rec-${name}-${Math.random()}`,
  } as never);
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `rs-rec-${name}`,
    createdBy: "u",
  });
  missionId = mission.id;
  return { teamId: (habitat as { teamId?: string | null }).teamId ?? null };
}

function makeUser(role: "admin" | "editor" | "viewer"): string {
  const id = uuid();
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", displayName: id, role })
    .run();
  return id;
}

function makeTeamWithMember(role: "owner" | "admin" | "member"): {
  teamId: string;
  userId: string;
} {
  const teamId = uuid();
  const orgId = uuid();
  getDb()
    .insert(organizations)
    .values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` })
    .run();
  getDb()
    .insert(teams)
    .values({ id: teamId, organizationId: orgId, name: `t-${teamId}`, slug: `t-${teamId}` })
    .run();
  const userId = makeUser("editor");
  getDb().insert(teamMembers).values({ id: uuid(), teamId, userId, role }).run();
  // Attach the team to the habitat.
  getDb().update(habitats).set({ teamId }).where(eq(habitats.id, habitatId)).run();
  return { teamId, userId };
}

function claimedLegacyUnknown(stopBeforeSubmit = false): { taskId: string; agent: string } {
  const taskId = taskCrud.createTask({ missionId, title: `t-${Math.random()}`, createdBy: "u" }).id;
  // Legacy-unknown shape (migration equivalent) + a genuine claim on top.
  const agent = agentRepo.createAgent({
    name: `rs-agent-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  }).agent.id;
  getDb()
    .update(taskReviewRequirements)
    .set({
      origin: "legacy_unverified",
      state: "legacy_unknown",
      knownPolicyFloor: 1,
      nonOverriddenFloor: null,
      effectiveCount: null,
    })
    .where(eq(taskReviewRequirements.taskId, taskId))
    .run();
  if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
  taskStateMachine.startTask(taskId, agent);
  if (!stopBeforeSubmit) taskStateMachine.submitTask(taskId, agent, "w", []);
  return { taskId, agent };
}

function resolve(
  taskId: string,
  actor: string,
  opts?: Partial<{ tv: number; rv: number; count: number; reason: string }>,
) {
  const r = getRequirementWithClient(getDb() as never, taskId)!;
  const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  return resolveTaskReviewRequirement({
    taskId,
    actorUserId: actor,
    expectedTaskVersion: opts?.tv ?? t.version,
    expectedRequirementVersion: opts?.rv ?? r.requirementVersion,
    effectiveCount: opts?.count ?? 0,
    reason: opts?.reason ?? "operator resolution",
  });
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe("recovery authorization — persisted roles under the viewer ceiling", () => {
  it("global admin resolves; global viewer is refused even as team owner", () => {
    const { teamId } = seedWorld("auth");
    expect(teamId).toBeNull(); // personal habitat by default
    const { taskId } = claimedLegacyUnknown();
    const admin = makeUser("admin");
    expect(resolve(taskId, admin).ok).toBe(true);
    const r = getRequirementWithClient(getDb() as never, taskId)!;
    // Explicit 0 with accumulated known_policy_floor 1: the resolution takes
    // the MAX — baseline 1, still `required` (never a fabricated known-zero).
    expect(r.state).toBe("required");
    expect(r.nonOverriddenFloor).toBe(0);
    expect(r.effectiveCount).toBe(1);
  });

  it("team owner/admin in the correct team resolves; viewer+owner is refused; stale membership is refused", () => {
    seedWorld("team");
    const { taskId } = claimedLegacyUnknown();
    const owner = makeTeamWithMember("owner");
    expect(resolve(taskId, owner.userId, { count: 1 }).ok).toBe(true);

    // A DIFFERENT habitat's team member cannot resolve.
    const other = makeTeamWithMember("admin"); // re-attaches habitat — simulate stale by reverting teamId
    getDb().update(habitats).set({ teamId: owner.teamId }).where(eq(habitats.id, habitatId)).run();
    expect(resolve(taskId, other.userId).ok).toBe(false);

    // Viewer ceiling: a persisted viewer who is the team owner is refused.
    const viewerId = makeUser("viewer");
    getDb()
      .insert(teamMembers)
      .values({ id: uuid(), teamId: owner.teamId, userId: viewerId, role: "owner" })
      .run();
    expect(resolve(taskId, viewerId).ok).toBe(false);
  });
});

describe("recovery independence + versions", () => {
  it("the current executor and a current-generation decider are refused", () => {
    seedWorld("independence");
    const { taskId, agent } = claimedLegacyUnknown();
    // A human review decider exists in the current generation.
    taskService.rejectTask(taskId, "decider-1", "no", "human");
    const admin = makeUser("admin");
    // Executor: typed claimant id equal to the actor id string.
    expect(resolve(taskId, agent).ok).toBe(false);
    // Decider in the current generation.
    expect(resolve(taskId, "decider-1").ok).toBe(false);
    // Independent admin succeeds.
    expect(resolve(taskId, admin, { count: 1 }).ok).toBe(true);
  });

  it("stale task/requirement versions reject", () => {
    seedWorld("versions");
    const { taskId } = claimedLegacyUnknown();
    const admin = makeUser("admin");
    expect(resolve(taskId, admin, { tv: 999 }).ok).toBe(false);
    expect(resolve(taskId, admin, { rv: 999 }).ok).toBe(false);
  });
});

describe("resolution semantics + override expiry", () => {
  it("resolving unknown to a positive count sets the historical floor; zero-vs-policy takes max", () => {
    seedWorld("resolve");
    const { taskId } = claimedLegacyUnknown();
    const admin = makeUser("admin");
    // known_policy_floor accumulated 1 at claim; explicit 0 → baseline max(0,1)=1 → required.
    const out = resolve(taskId, admin, { count: 0 });
    expect(out.ok).toBe(true);
    const r = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r.state).toBe("required");
    expect(r.nonOverriddenFloor).toBe(0);
    expect(r.effectiveCount).toBe(1);
    // A second resolution is NOT a raise: once resolved, raising above the
    // baseline is refused (only a reduction may override).
    const out2 = resolve(taskId, admin, { count: 2 });
    expect(out2.ok).toBe(false);
    expect((out2 as { reason: string }).reason).toBe("not_a_reduction");
  });

  it("relax-to-zero stays required and expires at the next release with immediate baseline restore", () => {
    seedWorld("relax-expiry");
    const { taskId, agent } = claimedLegacyUnknown(true); // stop before submit
    const admin = makeUser("admin");
    expect(resolve(taskId, admin, { count: 2 }).ok).toBe(true);

    const relaxed = resolveTaskReviewRequirement({
      taskId,
      actorUserId: admin,
      expectedTaskVersion: getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!.version,
      expectedRequirementVersion: getRequirementWithClient(getDb() as never, taskId)!
        .requirementVersion,
      effectiveCount: 0,
      reason: "relax",
    });
    expect(relaxed.ok).toBe(true);
    const r0 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r0.state).toBe("required"); // never relabeled known_zero
    expect(r0.effectiveCount).toBe(0);
    expect(r0.activeOverrideId).not.toBeNull();

    // Release WITHOUT a new claim: baseline restored immediately.
    expect(taskStateMachine.releaseTask(taskId, "requeue") !== null).toBe(true);
    const r1 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r1.state).toBe("required");
    expect(r1.activeOverrideId).toBeNull();
    expect(r1.effectiveCount).toBe(2);
    void agent;
  });

  it("a resolution never approves or completes the task", () => {
    seedWorld("never-approves");
    const { taskId } = claimedLegacyUnknown();
    const admin = makeUser("admin");
    expect(resolve(taskId, admin, { count: 0 }).ok).toBe(true);
    const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(t.status).toBe("submitted"); // untouched by the resolution
  });
});
