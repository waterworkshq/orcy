/**
 * Four Task dependency operations (dependency-contract, Sol ACCEPT) — REAL
 * HTTP wire matrix on BOTH served prefixes (`/api/v1`, deprecated `/api`)
 * plus served MCP compatibility.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - GET /tasks/:id/dependencies, GET /tasks/:id/blocked-status,
 *    POST /tasks/:id/dependencies, DELETE /tasks/:id/dependencies/:depId
 *    resolve the TARGET Task's (and every linked edge endpoint's) actual
 *    Mission → Habitat and enforce the shared membership predicate before
 *    any projection or write. Intended deltas: team-nonmember humans 403
 *    (was 200); inaccessible linked endpoint 403 for the whole read; absent
 *    POST body 400 (was a thrown 500); absent DELETE pair 404 (was a false
 *    `{success:true}` 200).
 *  - Preserved: local_actor policy and 401 for anonymous / invalid local /
 *    remote-only credentials; member (any role) / personal-Habitat human /
 *    local agent admission; response shapes; self/cycle/duplicate 409;
 *    legacy cross-Habitat edges when the actor may access BOTH actual
 *    endpoints.
 *
 * Disclosed limits: the blocked-status second-query guard (a `blockedBy` id
 * absent from the first raw inventory) and the raw/projection direction
 * race live between two synchronous reads of one handler; they are pinned
 * by the labeled SEAM tests in `taskDependencyGuardSeams.test.ts` (partial
 * repository-module mock) rather than by this wire file, whose blockedBy
 * assertions here are limited to ids already in the authorized outgoing
 * inventory. Deletion-statement fault propagation (500, edge preserved,
 * after admission and exact-pair lookup passed) is proven on the real wire
 * in `taskDependencyFaultWire.test.ts` by a sql.js BEFORE DELETE trigger
 * with a controlled rerun, not by the DB-close test (that one only pins the
 * database-unavailable entry path). Raw-inventory dangling-edge 404 is
 * proven on the real wire below via a PRAGMA-off corrupted-FK fixture (the
 * only way to create a dangling edge; FK cascade removes edges normally).
 *
 * No middleware mocks: every request crosses a real TCP socket into the
 * real application; MCP checks drive the spawned server over stdio with a
 * real agent key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { eq, and, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { missions, tasks, taskDependencies } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

const TITLE_OUT = "tda-xhab-out-marker";
const TITLE_IN = "tda-xhab-in-marker";

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let agentId: string;
let validRemoteKey: string;

let memberAdminJwt: string;
let memberViewerJwt: string;
let memberBJwt: string;
let dualMemberJwt: string;
let nonmemberAdminJwt: string;

// ---- wire helpers ----------------------------------------------------------
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
  return jwt.sign({ sub: userId, username: `tda-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
  rawBody?: string;
}
async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

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

function setTaskStatus(taskId: string, status: "in_progress" | "done"): void {
  getDb().update(tasks).set({ status }).where(eq(tasks.id, taskId)).run();
}

function edgeRows(taskId: string, dependsOnId: string) {
  return getDb()
    .select()
    .from(taskDependencies)
    .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
    .all();
}

function bothReads(taskId: string): string[] {
  return [`/tasks/${taskId}/dependencies`, `/tasks/${taskId}/blocked-status`];
}

// ---- MCP client over stdio (newline-delimited JSON-RPC) --------------------
let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";
function mcpRequest(method: string, params?: unknown): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function callTool(name: string, args: Record<string, unknown>) {
  return mcpRequest("tools/call", { name, arguments: args });
}
function toolText(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
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
    name: "tda-org",
    slug: `tda-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tda-team-a",
    slug: `tda-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tda-team-b",
    slug: `tda-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tda-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tda-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tda-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tda-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tda-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tda-member-b", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tda-dual-member", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tda-dual-member", role: "member" });

  memberAdminJwt = mint("tda-member-admin", "admin");
  memberViewerJwt = mint("tda-member-viewer", "viewer");
  memberBJwt = mint("tda-member-b", "viewer");
  dualMemberJwt = mint("tda-dual-member", "viewer");
  nonmemberAdminJwt = mint("tda-nonmember-admin", "admin");

  const created = agentRepo.createAgent({
    name: "tda-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  const pod = remotePodRepo.createRemotePod({
    habitatId: teamAHabitatId,
    name: "tda-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tda-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tda-remote-cred",
  }).plaintextSecret;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childExit = new Promise((resolve) => child.on("exit", () => resolve()));
  child.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    if (text.trim()) console.warn("[mcp stderr]:", text.trim());
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  const init = await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tda-dependency-access-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}, 120_000);

afterAll(async () => {
  child.kill("SIGTERM");
  await childExit;
  await app.close();
  closeDb();
});

describe("task dependency reads — both GETs (raw edge inventory + joined projection)", () => {
  it("member with all endpoints accessible gets 200 with both arrays and blocked truth on both prefixes", async () => {
    const src = makeTask(teamAHabitatId, "tda-read-src", "tda-seed");
    const dep = makeTask(teamAHabitatId, "tda-read-dep", "tda-seed");
    const blocker = makeTask(teamAHabitatId, "tda-read-blocker", "tda-seed");
    dependencyRepo.addTaskDependency(src, dep);
    dependencyRepo.addTaskDependency(blocker, src);
    setTaskStatus(dep, "in_progress");

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${src}/dependencies`, {
        token: memberAdminJwt,
      });
      expect(res.status, `${prefix} deps`).toBe(200);
      expect(res.body.dependsOn).toHaveLength(1);
      expect(res.body.dependsOn[0].taskId).toBe(dep);
      expect(res.body.dependsOn[0].status).toBe("in_progress");
      expect(res.body.dependsOn[0].completedAt).toBeNull();
      expect(res.body.blocking).toHaveLength(1);
      expect(res.body.blocking[0].taskId).toBe(blocker);

      const blocked = await wire(prefix, "GET", `/tasks/${src}/blocked-status`, {
        token: memberAdminJwt,
      });
      expect(blocked.status, `${prefix} blocked`).toBe(200);
      expect(blocked.body.taskId).toBe(src);
      expect(blocked.body.isBlocked).toBe(true);
      expect(blocked.body.canComplete).toBe(false);
      expect(blocked.body.reason).toBe("BLOCKED_BY_DEPENDENCIES");
      expect(blocked.body.blockedBy.map((b: any) => b.taskId)).toEqual([dep]);
      expect(blocked.body.blocking.map((b: any) => b.taskId)).toEqual([blocker]);
    }

    // Resolved outgoing dep flips the blocked truth without touching shape.
    setTaskStatus(dep, "done");
    const cleared = await wire("/api/v1", "GET", `/tasks/${src}/blocked-status`, {
      token: memberAdminJwt,
    });
    expect(cleared.body.isBlocked).toBe(false);
    expect(cleared.body.canComplete).toBe(true);
    expect(cleared.body.blockedBy).toBeUndefined();
  }, 30_000);

  it("global-admin NONmember is 403 on both GETs with zero projection disclosure", async () => {
    const src = makeTask(teamAHabitatId, "tda-nonmember-src", "tda-seed");
    const dep = makeTask(teamAHabitatId, "tda-nonmember-dep", "tda-seed");
    dependencyRepo.addTaskDependency(src, dep);

    for (const prefix of PREFIXES) {
      for (const path of bothReads(src)) {
        const res = await wire(prefix, "GET", path, { token: nonmemberAdminJwt });
        expect(res.status, `${prefix} ${path}`).toBe(403);
        expect(res.text).not.toContain("tda-nonmember-dep");
        expect(res.body.dependsOn).toBeUndefined();
        expect(res.body.blocking).toBeUndefined();
        expect(res.body.blockedBy).toBeUndefined();
      }
    }
  }, 30_000);

  it("member of A with OUTGOING endpoint in inaccessible team B is 403 on both GETs; dual member gets 200", async () => {
    const src = makeTask(teamAHabitatId, "tda-xout-src", "tda-seed");
    const dep = makeTask(teamBHabitatId, TITLE_OUT, "tda-seed");
    dependencyRepo.addTaskDependency(src, dep);

    for (const prefix of PREFIXES) {
      for (const path of bothReads(src)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} A-only ${path}`).toBe(403);
        expect(res.text).not.toContain(TITLE_OUT);
        // Never a misleading unblocked answer either.
        expect(res.body.isBlocked).toBeUndefined();
      }
    }
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${src}/dependencies`, { token: dualMemberJwt });
      expect(res.status, `${prefix} dual deps`).toBe(200);
      expect(res.text).toContain(TITLE_OUT);
      const blocked = await wire(prefix, "GET", `/tasks/${src}/blocked-status`, {
        token: dualMemberJwt,
      });
      expect(blocked.status).toBe(200);
    }
  }, 30_000);

  it("member of A with INCOMING endpoint in inaccessible team B is 403 on both GETs (reverse direction checked)", async () => {
    const src = makeTask(teamAHabitatId, "tda-xin-src", "tda-seed");
    const blocker = makeTask(teamBHabitatId, TITLE_IN, "tda-seed");
    dependencyRepo.addTaskDependency(blocker, src);

    for (const prefix of PREFIXES) {
      for (const path of bothReads(src)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} ${path}`).toBe(403);
        expect(res.text).not.toContain(TITLE_IN);
      }
      const dual = await wire(prefix, "GET", `/tasks/${src}/dependencies`, {
        token: dualMemberJwt,
      });
      expect(dual.status).toBe(200);
      expect(dual.body.blocking.map((b: any) => b.taskId)).toEqual([blocker]);
    }
  }, 30_000);

  it("personal-habitat edges admit any authenticated human; local agents admitted on team reads", async () => {
    const src = makeTask(personalHabitatId, "tda-personal-src", "tda-seed");
    const dep = makeTask(personalHabitatId, "tda-personal-dep", "tda-seed");
    dependencyRepo.addTaskDependency(src, dep);

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${src}/dependencies`, {
        token: nonmemberAdminJwt,
      });
      expect(res.status, `${prefix} personal`).toBe(200);
      expect(res.body.dependsOn).toHaveLength(1);
    }

    const teamSrc = makeTask(teamAHabitatId, "tda-agent-src", "tda-seed");
    const teamDep = makeTask(teamAHabitatId, "tda-agent-dep", "tda-seed");
    dependencyRepo.addTaskDependency(teamSrc, teamDep);
    for (const path of bothReads(teamSrc)) {
      const res = await wire("/api/v1", "GET", path, { agentKey });
      expect(res.status, `agent ${path}`).toBe(200);
    }
  }, 30_000);

  it("anonymous, invalid agent key and VALID remote credential get 401 on both GETs", async () => {
    const src = makeTask(teamAHabitatId, "tda-authn-src", "tda-seed");
    for (const prefix of PREFIXES) {
      for (const path of bothReads(src)) {
        expect((await wire(prefix, "GET", path)).status, `${prefix} anon ${path}`).toBe(401);
        expect(
          (await wire(prefix, "GET", path, { agentKey: "not-a-key" })).status,
          `${prefix} badkey ${path}`,
        ).toBe(401);
        expect(
          (await wire(prefix, "GET", path, { remoteKey: validRemoteKey })).status,
          `${prefix} remote ${path}`,
        ).toBe(401);
      }
    }
  }, 60_000);

  it("authenticated missing Task is 404 on both GETs; a normally deleted Mission cascades its Task to the same 404", async () => {
    const missingTask = "00000000-0000-4000-8000-00000000000b";
    // Deleting the Mission through the normal path CASCADES the Task (FK),
    // so the second fixture proves the missing-TASK 404, not a surviving
    // Task with an absent Mission — no stronger ancestry claim is made.
    const cascadeTaskId = makeTask(teamAHabitatId, "tda-orphan", "tda-seed");
    const missionId = taskRepo.getMissionIdForTask(cascadeTaskId)!;
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    for (const prefix of PREFIXES) {
      for (const path of bothReads(missingTask)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} missing ${path}`).toBe(404);
      }
      for (const path of bothReads(cascadeTaskId)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} cascaded ${path}`).toBe(404);
      }
    }
  }, 30_000);

  it("dangling edge endpoint (corrupted-FK fixture) yields 404, not a silently-dropped row", async () => {
    // Only way to produce a dangling edge: FK cascade removes edges on every
    // normal deletion path, so this fixture disables the connection-level FK
    // pragma, removes the endpoint row directly, and re-enables it.
    const src = makeTask(teamAHabitatId, "tda-dangling-src", "tda-seed");
    const dep = makeTask(teamAHabitatId, "tda-dangling-dep", "tda-seed");
    dependencyRepo.addTaskDependency(src, dep);
    const db = getDb();
    db.run(sql`PRAGMA foreign_keys = OFF`);
    db.delete(tasks).where(eq(tasks.id, dep)).run();
    db.run(sql`PRAGMA foreign_keys = ON`);

    // Raw edge row survived the abnormal deletion.
    expect(edgeRows(src, dep)).toHaveLength(1);

    for (const path of bothReads(src)) {
      const res = await wire("/api/v1", "GET", path, { token: memberAdminJwt });
      expect(res.status, `dangling ${path}`).toBe(404);
    }
  }, 30_000);
});

describe("task dependency writes — POST admission before cycle/write", () => {
  it("absent body and empty object both return the explicit 400 on both prefixes (authenticated)", async () => {
    const src = makeTask(teamAHabitatId, "tda-post-body", "tda-seed");
    for (const prefix of PREFIXES) {
      const noBody = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        token: memberAdminJwt,
      });
      expect(noBody.status, `${prefix} no-body`).toBe(400);
      expect(noBody.body.error).toBe("dependsOnTaskId is required");

      const empty = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        token: memberAdminJwt,
        body: {},
      });
      expect(empty.status, `${prefix} empty`).toBe(400);
      expect(empty.body.error).toBe("dependsOnTaskId is required");
    }
    // Auth is installed first: the malformed body never leaks past 401.
    const anon = await wire("/api/v1", "POST", `/tasks/${src}/dependencies`, { body: {} });
    expect(anon.status).toBe(401);
    expect(edgeRows(src, src)).toHaveLength(0);
  }, 30_000);

  it("source admitted / destination denied is 403 with no row; reverse ordering also 403 (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const src = makeTask(teamAHabitatId, `tda-post-out-src-${suffix}`, "tda-seed");
      const depB = makeTask(teamBHabitatId, `tda-post-out-dep-${suffix}`, "tda-seed");

      const res = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: depB },
      });
      expect(res.status, `${prefix} dest-denied`).toBe(403);
      expect(edgeRows(src, depB)).toHaveLength(0);

      // Reverse: caller is a member of B (destination) but NOT of A (source).
      const reverse = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        token: memberBJwt,
        body: { dependsOnTaskId: depB },
      });
      expect(reverse.status, `${prefix} src-denied`).toBe(403);
      expect(edgeRows(src, depB)).toHaveLength(0);
    }
  }, 60_000);

  it("legacy cross-Habitat edge is preserved when the actor may access BOTH actual endpoints (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const src = makeTask(teamAHabitatId, `tda-post-x-src-${suffix}`, "tda-seed");
      const depB = makeTask(teamBHabitatId, `tda-post-x-dep-${suffix}`, "tda-seed");

      const agent = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        agentKey,
        body: { dependsOnTaskId: depB },
      });
      expect(agent.status, `${prefix} agent`).toBe(200);
      expect(agent.body.success).toBe(true);
      expect(edgeRows(src, depB)).toHaveLength(1);

      const dual = makeTask(teamAHabitatId, `tda-post-x2-src-${suffix}`, "tda-seed");
      const dualDep = makeTask(teamBHabitatId, `tda-post-x2-dep-${suffix}`, "tda-seed");
      const viaDual = await wire(prefix, "POST", `/tasks/${dual}/dependencies`, {
        token: dualMemberJwt,
        body: { dependsOnTaskId: dualDep },
      });
      expect(viaDual.status, `${prefix} dual`).toBe(200);
      expect(edgeRows(dual, dualDep)).toHaveLength(1);
    }
  }, 60_000);

  it("missing source 404, missing destination 404 with the dependency-specific message (both prefixes)", async () => {
    const missing = "00000000-0000-4000-8000-00000000000c";
    for (const prefix of PREFIXES) {
      const src = makeTask(teamAHabitatId, `tda-post-missing-${prefix.slice(5)}`, "tda-seed");

      const noSource = await wire(prefix, "POST", `/tasks/${missing}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: src },
      });
      expect(noSource.status, `${prefix} no-source`).toBe(404);
      expect(noSource.body.error).toBe("Task not found");

      const noDest = await wire(prefix, "POST", `/tasks/${src}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: missing },
      });
      expect(noDest.status, `${prefix} no-dest`).toBe(404);
      expect(noDest.body.error).toBe("Dependency task not found");
    }
  }, 60_000);

  it("self, cycle and duplicate are 409 on sql.js real wire with no unintended writes (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const a = makeTask(teamAHabitatId, `tda-conflict-a-${suffix}`, "tda-seed");
      const b = makeTask(teamAHabitatId, `tda-conflict-b-${suffix}`, "tda-seed");

      const self = await wire(prefix, "POST", `/tasks/${a}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: a },
      });
      expect(self.status, `${prefix} self`).toBe(409);
      expect(edgeRows(a, a)).toHaveLength(0);

      const ab = await wire(prefix, "POST", `/tasks/${a}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: b },
      });
      expect(ab.status, `${prefix} add`).toBe(200);
      const cycle = await wire(prefix, "POST", `/tasks/${b}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: a },
      });
      expect(cycle.status, `${prefix} cycle`).toBe(409);
      expect(edgeRows(b, a)).toHaveLength(0);

      // sql.js throws a plain-message UNIQUE error (no .code) — proves the
      // message-fallback classifier.
      const dup = await wire(prefix, "POST", `/tasks/${a}/dependencies`, {
        token: memberAdminJwt,
        body: { dependsOnTaskId: b },
      });
      expect(dup.status, `${prefix} dup`).toBe(409);
      expect(edgeRows(a, b)).toHaveLength(1);
    }
  }, 60_000);
});

describe("task dependency writes — DELETE exact ordered pair", () => {
  it("authorized exact-pair delete succeeds and removes ONLY that edge (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const src = makeTask(teamAHabitatId, `tda-del-src-${suffix}`, "tda-seed");
      const dep = makeTask(teamAHabitatId, `tda-del-dep-${suffix}`, "tda-seed");
      const other = makeTask(teamAHabitatId, `tda-del-other-${suffix}`, "tda-seed");
      dependencyRepo.addTaskDependency(src, dep);
      dependencyRepo.addTaskDependency(src, other);

      const res = await wire(prefix, "DELETE", `/tasks/${src}/dependencies/${dep}`, {
        token: memberAdminJwt,
      });
      expect(res.status, `${prefix} delete`).toBe(200);
      expect(res.body.success).toBe(true);
      expect(edgeRows(src, dep)).toHaveLength(0);
      expect(edgeRows(src, other)).toHaveLength(1);
    }
  }, 60_000);

  it("wrong source and nonexistent pair are 404 with the real edge untouched — was false 200 (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tda-delw-owner-${suffix}`, "tda-seed");
      const dep = makeTask(teamAHabitatId, `tda-delw-dep-${suffix}`, "tda-seed");
      const stranger = makeTask(teamAHabitatId, `tda-delw-stranger-${suffix}`, "tda-seed");
      dependencyRepo.addTaskDependency(owner, dep);

      const wrongSource = await wire(prefix, "DELETE", `/tasks/${stranger}/dependencies/${dep}`, {
        token: memberAdminJwt,
      });
      expect(wrongSource.status, `${prefix} wrong-source`).toBe(404);
      expect(wrongSource.body.error).toBe("Dependency not found");
      expect(edgeRows(owner, dep)).toHaveLength(1);

      const nonexistent = await wire(
        prefix,
        "DELETE",
        `/tasks/${stranger}/dependencies/00000000-0000-4000-8000-00000000000d`,
        { token: memberAdminJwt },
      );
      expect(nonexistent.status, `${prefix} nonexistent`).toBe(404);
      expect(edgeRows(owner, dep)).toHaveLength(1);
    }
  }, 60_000);

  it("destination denied 403 leaves the edge; source denied 403; missing source 404 (both prefixes)", async () => {
    const missingId = "00000000-0000-4000-8000-00000000000e";
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const src = makeTask(teamAHabitatId, `tda-deld-src-${suffix}`, "tda-seed");
      const depB = makeTask(teamBHabitatId, `tda-deld-dep-${suffix}`, "tda-seed");
      dependencyRepo.addTaskDependency(src, depB);

      const destDenied = await wire(prefix, "DELETE", `/tasks/${src}/dependencies/${depB}`, {
        token: memberAdminJwt,
      });
      expect(destDenied.status, `${prefix} dest-denied`).toBe(403);
      expect(edgeRows(src, depB)).toHaveLength(1);

      const sourceDenied = await wire(prefix, "DELETE", `/tasks/${src}/dependencies/${depB}`, {
        token: nonmemberAdminJwt,
      });
      expect(sourceDenied.status, `${prefix} src-denied`).toBe(403);
      expect(edgeRows(src, depB)).toHaveLength(1);

      const missing = await wire(
        prefix,
        "DELETE",
        `/tasks/${missingId}/dependencies/00000000-0000-4000-8000-00000000000f`,
        { token: memberAdminJwt },
      );
      expect(missing.status, `${prefix} missing-source`).toBe(404);

      // Dual member may remove the cross-Habitat edge (both sides accessible).
      const dual = await wire(prefix, "DELETE", `/tasks/${src}/dependencies/${depB}`, {
        token: dualMemberJwt,
      });
      expect(dual.status, `${prefix} dual-remove`).toBe(200);
      expect(edgeRows(src, depB)).toHaveLength(0);
    }
  }, 60_000);

  it("dangling destination (corrupted-FK fixture) is 404 and does not mutate the edge (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const src = makeTask(teamAHabitatId, `tda-deld2-src-${suffix}`, "tda-seed");
      const dep = makeTask(teamAHabitatId, `tda-deld2-dep-${suffix}`, "tda-seed");
      dependencyRepo.addTaskDependency(src, dep);
      const db = getDb();
      db.run(sql`PRAGMA foreign_keys = OFF`);
      db.delete(tasks).where(eq(tasks.id, dep)).run();
      db.run(sql`PRAGMA foreign_keys = ON`);

      const res = await wire(prefix, "DELETE", `/tasks/${src}/dependencies/${dep}`, {
        token: memberAdminJwt,
      });
      expect(res.status, `${prefix} dangling-delete`).toBe(404);
      expect(edgeRows(src, dep)).toHaveLength(1);
    }
  }, 60_000);

  it("anonymous, invalid agent key and VALID remote-only callers are 401 on both writes (both prefixes)", async () => {
    for (const prefix of PREFIXES) {
      const src = makeTask(teamAHabitatId, `tda-delauth-src-${prefix.slice(5)}`, "tda-seed");
      for (const method of ["POST", "DELETE"] as const) {
        const path =
          method === "POST" ? `/tasks/${src}/dependencies` : `/tasks/${src}/dependencies/${src}`;
        const opts = method === "POST" ? { body: {} } : {};
        expect((await wire(prefix, method, path, opts)).status, `${prefix} anon ${method}`).toBe(
          401,
        );
        expect(
          (await wire(prefix, method, path, { ...opts, agentKey: "not-a-key" })).status,
          `${prefix} badkey ${method}`,
        ).toBe(401);
        expect(
          (await wire(prefix, method, path, { ...opts, remoteKey: validRemoteKey })).status,
          `${prefix} remote ${method}`,
        ).toBe(401);
      }
    }
  }, 60_000);
});

describe("task dependency operations — served MCP compatibility (team habitat, real agent key)", () => {
  it("add/get-blocked/remove round-trip with the MCP destination-Task-ID semantics", async () => {
    const src = makeTask(teamAHabitatId, "tda-mcp-src", "tda-seed");
    const dep = makeTask(teamAHabitatId, "tda-mcp-dep", "tda-seed");

    const add = await callTool("orcy_habitat_task", {
      action: "add-dependency",
      taskId: src,
      dependsOnTaskId: dep,
    });
    expect(add.isError).toBeFalsy();
    expect(edgeRows(src, dep)).toHaveLength(1);

    const blocked = await callTool("orcy_habitat_task", {
      action: "get-blocked-status",
      taskId: src,
    });
    expect(blocked.isError).toBeFalsy();
    const blockedBody = JSON.parse(toolText(blocked));
    expect(blockedBody.isBlocked).toBe(true);
    expect(blockedBody.blockedBy.map((b: any) => b.taskId)).toEqual([dep]);

    // MCP sends the DESTINATION Task ID as dependencyTaskId — not a row id.
    const remove = await callTool("orcy_habitat_task", {
      action: "remove-dependency",
      taskId: src,
      dependencyTaskId: dep,
    });
    expect(remove.isError).toBeFalsy();
    expect(edgeRows(src, dep)).toHaveLength(0);
  }, 60_000);
});
