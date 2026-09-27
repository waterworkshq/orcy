/**
 * Five Task adjunct GETs (remaining-task-access, Sol ACCEPT) — REAL HTTP wire
 * matrix on BOTH served prefixes (`/api/v1`, deprecated `/api`) plus served
 * MCP compatibility.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - GET /tasks/:id/quality-checklist, /approval-status, /effort-report,
 *    /effort-entries, /time-report resolve the TARGET Task → Mission →
 *    Habitat and enforce the shared membership predicate BEFORE any
 *    report/row-producing call. Intended deltas: team-nonmember humans 403
 *    (was 200); authenticated missing Task / orphaned Mission 404.
 *  - Preserved: local_actor policy and 401 for anonymous / invalid local /
 *    remote-only credentials; member (any role) and personal-Habitat human
 *    admission; bound/unbound local agents; effort query defaults
 *    (includeCorrections default true, limit 100, offset 0) and pagination;
 *    report/row shapes; 200-with-empty-shape for an existing Task with no
 *    domain rows (the retained null-report 404 covers only absent Tasks).
 *
 * No middleware mocks: every request crosses a real TCP socket into the real
 * application; MCP checks drive the spawned server over stdio with a real
 * agent key.
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
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as qualityRepo from "../repositories/qualityGate.js";
import { missions } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

const QUALITY_ITEM_TITLE = "adjunct-quality-item-marker";
const EFFORT_NOTE = "adjunct-effort-note-marker";

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamId: string;
let teamHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let agentId: string;
let boundAgentKey: string;
let validRemoteKey: string;

let memberAdminJwt: string;
let memberViewerJwt: string;
let teamOwnerJwt: string;
let teamAdminJwt: string;
let teamMemberJwt: string;
let nonmemberAdminJwt: string;

// Seeded team-habitat task with nonempty quality/effort/time rows.
let teamTaskId: string;
let teamSeeded = false;

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
  return jwt.sign({ sub: userId, username: `tar-${userId}`, role }, getJwtSecret(), {
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

/** The five guarded adjunct reads as [path-suffix] pairs for a task id. */
function adjunctReads(taskId: string): string[] {
  return [
    `/tasks/${taskId}/quality-checklist`,
    `/tasks/${taskId}/approval-status`,
    `/tasks/${taskId}/effort-report`,
    `/tasks/${taskId}/effort-entries`,
    `/tasks/${taskId}/time-report`,
  ];
}

/**
 * Seed a team-habitat task with nonempty domain rows: one required quality
 * template/checklist with an item, three logged effort entries plus one
 * correction (four rows total), and an estimate.
 */
async function ensureSeededTeamTask(): Promise<string> {
  if (teamSeeded) return teamTaskId;
  teamTaskId = makeTask(teamHabitatId, "tar-team-task", "tar-seed");

  const template = qualityRepo.createTemplate({
    name: "tar-adjunct-template",
    category: "tar",
    isRequired: true,
    items: [{ title: QUALITY_ITEM_TITLE, required: true }],
  });
  qualityRepo.createTaskChecklist(teamTaskId, template.id);

  const estimate = await wire("/api/v1", "PUT", `/tasks/${teamTaskId}/estimate`, {
    agentKey,
    body: { estimatedMinutes: 90 },
  });
  expect(estimate.status).toBe(200);

  let firstEntryId = "";
  for (const minutes of [30, 20, 10]) {
    const entry = await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
      agentKey,
      body: { minutes, note: `${EFFORT_NOTE}-${minutes}` },
    });
    expect(entry.status).toBe(200);
    if (!firstEntryId) firstEntryId = entry.body.id;
  }
  const correction = await wire(
    "/api/v1",
    "POST",
    `/tasks/${teamTaskId}/effort-entries/${firstEntryId}/correct`,
    {
      agentKey,
      body: { minutesDelta: -5, correctionReason: "tar-correction" },
    },
  );
  expect(correction.status).toBe(200);

  teamSeeded = true;
  return teamTaskId;
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
    name: "tar-org",
    slug: `tar-org-${Date.now()}`,
  });
  teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "tar-team",
    slug: `tar-team-${Date.now()}`,
  }).id;
  teamHabitatId = habitatRepo.createHabitat({
    name: "tar-team-habitat",
    teamId,
  }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tar-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId, userId: "tar-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "tar-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "tar-team-owner", role: "owner" });
  teamMemberRepo.addMember({ teamId, userId: "tar-team-admin", role: "admin" });
  teamMemberRepo.addMember({ teamId, userId: "tar-team-member", role: "member" });

  memberAdminJwt = mint("tar-member-admin", "admin");
  memberViewerJwt = mint("tar-member-viewer", "viewer");
  teamOwnerJwt = mint("tar-team-owner", "viewer");
  teamAdminJwt = mint("tar-team-admin", "editor");
  teamMemberJwt = mint("tar-team-member", "viewer");
  nonmemberAdminJwt = mint("tar-nonmember-admin", "admin");

  const created = agentRepo.createAgent({
    name: "tar-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  // Second agent BOUND (currentTaskId) to a personal-habitat task: proves
  // binding elsewhere changes nothing for the TEAM-habitat reads below.
  const boundAgent = agentRepo.createAgent({
    name: "tar-bound-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  boundAgentKey = boundAgent.plainApiKey;
  const boundAnchorTask = makeTask(personalHabitatId, "tar-bound-anchor", "tar-seed");
  agentRepo.heartbeat(boundAgent.agent.id, boundAnchorTask);

  // Fully VALID remote credential: must still get 401 on these
  // local-credential policies.
  const pod = remotePodRepo.createRemotePod({
    habitatId: teamHabitatId,
    name: "tar-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: "remote_orcy",
    displayName: "tar-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: "api",
    label: "tar-remote-cred",
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
    clientInfo: { name: "tar-adjunct-reads-wire-test", version: "1.0.0" },
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

describe("task adjunct reads — five guarded GETs (derived habitat)", () => {
  it("admits every member shape on both prefixes across all five reads; seeded content visible with existing shapes", async () => {
    const taskId = await ensureSeededTeamTask();
    for (const prefix of PREFIXES) {
      for (const token of [
        memberAdminJwt,
        memberViewerJwt,
        teamOwnerJwt,
        teamAdminJwt,
        teamMemberJwt,
      ]) {
        for (const path of adjunctReads(taskId)) {
          const res = await wire(prefix, "GET", path, { token });
          expect(res.status, `${prefix} ${path}`).toBe(200);
        }
        if (token === memberAdminJwt) {
          const quality = await wire(prefix, "GET", `/tasks/${taskId}/quality-checklist`, {
            token,
          });
          expect(quality.text).toContain(QUALITY_ITEM_TITLE);
          expect(quality.body.checklists).toHaveLength(1);
          expect(quality.body.checklists[0].progress.total).toBe(1);

          const approval = await wire(prefix, "GET", `/tasks/${taskId}/approval-status`, {
            token,
          });
          expect(approval.body.canBeApproved).toBe(false);
          expect(approval.body.reasons).toContain("QUALITY_GATES_INCOMPLETE");
          expect(approval.body.requirements.qualityChecklist.total).toBe(1);

          const report = await wire(prefix, "GET", `/tasks/${taskId}/effort-report`, {
            token,
          });
          expect(report.text).toContain(EFFORT_NOTE);
          expect(report.body.estimate.plannedMinutes).toBe(90);
          expect(report.body.entries.length).toBeGreaterThanOrEqual(4);

          const entries = await wire(prefix, "GET", `/tasks/${taskId}/effort-entries`, {
            token,
          });
          expect(entries.body).toHaveLength(4);
          expect(entries.text).toContain(EFFORT_NOTE);

          const time = await wire(prefix, "GET", `/tasks/${taskId}/time-report`, { token });
          expect(time.body.taskId).toBe(taskId);
          expect(time.body.estimatedMinutes).toBe(90);
          expect(Array.isArray(time.body.heartbeatHistory)).toBe(true);
        }
      }
    }
  }, 60_000);

  it("global-admin NONmember gets 403 on all five reads with zero seeded disclosure", async () => {
    const taskId = await ensureSeededTeamTask();
    for (const prefix of PREFIXES) {
      for (const path of adjunctReads(taskId)) {
        const res = await wire(prefix, "GET", path, { token: nonmemberAdminJwt });
        expect(res.status, `${prefix} ${path}`).toBe(403);
        expect(res.text).not.toContain(QUALITY_ITEM_TITLE);
        expect(res.text).not.toContain(EFFORT_NOTE);
        expect(res.body.reasons).toBeUndefined();
        expect(res.body.checklists).toBeUndefined();
        expect(res.body.entries).toBeUndefined();
        expect(res.body.heartbeatHistory).toBeUndefined();
      }
    }
  }, 30_000);

  it("personal-habitat task admits any authenticated human (nonmember included); existing task with NO domain rows keeps 200 empty shapes", async () => {
    const taskId = makeTask(personalHabitatId, "tar-personal-empty", "tar-seed");
    for (const prefix of PREFIXES) {
      const quality = await wire(prefix, "GET", `/tasks/${taskId}/quality-checklist`, {
        token: nonmemberAdminJwt,
      });
      expect(quality.status).toBe(200);
      expect(quality.body.checklists).toEqual([]);

      const approval = await wire(prefix, "GET", `/tasks/${taskId}/approval-status`, {
        token: nonmemberAdminJwt,
      });
      expect(approval.status).toBe(200);
      // Existing behavior: with no checklists, canApprove is vacuously true.
      expect(approval.body.requirements.qualityChecklist.status).toBe("complete");

      const report = await wire(prefix, "GET", `/tasks/${taskId}/effort-report`, {
        token: nonmemberAdminJwt,
      });
      expect(report.status).toBe(200);
      expect(report.body.entries).toEqual([]);

      const entries = await wire(prefix, "GET", `/tasks/${taskId}/effort-entries`, {
        token: nonmemberAdminJwt,
      });
      expect(entries.status).toBe(200);
      expect(entries.body).toEqual([]);

      const time = await wire(prefix, "GET", `/tasks/${taskId}/time-report`, {
        token: nonmemberAdminJwt,
      });
      expect(time.status).toBe(200);
      expect(time.body.heartbeatHistory).toEqual([]);
    }
  }, 30_000);

  it("local agent keys stay admitted on the TEAM-habitat task regardless of binding", async () => {
    const taskId = await ensureSeededTeamTask();
    for (const key of [agentKey, boundAgentKey]) {
      // boundAgent is currentTaskId-bound to a PERSONAL-habitat task; the
      // predicate ignores agent task/habitat binding entirely.
      for (const path of adjunctReads(taskId)) {
        const res = await wire("/api/v1", "GET", path, { agentKey: key });
        expect(res.status, `${key.slice(0, 8)} ${path}`).toBe(200);
      }
    }
  }, 30_000);

  it("anonymous, invalid agent key and VALID remote credential get 401 on all five reads", async () => {
    const taskId = await ensureSeededTeamTask();
    for (const prefix of PREFIXES) {
      for (const path of adjunctReads(taskId)) {
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
    const orphanTaskId = makeTask(teamHabitatId, "tar-orphan", "tar-seed");
    const missionId = taskRepo.getMissionIdForTask(orphanTaskId)!;
    getDb().delete(missions).where(eq(missions.id, missionId)).run();

    for (const prefix of PREFIXES) {
      // memberViewerJwt spreads the per-header rate-limit budget (the
      // limiter counts raw headers; a single token would hit the cap).
      for (const path of adjunctReads(missingTask)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} missing ${path}`).toBe(404);
      }
      for (const path of adjunctReads(orphanTaskId)) {
        const res = await wire(prefix, "GET", path, { token: memberViewerJwt });
        expect(res.status, `${prefix} orphan ${path}`).toBe(404);
      }
    }
  }, 30_000);

  it("effort-entries query options still shape rows: includeCorrections filters, limit and offset page", async () => {
    const taskId = await ensureSeededTeamTask();

    const all = await wire("/api/v1", "GET", `/tasks/${taskId}/effort-entries`, {
      agentKey,
    });
    expect(all.body).toHaveLength(4);

    const noCorrections = await wire(
      "/api/v1",
      "GET",
      `/tasks/${taskId}/effort-entries?includeCorrections=false`,
      { agentKey },
    );
    expect(noCorrections.status).toBe(200);
    expect(noCorrections.body).toHaveLength(3);
    expect(noCorrections.body.some((e: any) => e.source === "correction_adjustment")).toBe(false);

    const limited = await wire("/api/v1", "GET", `/tasks/${taskId}/effort-entries?limit=2`, {
      agentKey,
    });
    expect(limited.body).toHaveLength(2);

    const paged = await wire(
      "/api/v1",
      "GET",
      `/tasks/${taskId}/effort-entries?limit=10&offset=2`,
      { agentKey },
    );
    expect(paged.body).toHaveLength(2);

    // limit+offset compose consistently with the default listing order.
    expect(paged.body[0].id).toBe(all.body[2].id);
    expect(paged.body[1].id).toBe(all.body[3].id);
  }, 30_000);
});

describe("task adjunct reads — served MCP compatibility (team habitat, real agent key)", () => {
  it("orcy_habitat_task dispatch serves all five guarded reads to the agent key", async () => {
    const taskId = await ensureSeededTeamTask();

    const quality = await callTool("orcy_habitat_task", {
      action: "get-quality-checklist",
      taskId,
    });
    expect(quality.isError).toBeFalsy();
    expect(toolText(quality)).toContain(QUALITY_ITEM_TITLE);

    const approval = await callTool("orcy_habitat_task", {
      action: "get-approval-status",
      taskId,
    });
    expect(approval.isError).toBeFalsy();
    expect(toolText(approval)).toContain("QUALITY_GATES_INCOMPLETE");

    const report = await callTool("orcy_habitat_task", {
      action: "get-effort-report",
      taskId,
    });
    expect(report.isError).toBeFalsy();
    expect(toolText(report)).toContain(EFFORT_NOTE);

    const entries = await callTool("orcy_habitat_task", {
      action: "list-effort",
      taskId,
    });
    expect(entries.isError).toBeFalsy();
    expect(toolText(entries)).toContain(EFFORT_NOTE);

    const time = await callTool("orcy_habitat_task", {
      action: "get-time-report",
      taskId,
    });
    expect(time.isError).toBeFalsy();
    const timeBody = JSON.parse(toolText(time));
    expect(timeBody.estimatedMinutes).toBe(90);
    expect(timeBody.taskId).toBe(taskId);
  }, 60_000);
});
