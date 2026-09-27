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
 *  - Six Task object operations (task-object-access-followup) derive the
 *    TARGET Task → Mission → Habitat server-side and enforce the shared
 *    membership predicate BEFORE any read or deletion effect: GET and
 *    DELETE /tasks/:id, GET /tasks/:id/details, /events, /comments and
 *    /tasks/:taskId/code-evidence. Intended deltas: team-nonmember humans
 *    403 (were 200); authenticated missing Task/orphaned Mission 404 on
 *    reads that previously leaked (simple GET, details, events, comments).
 *    Request-time authorization, not transactional revocation fencing.
 *  - STILL UNGUARDED (explicit retained exposure, separate follow-up):
 *    adjunct Task reads (/dependencies, /blocked-status, /approval-status,
 *    /quality-checklist, /effort-report, /effort-entries, /time-report,
 *    /failure-context, /workflow-context, human-only /pull-requests,
 *    /pipeline-events, /watchers) and Task-ID mutations beyond individual
 *    DELETE (PATCH /tasks/:id, comments/evidence/dependencies writes).
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
import * as eventRepo from "../repositories/event.js";
import * as dependencyService from "../services/dependencyService.js";
import * as codeEvidenceService from "../services/codeEvidenceService.js";
import * as commentService from "../services/commentService.js";
import * as watcherRepo from "../repositories/watcher.js";
import * as dependencyReadRepo from "../repositories/dependency.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { checkHabitatAccess } from "../middleware/realtimeAuth.js";

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

// ---- six-operation Task object access (task-object-access-followup) ------
// GET /tasks/:id, DELETE /tasks/:id, GET /tasks/:id/details, /events,
// /comments and /tasks/:taskId/code-evidence all resolve the TARGET Task →
// Mission → Habitat and run the shared membership predicate before any read
// or deletion effect. Request-time authorization only.

const SIX_TITLE = "boa-six-task";
const SIX_EVENT_ACTOR = "boa-six-event-actor";
const SIX_COMMENT = "boa-six-comment-marker";
const SIX_EVIDENCE_URL = "https://example.com/boa-six-evidence-marker";
let sixTaskId: string;
let sixSeeded = false;

function sixReads(taskId: string): Array<[string, string]> {
  return [
    ["GET", `/tasks/${taskId}`],
    ["GET", `/tasks/${taskId}/details`],
    ["GET", `/tasks/${taskId}/events`],
    ["GET", `/tasks/${taskId}/comments`],
    ["GET", `/tasks/${taskId}/code-evidence`],
  ];
}

async function ensureSixSeed(): Promise<string> {
  if (sixSeeded) return sixTaskId;
  sixTaskId = makeTask(teamHabitatId, SIX_TITLE, "boa-seed");
  eventRepo.createEvent({
    taskId: sixTaskId,
    actorType: "human",
    actorId: SIX_EVENT_ACTOR,
    action: "updated",
    metadata: {},
  });
  const comment = await wire("/api/v1", "POST", `/tasks/${sixTaskId}/comments`, {
    agentKey,
    body: { content: SIX_COMMENT },
  });
  expect(comment.status).toBe(201);
  codeEvidenceService.linkTaskCodeEvidence(
    sixTaskId,
    { externalUrls: [SIX_EVIDENCE_URL], allowExternalRepository: true },
    { type: "agent", id: agentId },
    { habitatId: teamHabitatId },
  );
  sixSeeded = true;
  return sixTaskId;
}

describe("task object access — five Task GET reads (derived habitat)", () => {
  it("admits every member shape on both prefixes across all five reads; seeded content visible", async () => {
    const taskId = await ensureSixSeed();
    for (const prefix of PREFIXES) {
      for (const token of [
        memberAdminJwt,
        memberViewerJwt,
        teamOwnerJwt,
        teamAdminJwt,
        teamMemberJwt,
      ]) {
        for (const [, path] of sixReads(taskId)) {
          const res = await wire(prefix, "GET", path, { token });
          expect(res.status, `${prefix} ${path}`).toBe(200);
        }
        if (token === memberAdminJwt) {
          const simple = await wire(prefix, "GET", `/tasks/${taskId}`, { token });
          expect(simple.body.task.title).toBe(SIX_TITLE);
          const details = await wire(prefix, "GET", `/tasks/${taskId}/details`, { token });
          expect(details.text).toContain(SIX_TITLE);
          const events = await wire(prefix, "GET", `/tasks/${taskId}/events`, { token });
          expect(events.text).toContain(SIX_EVENT_ACTOR);
          const comments = await wire(prefix, "GET", `/tasks/${taskId}/comments`, { token });
          expect(comments.text).toContain(SIX_COMMENT);
          const evidence = await wire(prefix, "GET", `/tasks/${taskId}/code-evidence`, { token });
          expect(evidence.text).toContain(SIX_EVIDENCE_URL);
        }
      }
    }
  }, 60_000);

  it("global-admin NONmember gets 403 on all five reads with zero seeded disclosure", async () => {
    const taskId = await ensureSixSeed();
    for (const prefix of PREFIXES) {
      for (const [, path] of sixReads(taskId)) {
        const res = await wire(prefix, "GET", path, { token: nonmemberAdminJwt });
        expect(res.status, `${prefix} ${path}`).toBe(403);
        expect(res.text).not.toContain(SIX_TITLE);
        expect(res.text).not.toContain(SIX_EVENT_ACTOR);
        expect(res.text).not.toContain(SIX_COMMENT);
        expect(res.text).not.toContain(SIX_EVIDENCE_URL);
      }
    }
  }, 30_000);

  it("personal-habitat task admits any authenticated human (nonmember included) on all five reads", async () => {
    const taskId = makeTask(personalHabitatId, "boa-six-personal", "boa-seed");
    for (const prefix of PREFIXES) {
      for (const [, path] of sixReads(taskId)) {
        const res = await wire(prefix, "GET", path, { token: nonmemberAdminJwt });
        expect(res.status, `${prefix} ${path}`).toBe(200);
      }
    }
  }, 30_000);

  it("local agent keys stay admitted on the TEAM-habitat task regardless of binding", async () => {
    const taskId = await ensureSixSeed();
    for (const key of [agentKey, boundAgentKey]) {
      // boundAgent is currentTaskId-bound to a PERSONAL-habitat task; the
      // predicate ignores agent task/habitat binding entirely.
      for (const [, path] of sixReads(taskId)) {
        const res = await wire("/api/v1", "GET", path, { agentKey: key });
        expect(res.status, `${key.slice(0, 8)} ${path}`).toBe(200);
      }
    }
  }, 30_000);

  it("anonymous, invalid agent key and VALID remote credential get 401 on all five reads", async () => {
    const taskId = await ensureSixSeed();
    for (const prefix of PREFIXES) {
      for (const [, path] of sixReads(taskId)) {
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

  it("authenticated missing Task and orphaned Mission are 404 on all five reads", async () => {
    const missingTask = "00000000-0000-4000-8000-00000000000a";
    const orphanTaskId = makeTask(teamHabitatId, "boa-six-orphan", "boa-seed");
    const missionId = taskRepo.getMissionIdForTask(orphanTaskId)!;
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    for (const prefix of PREFIXES) {
      // memberViewerJwt spreads the per-header rate-limit budget (the
      // limiter counts raw headers; a single token would hit the cap).
      for (const [, path] of sixReads(missingTask)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} missing ${path}`).toBe(404);
      }
      for (const [, path] of sixReads(orphanTaskId)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} orphan ${path}`).toBe(404);
      }
    }
  }, 30_000);
});

describe("task object access — DELETE /tasks/:id (derived habitat)", () => {
  it("global-admin NONmember DELETE is 403 with zero deletion effects (both prefixes)", async () => {
    const task = makeTask(teamHabitatId, "boa-six-del-denied", "boa-seed");
    eventRepo.createEvent({
      taskId: task,
      actorType: "human",
      actorId: SIX_EVENT_ACTOR,
      action: "updated",
      metadata: {},
    });
    const comment = await wire("/api/v1", "POST", `/tasks/${task}/comments`, {
      agentKey,
      body: { content: "boa-six-del-comment" },
    });
    expect(comment.status).toBe(201);
    const eventsBefore = eventRepo.getEventsByTaskId(task).total;
    const commentsBefore = commentService.getComments(task).total;

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "DELETE", `/tasks/${task}`, { token: nonmemberAdminJwt });
      expect(res.status, prefix).toBe(403);
    }

    // deleteTask never ran: task, events and comments all intact.
    expect(taskRepo.getTaskById(task)).not.toBeNull();
    expect(eventRepo.getEventsByTaskId(task).total).toBe(eventsBefore);
    expect(commentService.getComments(task).total).toBe(commentsBefore);
  }, 30_000);

  it("membership denial precedes the dependent guard; member keeps the retained dependent failure", async () => {
    const target = makeTask(teamHabitatId, "boa-six-dep-target", "boa-seed");
    const dependent = makeTask(teamHabitatId, "boa-six-dep-dependent", "boa-seed");
    dependencyService.addTaskDependency(dependent, target);

    // Nonmember is denied on MEMBERSHIP (403), not dependents (400).
    const denied = await wire("/api/v1", "DELETE", `/tasks/${target}`, {
      token: nonmemberAdminJwt,
    });
    expect(denied.status).toBe(403);
    expect(taskRepo.getTaskById(target)).not.toBeNull();

    // Admitted member still hits the retained has-dependents guard.
    const member = await wire("/api/v1", "DELETE", `/tasks/${target}`, {
      token: memberAdminJwt,
    });
    expect(member.status).toBe(400);
    expect(member.body.error).toContain("Cannot delete task");
    expect(taskRepo.getTaskById(target)).not.toBeNull();
    expect(taskRepo.getTaskById(dependent)).not.toBeNull();
  }, 30_000);

  it("member DELETE succeeds with existing effects; anonymous/bad-key/valid-remote stay 401; missing Task 404", async () => {
    const doomed = makeTask(teamHabitatId, "boa-six-del-ok", "boa-seed");

    for (const prefix of PREFIXES) {
      expect((await wire(prefix, "DELETE", `/tasks/${doomed}`)).status, `${prefix} anon`).toBe(401);
      expect(
        (await wire(prefix, "DELETE", `/tasks/${doomed}`, { agentKey: "not-a-key" })).status,
        `${prefix} badkey`,
      ).toBe(401);
      expect(
        (await wire(prefix, "DELETE", `/tasks/${doomed}`, { remoteKey: validRemoteKey })).status,
        `${prefix} remote`,
      ).toBe(401);
    }

    const missing = await wire("/api", "DELETE", "/tasks/00000000-0000-4000-8000-00000000000b", {
      token: memberAdminJwt,
    });
    expect(missing.status).toBe(404);

    const ok = await wire("/api", "DELETE", `/tasks/${doomed}`, { token: memberViewerJwt });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(taskRepo.getTaskById(doomed)).toBeNull();
  }, 30_000);

  it("archived-mission DELETE failure is retained for an admitted member", async () => {
    const task = makeTask(teamHabitatId, "boa-six-del-archived", "boa-seed");
    const missionId = taskRepo.getMissionIdForTask(task)!;
    missionRepo.updateMission(missionId, { isArchived: true });

    const res = await wire("/api/v1", "DELETE", `/tasks/${task}`, { token: memberAdminJwt });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("archived");
    expect(taskRepo.getTaskById(task)).not.toBeNull();
  }, 30_000);
});

describe("task object access — served MCP compatibility (six operations)", () => {
  it("orcy_habitat_task get-context/get-events/get-comments serve the guarded reads; delete deletes", async () => {
    const taskId = await ensureSixSeed();

    const context = await callTool("orcy_habitat_task", { action: "get-context", taskId });
    expect(context.isError).toBeFalsy();
    expect(toolText(context)).toContain(SIX_TITLE);

    const events = await callTool("orcy_habitat_task", { action: "get-events", taskId });
    expect(events.isError).toBeFalsy();
    expect(toolText(events)).toContain(SIX_EVENT_ACTOR);

    const comments = await callTool("orcy_habitat_task", { action: "get-comments", taskId });
    expect(comments.isError).toBeFalsy();
    expect(toolText(comments)).toContain(SIX_COMMENT);

    const doomed = makeTask(teamHabitatId, "boa-six-mcp-del", "boa-seed");
    const del = await callTool("orcy_habitat_task", { action: "delete", taskId: doomed });
    expect(del.isError).toBeFalsy();
    expect(taskRepo.getTaskById(doomed)).toBeNull();
  }, 60_000);
});

// ---- DELETE effects + matrix fixup (Sol review required 1–2) ------------
// Observes the REAL broadcast channel (in-process sseBroadcaster singleton
// shared with the served app): notifyWatchers publishes task.watcher_notify
// and emitTransition publishes task.deleted on the habitat stream.

describe("task object access — DELETE effects and matrix fixup (Sol review required 1–2)", () => {
  it("denied DELETE: zero broadcasts (no watcher notification, no deletion transition), no new event, dependency relation and watcher row intact", async () => {
    const task = makeTask(teamHabitatId, "boa-fixup-denied", "boa-seed");
    watcherRepo.addWatcher(task, "boa-fixup-watcher");
    const dependent = makeTask(teamHabitatId, "boa-fixup-dependent", "boa-seed");
    dependencyService.addTaskDependency(dependent, task);
    const eventsBefore = eventRepo.getEventsByTaskId(task).total;

    const seen: string[] = [];
    const unsubscribe = sseBroadcaster.subscribe(teamHabitatId, (e) => seen.push(e.type));
    try {
      for (const prefix of PREFIXES) {
        const res = await wire(prefix, "DELETE", `/tasks/${task}`, {
          token: nonmemberAdminJwt,
        });
        expect(res.status, prefix).toBe(403);
      }
    } finally {
      unsubscribe();
    }

    // deleteTask never ran: nothing was broadcast, no event row appeared,
    // and the seeded watcher + dependency relation are untouched.
    expect(seen).toEqual([]);
    expect(taskRepo.getTaskById(task)).not.toBeNull();
    expect(eventRepo.getEventsByTaskId(task).total).toBe(eventsBefore);
    expect(
      dependencyReadRepo.getTaskDependencies(dependent).dependsOn.some((d) => d.taskId === task),
    ).toBe(true);
    expect(watcherRepo.getWatcherUserIdsForTask(task)).toContain("boa-fixup-watcher");
  }, 30_000);

  it("admitted DELETE retains effects: watcher notification AND task.deleted broadcast observed on the habitat stream", async () => {
    const task = makeTask(teamHabitatId, "boa-fixup-admitted", "boa-seed");
    watcherRepo.addWatcher(task, "boa-fixup-watcher2");

    const seen: string[] = [];
    const unsubscribe = sseBroadcaster.subscribe(teamHabitatId, (e) => seen.push(e.type));
    try {
      const res = await wire("/api/v1", "DELETE", `/tasks/${task}`, { token: memberAdminJwt });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    } finally {
      unsubscribe();
    }

    expect(taskRepo.getTaskById(task)).toBeNull();
    expect(seen).toContain("task.watcher_notify");
    expect(seen).toContain("task.deleted");
  }, 30_000);

  it("DELETE actor matrix: personal human, unbound + other-habitat-bound agents, every member shape", async () => {
    // Personal habitat admits any authenticated human (both prefixes).
    for (const prefix of PREFIXES) {
      const pTask = makeTask(personalHabitatId, `boa-fixup-personal-${prefix}`, "boa-seed");
      const res = await wire(prefix, "DELETE", `/tasks/${pTask}`, { token: plainHumanJwt });
      expect(res.status, `personal ${prefix}`).toBe(200);
      expect(taskRepo.getTaskById(pTask)).toBeNull();
    }

    // Local agents delete TEAM-habitat tasks regardless of task binding.
    for (const [label, key] of [
      ["unbound", agentKey],
      ["other-habitat-bound", boundAgentKey],
    ] as const) {
      const aTask = makeTask(teamHabitatId, `boa-fixup-agent-${label}`, "boa-seed");
      const res = await wire("/api/v1", "DELETE", `/tasks/${aTask}`, { agentKey: key });
      expect(res.status, label).toBe(200);
      expect(taskRepo.getTaskById(aTask)).toBeNull();
    }

    // Every member shape deletes a team-habitat task.
    for (const token of [
      memberAdminJwt,
      memberViewerJwt,
      teamOwnerJwt,
      teamAdminJwt,
      teamMemberJwt,
    ]) {
      const mTask = makeTask(teamHabitatId, `boa-fixup-member-${token.length}`, "boa-seed");
      const res = await wire("/api", "DELETE", `/tasks/${mTask}`, { token });
      expect(res.status, `member ${token.slice(0, 12)}`).toBe(200);
      expect(taskRepo.getTaskById(mTask)).toBeNull();
    }
  }, 60_000);

  it("DELETE ancestry: orphaned Mission is 404 on both prefixes; missing-Habitat branch verified at the unit seam (FK cascade prevents a wire fixture)", async () => {
    const orphan = makeTask(teamHabitatId, "boa-fixup-orphan", "boa-seed");
    const missionId = taskRepo.getMissionIdForTask(orphan)!;
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "DELETE", `/tasks/${orphan}`, { token: memberViewerJwt });
      expect(res.status, prefix).toBe(404);
    }

    // missions.habitatId is ON DELETE CASCADE: removing a habitat removes
    // the mission and its tasks, so no wire fixture can reach
    // checkHabitatAccess's missing-habitat branch. Verify that branch
    // directly (unit seam of the same shared predicate) and disclose the
    // fixture limit — this is NOT wire coverage of that branch.
    const req = {
      user: { id: "boa-member-admin" },
    } as unknown as Parameters<typeof checkHabitatAccess>[0];
    let statusCode = 0;
    try {
      await checkHabitatAccess(req, "00000000-0000-4000-8000-00000000000c");
    } catch (err) {
      statusCode = (err as { statusCode?: number }).statusCode ?? 0;
    }
    expect(statusCode).toBe(404);
  }, 30_000);
});
