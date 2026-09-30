/**
 * Task dependency read-guard SEAM tests (dependency-contract fixup, review
 * findings 1+2).
 *
 * These are labeled SEAM tests: the raw-inventory read is partially mocked
 * (vi.mock on the repository module; everything else — service joins,
 * authorizeTaskAccess, error mapping — is the real code) because the guarded
 * behaviors live BETWEEN two synchronous reads of one handler: no real-wire
 * request can interleave them in single-threaded synchronous code. Each test
 * states which guard it pins and what the pre-fixup implementation would
 * have done.
 *
 *  1. direction reversal between the raw inventory and the joined
 *     projection is DETECTED (outgoing-vs-dependsOn and incoming-vs-blocking
 *     compared separately): one revalidation inventory runs and the response
 *     carries the direction-correct arrays. The pre-fixup endpoint-union
 *     comparison accepted the reversal silently with a single inventory
 *     call — this test FAILS on that implementation (calls === 1).
 *  2. persistent direction/endpoint mismatch fails closed: 503 after
 *     exactly two inventories (pre-fixup direction flip returned 200).
 *  3. a retry that inventories a newly-present inaccessible endpoint
 *     denies the read (403) — regression pin, not a discriminator.
 *  4. blocked-status second query returns a blockedBy id absent from the
 *     first inventory: the blocker guard authorizes it and denies (403);
 *     without the guard the response would be 200 with isBlocked TRUE and
 *     the unauthorized blocker's id/title/status disclosed — a data leak,
 *     not merely a wrong boolean — regression pin.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as pluginManager from "../plugins/pluginManager.js";

const seam = vi.hoisted(() => ({
  edgeIdsCalls: 0,
  overrideEdgeIds: null as null | ((call: number) => { outgoing: string[]; incoming: string[] }),
  statusesOverride: null as null | { taskId: string; title: string; status: string }[],
}));

vi.mock("../repositories/dependency.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/dependency.js")>();
  return {
    ...actual,
    getTaskDependencyEdgeIds: (taskId: string) => {
      seam.edgeIdsCalls += 1;
      if (seam.overrideEdgeIds) return seam.overrideEdgeIds(seam.edgeIdsCalls);
      return actual.getTaskDependencyEdgeIds(taskId);
    },
    getTaskDependencyStatuses: (taskId: string) =>
      seam.statusesOverride ?? actual.getTaskDependencyStatuses(taskId),
  };
});

let app: HttpRuntimeHandle;
let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let memberAJwtBody: { authorization: string };

let columnOrder = 0;
function makeTask(habitatId: string, title: string, createdBy: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy,
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  const org = organizationRepo.createOrganization({
    name: "tds-org",
    slug: `tds-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tds-team-a",
    slug: `tds-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tds-team-b",
    slug: `tds-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tds-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tds-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tds-personal-habitat" }).id;
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tds-member-a", role: "member" });

  const created = agentRepo.createAgent({
    name: "tds-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentKey = created.plainApiKey;
  // Member of team A only; team B endpoints are inaccessible to this JWT.
  const { getJwtSecret } = await import("../middleware/jwt-verification.js");
  const jwt = (await import("jsonwebtoken")).default;
  const token = jwt.sign(
    { sub: "tds-member-a", username: "tds-member-a", role: "viewer" },
    getJwtSecret(),
    {
      expiresIn: "1h",
      issuer: "orcy",
    },
  );
  memberAJwtBody = { authorization: `Bearer ${token}` };
}, 120_000);

afterEach(() => {
  seam.edgeIdsCalls = 0;
  seam.overrideEdgeIds = null;
  seam.statusesOverride = null;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("task dependency read guards (SEAM — interleaved synchronous reads)", () => {
  it("a direction reversal between inventory and projection triggers revalidation, not silent acceptance", async () => {
    // Real DB holds the REVERSED edge (B blocks src); the first (stale)
    // inventory reports the forward direction. Union equality holds across
    // the flip, so the pre-fixup comparator returned the projection after a
    // single inventory; direction-aware comparison must retry.
    const src = makeTask(personalHabitatId, "tds-rev-src", "tds-seed");
    const b = makeTask(personalHabitatId, "tds-rev-b", "tds-seed");
    dependencyRepo.addTaskDependency(b, src);

    seam.overrideEdgeIds = (call) =>
      call === 1 ? { outgoing: [b], incoming: [] } : { outgoing: [], incoming: [b] };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${src}/dependencies`,
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dependsOn).toEqual([]);
    expect(body.blocking.map((row: { taskId: string }) => row.taskId)).toEqual([b]);
    // Discriminator: pre-fixup implementation called the inventory once and
    // never noticed the reversal.
    expect(seam.edgeIdsCalls).toBe(2);
  }, 30_000);

  it("persistent direction mismatch fails closed with 503 after exactly two inventories", async () => {
    const src = makeTask(personalHabitatId, "tds-stale-src", "tds-seed");
    const b = makeTask(personalHabitatId, "tds-stale-b", "tds-seed");
    dependencyRepo.addTaskDependency(b, src);

    seam.overrideEdgeIds = () => ({ outgoing: [b], incoming: [] });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${src}/dependencies`,
      headers: { "x-agent-api-key": agentKey },
    });
    expect(res.statusCode).toBe(503);
    expect(seam.edgeIdsCalls).toBe(2);
  }, 30_000);

  it("a retry that inventories a newly-present inaccessible endpoint denies the read (403)", async () => {
    const src = makeTask(teamAHabitatId, "tds-retry-src", "tds-seed");
    const accessible = makeTask(teamAHabitatId, "tds-retry-accessible", "tds-seed");
    const hidden = makeTask(teamBHabitatId, "tds-retry-hidden", "tds-seed");
    // Real DB edge points at the team-B endpoint; the stale first inventory
    // named the accessible team-A endpoint instead.
    dependencyRepo.addTaskDependency(src, hidden);

    seam.overrideEdgeIds = (call) =>
      call === 1 ? { outgoing: [accessible], incoming: [] } : { outgoing: [hidden], incoming: [] };

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${src}/dependencies`,
      headers: memberAJwtBody,
    });
    expect(res.statusCode).toBe(403);
    expect(seam.edgeIdsCalls).toBe(2);
  }, 30_000);

  it("blocked-status second query returning an inventory-absent blockedBy id denies the whole read (403)", async () => {
    const src = makeTask(teamAHabitatId, "tds-blockedby-src", "tds-seed");
    const hidden = makeTask(teamBHabitatId, "tds-blockedby-hidden", "tds-seed");
    // No edges in the DB: raw inventory and joined projection agree on
    // empty. The SECOND query (validateTaskCompletion) surfaces a hidden
    // team-B blocker the first inventory never saw.
    seam.statusesOverride = [{ taskId: hidden, title: "tds-blockedby-hidden", status: "pending" }];

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tasks/${src}/blocked-status`,
      headers: memberAJwtBody,
    });
    // Without the blocker guard this would be 200 with isBlocked TRUE and
    // the unauthorized blocker's data (id/title/status) disclosed; the
    // guard authorizes the reported blocker and denies instead.
    expect(res.statusCode).toBe(403);
    expect(res.json().isBlocked).toBeUndefined();
  }, 30_000);
});
