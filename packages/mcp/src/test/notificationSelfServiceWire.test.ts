/**
 * REC-07 family 1 — real stdio MCP wire test for agent notification
 * self-service.
 *
 * Boots the REAL compiled API server (`node packages/api/dist/index.js`) on a
 * free port with a disposable file DB, bootstraps a habitat, two agents, a
 * required habitat-default subscription, and agent-recipient deliveries
 * through the REAL enqueue path (agent A sends mail to agent B via
 * POST /api/agents/:id/messages), then connects a real MCP client
 * (StdioClientTransport spawning `packages/mcp/dist/index.js`) authenticated
 * as agent B and exercises all 7 `orcy_notification` actions.
 *
 * Also asserts the wire-level event projection: agents see the canonical row
 * fields (eventType/severity/title/body — the rendered fan-out content) but
 * never the raw `agent.message_received` payload (fromAgentName, subject,
 * messageId, ...), `createdBy*`, or `historySummary`.
 *
 * Order-independent: every test fetches its own delivery ids via get_inbox.
 * Cost note: beforeAll builds shared/daemon/api/mcp once (tsc) — this file is
 * the only package-building test in @orcy/mcp; builds are not repeated
 * per-test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_PKG = join(import.meta.dirname, "..", "..");
const API_DIST = join(MCP_PKG, "..", "api", "dist", "index.js");
const MCP_DIST = join(MCP_PKG, "dist", "index.js");
const JWT_SECRET = "wire-test-jwt-secret-0123456789abcdef0123456789abcdef";
const REG_TOKEN = "wire-test-registration-token";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve((addr as { port: number }).port));
    });
  });
}

let apiChild: ChildProcessWithoutNullStreams;
let apiPort: number;
let dbDir: string;
let client: Client;
let transport: StdioClientTransport;
let habitatId: string;
let agentBKey: string;

async function api(
  method: string,
  path: string,
  options?: { token?: string; agentKey?: string; regToken?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options?.token) headers.authorization = `Bearer ${options.token}`;
  if (options?.agentKey) headers["x-agent-api-key"] = options.agentKey;
  if (options?.regToken) headers["x-registration-token"] = options.regToken;
  const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers,
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function callNotification(args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "orcy_notification",
    arguments: { action: args.action, habitatId, ...args },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  )!.text;
  return JSON.parse(text);
}

/** Order-independent: every test fetches its own delivery ids fresh. */
async function ownDeliveryIds(): Promise<string[]> {
  const body = await callNotification({ action: "get_inbox" });
  return body.deliveries.map((d: { id: string }) => d.id);
}

beforeAll(async () => {
  execSync(
    "corepack pnpm --filter @orcy/shared --filter @orcy/daemon --filter @orcy/api --filter @orcy/mcp build",
    {
      cwd: MCP_PKG,
      stdio: "pipe",
    },
  );

  apiPort = await getFreePort();
  dbDir = await mkdtemp(join(tmpdir(), "orcy-notif-wire-"));

  apiChild = spawn(process.execPath, [API_DIST], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      DB_PATH: join(dbDir, "wire.db"),
      PORT: String(apiPort),
      HOST: "127.0.0.1",
      JWT_SECRET,
      ORCY_REGISTRATION_TOKEN: REG_TOKEN,
      LOG_LEVEL: "error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  apiChild.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/health`);
      if (res.ok) ready = true;
    } catch {
      /* booting */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 400));
  }
  if (!ready) throw new Error(`compiled API never became healthy\n${stderr}`);

  // Bootstrap over the real HTTP surface.
  const reg = await api("POST", "/api/auth/register", {
    body: { username: "wire-admin", password: "wire-test-pass-123", displayName: "Wire Admin" },
  });
  expect(reg.status).toBeLessThan(300);
  const adminToken: string = reg.json.token;

  const habitat = await api("POST", "/api/habitats", {
    token: adminToken,
    body: { name: "Wire Habitat", defaultColumns: true },
  });
  expect(habitat.status).toBeGreaterThanOrEqual(200);
  expect(habitat.status).toBeLessThan(300);
  habitatId = habitat.json.habitat.id;

  const register = (n: string) =>
    api("POST", "/api/agents", {
      body: { name: n, type: "opencode", domain: "fullstack", capabilities: ["typescript"] },
      regToken: REG_TOKEN,
    });
  const agentA = await register("wire-agent-a");
  const agentB = await register("wire-agent-b");
  expect(agentA.status).toBeLessThan(300);
  expect(agentB.status).toBeLessThan(300);
  const agentAId: string = agentA.json.agent.id;
  agentBKey = agentB.json.apiKey;

  // Required habitat default so explicit recipients resolve to deliveries.
  const subs = await api("POST", `/api/habitats/${habitatId}/notifications/admin/subscriptions`, {
    token: adminToken,
    body: {
      habitatId,
      scope: "habitat_default",
      eventType: "agent.message_received",
      required: true,
      channels: ["in_app"],
    },
  });
  expect(subs.status).toBeLessThan(300);

  // Three deliveries for agent B through the real enqueue path.
  for (let i = 0; i < 3; i++) {
    const mail = await api("POST", `/api/agents/${agentAId}/messages`, {
      agentKey: agentA.json.apiKey,
      body: {
        habitatId,
        toAgentId: agentB.json.agent.id,
        subject: `wire mail ${i}`,
        body: `secret mail body ${i}`,
        priority: "normal",
      },
    });
    expect(mail.status).toBe(201);
  }

  // Real MCP client over stdio, authenticated as agent B.
  client = new Client({ name: "wire-test-client", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_DIST],
    env: {
      ...process.env,
      ORCY_API_URL: `http://127.0.0.1:${apiPort}`,
      ORCY_API_KEY: agentBKey,
    },
  });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  apiChild?.kill("SIGTERM");
  await rm(dbDir, { recursive: true, force: true }).catch(() => {});
});

describe("orcy_notification over the real stdio MCP wire (agent principal)", () => {
  it("get_inbox lists the agent's own deliveries", async () => {
    const body = await callNotification({ action: "get_inbox" });
    expect(body.total).toBe(3);
    expect(body.deliveries).toHaveLength(3);
    for (const d of body.deliveries) {
      expect(d.recipientType).toBe("agent");
    }
  });

  it("get_history returns the agent's own history", async () => {
    const body = await callNotification({ action: "get_history" });
    expect(body.total).toBe(3);
  });

  it("get_delivery returns own delivery with a MEANINGFUL projected event (canonical row fields; no raw payload leak)", async () => {
    const deliveryId = (await ownDeliveryIds())[0];
    const body = await callNotification({ action: "get_delivery", deliveryId });
    expect(body.delivery.id).toBe(deliveryId);
    // Canonical row fields — the rendered fan-out content, meaningful for an
    // agent triaging its inbox. agent.message_received renders
    //   title: `Agent mail from <fromAgentName>: <subject>`
    //   body:  `<fromAgentName> sent: <subject>`
    // at enqueue time (notificationTemplateService.ts); severity info for
    // normal-priority mail.
    expect(body.event.eventType).toBe("agent.message_received");
    expect(body.event.severity).toBe("info");
    // Inbox is newest-first; the fetched delivery is one of "wire mail 0..2".
    expect(body.event.title).toMatch(/^Agent mail from wire-agent-a: wire mail [0-2]$/);
    expect(body.event.body).toMatch(/^wire-agent-a sent: wire mail [0-2]$/);
    // title/body of THIS delivery are consistent with each other
    expect(body.event.title.endsWith(body.event.body.replace(/^wire-agent-a sent: /, ""))).toBe(
      true,
    );
    // The stored payload carries only non-allowlisted keys
    // (fromAgentName, subject, messageId, ...) — none may leak.
    for (const banned of [
      "payload",
      "createdByType",
      "createdById",
      "historySummary",
      "subject",
      "fromAgentName",
      "fromAgentId",
      "messageId",
      "secret",
    ]) {
      expect(body.event).not.toHaveProperty(banned);
    }
  });

  it("get_subscriptions returns overrides and habitat defaults", async () => {
    const body = await callNotification({ action: "get_subscriptions" });
    expect(body.overrides).toEqual([]);
    expect(body.defaults).toHaveLength(1);
    expect(body.defaults[0].eventType).toBe("agent.message_received");
  });

  it("snooze defers an own delivery", async () => {
    const deliveryId = (await ownDeliveryIds())[0];
    const body = await callNotification({
      action: "snooze",
      deliveryId,
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    expect(body.status).toBe("snoozed");
  });

  it("ack acknowledges an own delivery", async () => {
    const deliveryId = (await ownDeliveryIds())[0];
    const body = await callNotification({ action: "ack", deliveryId });
    expect(body.status).toBe("acknowledged");
  });

  it("clear removes an own delivery from the active path", async () => {
    const deliveryId = (await ownDeliveryIds())[0];
    const body = await callNotification({ action: "clear", deliveryId });
    expect(body.status).toBe("cleared");
  });
});
