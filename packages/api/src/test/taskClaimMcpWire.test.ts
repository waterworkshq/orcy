/**
 * Local MCP Task claim — served MCP wire.
 *
 * Same harness shape as epochMutationGuardMcpWire.test.ts: the REAL MCP
 * server (`packages/mcp/src/index.ts`) as a child process over stdio, the
 * REAL HTTP client, the authenticated claim route on the REAL API listening
 * on a TCP socket, and the sql.js DB holding the persisted state. No mocks.
 *
 *   - claim through the served dispatch tool returns the documented receipt;
 *     the state commits once and the receipt token is the current epoch
 *   - a refused claim (other agent, capability, domain, missing task) keeps
 *     its typed failure and never returns a receipt or moves ownership
 *   - a failed optional display-name lookup after the commit (a forwarder
 *     answers that one read with 503) still returns the receipt with the token
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks, taskEvents } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

let app: HttpRuntimeHandle;
let baseUrl: string;
let habitatId: string;
let columnId: string;
/** The agent whose claims are under test; its MCP server talks to the API directly. */
let claimant: { id: string; apiKey: string };
let claimantMcp: McpServer;
/** A second agent's MCP server (domain `backend`). It reaches the API through
 * the lookup-fault proxy. */
let rivalMcp: McpServer;
let proxy: Awaited<ReturnType<typeof startLookupFaultProxy>>;

// ---- Minimal MCP client over stdio (newline-delimited JSON-RPC) ------------
// The @modelcontextprotocol SDK is a dependency of @orcy/mcp, not @orcy/api;
// rather than add one, speak the served protocol directly — the server under
// test is the REAL served server, the frames are the real wire format.
interface McpServer {
  child: ChildProcess;
  callTool(args: Record<string, unknown>): Promise<any>;
}

async function connectMcp(url: string, agent: { id: string; apiKey: string }): Promise<McpServer> {
  const child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: url,
      ORCY_AGENT_ID: agent.id,
      ORCY_API_KEY: agent.apiKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rpcId = 0;
  let buffer = "";
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (obj: unknown): void => {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  };
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
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

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "task-claim-wire-test", version: "1.0.0" },
    });
    expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  } catch (err) {
    child.kill("SIGTERM");
    throw err;
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    child,
    callTool: (args) => request("tools/call", { name: "orcy_habitat_task", arguments: args }),
  };
}

/** Forwards every request to the served API; while `armed`, agent lookups
 * (`GET /api/agents/:id` — the claim's optional display-name read) answer 503. */
async function startLookupFaultProxy(): Promise<{
  url: string;
  armed: boolean;
  lookupStatus: number;
  lookups: number;
  starts: number;
  close: () => Promise<void>;
}> {
  const { hostname, port } = new URL(baseUrl);
  const proxy: { url: string; armed: boolean; lookupStatus: number; lookups: number; starts: number; close: () => Promise<void> } = {
    url: "",
    armed: false,
    lookupStatus: 503,
    lookups: 0,
    starts: 0,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && /^\/api\/tasks\/[^/]+\/start$/.test(req.url ?? "")) proxy.starts++;
    if (req.method === "GET" && /^\/api\/agents\/[^/]+$/.test(req.url ?? "")) proxy.lookups++;
    if (proxy.armed && req.method === "GET" && /^\/api\/agents\/[^/]+$/.test(req.url ?? "")) {
      req.resume();
      res.writeHead(proxy.lookupStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Agent lookup unavailable" }));
      return;
    }
    const upstream = http.request(
      { hostname, port: Number(port), method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  proxy.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  proxy.close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return proxy;
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

function seedAgent(name: string, domain = "fullstack"): { id: string; apiKey: string } {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain,
    capabilities: ["typescript"],
  });
  return { id: created.agent.id, apiKey: created.plainApiKey };
}

function seedTask(
  title: string,
  requiredCapabilities: string[] = [],
  requiredDomain: string | null = null,
): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "user-1",
    requiredDomain,
    requiredCapabilities,
  }).id;
}

function taskRow(taskId: string) {
  return getDb()
    .select({
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      executionToken: tasks.executionToken,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()!;
}

function claimedEventCount(taskId: string): number {
  return getDb()
    .select({ action: taskEvents.action })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((event) => event.action === "claimed").length;
}

function toolJson(result: any): any {
  return JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  claimant = seedAgent("claim-mcp-agent");
  claimantMcp = await connectMcp(baseUrl, claimant);
  proxy = await startLookupFaultProxy();
  rivalMcp = await connectMcp(proxy.url, seedAgent("claim-mcp-rival", "backend"));
}, 120_000);

// Tolerates a `beforeAll` that failed partway: only initialized resources are torn down.
afterAll(async () => {
  claimantMcp?.child.kill("SIGTERM");
  rivalMcp?.child.kill("SIGTERM");
  await proxy?.close();
  await app?.close();
  closeDb();
});

beforeEach(() => {
  const habitat = habitatRepo.createHabitat({ name: "Task Claim MCP Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

describe("local MCP rework receipt — served MCP wire", () => {
  it.each(["start", "update"])("%s preserves successful and missing display names", async (action) => {
    for (const lookupStatus of [200, 404]) {
      const taskId = seedTask(`rework-name-${action}-${lookupStatus}`);
      const oldToken: string = toolJson(await rivalMcp.callTool({ action: "claim", taskId })).task.executionToken;
      getDb().update(tasks).set({ status: "rejected" }).where(eq(tasks.id, taskId)).run();
      proxy.lookupStatus = lookupStatus;
      proxy.armed = lookupStatus === 404;
      try {
        const result = await rivalMcp.callTool({ action, taskId, status: "in_progress", executionToken: oldToken });
        expect(result.isError).toBeFalsy();
        expect(toolJson(result)).toMatchObject({ success: true, task: {
          status: "in_progress", assignedAgentName: lookupStatus === 200 ? "claim-mcp-rival" : null,
        } });
      } finally {
        proxy.armed = false;
        proxy.lookupStatus = 503;
      }
    }
  }, 60_000);

  it.each(["start", "update"])("%s returns the rotated receipt when name lookup fails", async (action) => {
    const taskId = seedTask(`rework-${action}`);
    const claimed = toolJson(await rivalMcp.callTool({ action: "claim", taskId }));
    const oldToken: string = claimed.task.executionToken;
    // Synthetic rejected state retains the actual claimed epoch and assignee;
    // the rework, fencing and subsequent submission use the real served routes.
    getDb().update(tasks).set({ status: "rejected" }).where(eq(tasks.id, taskId)).run();
    const args = { action, taskId, status: "in_progress", executionToken: oldToken };
    const before = { ...taskRow(taskId) };
    const lookups = proxy.lookups;
    const starts = proxy.starts;
    proxy.armed = true;
    try {
      const refused = await rivalMcp.callTool({ ...args, executionToken: "stale-token" });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("EPOCH_MISMATCH");
      expect(taskRow(taskId)).toEqual(before);
      expect(proxy.lookups).toBe(lookups);
      const result = await rivalMcp.callTool(args);
      expect(result.isError).toBeFalsy();
      const receipt = toolJson(result);
      expect(receipt).toMatchObject({ success: true, task: { id: taskId, status: "in_progress", assignedAgentName: null } });
      const currentToken: string = receipt.task.executionToken;
      expect(currentToken).toBeTruthy();
      expect(currentToken).not.toBe(oldToken);
      expect(taskRow(taskId)).toMatchObject({ status: "in_progress", executionToken: currentToken });
      expect(proxy.starts - starts).toBe(2); // one refused, one successful, no replay
      expect(proxy.lookups - lookups).toBeGreaterThan(0);
      const staleSubmit = await rivalMcp.callTool({ action: "submit", taskId, result: "done", executionToken: oldToken });
      expect(staleSubmit.isError).toBe(true);
      expect(staleSubmit.content[0].text).toContain("EPOCH_MISMATCH");
      const submitted = await rivalMcp.callTool({ action: "submit", taskId, result: "done", executionToken: currentToken });
      expect(submitted.isError).toBeFalsy();
      expect(taskRow(taskId).status).toBe("submitted");
    } finally {
      proxy.armed = false;
    }
  }, 60_000);
});

describe("local MCP Task claim — served MCP wire", () => {
  it("claim returns the documented receipt; the state commits once and the receipt token is the current epoch", async () => {
    const taskId = seedTask("claim-mcp", ["typescript"]);

    const result = await claimantMcp.callTool({ action: "claim", taskId });
    expect(result.isError).toBeFalsy();
    const receipt = toolJson(result);
    expect(receipt).toMatchObject({
      success: true,
      task: {
        id: taskId,
        status: "claimed",
        assignedAgentId: claimant.id,
        assignedAgentName: "claim-mcp-agent",
      },
    });
    const token: string = receipt.task.executionToken;
    expect(token).toBeTruthy();

    expect(taskRow(taskId)).toEqual({
      status: "claimed",
      assignedAgentId: claimant.id,
      executionToken: token,
    });
    expect(claimedEventCount(taskId)).toBe(1);

    // The receipt token is the authorized current epoch: it starts the task.
    const started = await claimantMcp.callTool({ action: "start", taskId, executionToken: token });
    expect(started.isError).toBeFalsy();
    expect(taskRow(taskId).status).toBe("in_progress");
  }, 60_000);

  it("a refused claim keeps its typed failure and never returns a receipt or moves ownership", async () => {
    const taskId = seedTask("claim-mcp-conflict", ["typescript"]);
    const token: string = toolJson(
      await claimantMcp.callTool({ action: "claim", taskId }),
    ).task.executionToken;

    // Another agent, same served route: a conflict, not a receipt.
    const rival = await rivalMcp.callTool({ action: "claim", taskId });
    expect(rival.isError).toBeFalsy();
    expect(toolJson(rival)).toMatchObject({ success: false, reason: "already_claimed" });

    // The holder's own repeat claim: the same conflict.
    const again = await claimantMcp.callTool({ action: "claim", taskId });
    expect(again.isError).toBeFalsy();
    expect(toolJson(again)).toMatchObject({ success: false, reason: "already_claimed" });

    expect(taskRow(taskId)).toEqual({
      status: "claimed",
      assignedAgentId: claimant.id,
      executionToken: token,
    });
    expect(claimedEventCount(taskId)).toBe(1);
  }, 60_000);

  it("a capability refusal is typed with the missing capabilities and leaves the task untouched", async () => {
    const taskId = seedTask("claim-mcp-capability", ["postgresql"]);

    const result = await claimantMcp.callTool({ action: "claim", taskId });
    expect(result.isError).toBeFalsy();
    expect(toolJson(result)).toEqual({
      success: false,
      reason: "capability_mismatch",
      message: "Missing capabilities: postgresql",
      missingCapabilities: ["postgresql"],
    });
    expect(taskRow(taskId)).toEqual({
      status: "pending",
      assignedAgentId: null,
      executionToken: null,
    });
    expect(claimedEventCount(taskId)).toBe(0);
  }, 60_000);

  it("a failed display-name lookup after the commit still returns the receipt with its token", async () => {
    const taskId = seedTask("claim-mcp-lookup-failure");
    proxy.armed = true;
    try {
      const result = await rivalMcp.callTool({ action: "claim", taskId });
      expect(result.isError).toBeFalsy();
      const receipt = toolJson(result);
      expect(receipt).toMatchObject({
        success: true,
        task: { id: taskId, status: "claimed", assignedAgentName: null },
      });
      const token: string = receipt.task.executionToken;
      expect(token).toBeTruthy();
      expect(taskRow(taskId)).toMatchObject({ status: "claimed", executionToken: token });
      expect(claimedEventCount(taskId)).toBe(1);
    } finally {
      proxy.armed = false;
    }
  }, 60_000);

  it("a domain refusal is typed as domain_mismatch and leaves the task untouched", async () => {
    // Control: the backend agent claims within its domain.
    const inDomainTaskId = seedTask("claim-mcp-domain-in-domain", [], "backend");
    const inDomain = await rivalMcp.callTool({ action: "claim", taskId: inDomainTaskId });
    expect(toolJson(inDomain)).toMatchObject({
      success: true,
      task: { id: inDomainTaskId, status: "claimed" },
    });

    const taskId = seedTask("claim-mcp-domain", [], "frontend");
    const refused = await rivalMcp.callTool({ action: "claim", taskId });
    expect(refused.isError).toBeFalsy();
    const failure = toolJson(refused);
    expect(failure).toMatchObject({ success: false, reason: "domain_mismatch" });
    expect(failure).not.toHaveProperty("task");
    expect(taskRow(taskId)).toEqual({
      status: "pending",
      assignedAgentId: null,
      executionToken: null,
    });
    expect(claimedEventCount(taskId)).toBe(0);

    // Control: the refusal was the domain gate — a matching agent claims the same task.
    const matching = await claimantMcp.callTool({ action: "claim", taskId });
    expect(toolJson(matching)).toMatchObject({
      success: true,
      task: { id: taskId, status: "claimed", assignedAgentId: claimant.id },
    });
    expect(claimedEventCount(taskId)).toBe(1);
  }, 60_000);

  it("a missing task is typed as not_found and leaves the caller's own claim untouched", async () => {
    const taskId = seedTask("claim-mcp-not-found-control", ["typescript"]);
    const token: string = toolJson(await claimantMcp.callTool({ action: "claim", taskId }))
      .task.executionToken;

    const result = await claimantMcp.callTool({ action: "claim", taskId: randomUUID() });
    expect(result.isError).toBeFalsy();
    const failure = toolJson(result);
    expect(failure).toMatchObject({ success: false, reason: "not_found" });
    expect(failure).not.toHaveProperty("task");

    // Control: the caller's existing claim keeps its ownership, token and single event.
    expect(taskRow(taskId)).toEqual({
      status: "claimed",
      assignedAgentId: claimant.id,
      executionToken: token,
    });
    expect(claimedEventCount(taskId)).toBe(1);
  }, 60_000);

  it("a task ID that would retarget the claim request is refused without changing the task", async () => {
    const taskId = seedTask("claim-mcp-retarget", ["typescript"]);
    await claimantMcp.callTool({ action: "claim", taskId });
    // A legacy token-less claim is the observable target: `start` accepts an
    // omitted token on it, so a retargeted POST /tasks/:id/start would land.
    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, taskId)).run();

    const retargeted = await claimantMcp.callTool({
      action: "claim",
      taskId: `${taskId}/start?`,
    });
    expect(retargeted.isError).toBeFalsy();
    const failure = toolJson(retargeted);
    expect(failure).toMatchObject({ success: false, reason: "not_found" });
    expect(failure).not.toHaveProperty("task");
    expect(taskRow(taskId)).toEqual({
      status: "claimed",
      assignedAgentId: claimant.id,
      executionToken: null,
    });
    expect(claimedEventCount(taskId)).toBe(1);
  }, 60_000);
});
