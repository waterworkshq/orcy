/**
 * Agent domain filter — SERVED MCP wire (agent domain-filter-contract ticket).
 *
 * Spawns the REAL MCP server (`packages/mcp/src/index.ts`) as a child process
 * over stdio, against the REAL API listening on a TCP socket, and drives
 * `tools/list` + `tools/call` through the served JSON-RPC wire. No mocks.
 *
 *   - tools/list: `orcy_habitat_agent` advertises exactly one canonical
 *     `domain` property (description covering register AND list), no
 *     never-consumed `domainFilter`; actions and `required: ['action']`
 *     unchanged.
 *   - tools/call list with `domain: 'backend'` against an API seeded with a
 *     backend and a frontend agent returns ONLY the backend agent.
 *   - tools/call list without a domain returns both.
 *   - tools/call register with `domain: 'frontend'` still sends that primary
 *     domain (the canonical param serves both actions).
 *   - failure path: an MCP child pointed at an unreachable API surfaces the
 *     connect failure through the wire and the bounded teardown reaps it —
 *     no dangling process even when setup partially fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

// Partial-setup state: every stage is optional so a failed beforeAll still
// tears down exactly what was created — no dangling child, server, or DB.
let app: HttpRuntimeHandle | undefined;
let baseUrl = "";
let child: ChildProcess | undefined;
let wire: ReturnType<typeof attachWireClient> | undefined;
let dbReady = false;
let mcpAgentKey: string;
let mcpAgentId: string;

// ---- Minimal MCP client over stdio (newline-delimited JSON-RPC) ------------
// Same harness shape as epochMutationGuardMcpWire.test.ts: the server under
// test is the REAL served server, the frames are the real wire format.
// Requests are bounded (they reject on timeout or child exit) so a dead or
// hung server can never leave an unresolved promise behind.
interface WireClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  dispose(): void;
}

function attachWireClient(proc: ChildProcess): WireClient {
  let rpcId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let buffer = "";

  const settleAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const onData = (chunk: Buffer): void => {
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
  };

  const onExit = (): void => {
    settleAll(new Error("MCP child exited before responding"));
  };

  proc.stdout!.on("data", onData);
  proc.on("exit", onExit);

  return {
    request(method, params, timeoutMs = 15_000) {
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        pending.set(id, {
          resolve: (v: any) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e: Error) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
          proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    notify(method, params) {
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    dispose() {
      proc.stdout!.removeListener("data", onData);
      proc.removeListener("exit", onExit);
      settleAll(new Error("wire client disposed"));
    },
  };
}

// Bounded kill/reap. Never throws, cleans up its own timers and listeners on
// every path, and reports honestly:
//   - "already-exited": the child was dead on entry (observed exit fields).
//   - "exited": a real `exit` event (or observed exit fields) was seen after
//     SIGTERM, escalating to SIGKILL after the grace window.
//   - "no-exit-observed": SIGKILL was sent (or kill refused) and STILL no
//     exit was observed within the bounded terminal wait — a cleanup failure,
//     reported as such, never fabricated as an exit.
// The exit listener is registered before any signal is sent, and the
// already-exited fields are re-checked after registration, so an exit that
// races the signal can never be missed.
interface ReapTarget {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

type ReapInfo =
  | { status: "already-exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "exited"; code: number | null; signal: NodeJS.Signals | null }
  | { status: "no-exit-observed"; lastSignal: "SIGKILL" };

function observedExit(
  proc: ReapTarget,
): { code: number | null; signal: NodeJS.Signals | null } | null {
  return proc.exitCode !== null || proc.signalCode !== null
    ? { code: proc.exitCode, signal: proc.signalCode }
    : null;
}

function raceExit(
  proc: ReapTarget,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timeout"> {
  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve("timeout");
    }, ms);
    proc.once("exit", onExit);
    // The exit may already have happened before the listener was attached —
    // check once after registering so the race cannot be lost.
    const already = observedExit(proc);
    if (already) {
      cleanup();
      resolve(already);
    }
  });
}

async function reapChild(proc: ReapTarget, graceMs = 3_000, killWaitMs = 5_000): Promise<ReapInfo> {
  const already = observedExit(proc);
  if (already) return { status: "already-exited", ...already };
  try {
    proc.kill("SIGTERM");
  } catch {
    // kill threw (spawn error / access denied) — observation decides below.
  }
  let observed = await raceExit(proc, graceMs);
  if (observed !== "timeout") return { status: "exited", ...observed };
  try {
    proc.kill("SIGKILL");
  } catch {
    // Same as above: bound the wait and report what is actually observed.
  }
  observed = await raceExit(proc, killWaitMs); // bounded terminal wait — never hangs
  return observed === "timeout"
    ? { status: "no-exit-observed", lastSignal: "SIGKILL" }
    : { status: "exited", ...observed };
}

// Per-stage guarded teardown: every stage runs even if an earlier one fails
// (so app/db cleanup always executes even when reaping fails); failures are
// aggregated and rethrown, never swallowed. vitest reports an afterAll
// failure alongside — not instead of — any test failure.
async function guardedTeardown(state: {
  wire?: WireClient;
  child?: ReapTarget;
  app?: HttpRuntimeHandle;
  dbReady?: boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    state.wire?.dispose();
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.child) {
      const info = await reapChild(state.child);
      if (info.status === "no-exit-observed") {
        failures.push(new Error("child did not exit after SIGKILL within the bounded wait"));
      }
    }
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.app) await state.app.close();
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.dbReady) closeDb();
  } catch (e) {
    failures.push(e);
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed");
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

async function callAgentTool(args: Record<string, unknown>): Promise<any> {
  const result = await wire!.request("tools/call", { name: "orcy_habitat_agent", arguments: args });
  expect(result?.isError, `orcy_habitat_agent errored: ${result?.content?.[0]?.text}`).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  await initTestDb();
  dbReady = true;
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  // MCP caller identity (fullstack — must never match the domain probes).
  const caller = agentRepo.createAgent({
    name: "domain-filter-wire-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  mcpAgentId = caller.agent.id;
  mcpAgentKey = caller.plainApiKey;

  // Seed the discriminating population: one backend, one frontend.
  agentRepo.createAgent({
    name: "df-backend-1",
    type: "claude-code",
    domain: "backend",
    capabilities: [],
  });
  agentRepo.createAgent({
    name: "df-frontend-1",
    type: "claude-code",
    domain: "frontend",
    capabilities: [],
  });

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
  wire = attachWireClient(child);

  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "domain-filter-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  wire.notify("notifications/initialized");
}, 120_000);

afterAll(async () => {
  // Guarded partial teardown: every stage runs even if earlier ones fail,
  // and only tears down what beforeAll actually created.
  await guardedTeardown({ wire, child, app, dbReady });
}, 30_000);

describe("agent domain filter — served MCP wire", () => {
  it("tools/list: one canonical `domain` covering register+list; no advertised `domainFilter`; actions/required unchanged", async () => {
    const list = await wire!.request("tools/list", {});
    const byName = new Map<any, any>((list.tools as any[]).map((t) => [t.name, t]));
    const tool = byName.get("orcy_habitat_agent");
    expect(tool, "orcy_habitat_agent must be served").toBeTruthy();
    const schema = tool!.inputSchema as {
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };
    const props = schema.properties!;
    expect(props.domain, "canonical `domain` must be advertised").toBeTruthy();
    expect(
      props.domainFilter,
      "never-consumed `domainFilter` must not be advertised",
    ).toBeUndefined();
    const domainDescription = props.domain.description ?? "";
    expect(
      domainDescription.includes("register") && domainDescription.includes("list"),
      `domain description must cover register AND list, got: "${domainDescription}"`,
    ).toBe(true);
    const actionEnum = (props.action as unknown as { enum?: string[] }).enum;
    expect(actionEnum).toEqual(["register", "list", "heartbeat", "get-stats"]);
    expect(schema.required).toEqual(["action"]);
  }, 60_000);

  it("tools/call list domain=backend → real API filter returns only the backend agent", async () => {
    const result = await callAgentTool({ action: "list", domain: "backend" });
    const names: string[] = result.agents.map((a: { name: string }) => a.name);
    expect(names).toContain("df-backend-1");
    expect(names).not.toContain("df-frontend-1");
    for (const agent of result.agents) {
      expect(agent.domain).toBe("backend");
    }
  }, 60_000);

  it("tools/call list without domain → both seeded agents returned", async () => {
    const result = await callAgentTool({ action: "list" });
    const names: string[] = result.agents.map((a: { name: string }) => a.name);
    expect(names).toContain("df-backend-1");
    expect(names).toContain("df-frontend-1");
  }, 60_000);

  it("tools/call register domain=frontend still sends the primary domain through the canonical param", async () => {
    const result = await callAgentTool({
      action: "register",
      name: "df-registered-1",
      type: "claude-code",
      domain: "frontend",
    });
    expect(result.success).toBe(true);
    const listed = await callAgentTool({ action: "list", domain: "frontend" });
    const names: string[] = listed.agents.map((a: { name: string }) => a.name);
    expect(names).toContain("df-registered-1");
    expect(names).not.toContain("df-backend-1");
  }, 60_000);

  it("failure path: unreachable API surfaces through the wire and the child is reaped, not dangled", async () => {
    // Pick a port and deliberately never listen on it: the MCP child boots
    // its stdio transport fine, but every tools/call hits ECONNREFUSED.
    const deadPort = await freePort();
    const failChild = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
      env: {
        ...process.env,
        ORCY_API_URL: `http://127.0.0.1:${deadPort}`,
        ORCY_AGENT_ID: mcpAgentId,
        ORCY_API_KEY: mcpAgentKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const failWire = attachWireClient(failChild);
    try {
      const init = await failWire.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "domain-filter-wire-test", version: "1.0.0" },
      });
      expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
      failWire.notify("notifications/initialized");

      const result = await failWire.request("tools/call", {
        name: "orcy_habitat_agent",
        arguments: { action: "list" },
      });
      expect(result?.isError, "unreachable API must surface as a tool error").toBe(true);

      // The injected failure must not have crashed the child — it is alive,
      // so this next assertion proves the reap path actually did the work.
      expect(failChild.exitCode, "child must still be alive pre-reap").toBeNull();
      expect(failChild.signalCode, "child must not be signalled pre-reap").toBeNull();
    } finally {
      failWire.dispose();
      const info = await reapChild(failChild);
      expect(info.status, `a real exit must be observed, got: ${JSON.stringify(info)}`).toBe(
        "exited",
      );
      expect(info.status === "exited" && info.code, "graceful SIGTERM exit").toBe(0);
    }
  }, 60_000);

  it("reap escalation: a child that ignores SIGTERM is really killed by SIGKILL and its exit observed", async () => {
    const stubborn = spawn(process.execPath, [
      "-e",
      "process.stdout.write('ready\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    ]);
    // Wait for the child to actually install its SIGTERM handler, so the
    // initial SIGTERM cannot race node startup and win by accident.
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("stubborn child never reported ready")),
        5_000,
      );
      stubborn.stdout!.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      stubborn.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("stubborn child exited before reporting ready"));
      });
    });
    await ready;
    expect(stubborn.exitCode, "child must be alive pre-reap").toBeNull();
    expect(stubborn.signalCode, "child must not be signalled pre-reap").toBeNull();
    const info = await reapChild(stubborn, 300, 3_000);
    expect(
      info.status,
      `escalation must end in an observed exit, got: ${JSON.stringify(info)}`,
    ).toBe("exited");
    if (info.status !== "exited") return;
    expect(info.signal, "SIGTERM was ignored, so SIGKILL must be the terminal signal").toBe(
      "SIGKILL",
    );
    expect(info.code, "SIGKILL exit carries a null code").toBeNull();
  }, 60_000);

  it("reap terminal wait is bounded: a kill-refusing, never-exiting target reports failure honestly instead of hanging", async () => {
    // Controlled no-exit stand-in: kill() "succeeds" but no exit event ever
    // fires — proves the post-SIGKILL wait is time-bounded WITHOUT spawning
    // a real unkillable process.
    const kills: (NodeJS.Signals | number)[] = [];
    const immortal: ReapTarget = {
      exitCode: null,
      signalCode: null,
      kill(signal) {
        kills.push(signal ?? "SIGTERM");
        return true;
      },
      once() {
        /* never emits exit */
      },
      removeListener() {
        /* nothing registered */
      },
    };
    const started = Date.now();
    const info = await reapChild(immortal, 100, 200);
    const elapsed = Date.now() - started;
    expect(elapsed, "terminal wait must be bounded (grace+killWait+slack)").toBeLessThan(2_000);
    expect(kills, "must escalate SIGTERM → SIGKILL").toEqual(["SIGTERM", "SIGKILL"]);
    expect(info.status, "no fabricated exit — reported as a cleanup failure").toBe(
      "no-exit-observed",
    );
  }, 60_000);

  it("partial setup: a failure before wire init still cleans up every acquired resource", async () => {
    // Mirror of a beforeAll that dies between spawning the child and
    // initialize(): db shared with the suite, app acquired and listening,
    // child alive, NO wire client. The guarded stages must reap the child,
    // close the app, and leave the shared DB open — resolving cleanly.
    const partialApp = await createHttpApplication({ logger: false });
    await partialApp.installPluginRoutes(pluginManager.getPluginRouteCatalog());
    await partialApp.finalize();
    const port = await freePort();
    await partialApp.listen({ port, host: "127.0.0.1" });
    const partialChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
    expect(partialChild.exitCode, "partial child must be alive").toBeNull();

    await expect(
      guardedTeardown({ child: partialChild, app: partialApp, dbReady: false }),
    ).resolves.toBeUndefined();
    expect(
      partialChild.exitCode !== null || partialChild.signalCode !== null,
      "partial child must have exited",
    ).toBe(true);
  }, 60_000);
});
