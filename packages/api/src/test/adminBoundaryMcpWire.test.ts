/**
 * REC-08 — administrative action boundaries, SERVED MCP wire
 * (real JSON-RPC over stdio against the REAL API on a TCP socket; no mocks).
 *
 * Pins the exact agent/human boundary for review-rule, reviewer, sprint, and
 * batch task actions, per the source-verified census at f8c7211:
 *
 *   POSITIVE agent reads (8, `local_actor`, census said WORKS — wire-pinned here
 *     on a PERSONAL habitat only): orcy_review list_rules, list_reviewers;
 *     orcy_sprint list, get_active, get, get_metrics, get_burndown, get_carry_over
 *
 *   TEAM-HABITAT SPRINT READ DENIAL: the four id-keyed sprint reads
 *     (get, get_metrics, get_burndown, get_carry_over) run
 *     verifySprintHabitatAccess, which 403s agents on TEAM habitats
 *     ("Agents cannot access team habitats") while personal habitats pass —
 *     the personal-habitat control for `get` is it#1. Habitat-scoped reads
 *     (sprint list/get_active, review list_rules) admit any agent on any
 *     habitat shape (checkHabitatAccess returns immediately for agents).
 *
 *   NEGATIVE agent mutations (`authPolicy: "human"` — humanAuth accepts only a
 *   Bearer JWT, so an agent API key never reaches the handler):
 *     orcy_review create_rule → 401, add_reviewer → 401;
 *     orcy_sprint create → 401, start → 401
 *     (exact status preserved through the MCP transport: the dispatch tool
 *     result carries `Error: API 401: …` with the API error body)
 *
 *   BATCH (`local_actor` + in-handler guard, tasks/batch.ts):
 *     orcy_habitat_task batch-assign → 403 with the exact claim-pointer
 *     message ("Batch assignment is admin-only. Use POST /tasks/:id/claim …")
 *     — the documented 2513a22 deliberate deferral, not an unfinished promise;
 *     CONTROL: batch-set-priority with the same agent key succeeds (the
 *     assign/priority/delete asymmetry is intentional — this pins the open
 *     side only, no broad write coverage claimed).
 *
 *   HUMAN-ROLE FACT PINS (HTTP only — the MCP transport is agent-key):
 *     an editor-role JWT held by a TEAM MEMBER passes POST review-rule create
 *     (no admin-role distinction is enforced anywhere) — and so does a
 *     VIEWER-role member (weakest role), separating the role axis from the
 *     membership axis; a viewer-role JWT held by a NON-member gets 403.
 *
 * Prerequisites are bare fixtures in a controlled disposable test DB
 * (initTestDb in-memory sql.js): habitats/missions/tasks via repositories,
 * the sprint via sprintRepo.create (agent-negative targets must exist so the
 * ONLY failure is auth), human JWTs minted with the real jwt-verification
 * secret. No fake auth proxy — every request crosses the real HTTP wire.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as userRepo from "../repositories/user.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as sprintRepo from "../repositories/sprint.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;
let habitatId: string;
let columnId: string;
let taskId: string;
let sprintId: string;
let teamHabitatId: string;
let teamHabitatSprintId: string;
let mcpAgentId: string;
let mcpAgentKey: string;
let seededUserId: string;

// ---- Minimal MCP client over stdio (newline-delimited JSON-RPC) ------------
let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";

function send(obj: unknown): void {
  child.stdin!.write(JSON.stringify(obj) + "\n");
}

function request(method: string, params?: unknown): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function notify(method: string, params?: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function callTool(name: string, args: Record<string, unknown>) {
  return request("tools/call", { name, arguments: args });
}

function toolText(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

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

function mintHumanJwt(sub: string, role: string): string {
  return jwt.sign({ sub, username: `rec08-${role}-${sub}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const agent = agentRepo.createAgent({
    name: "rec08-mcp-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  mcpAgentId = agent.agent.id;
  mcpAgentKey = agent.plainApiKey;

  const seeded = userRepo.getUserByUsername("admin");
  seededUserId = seeded!.id;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: mcpAgentId,
      ORCY_API_KEY: mcpAgentKey,
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

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "rec08-admin-boundary-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  notify("notifications/initialized");
}, 120_000);

afterAll(async () => {
  child.kill("SIGTERM");
  await childExit;
  await app.close();
  closeDb();
});

beforeEach(() => {
  const habitat = habitatRepo.createHabitat({ name: "REC08 Personal Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "rec08-mission",
    createdBy: seededUserId,
  });
  taskId = taskRepo.createTask({
    missionId: mission.id,
    title: "rec08-task",
    createdBy: seededUserId,
  }).id;

  // Sprint exists so id-keyed agent negatives (start) fail on AUTH ONLY.
  const now = Date.now();
  sprintId = sprintRepo.create(habitatId, {
    name: "rec08-sprint",
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
    createdBy: seededUserId,
  }).id;

  // Team habitat so the human pins exercise the TEAM-MEMBER branch
  // (personal habitats admit ANY authenticated human — weaker pin) and the
  // agent sprint-read denial exercises verifySprintHabitatAccess.
  const org = organizationRepo.createOrganization({
    name: "rec08-org",
    slug: `rec08-org-${Date.now()}`,
  });
  const team = teamRepo.createTeam({
    organizationId: org.id,
    name: "rec08-team",
    slug: `rec08-team-${Date.now()}`,
  });
  teamHabitatId = habitatRepo.createHabitat({
    name: "REC08 Team Habitat",
    teamId: team.id,
  }).id;

  // Sprint on the TEAM habitat so id-keyed agent reads fail on habitat
  // shape (403), not on a missing sprint.
  teamHabitatSprintId = sprintRepo.create(teamHabitatId, {
    name: "rec08-team-sprint",
    startDate: new Date(now).toISOString(),
    endDate: new Date(now + 14 * 24 * 3600 * 1000).toISOString(),
    createdBy: seededUserId,
  }).id;
});

describe("REC-08 administrative boundaries — served MCP wire", () => {
  it("agent key passes all 8 administrative READS on a PERSONAL habitat (local_actor; census-positive, wire-pinned for this shape)", async () => {
    // orcy_review
    const rules = await callTool("orcy_review", { action: "list_rules", habitatId });
    expect(rules.isError).toBeFalsy();
    expect(JSON.parse(toolText(rules))).toMatchObject({ reviewRules: [] });

    const reviewers = await callTool("orcy_review", { action: "list_reviewers", taskId });
    expect(reviewers.isError).toBeFalsy();
    expect(JSON.parse(toolText(reviewers))).toMatchObject({ reviewers: [] });

    // orcy_sprint — the six reads
    const list = await callTool("orcy_sprint", { action: "list", habitatId });
    expect(list.isError).toBeFalsy();
    const listBody = JSON.parse(toolText(list)) as { sprints: { id: string }[] };
    expect(listBody.sprints.map((s) => s.id)).toContain(sprintId);

    const active = await callTool("orcy_sprint", { action: "get_active", habitatId });
    expect(active.isError).toBeFalsy();
    expect(JSON.parse(toolText(active)).sprint).toBeNull(); // seeded sprint is "planning", not active

    const got = await callTool("orcy_sprint", { action: "get", sprintId });
    expect(got.isError).toBeFalsy();
    expect(JSON.parse(toolText(got))).toMatchObject({ sprint: { id: sprintId } });

    for (const action of ["get_metrics", "get_burndown", "get_carry_over"]) {
      const res = await callTool("orcy_sprint", { action, sprintId });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(toolText(res))).toBeTruthy();
    }
  }, 60_000);

  it("TEAM-habitat sprint: all 4 id-keyed agent reads 403 (verifySprintHabitatAccess) — personal control is it#1", async () => {
    for (const action of ["get", "get_metrics", "get_burndown", "get_carry_over"]) {
      const res = await callTool("orcy_sprint", { action, sprintId: teamHabitatSprintId });
      expect(res.isError).toBe(true);
      const text = toolText(res);
      expect(text).toContain("API 403:");
      expect(text).toContain("Agents cannot access team habitats");
    }
  }, 60_000);

  it("agent key gets EXACTLY 401 (not 403) on human-policy mutations — status preserved through MCP transport", async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      {
        tool: "orcy_review",
        args: { action: "create_rule", habitatId, name: "agent-rule" },
      },
      {
        tool: "orcy_review",
        args: { action: "add_reviewer", taskId, reviewerId: seededUserId },
      },
      {
        tool: "orcy_sprint",
        args: {
          action: "create",
          habitatId,
          name: "agent-sprint",
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        },
      },
      { tool: "orcy_sprint", args: { action: "start", sprintId } },
    ];

    for (const { tool, args } of cases) {
      const res = await callTool(tool, args);
      expect(res.isError).toBe(true);
      const text = toolText(res);
      // ApiClientError message is "API <status>: <body>" — the real HTTP
      // status crossed the MCP stdio transport inside the tool result.
      expect(text).toContain("API 401:");
      expect(text).not.toContain("API 403:");
    }
  }, 60_000);

  it("batch-assign: agent gets 403 with the EXACT claim-pointer message (2513a22 deliberate); set-priority control succeeds", async () => {
    const assign = await callTool("orcy_habitat_task", {
      action: "batch-assign",
      habitatId,
      taskIds: [taskId],
      assigneeId: mcpAgentId,
    });
    expect(assign.isError).toBe(true);
    const assignText = toolText(assign);
    expect(assignText).toContain("API 403:");
    expect(assignText).toContain(
      "Batch assignment is admin-only. Use POST /tasks/:id/claim to claim a task.",
    );

    // Control on the SAME route with the SAME agent key: priority op is open
    // to local actors (asymmetry is intentional per the assign guard itself).
    const priority = await callTool("orcy_habitat_task", {
      action: "batch-set-priority",
      habitatId,
      taskIds: [taskId],
      priority: "high",
    });
    expect(priority.isError).toBeFalsy();
    const priorityBody = JSON.parse(toolText(priority)) as {
      successCount: number;
      failureCount: number;
    };
    expect(priorityBody.successCount).toBe(1);
    expect(priorityBody.failureCount).toBe(0);
  }, 60_000);

  it("human-role fact pins (HTTP): editor AND viewer team members create a review rule (no admin-role gate); non-member 403", async () => {
    const editorId = "rec08-editor-user";
    const viewerMemberId = "rec08-viewer-member-user";
    const teamId = habitatRepo.getHabitatById(teamHabitatId)!.teamId!;
    teamMemberRepo.addMember({ teamId, userId: editorId, role: "member" });
    teamMemberRepo.addMember({ teamId, userId: viewerMemberId, role: "member" });
    const editorJwt = mintHumanJwt(editorId, "editor");
    const viewerMemberJwt = mintHumanJwt(viewerMemberId, "viewer");
    const outsiderJwt = mintHumanJwt("rec08-outsider-user", "viewer");

    const create = async (token: string): Promise<Response> =>
      fetch(`${baseUrl}/api/habitats/${teamHabitatId}/review-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "rec08-rule" }),
      });

    const member = await create(editorJwt);
    expect(member.status).toBe(201);

    // Weakest role + member: separates the role axis from the membership
    // axis — pins "no admin-role distinction" (a viewer non-member 403 alone
    // would leave the 403 attributable to either).
    const viewerMember = await create(viewerMemberJwt);
    expect(viewerMember.status).toBe(201);

    const outsider = await create(outsiderJwt);
    expect(outsider.status).toBe(403);
  }, 30_000);

  it("orcy_habitat update-rules / evaluate-rules: agent key gets EXACTLY 401 with persisted rules UNCHANGED; human JWT control mutates the same route", async () => {
    // Prioritization is human-only TODAY (prioritization.ts authPolicy: "human"
    // on PUT /habitats/:id/rules and POST /habitats/:id/rules/evaluate) — this
    // pins the current boundary, not a future-RBAC design. Narrow coverage
    // claim: the two wire denials + unchanged persisted state + a human
    // positive control that proves the 401 is the auth axis (not an unmounted
    // route, a validation 400, or a tool/param error that never leaves the
    // dispatch layer).
    const before = JSON.stringify(
      habitatRepo.getHabitatById(habitatId)!.prioritizationSettings ?? null,
    );

    const payload = { enabled: false, fallbackToManual: false };

    const update = await callTool("orcy_habitat", {
      action: "update-rules",
      habitatId,
      rules: payload,
    });
    expect(update.isError).toBe(true);
    const updateText = toolText(update);
    expect(updateText).toContain("API 401:"); // request crossed to the real PUT route and was refused by its auth policy
    expect(updateText).not.toContain("API 403:");

    const evaluate = await callTool("orcy_habitat", { action: "evaluate-rules", habitatId });
    expect(evaluate.isError).toBe(true);
    const evaluateText = toolText(evaluate);
    expect(evaluateText).toContain("API 401:"); // same for the POST /rules/evaluate sibling
    expect(evaluateText).not.toContain("API 403:");

    // Denials reached the routes yet mutated nothing.
    expect(
      JSON.stringify(habitatRepo.getHabitatById(habitatId)!.prioritizationSettings ?? null),
    ).toBe(before);

    // HUMAN POSITIVE CONTROL on the exact routes and payload class above: a
    // JWT holder gets 200 and the settings DO change — so the agent 401s are
    // attributable to the credential axis alone.
    const humanJwt = mintHumanJwt(seededUserId, "admin");
    const put = await fetch(`${baseUrl}/api/habitats/${habitatId}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${humanJwt}` },
      body: JSON.stringify(payload),
    });
    expect(put.status).toBe(200);
    const post = await fetch(`${baseUrl}/api/habitats/${habitatId}/rules/evaluate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanJwt}` },
    });
    expect(post.status).toBe(200);
    const after = habitatRepo.getHabitatById(habitatId)!.prioritizationSettings!;
    expect(after.enabled).toBe(false);
    expect(after.fallbackToManual).toBe(false);
  }, 60_000);
});
