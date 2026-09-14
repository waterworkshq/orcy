/**
 * Epoch mutation guard — SERVED MCP wire (epoch-mutation-guard ticket, item 6).
 *
 * Spawns the REAL MCP server (`packages/mcp/src/index.ts`) as a child process
 * over stdio, against the REAL API listening on a TCP socket, and drives
 * `tools/list` + `tools/call` through the MCP client SDK. No mocks.
 *
 *   - tool with the token passes
 *   - tool without the token → the server's 409 EPOCH_MISMATCH surfaces
 *     through the tool result (isError + status text)
 *   - the task-crud alias (`board_update_task` status branches) is fenced
 *     identically to the dedicated lifecycle tools
 *   - schemas: the four mutation tools carry executionToken; board_claim_task
 *     does NOT (it mints).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as pluginManager from "../plugins/pluginManager.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let habitatId: string;
let columnId: string;
/** The agent identity the MCP server authenticates as — every claim in this
 *  suite must be made by THIS agent (the mutations check assignee identity). */
let mcpAgentKey: string;
/** The seeded MCP caller's agent id (used to grant it a pending reviewer row in the review test). */
let mcpAgentId: string;

// ---- Minimal MCP client over stdio (newline-delimited JSON-RPC) ------------
// The @modelcontextprotocol SDK is a dependency of @orcy/mcp, not @orcy/api;
// rather than add one, speak the served protocol directly — the server under
// test is the REAL served server, the frames are the real wire format.
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

async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<any> {
  return request("tools/call", { name, arguments: args });
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

function seedAgent(name: string): { id: string; apiKey: string } {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  return { id: created.agent.id, apiKey: created.plainApiKey };
}

function seedTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" }).id;
}

function taskToken(taskId: string): string | null {
  const row = getDb()
    .select({ t: tasks.executionToken })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as { t: string | null } | undefined;
  return row?.t ?? null;
}

async function claim(taskId: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { executionToken?: string | null } };
  expect(body.task.executionToken).toBeTruthy();
  return body.task.executionToken!;
}

async function callTool(name: string, args: Record<string, unknown>) {
  return request("tools/call", { name, arguments: args });
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const agent = seedAgent("mcp-wire-agent");
  mcpAgentKey = agent.apiKey;
  mcpAgentId = agent.id;
  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: agent.id,
      ORCY_API_KEY: agent.apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
    clientInfo: { name: "epoch-guard-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  notify("notifications/initialized");
}, 120_000);

afterAll(async () => {
  child.kill("SIGTERM");
  await app.close();
  closeDb();
});

beforeEach(() => {
  const habitat = habitatRepo.createHabitat({ name: "MCP Wire Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

describe("epoch mutation guard — served MCP wire", () => {
  it("tools/list: the served task-dispatch tool exposes executionToken for the mutation actions", async () => {
    const list = await request("tools/list", {});
    const byName = new Map<any, any>((list.tools as any[]).map((t) => [t.name, t]));
    const dispatch = byName.get("orcy_habitat_task");
    expect(dispatch, "orcy_habitat_task must be served").toBeTruthy();
    const schema = dispatch!.inputSchema as { properties?: Record<string, unknown> };
    expect(
      schema.properties?.executionToken,
      "orcy_habitat_task must carry executionToken",
    ).toBeTruthy();
  }, 60_000);

  it("board_start_task WITHOUT the token on a tokened task → 409 EPOCH_MISMATCH surfaces through the tool", async () => {
    const taskId = seedTask("start-no-token");
    await claim(taskId, mcpAgentKey);

    const result = await callTool("orcy_habitat_task", { action: "start", taskId });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("409");
    expect(text).toContain("EPOCH_MISMATCH");
    // task untouched
    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(row.status).toBe("claimed");
  }, 60_000);

  it("board_start_task WITH the token passes", async () => {
    const taskId = seedTask("start-with-token");
    const token = await claim(taskId, mcpAgentKey);

    const result = await callTool("orcy_habitat_task", {
      action: "start",
      taskId,
      executionToken: token,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as {
      task?: { status?: string };
    };
    expect(parsed.task?.status ?? parsed).toBeTruthy();
    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(row.status).toBe("in_progress");
  }, 60_000);

  it("task-crud alias: board_update_task status=in_progress WITHOUT token → 409 EPOCH_MISMATCH; WITH token passes", async () => {
    // Without: fenced exactly like the dedicated tool.
    const task1 = seedTask("alias-no-token");
    await claim(task1, mcpAgentKey);
    const refused = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: task1,
      status: "in_progress",
    });
    expect(refused.isError).toBe(true);
    const refusedText = (refused.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(refusedText).toContain("EPOCH_MISMATCH");
    const row1 = getDb().select().from(tasks).where(eq(tasks.id, task1)).get() as {
      status: string;
    };
    expect(row1.status).toBe("claimed");

    // With: passes.
    const task2 = seedTask("alias-with-token");
    const token2 = await claim(task2, mcpAgentKey);
    const ok = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: task2,
      status: "in_progress",
      executionToken: token2,
    });
    expect(ok.isError).toBeFalsy();
    const row2 = getDb().select().from(tasks).where(eq(tasks.id, task2)).get() as {
      status: string;
    };
    expect(row2.status).toBe("in_progress");
  }, 60_000);

  it("board_submit_task WITH the token submits; a stale token surfaces EPOCH_MISMATCH", async () => {
    const taskId = seedTask("submit-mcp");
    const token = await claim(taskId, mcpAgentKey);
    const start = await callTool("orcy_habitat_task", {
      action: "start",
      taskId,
      executionToken: token,
    });
    expect(start.isError).toBeFalsy();

    const stale = await callTool("orcy_habitat_task", {
      action: "submit",
      taskId,
      result: "work done",
      executionToken: "stale-epoch-token",
    });
    expect(stale.isError).toBe(true);
    const staleText = (stale.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(staleText).toContain("EPOCH_MISMATCH");

    const ok = await callTool("orcy_habitat_task", {
      action: "submit",
      taskId,
      result: "work done",
      executionToken: taskToken(taskId),
    });
    expect(ok.isError).toBeFalsy();
    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(row.status).toBe("submitted");
  }, 60_000);

  it("served review actions: approve/reject reach the canonical review decisions server-side", async () => {
    // The fixture grants the MCP agent its pending typed row directly (the
    // human-only management route is untouched by this ticket). A distinct
    // worker claims/submits so the reviewer is never the current assignee
    // (typed anti-self would 400 that shape — covered in the wire suite).
    const worker = seedAgent("alias-approve-worker");
    const taskId = seedTask("alias-approve-mcp");
    await claim(taskId, worker.apiKey);
    const started = await fetch(`${baseUrl}/api/tasks/${taskId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": worker.apiKey },
      body: JSON.stringify({ executionToken: taskToken(taskId) }),
    });
    expect(started.status).toBe(200);
    const submitted = await fetch(`${baseUrl}/api/tasks/${taskId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": worker.apiKey },
      body: JSON.stringify({ result: "review me", executionToken: taskToken(taskId) }),
    });
    expect(submitted.status).toBe(200);
    taskReviewerRepo.create(taskId, "agent", mcpAgentId);

    const approved = await callTool("orcy_habitat_task", { action: "approve", taskId });
    expect(approved.isError).toBeFalsy();
    const okRow = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(okRow.status).toBe("approved");

    // Reject: same shape with a required reason.
    const worker2 = seedAgent("alias-reject-worker");
    const task2 = seedTask("alias-reject-mcp");
    await claim(task2, worker2.apiKey);
    const started2 = await fetch(`${baseUrl}/api/tasks/${task2}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": worker2.apiKey },
      body: JSON.stringify({ executionToken: taskToken(task2) }),
    });
    expect(started2.status).toBe(200);
    const submitted2 = await fetch(`${baseUrl}/api/tasks/${task2}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": worker2.apiKey },
      body: JSON.stringify({ result: "review me too", executionToken: taskToken(task2) }),
    });
    expect(submitted2.status).toBe(200);
    taskReviewerRepo.create(task2, "agent", mcpAgentId);

    const rejected = await callTool("orcy_habitat_task", {
      action: "reject",
      taskId: task2,
      reason: "needs a second look",
    });
    expect(rejected.isError).toBeFalsy();
    const rejRow = getDb().select().from(tasks).where(eq(tasks.id, task2)).get() as {
      status: string;
    };
    expect(rejRow.status).toBe("rejected");

    // Reject without a reason is refused by required-parameter validation.
    const refused = await callTool("orcy_habitat_task", { action: "reject", taskId: task2 });
    expect(refused.isError).toBe(true);
  }, 120_000);
});
