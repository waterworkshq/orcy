/**
 * REC-10 rework continuation — served MCP wire (real JSON-RPC over stdio
 * against the REAL API on a TCP socket; no mocks).
 *
 *   - rework start on a rejected task through the served dispatch tool with
 *     the continuation token X: succeeds; the RESULT task carries the fresh
 *     rework token Y (capture discipline: Y comes from YOUR start response);
 *   - a process still presenting prompt-X after the mint is correctly fenced
 *     (submit with X → 409 EPOCH_MISMATCH — desired fencing, not a defect);
 *   - the same tool call with Y lands (the rework wire completes).
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
import * as pluginManager from "../plugins/pluginManager.js";
import * as taskService from "../services/tasks/index.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let habitatId: string;
let columnId: string;
let mcpAgentId: string;
let mcpAgentKey: string;

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

function callTool(args: Record<string, unknown>) {
  return request("tools/call", { name: "orcy_habitat_task", arguments: args });
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

async function httpPost(path: string, apiKey: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: JSON.stringify(body),
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
    name: "rework-mcp-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  mcpAgentId = agent.agent.id;
  mcpAgentKey = agent.plainApiKey;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: mcpAgentId,
      ORCY_API_KEY: mcpAgentKey,
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
    clientInfo: { name: "rework-mcp-wire-test", version: "1.0.0" },
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
  const habitat = habitatRepo.createHabitat({ name: "Rework MCP Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

describe("rework continuation — served MCP wire", () => {
  it("rework start on rejected via real JSON-RPC: response carries Y; prompt-X mutations after the mint 409 (desired); Y completes the wire", async () => {
    const taskId = seedTask("rework-mcp");

    // Claim + start + submit over the real HTTP wire as the MCP agent.
    const claimRes = await httpPost(`/api/tasks/${taskId}/claim`, mcpAgentKey, {});
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as { task: { executionToken: string } };
    const X = claimBody.task.executionToken;
    expect(X).toBeTruthy();

    const startRes = await httpPost(`/api/tasks/${taskId}/start`, mcpAgentKey, {
      executionToken: X,
    });
    expect(startRes.status).toBe(200);
    const submitRes = await httpPost(`/api/tasks/${taskId}/submit`, mcpAgentKey, {
      result: "round-1",
      artifacts: [],
      executionToken: X,
    });
    expect(submitRes.status).toBe(200);

    // Reject by a human reviewer (real service path, same process).
    const rejected = taskService.rejectTask(taskId, "human-mcp", "mcp rework", "human");
    expect(rejected).not.toBeNull();
    expect(taskToken(taskId)).toBe(X); // preserved continuation token

    // MCP rework start with X — the response task carries the FRESH Y.
    const reworkStart = await callTool({ action: "start", taskId, executionToken: X });
    expect(reworkStart.isError).toBeFalsy();
    const parsed = JSON.parse(
      (reworkStart.content as Array<{ type: string; text: string }>)[0]!.text,
    ) as { task?: { status?: string; executionToken?: string | null } };
    const taskOut =
      parsed.task ?? (parsed as unknown as { status?: string; executionToken?: string | null });
    expect(taskOut.status).toBe("in_progress");
    const Y = taskOut.executionToken;
    expect(Y).toBeTruthy();
    expect(Y).not.toBe(X);
    expect(taskToken(taskId)).toBe(Y);

    // A process still acting on prompt-X after the rework mint is correctly
    // fenced — desired fencing, not a defect.
    const fenced = await callTool({
      action: "submit",
      taskId,
      result: "stale prompt process",
      artifacts: [],
      executionToken: X,
    });
    expect(fenced.isError).toBe(true);
    const fencedText = (fenced.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(fencedText).toContain("EPOCH_MISMATCH");

    // The rework worker re-pins from ITS start response: submit with Y lands.
    const ok = await callTool({
      action: "submit",
      taskId,
      result: "round-2 under Y",
      artifacts: [],
      executionToken: Y,
    });
    expect(ok.isError).toBeFalsy();
    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
      status: string;
    };
    expect(row.status).toBe("submitted");
  }, 60_000);
});
