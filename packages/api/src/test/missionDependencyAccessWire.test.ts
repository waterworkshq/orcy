/**
 * Mission dependency authorization wire matrix (issue: human nonmember
 * access to Mission dependency endpoints) — REAL HTTP on BOTH served
 * prefixes (`/api/v1`, deprecated `/api`).
 *
 * Scope of claims:
 *  - All five Mission dependency handlers (POST/DELETE dependencies, GET
 *    dependencies, GET blocked-status, GET dependency-graph) authorize the
 *    TARGET mission's actual Habitat via the persisted Mission → Habitat
 *    ancestry before any projection or write — the same membership
 *    predicate as the Task dependency handlers. Intended delta: team
 *    nonmember humans 403 (was 200 read/write of private Team data).
 *  - Linked missions are authorized too: an accessible root never
 *    discloses inaccessible linked missions' titles, statuses, or graph
 *    nodes (outgoing, incoming, blockedBy, and traversed graph nodes).
 *  - Preserved: anonymous 401; member (any role) / personal-Habitat human
 *    / local agent admission (broad pod-wide agent access is intentional);
 *    generated HEAD reads inherit the GET guards.
 *  - Denied writes leave edges unchanged (zero rows inserted/deleted).
 *
 * No middleware mocks: every request crosses a real TCP socket into the
 * real application. Duplicate-insert 409 and DB-fault 500 classification
 * live in `taskDependencyFaultWire.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, and } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { missions, missionDependencies } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";

const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let agentKey: string;

let memberJwt: string;
let dualMemberJwt: string;
let nonmemberAdminJwt: string;
let personalHumanJwt: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function mint(userId: string, role: string): string {
  return jwt.sign({ sub: userId, username: `mda-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: { token?: string; agentKey?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON (e.g. HEAD) */
  }
  return { status: res.status, body, text };
}

let columnOrder = 0;
function makeMission(habitatId: string, title: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `mda-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  return missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title,
    createdBy: "mda-seed",
  }).id;
}

function setMissionStatus(missionId: string, status: string): void {
  getDb().update(missions).set({ status }).where(eq(missions.id, missionId)).run();
}

function edgeRows(missionId: string, dependsOnId: string) {
  return getDb()
    .select()
    .from(missionDependencies)
    .where(
      and(
        eq(missionDependencies.missionId, missionId),
        eq(missionDependencies.dependsOnId, dependsOnId),
      ),
    )
    .all();
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "mda-org",
    slug: `mda-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "mda-team-a",
    slug: `mda-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "mda-team-b",
    slug: `mda-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "mda-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "mda-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "mda-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId: teamA.id, userId: "mda-member", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "mda-dual-member", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "mda-dual-member", role: "member" });

  memberJwt = mint("mda-member", "viewer");
  dualMemberJwt = mint("mda-dual-member", "viewer");
  nonmemberAdminJwt = mint("mda-nonmember-admin", "admin");
  personalHumanJwt = mint("mda-personal-human", "admin");

  agentKey = agentRepo.createAgent({
    name: "mda-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).plainApiKey;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("mission dependency endpoints — authentication and root authorization", () => {
  it("anonymous is 401 on all five handlers on both prefixes", async () => {
    const root = makeMission(teamAHabitatId, "mda-anon-root");
    const dep = makeMission(teamAHabitatId, "mda-anon-dep");
    const targets: [string, string, unknown][] = [
      ["POST", `/missions/${root}/dependencies`, { dependsOnMissionId: dep }],
      ["DELETE", `/missions/${root}/dependencies/${dep}`, undefined],
      ["GET", `/missions/${root}/dependencies`, undefined],
      ["GET", `/missions/${root}/blocked-status`, undefined],
      ["GET", `/missions/${root}/dependency-graph`, undefined],
    ];
    for (const prefix of PREFIXES) {
      for (const [method, path, body] of targets) {
        const res = await wire(prefix, method, path, { body });
        expect(res.status, `${prefix} ${method}`).toBe(401);
      }
    }
    expect(edgeRows(root, dep)).toHaveLength(0);
  }, 30_000);

  it("team nonmember human is 403 on all five handlers with no disclosure and unchanged edges", async () => {
    const root = makeMission(teamAHabitatId, "mda-priv-root");
    const dep = makeMission(teamAHabitatId, "mda-priv-dep");
    dependencyRepo.addMissionDependency(root, dep);
    setMissionStatus(dep, "not_started");

    for (const prefix of PREFIXES) {
      const reads = await Promise.all([
        wire(prefix, "GET", `/missions/${root}/dependencies`, { token: nonmemberAdminJwt }),
        wire(prefix, "GET", `/missions/${root}/blocked-status`, { token: nonmemberAdminJwt }),
        wire(prefix, "GET", `/missions/${root}/dependency-graph`, { token: nonmemberAdminJwt }),
      ]);
      for (const res of reads) {
        expect(res.status).toBe(403);
        expect(res.text).not.toContain("mda-priv-dep");
        expect(res.body.dependsOn).toBeUndefined();
        expect(res.body.blockedBy).toBeUndefined();
        expect(res.body.nodes).toBeUndefined();
      }

      // Denied writes: insert (dep in the nonmember's personal habitat is
      // still a write against the private root) and delete.
      const posted = await wire(prefix, "POST", `/missions/${root}/dependencies`, {
        token: nonmemberAdminJwt,
        body: { dependsOnMissionId: makeMission(personalHabitatId, "mda-priv-write-dep") },
      });
      expect(posted.status).toBe(403);
      const deleted = await wire(prefix, "DELETE", `/missions/${root}/dependencies/${dep}`, {
        token: nonmemberAdminJwt,
      });
      expect(deleted.status).toBe(403);
    }
    expect(edgeRows(root, dep)).toHaveLength(1);
  }, 30_000);

  it("member human gets full read shapes and working writes; generated HEAD reads are guarded", async () => {
    const root = makeMission(teamAHabitatId, "mda-member-root");
    const dep = makeMission(teamAHabitatId, "mda-member-dep");
    setMissionStatus(dep, "not_started");

    const posted = await wire("/api/v1", "POST", `/missions/${root}/dependencies`, {
      token: memberJwt,
      body: { dependsOnMissionId: dep },
    });
    expect(posted.status).toBe(200);
    expect(edgeRows(root, dep)).toHaveLength(1);

    for (const prefix of PREFIXES) {
      const deps = await wire(prefix, "GET", `/missions/${root}/dependencies`, { token: memberJwt });
      expect(deps.status).toBe(200);
      expect(deps.body.dependsOn).toHaveLength(1);
      expect(deps.body.dependsOn[0].missionId).toBe(dep);
      expect(deps.body.blocking).toHaveLength(0);

      const blocked = await wire(prefix, "GET", `/missions/${root}/blocked-status`, {
        token: memberJwt,
      });
      expect(blocked.status).toBe(200);
      expect(blocked.body.canComplete).toBe(false);
      expect(blocked.body.reason).toBe("BLOCKED_BY_FEATURE_DEPENDENCIES");
      expect(blocked.body.blockedBy[0].taskId).toBe(dep);

      const graph = await wire(prefix, "GET", `/missions/${root}/dependency-graph`, {
        token: memberJwt,
      });
      expect(graph.status).toBe(200);
      expect(graph.body.nodes.map((n: any) => n.id).toSorted()).toEqual([dep, root].toSorted());
      expect(graph.body.edges).toEqual([{ from: root, to: dep }]);

      // Fastify's generated HEAD reuses the GET handler; its guards must hold.
      const head = await wire(prefix, "HEAD", `/missions/${root}/blocked-status`, {
        token: nonmemberAdminJwt,
      });
      expect(head.status, `${prefix} head`).toBe(403);
    }

    const deleted = await wire("/api/v1", "DELETE", `/missions/${root}/dependencies/${dep}`, {
      token: memberJwt,
    });
    expect(deleted.status).toBe(200);
    expect(edgeRows(root, dep)).toHaveLength(0);
    const missing = await wire("/api/v1", "DELETE", `/missions/${root}/dependencies/${dep}`, {
      token: memberJwt,
    });
    expect(missing.status).toBe(404);
  }, 30_000);

  it("personal-habitat human and local agent keep admission", async () => {
    const personalRoot = makeMission(personalHabitatId, "mda-personal-root");
    const personalDep = makeMission(personalHabitatId, "mda-personal-dep");
    const posted = await wire("/api/v1", "POST", `/missions/${personalRoot}/dependencies`, {
      token: personalHumanJwt,
      body: { dependsOnMissionId: personalDep },
    });
    expect(posted.status).toBe(200);

    const agentRoot = makeMission(teamAHabitatId, "mda-agent-root");
    const agentDep = makeMission(teamBHabitatId, "mda-agent-dep");
    for (const path of [`/missions/${agentRoot}/dependencies`, `/missions/${agentRoot}/dependency-graph`]) {
      const res = await wire("/api/v1", "GET", path, { agentKey });
      expect(res.status, path).toBe(200);
    }
    const agentPost = await wire("/api/v1", "POST", `/missions/${agentRoot}/dependencies`, {
      agentKey,
      body: { dependsOnMissionId: agentDep },
    });
    expect(agentPost.status).toBe(200);
  }, 30_000);
});

describe("mission dependency reads — linked mission authorization", () => {
  const TITLE_OUT = "mda-xhab-out-marker";
  const TITLE_GRAPH = "mda-xhab-graph-marker";

  it("member with OUTGOING endpoint in inaccessible team B is 403 on all three reads; dual member gets 200", async () => {
    const root = makeMission(teamAHabitatId, "mda-xout-root");
    const dep = makeMission(teamBHabitatId, TITLE_OUT);
    dependencyRepo.addMissionDependency(root, dep);
    setMissionStatus(dep, "not_started");

    for (const prefix of PREFIXES) {
      for (const path of [
        `/missions/${root}/dependencies`,
        `/missions/${root}/blocked-status`,
        `/missions/${root}/dependency-graph`,
      ]) {
        const res = await wire(prefix, "GET", path, { token: memberJwt });
        expect(res.status, `${prefix} ${path}`).toBe(403);
        expect(res.text).not.toContain(TITLE_OUT);
      }
    }
    for (const path of [
      `/missions/${root}/dependencies`,
      `/missions/${root}/blocked-status`,
      `/missions/${root}/dependency-graph`,
    ]) {
      const res = await wire("/api/v1", "GET", path, { token: dualMemberJwt });
      expect(res.status, path).toBe(200);
      expect(res.text).toContain(TITLE_OUT);
    }
  }, 30_000);

  it("member with INCOMING endpoint in inaccessible team B is 403 on the dependencies read (reverse direction)", async () => {
    const root = makeMission(teamAHabitatId, "mda-xin-root");
    const blocker = makeMission(teamBHabitatId, "mda-xin-blocker-marker");
    dependencyRepo.addMissionDependency(blocker, root);

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/missions/${root}/dependencies`, { token: memberJwt });
      expect(res.status, `${prefix} deps`).toBe(403);
      expect(res.text).not.toContain("mda-xin-blocker-marker");
      expect(res.body.blocking).toBeUndefined();
    }
  }, 30_000);

  it("graph traversal stops closed at an inaccessible transitive node", async () => {
    const root = makeMission(teamAHabitatId, "mda-graph-root");
    const mid = makeMission(teamAHabitatId, "mda-graph-mid");
    const far = makeMission(teamBHabitatId, TITLE_GRAPH);
    dependencyRepo.addMissionDependency(root, mid);
    dependencyRepo.addMissionDependency(mid, far);

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/missions/${root}/dependency-graph`, {
        token: memberJwt,
      });
      expect(res.status, `${prefix} graph`).toBe(403);
      expect(res.text).not.toContain(TITLE_GRAPH);
    }
    const dual = await wire("/api/v1", "GET", `/missions/${root}/dependency-graph`, {
      token: dualMemberJwt,
    });
    expect(dual.status).toBe(200);
    expect(dual.body.nodes).toHaveLength(3);
  }, 30_000);
});
