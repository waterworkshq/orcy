/**
 * Bounded object-access hardening — REAL HTTP wire matrix on BOTH served
 * prefixes (`/api/v1` and deprecated `/api`) plus served MCP compatibility,
 * per object-access-hardening/index.md + contract-review (Sol ACCEPT).
 *
 * Scope of claims (author evidence, not a universal security guarantee):
 *  - GET /tasks/:taskId/reviewers resolves the Task → Mission → Habitat and
 *    enforces the shared membership predicate BEFORE reading reviewer rows.
 *    Intended deltas: team-nonmember humans 403 (was 200), authenticated
 *    missing Task/Mission 404 (was 200 with empty rows).
 *  - POST /habitats/:habitatId/tasks/batch, PATCH /habitats/:habitatId,
 *    PUT /habitats/:habitatId/webhook-secrets gain the existing
 *    requireHabitatAccess preHandler behind installed auth. Intended deltas:
 *    team-nonmember humans 403 (were 200); agents/anonymous/remote remain
 *    401 on the human-policy routes; per-task batch semantics retained
 *    (mixed batches are NOT atomic; a denied actor writes zero).
 *  - Individual GET/DELETE /tasks/:id remain UNGUARDED (separate work).
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
import { eq } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { missions } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamId: string;
let teamHabitatId: string;
let teamTaskId: string;
let personalHabitatId: string;
let personalTaskId: string;
let agentKey: string;
let agentId: string;
let boundAgentKey: string;
let boundAgentId: string;
let validRemoteKey: string;

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
  return jwt.sign({ sub: userId, username: `boa-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
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
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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

// Shared human credentials: members of `teamId` in every role shape, plus a
// global-admin NONmember (the discriminator that proves the reused predicate
// carries no global-admin exception).
let memberAdminJwt: string;
let memberViewerJwt: string;
let teamOwnerJwt: string;
let teamAdminJwt: string;
let teamMemberJwt: string;
let nonmemberAdminJwt: string;
let plainHumanJwt: string;

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
    name: "boa-org",
    slug: `boa-org-${Date.now()}`,
  });
  teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "boa-team",
    slug: `boa-team-${Date.now()}`,
  }).id;
  teamHabitatId = habitatRepo.createHabitat({
    name: "boa-team-habitat",
    teamId,
  }).id;
  teamTaskId = makeTask(teamHabitatId, "boa-team-task", "boa-seed");
  taskReviewerRepo.create(teamTaskId, "human", "boa-reviewer-user");

  personalHabitatId = habitatRepo.createHabitat({ name: "boa-personal-habitat" }).id;
  personalTaskId = makeTask(personalHabitatId, "boa-personal-task", "boa-seed");

  // Membership matrix on the SAME team: global-role members (admin/viewer —
  // editor covered by team-role shapes below) and each team role.
  teamMemberRepo.addMember({ teamId, userId: "boa-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "boa-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "boa-team-owner", role: "owner" });
  teamMemberRepo.addMember({ teamId, userId: "boa-team-admin", role: "admin" });
  teamMemberRepo.addMember({ teamId, userId: "boa-team-member", role: "member" });

  memberAdminJwt = mint("boa-member-admin", "admin");
  memberViewerJwt = mint("boa-member-viewer", "viewer");
  teamOwnerJwt = mint("boa-team-owner", "viewer");
  teamAdminJwt = mint("boa-team-admin", "editor");
  teamMemberJwt = mint("boa-team-member", "viewer");
  nonmemberAdminJwt = mint("boa-nonmember-admin", "admin");
  plainHumanJwt = mint("boa-plain-human", "viewer");

  const created = agentRepo.createAgent({
    name: "boa-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  // Second agent BOUND (currentTaskId) to a task in a DIFFERENT habitat
  // (personal) — the production predicate ignores agent task binding; the
  // bound-agent cases below prove that on the wire (Sol required-1).
  const boundAgent = agentRepo.createAgent({
    name: "boa-bound-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  boundAgentId = boundAgent.agent.id;
  boundAgentKey = boundAgent.plainApiKey;
  const boundAnchorTask = makeTask(personalHabitatId, "boa-bound-anchor", "boa-seed");
  agentRepo.heartbeat(boundAgentId, boundAnchorTask);

  // Fully VALID remote participant/credential chain (Sol required-2): an
  // actually verifiable remote key must still get 401 on these
  // local-credential policies (human/local_actor never consult it).
  const pod = remotePodRepo.createRemotePod({
    habitatId: teamHabitatId,
    name: "boa-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: "remote_orcy",
    displayName: "boa-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: "api",
    label: "boa-remote-cred",
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
    clientInfo: { name: "boa-bounded-access-wire-test", version: "1.0.0" },
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

describe("bounded object access — GET /tasks/:taskId/reviewers (derived habitat)", () => {
  it("admits every member shape on both prefixes: global admin/viewer members and team owner/admin/member", async () => {
    for (const prefix of PREFIXES) {
      for (const token of [
        memberAdminJwt,
        memberViewerJwt,
        teamOwnerJwt,
        teamAdminJwt,
        teamMemberJwt,
      ]) {
        const res = await wire(prefix, "GET", `/tasks/${teamTaskId}/reviewers`, { token });
        expect(res.status).toBe(200);
        expect(res.body.reviewers).toHaveLength(1);
        expect(res.body.reviewers[0].reviewerId).toBe("boa-reviewer-user");
      }
    }
  }, 30_000);

  it("denies a global-admin NONmember 403 on both prefixes — no rows leak", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${teamTaskId}/reviewers`, {
        token: nonmemberAdminJwt,
      });
      expect(res.status).toBe(403);
      expect(res.body.reviewers).toBeUndefined();
    }
  }, 30_000);

  it("personal-habitat task admits any authenticated human (nonmember included)", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${personalTaskId}/reviewers`, {
        token: nonmemberAdminJwt,
      });
      expect(res.status).toBe(200);
    }
  }, 30_000);

  it("local agent key stays admitted on the TEAM-habitat task (broad local-agent access preserved)", async () => {
    const res = await wire("/api/v1", "GET", `/tasks/${teamTaskId}/reviewers`, { agentKey });
    expect(res.status).toBe(200);
  }, 30_000);

  it("anonymous, invalid key and remote key get 401", async () => {
    for (const prefix of PREFIXES) {
      expect((await wire(prefix, "GET", `/tasks/${teamTaskId}/reviewers`)).status).toBe(401);
      expect(
        (await wire(prefix, "GET", `/tasks/${teamTaskId}/reviewers`, { agentKey: "not-a-key" }))
          .status,
      ).toBe(401);
      expect(
        (
          await wire(prefix, "GET", `/tasks/${teamTaskId}/reviewers`, {
            remoteKey: "bogus-remote-key",
          })
        ).status,
      ).toBe(401);
    }
  }, 30_000);

  it("authenticated missing Task and missing Mission are 404 (previously 200 with empty rows)", async () => {
    const missingTask = "00000000-0000-4000-8000-000000000000";
    const orphanTaskId = makeTask(teamHabitatId, "boa-orphan-task", "boa-seed");
    const missionId = taskRepo.getMissionIdForTask(orphanTaskId)!;
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    for (const prefix of PREFIXES) {
      const missing = await wire(prefix, "GET", `/tasks/${missingTask}/reviewers`, {
        token: memberAdminJwt,
      });
      expect(missing.status).toBe(404);
      const orphan = await wire(prefix, "GET", `/tasks/${orphanTaskId}/reviewers`, {
        token: memberAdminJwt,
      });
      expect(orphan.status).toBe(404);
    }
  }, 30_000);
});

describe("bounded object access — POST /habitats/:habitatId/tasks/batch", () => {
  it("member human priority succeeds and mutates (both prefixes)", async () => {
    const taskA = makeTask(teamHabitatId, "boa-prio-a", "boa-seed");
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
        token: memberAdminJwt,
        body: { taskIds: [taskA], operation: "priority", payload: { priority: "high" } },
      });
      expect(res.status).toBe(200);
      expect(res.body.successCount).toBe(1);
    }
    expect(taskRepo.getTaskById(taskA)!.priority).toBe("high");
  }, 30_000);

  it("nonmember global-admin priority/delete/assign are 403 with ZERO writes", async () => {
    const task = makeTask(teamHabitatId, "boa-denied-task", "boa-seed");
    const before = taskRepo.getTaskById(task)!.priority;
    const ops = [
      { taskIds: [task], operation: "priority", payload: { priority: "critical" } },
      { taskIds: [task], operation: "delete", payload: {} },
      { taskIds: [task], operation: "assign", payload: { assignedAgentId: agentId } },
    ];
    for (const prefix of PREFIXES) {
      for (const body of ops) {
        const res = await wire(prefix, "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
          token: nonmemberAdminJwt,
          body,
        });
        expect(res.status).toBe(403);
      }
    }
    const after = taskRepo.getTaskById(task)!;
    expect(after.priority).toBe(before);
    expect(after.assignedAgentId ?? null).toBeNull();
  }, 30_000);

  it("agent key: priority and delete admitted, assign keeps the 403 claim pointer", async () => {
    const task = makeTask(teamHabitatId, "boa-agent-batch", "boa-seed");
    const priority = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey,
      body: { taskIds: [task], operation: "priority", payload: { priority: "low" } },
    });
    expect(priority.status).toBe(200);
    expect(priority.body.successCount).toBe(1);

    const assign = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey,
      body: { taskIds: [task], operation: "assign", payload: { assignedAgentId: agentId } },
    });
    expect(assign.status).toBe(403);
    expect(assign.body.error).toContain("POST /tasks/:id/claim");

    const del = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey,
      body: { taskIds: [task], operation: "delete", payload: {} },
    });
    expect(del.status).toBe(200);
    expect(del.body.successCount).toBe(1);
    expect(taskRepo.getTaskById(task)).toBeNull();
  }, 30_000);

  it("authenticated missing Habitat is 404; anonymous/remote are 401 with a valid payload", async () => {
    const missingHabitat = "00000000-0000-4000-8000-000000000001";
    const body = {
      taskIds: ["00000000-0000-4000-8000-000000000002"],
      operation: "priority" as const,
      payload: { priority: "high" as const },
    };
    for (const prefix of PREFIXES) {
      const missing = await wire(prefix, "POST", `/habitats/${missingHabitat}/tasks/batch`, {
        token: memberAdminJwt,
        body,
      });
      expect(missing.status).toBe(404);

      expect(
        (await wire(prefix, "POST", `/habitats/${teamHabitatId}/tasks/batch`, { body })).status,
      ).toBe(401);
      expect(
        (
          await wire(prefix, "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
            remoteKey: "bogus-remote-key",
            body,
          })
        ).status,
      ).toBe(401);
    }
  }, 30_000);

  it("mixed authorized batch is per-task, not atomic; a URL-habitat mismatch never mutates the foreign task", async () => {
    const tTask = makeTask(teamHabitatId, "boa-mixed-team", "boa-seed");
    const pTask = makeTask(personalHabitatId, "boa-mixed-personal", "boa-seed");
    // Member authorized on T; URL is T but one task belongs to P.
    const mixed = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      token: memberAdminJwt,
      body: { taskIds: [tTask, pTask], operation: "priority", payload: { priority: "critical" } },
    });
    expect(mixed.status).toBe(200);
    expect(mixed.body.successCount).toBe(1);
    expect(mixed.body.failureCount).toBe(1);
    expect(taskRepo.getTaskById(tTask)!.priority).toBe("critical");
    expect(taskRepo.getTaskById(pTask)!.priority ?? "medium").not.toBe("critical");

    // URL-habitat mismatch with a personal-habitat URL: P admits the member
    // human, but the T task must NOT be mutated (per-task check retained).
    const mismatch = await wire("/api/v1", "POST", `/habitats/${personalHabitatId}/tasks/batch`, {
      token: memberAdminJwt,
      body: { taskIds: [tTask], operation: "priority", payload: { priority: "low" } },
    });
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.successCount).toBe(0);
    expect(mismatch.body.failureCount).toBe(1);
    expect(taskRepo.getTaskById(tTask)!.priority).toBe("critical");
  }, 30_000);
});

describe("bounded object access — PATCH /habitats/:habitatId", () => {
  it("member human updates settings; nonmember global admin is 403 with state unchanged (both prefixes)", async () => {
    const memberBody = { description: "boa-member-updated" };
    const denyBody = { description: "boa-denied-write" };
    for (const prefix of PREFIXES) {
      const ok = await wire(prefix, "PATCH", `/habitats/${teamHabitatId}`, {
        token: memberViewerJwt,
        body: memberBody,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.habitat.description).toBe("boa-member-updated");

      const denied = await wire(prefix, "PATCH", `/habitats/${teamHabitatId}`, {
        token: nonmemberAdminJwt,
        body: denyBody,
      });
      expect(denied.status).toBe(403);
      expect(habitatRepo.getHabitatById(teamHabitatId)!.description).toBe("boa-member-updated");
    }
  }, 30_000);

  it("personal habitat admits any authenticated human; agent/anonymous/remote stay 401", async () => {
    const ok = await wire("/api/v1", "PATCH", `/habitats/${personalHabitatId}`, {
      token: nonmemberAdminJwt,
      body: { description: "boa-personal-update" },
    });
    expect(ok.status).toBe(200);

    for (const prefix of PREFIXES) {
      expect(
        (
          await wire(prefix, "PATCH", `/habitats/${personalHabitatId}`, {
            agentKey,
            body: { description: "nope" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await wire(prefix, "PATCH", `/habitats/${personalHabitatId}`, {
            body: { description: "nope" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await wire(prefix, "PATCH", `/habitats/${personalHabitatId}`, {
            remoteKey: "bogus-remote-key",
            body: { description: "nope" },
          })
        ).status,
      ).toBe(401);
    }
  }, 30_000);

  it("authenticated missing Habitat is 404 (valid body)", async () => {
    const res = await wire("/api/v1", "PATCH", "/habitats/00000000-0000-4000-8000-000000000003", {
      token: memberAdminJwt,
      body: { description: "x" },
    });
    expect(res.status).toBe(404);
  }, 30_000);
});

describe("bounded object access — PUT /habitats/:habitatId/webhook-secrets", () => {
  it("member human writes the selected provider secret, masks it, and null clears; nonmember is 403 with zero writes", async () => {
    // Selected-provider write: code_review.githubSecret only.
    const ok = await wire("/api/v1", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
      token: memberAdminJwt,
      body: { provider: "code_review", githubSecret: "boa-raw-cr-secret" },
    });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain("boa-raw-cr-secret");
    expect(ok.body.codeReviewSettings.hasGithubSecret).toBe(true);
    const stored = habitatRepo.getHabitatById(teamHabitatId)!;
    expect(stored.codeReviewSettings!.githubSecret).toBe("boa-raw-cr-secret");
    expect(stored.ciCdSettings?.githubSecret ?? null).toBeNull(); // ci_cd slot untouched

    // ci_cd selection writes the other slot only.
    const ci = await wire("/api/v1", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
      token: teamMemberJwt,
      body: { provider: "ci_cd", gitlabSecret: "boa-raw-cicd-secret" },
    });
    expect(ci.status).toBe(200);
    expect(ci.body.ciCdSettings.hasGitlabSecret).toBe(true);
    expect(ci.text).not.toContain("boa-raw-cicd-secret");
    const stored2 = habitatRepo.getHabitatById(teamHabitatId)!;
    expect(stored2.ciCdSettings!.gitlabSecret).toBe("boa-raw-cicd-secret");
    expect(stored2.codeReviewSettings!.githubSecret).toBe("boa-raw-cr-secret");

    // Null clears the selected slot.
    const cleared = await wire("/api", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
      token: teamOwnerJwt,
      body: { provider: "code_review", githubSecret: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.codeReviewSettings.hasGithubSecret).toBe(false);
    expect(habitatRepo.getHabitatById(teamHabitatId)!.codeReviewSettings!.githubSecret).toBeNull();

    // Nonmember denial leaves the ci_cd secret in place.
    const denied = await wire("/api", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
      token: nonmemberAdminJwt,
      body: { provider: "ci_cd", gitlabSecret: null },
    });
    expect(denied.status).toBe(403);
    expect(habitatRepo.getHabitatById(teamHabitatId)!.ciCdSettings!.gitlabSecret).toBe(
      "boa-raw-cicd-secret",
    );
  }, 30_000);

  it("agent key and anonymous stay 401 on both prefixes (valid body)", async () => {
    for (const prefix of PREFIXES) {
      expect(
        (
          await wire(prefix, "PUT", `/habitats/${personalHabitatId}/webhook-secrets`, {
            agentKey,
            body: { provider: "code_review", githubSecret: "x" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await wire(prefix, "PUT", `/habitats/${personalHabitatId}/webhook-secrets`, {
            body: { provider: "code_review", githubSecret: "x" },
          })
        ).status,
      ).toBe(401);
    }
  }, 30_000);

  it("authenticated missing Habitat is 404 (valid body)", async () => {
    const res = await wire(
      "/api/v1",
      "PUT",
      "/habitats/00000000-0000-4000-8000-000000000004/webhook-secrets",
      {
        token: memberAdminJwt,
        body: { provider: "code_review", githubSecret: "x" },
      },
    );
    expect(res.status).toBe(404);
  }, 30_000);
});

describe("bounded object access — served MCP compatibility (team habitat, real agent key)", () => {
  it("orcy_review list_reviewers on a team-habitat task stays open to the agent key", async () => {
    const res = await callTool("orcy_review", { action: "list_reviewers", taskId: teamTaskId });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(toolText(res)) as { reviewers: unknown[] };
    expect(body.reviewers).toHaveLength(1);
  }, 60_000);

  it("orcy_habitat_task batch-set-priority and batch-delete stay admitted; batch-assign keeps the 403 claim pointer", async () => {
    const task = makeTask(teamHabitatId, "boa-mcp-batch", "boa-seed");

    const priority = await callTool("orcy_habitat_task", {
      action: "batch-set-priority",
      habitatId: teamHabitatId,
      taskIds: [task],
      priority: "high",
    });
    expect(priority.isError).toBeFalsy();
    expect(JSON.parse(toolText(priority)).successCount).toBe(1);

    const assign = await callTool("orcy_habitat_task", {
      action: "batch-assign",
      habitatId: teamHabitatId,
      taskIds: [task],
      assigneeId: agentId,
    });
    expect(assign.isError).toBe(true);
    expect(toolText(assign)).toContain("API 403:");
    expect(toolText(assign)).toContain("POST /tasks/:id/claim");

    const del = await callTool("orcy_habitat_task", {
      action: "batch-delete",
      habitatId: teamHabitatId,
      taskIds: [task],
    });
    expect(del.isError).toBeFalsy();
    expect(JSON.parse(toolText(del)).successCount).toBe(1);
    expect(taskRepo.getTaskById(task)).toBeNull();
  }, 60_000);
});

describe("bounded object access — bound agent and VALID remote credential (Sol review required 1–2)", () => {
  it("agent BOUND to a different-habitat task keeps reviewer GET and batch priority/delete; assign stays 403", async () => {
    // Binding anchor: personal habitat. Targets: TEAM habitat. The predicate
    // ignores currentTaskId, so binding elsewhere changes nothing.
    const target = makeTask(teamHabitatId, "boa-bound-target", "boa-seed");

    const reviewers = await wire("/api/v1", "GET", `/tasks/${teamTaskId}/reviewers`, {
      agentKey: boundAgentKey,
    });
    expect(reviewers.status).toBe(200);

    const priority = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey: boundAgentKey,
      body: { taskIds: [target], operation: "priority", payload: { priority: "medium" } },
    });
    expect(priority.status).toBe(200);
    expect(priority.body.successCount).toBe(1);

    const assign = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey: boundAgentKey,
      body: { taskIds: [target], operation: "assign", payload: { assignedAgentId: boundAgentId } },
    });
    expect(assign.status).toBe(403);
    expect(assign.body.error).toContain("POST /tasks/:id/claim");

    const del = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
      agentKey: boundAgentKey,
      body: { taskIds: [target], operation: "delete", payload: {} },
    });
    expect(del.status).toBe(200);
    expect(del.body.successCount).toBe(1);
    expect(taskRepo.getTaskById(target)).toBeNull();
  }, 30_000);

  it("VALID remote credential alone gets 401 on ALL FOUR routes, both prefixes, valid payloads — zero writes", async () => {
    const remoteTarget = makeTask(teamHabitatId, "boa-remote-target", "boa-seed");
    const descBefore = habitatRepo.getHabitatById(teamHabitatId)!.description;
    const secretBefore =
      habitatRepo.getHabitatById(teamHabitatId)!.codeReviewSettings?.githubSecret ?? null;
    const prioBefore = taskRepo.getTaskById(remoteTarget)!.priority;

    for (const prefix of PREFIXES) {
      const gets = await wire(prefix, "GET", `/tasks/${remoteTarget}/reviewers`, {
        remoteKey: validRemoteKey,
      });
      expect(gets.status, `${prefix} GET`).toBe(401);

      const batch = await wire(prefix, "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
        remoteKey: validRemoteKey,
        body: { taskIds: [remoteTarget], operation: "priority", payload: { priority: "critical" } },
      });
      expect(batch.status, `${prefix} batch`).toBe(401);

      const patch = await wire(prefix, "PATCH", `/habitats/${teamHabitatId}`, {
        remoteKey: validRemoteKey,
        body: { description: "boa-remote-denied" },
      });
      expect(patch.status, `${prefix} PATCH`).toBe(401);

      const put = await wire(prefix, "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
        remoteKey: validRemoteKey,
        body: { provider: "code_review", githubSecret: "boa-remote-secret" },
      });
      expect(put.status, `${prefix} PUT`).toBe(401);
    }

    // Denials reached nothing: state byte-identical on all three surfaces.
    const after = habitatRepo.getHabitatById(teamHabitatId)!;
    expect(after.description).toBe(descBefore);
    expect(after.codeReviewSettings?.githubSecret ?? null).toBe(secretBefore);
    expect(taskRepo.getTaskById(remoteTarget)!.priority).toBe(prioBefore);
  }, 30_000);
});

describe("bounded object access — personal batch/PUT and role matrix (Sol review required 3)", () => {
  it("personal-habitat batch priority/delete and webhook-secret PUT admit an arbitrary human", async () => {
    const task = makeTask(personalHabitatId, "boa-personal-batch", "boa-seed");

    const priority = await wire("/api/v1", "POST", `/habitats/${personalHabitatId}/tasks/batch`, {
      token: plainHumanJwt,
      body: { taskIds: [task], operation: "priority", payload: { priority: "low" } },
    });
    expect(priority.status).toBe(200);
    expect(priority.body.successCount).toBe(1);

    const put = await wire("/api/v1", "PUT", `/habitats/${personalHabitatId}/webhook-secrets`, {
      token: plainHumanJwt,
      body: { provider: "ci_cd", githubSecret: "boa-personal-secret" },
    });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain("boa-personal-secret");
    expect(put.body.ciCdSettings.hasGithubSecret).toBe(true);
    expect(habitatRepo.getHabitatById(personalHabitatId)!.ciCdSettings!.githubSecret).toBe(
      "boa-personal-secret",
    );

    const del = await wire("/api/v1", "POST", `/habitats/${personalHabitatId}/tasks/batch`, {
      token: plainHumanJwt,
      body: { taskIds: [task], operation: "delete", payload: {} },
    });
    expect(del.status).toBe(200);
    expect(del.body.successCount).toBe(1);
    expect(taskRepo.getTaskById(task)).toBeNull();
  }, 30_000);

  it("batch/PATCH/PUT matrix: team owner/admin/member succeed; global editor AND viewer nonmembers get 403 with zero writes", async () => {
    const members: Array<[string, string]> = [
      ["team-owner", teamOwnerJwt],
      ["team-admin", teamAdminJwt],
      ["team-member", teamMemberJwt],
    ];
    const nonmembers: Array<[string, string]> = [
      ["editor-nonmember", mint("boa-nonmember-editor", "editor")],
      ["viewer-nonmember", mint("boa-nonmember-viewer", "viewer")],
    ];

    for (const [name, token] of members) {
      const task = makeTask(teamHabitatId, `boa-matrix-${name}`, "boa-seed");
      const batch = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
        token,
        body: { taskIds: [task], operation: "priority", payload: { priority: "medium" } },
      });
      expect(batch.status, `${name} batch`).toBe(200);

      const patch = await wire("/api/v1", "PATCH", `/habitats/${teamHabitatId}`, {
        token,
        body: { description: `boa-matrix-${name}` },
      });
      expect(patch.status, `${name} PATCH`).toBe(200);

      const put = await wire("/api/v1", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
        token,
        body: { provider: "ci_cd", gitlabSecret: `boa-${name}-secret` },
      });
      expect(put.status, `${name} PUT`).toBe(200);
    }

    for (const [name, token] of nonmembers) {
      const task = makeTask(teamHabitatId, `boa-denied-${name}`, "boa-seed");
      const batch = await wire("/api/v1", "POST", `/habitats/${teamHabitatId}/tasks/batch`, {
        token,
        body: { taskIds: [task], operation: "priority", payload: { priority: "low" } },
      });
      expect(batch.status, `${name} batch`).toBe(403);

      const patch = await wire("/api/v1", "PATCH", `/habitats/${teamHabitatId}`, {
        token,
        body: { description: `boa-denied-${name}` },
      });
      expect(patch.status, `${name} PATCH`).toBe(403);

      const put = await wire("/api/v1", "PUT", `/habitats/${teamHabitatId}/webhook-secrets`, {
        token,
        body: { provider: "ci_cd", gitlabSecret: "boa-denied-secret" },
      });
      expect(put.status, `${name} PUT`).toBe(403);

      // Denied writes landed nowhere.
      expect(taskRepo.getTaskById(task)!.priority ?? "medium").not.toBe("low");
    }

    // Last member write stands; no nonmember description ever landed.
    expect(habitatRepo.getHabitatById(teamHabitatId)!.description).toBe("boa-matrix-team-member");
    expect(habitatRepo.getHabitatById(teamHabitatId)!.ciCdSettings?.gitlabSecret ?? "").toBe(
      "boa-team-member-secret",
    );
  }, 30_000);
});
