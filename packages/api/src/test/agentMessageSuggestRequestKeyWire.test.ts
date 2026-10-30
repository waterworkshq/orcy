/**
 * Served MCP wire → real API routes — habitatId request keys (issue #138).
 *
 * Drives the SERVED dispatch handlers (`orcy_habitat_message` action=send,
 * `orcy_suggest` action=suggest-next-task) through the REAL KanbanApiClient
 * and the REAL `createApiClient` transport; the network hop alone is bridged
 * into `createHttpApplication` via `app.inject` (no listening socket, no
 * external network — same discipline as the issue's verification evidence).
 * Authentication is the real agent middleware over a real seeded
 * X-Agent-API-Key; persistence is asserted against the real DB.
 *
 *   - send with the documented `habitatId` argument → route accepts, message
 *     row persisted for the recipient, emitted JSON body carries `habitatId`
 *     and NOT the legacy `boardId`;
 *   - send with the accepted legacy `boardId` input alias → still succeeds,
 *     normalized to the canonical outgoing `habitatId` key;
 *   - suggest-next-task → query string carries `habitatId=`, NOT `boardId=`;
 *     the legitimate empty-suggestions habitat returns HTTP 200 with `[]`,
 *     and a seeded pending task yields a non-empty array.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { agentMessages } from "../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { resetConfig } from "@orcy/shared";

/**
 * The mcp modules are loaded by RUNTIME-COMPUTED dynamic import on purpose:
 * a static import would pull packages/mcp sources into the api tsc program,
 * tripping the package's rootDir fence (TS6059) — @orcy/api deliberately does
 * not depend on @orcy/mcp. The specifier is unresolvable at compile time, so
 * the program stays clean, while vitest still loads and transforms the REAL
 * served modules at runtime.
 */
const mcpModule = async <T = any>(rel: string): Promise<T> =>
  (await import(
    /* @vite-ignore */ pathToFileURL(join(import.meta.dirname, "..", "..", "..", "mcp", "src", rel)).href
  )) as T;

/** Shape of the served dispatch tool handlers (`createDispatchHandler` return). */
type DispatchHandler = (
  client: any,
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const INJECT_ORIGIN = "http://orcy-inject.test";

let app: HttpRuntimeHandle;
let client: Record<string, any>;
let messageDispatch: DispatchHandler;
let suggestDispatch: DispatchHandler;
let senderAgent: { id: string; apiKey: string };
let recipientAgent: { id: string; apiKey: string };
let habitatId: string;
let columnId: string;

const realFetch = globalThis.fetch;
/** Wire log of every request the real client transport produced. */
const wire: Array<{ method: string; url: string; headers: Record<string, string>; payload?: string }> = [];

function parseToolResult<T = any>(result: { content: Array<{ type: string; text: string }>; isError?: boolean }): T {
  expect(result.isError, `dispatch returned an error result: ${result.content[0]?.text}`).toBeFalsy();
  return JSON.parse(result.content[0].text) as T;
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

function seedPendingTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" }).id;
}

function recipientRow(recipientId: string) {
  return getDb()
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.toAgentId, recipientId), eq(agentMessages.subject, "Wire contract check")))
    .get();
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();

  senderAgent = seedAgent("wire-key-sender");
  recipientAgent = seedAgent("wire-key-recipient");

  // The real client reads its identity from the orcy config; pin it to the
  // seeded sender BEFORE the first config access and drop any cache.
  process.env.ORCY_API_URL = INJECT_ORIGIN;
  process.env.ORCY_AGENT_ID = senderAgent.id;
  process.env.ORCY_API_KEY = senderAgent.apiKey;
  resetConfig();

  // Bridge the single network hop into app.inject. Everything above the
  // socket — dispatch, client, transport serialization, headers — is real.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url: string = typeof input === "string" ? input : (input.url as string) ?? String(input);
    const method: string = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers as any).forEach((value, key) => {
      headers[key] = value;
    });
    const payload = typeof init?.body === "string" ? init.body : undefined;
    const { pathname, search } = new URL(url);
    const requestUrl = `${pathname}${search}`;
    const res = await app.inject({ method: method as any, url: requestUrl, headers, payload });
    wire.push({ method, url: requestUrl, headers, payload });
    return new Response(res.payload, {
      status: res.statusCode,
      statusText: res.statusMessage,
      headers: res.headers as Record<string, string>,
    });
  }) as typeof fetch;

  const { KanbanApiClient: KanbanApiClientCtor } = await mcpModule("api.ts");
  const { MESSAGE_DISPATCH_HANDLER } = await mcpModule("tools/message-dispatch.ts");
  const { SUGGEST_DISPATCH_HANDLER } = await mcpModule("tools/suggest-dispatch.ts");
  messageDispatch = MESSAGE_DISPATCH_HANDLER;
  suggestDispatch = SUGGEST_DISPATCH_HANDLER;
  client = new KanbanApiClientCtor(INJECT_ORIGIN);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDb();
});

beforeEach(() => {
  wire.length = 0;
  const habitat = habitatRepo.createHabitat({ name: "Wire Key Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

describe("served MCP wire → API routes — habitatId request keys", () => {
  it("orcy_habitat_message send: documented habitatId argument reaches the route, message persisted", async () => {
    const result = await messageDispatch(client, {
      action: "send",
      habitatId,
      toAgentId: recipientAgent.id,
      subject: "Wire contract check",
      body: "Message body",
      messageType: "info",
      priority: "normal",
    });
    const body = parseToolResult<{ message: { id: string } }>(result);
    expect(body.message.id).toBeTruthy();

    // The real route persisted the recipient's row.
    const row = recipientRow(recipientAgent.id);
    expect(row, "recipient message row must be persisted by the real route").toBeTruthy();
    expect(row!.fromAgentId).toBe(senderAgent.id);
    expect(row!.habitatId).toBe(habitatId);
    expect(row!.body).toBe("Message body");

    // Wire discipline: real auth header, canonical habitatId body key, no legacy boardId.
    const sent = wire.find((r) => r.method === "POST" && r.url.startsWith("/api/agents/"));
    expect(sent, "the real client transport must have produced the POST").toBeTruthy();
    expect(sent!.headers["x-agent-api-key"]).toBe(senderAgent.apiKey);
    const emitted = JSON.parse(sent!.payload!);
    expect(emitted.habitatId).toBe(habitatId);
    expect(Object.hasOwn(emitted, "boardId"), "outgoing body must not carry the legacy boardId key").toBe(false);
  }, 60_000);

  it("orcy_habitat_message send: accepted legacy boardId input alias normalizes to outgoing habitatId", async () => {
    const result = await messageDispatch(client, {
      action: "send",
      boardId: habitatId,
      toAgentId: recipientAgent.id,
      subject: "Wire contract check",
      body: "Legacy alias body",
    });
    const body = parseToolResult<{ message: { id: string } }>(result);
    expect(body.message.id).toBeTruthy();
    expect(recipientRow(recipientAgent.id)).toBeTruthy();

    const sent = wire.find((r) => r.method === "POST" && r.url.startsWith("/api/agents/"));
    expect(sent).toBeTruthy();
    const emitted = JSON.parse(sent!.payload!);
    expect(emitted.habitatId).toBe(habitatId);
    expect(Object.hasOwn(emitted, "boardId")).toBe(false);
  }, 60_000);

  it("orcy_suggest suggest-next-task: habitatId query key, empty case and seeded case both succeed", async () => {
    // Legitimate empty case: a habitat with no tasks returns HTTP 200 + [].
    const emptyResult = await suggestDispatch(client, {
      action: "suggest-next-task",
      habitatId,
      limit: 3,
    });
    const emptyBody = parseToolResult<{ suggestions: unknown[] }>(emptyResult);
    expect(emptyBody.suggestions).toEqual([]);

    // Seeded case: a pending task yields a non-empty suggestion array.
    const taskId = seedPendingTask("suggestible");
    const seededResult = await suggestDispatch(client, {
      action: "suggest-next-task",
      habitatId,
      limit: 3,
    });
    const seededBody = parseToolResult<{ suggestions: Array<{ taskId: string }> }>(seededResult);
    expect(seededBody.suggestions.length).toBeGreaterThan(0);
    expect(seededBody.suggestions.some((s) => s.taskId === taskId)).toBe(true);

    // Wire discipline: canonical habitatId query parameter, no boardId.
    const queries = wire.filter((r) => r.url.startsWith("/api/agents/") && r.url.includes("/suggestions"));
    expect(queries.length).toBe(2);
    for (const q of queries) {
      expect(q.url.includes(`habitatId=${encodeURIComponent(habitatId)}`)).toBe(true);
      expect(q.url.includes("boardId="), "outgoing query must not carry the legacy boardId key").toBe(false);
    }
  }, 60_000);
});
