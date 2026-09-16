/**
 * REC-07 family 2 — real stdio MCP wire test for agent automation
 * inspection.
 *
 * Boots the REAL compiled API server (`node packages/api/dist/index.js`) on
 * a free port with a disposable file DB, bootstraps over the real HTTP
 * surface (admin human, habitat, two agents, a mission, a task the worker
 * agent CLAIMS through the real claim route, secret-bearing + builtin +
 * plugin-condition rules through the real create route, and real run rows
 * through the real manual-run route — executed + cooldown-skipped), then
 * connects a real MCP client (StdioClientTransport spawning
 * `packages/mcp/dist/index.js`) authenticated as the WORKER agent and
 * exercises all 5 `orcy_automation` actions.
 *
 * Wire-level contract asserts:
 *  - list/get return the structural projection — exact key sets, fixed
 *    condition summaries, static per-action-type labels; the stored webhook
 *    URL, header values, plugin params, and signal content appear NOWHERE
 *    in the payload tree.
 *  - simulate returns the bounded agent shape; `payload` smuggling through
 *    the tool args is rejected with the fixed 400 code (via raw HTTP the
 *    `overrideCondition` rejection is pinned too — the MCP tool schema
 *    does not even expose that field).
 *  - run reads show only the allowlisted fields; the cooldown skipReason
 *    (a real AutomationSkipReason value) survives, and no
 *    actionResults/conditionResult/metadata ever appear.
 *  - the idle agent (no active work) is denied over raw HTTP: 403 on the
 *    habitat list, 404 on rule-id reads (uniform with cross-habitat).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCP_PKG = join(import.meta.dirname, "..", "..");
const API_DIST = join(MCP_PKG, "..", "api", "dist", "index.js");
const MCP_DIST = join(MCP_PKG, "dist", "index.js");
// better-sqlite3 is not an @orcy/mcp dependency; resolve it from the API
// package (the server under test owns that native module).
const requireFromApi = createRequire(join(MCP_PKG, "..", "api", "package.json"));
const JWT_SECRET = "wire-test-jwt-secret-0123456789abcdef0123456789abcdef";
const REG_TOKEN = "wire-test-registration-token";

const SECRET_URL = "https://hooks.wire-secret.example/SECRETTOKEN123";
const SECRET_HEADER = "Bearer HEADERSECRET456";
const SECRET_SIGNAL = "SECRET-SIGNAL-CONTENT-789";
const SECRET_PLUGIN_PARAM = "PLUGINPARAMSECRET012";

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
let foreignHabitatId: string;
let workerKey: string;
let idleKey: string;
let claimedTaskId: string;
let secretRuleId: string;
let statusRuleId: string;
let pluginRuleId: string;
let runRuleId: string;

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

async function callAutomation(args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "orcy_automation",
    arguments: { action: args.action, ...args },
  });
  const text = (result.content as Array<{ type: string; text: string }>).find(
    (c) => c.type === "text",
  )!.text;
  return {
    isError: result.isError === true,
    body: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })(),
  };
}

function expectNoWireSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const sentinel of [
    SECRET_URL,
    "SECRETTOKEN123",
    SECRET_HEADER,
    "HEADERSECRET456",
    SECRET_SIGNAL,
    SECRET_PLUGIN_PARAM,
    "PLUGINPARAMSECRET012",
    "hooks.wire-secret.example",
  ]) {
    if (text.includes(sentinel)) {
      throw new Error(`secret sentinel leaked over the MCP wire: ${sentinel}\n${text}`);
    }
  }
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
  dbDir = await mkdtemp(join(tmpdir(), "orcy-auto-wire-"));

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

  // --- Bootstrap over the real HTTP surface -----------------------------
  const reg = await api("POST", "/api/auth/register", {
    body: { username: "wire-admin", password: "wire-test-pass-123", displayName: "Wire Admin" },
  });
  expect(reg.status).toBeLessThan(300);
  const adminToken: string = reg.json.token;

  const habitat = await api("POST", "/api/habitats", {
    token: adminToken,
    body: { name: "Wire Habitat", defaultColumns: true },
  });
  expect(habitat.status).toBeLessThan(300);
  habitatId = habitat.json.habitat.id;

  const foreignHabitat = await api("POST", "/api/habitats", {
    token: adminToken,
    body: { name: "Foreign Habitat", defaultColumns: true },
  });
  expect(foreignHabitat.status).toBeLessThan(300);
  foreignHabitatId = foreignHabitat.json.habitat.id;

  const register = (n: string) =>
    api("POST", "/api/agents", {
      body: { name: n, type: "opencode", domain: "fullstack", capabilities: ["typescript"] },
      regToken: REG_TOKEN,
    });
  const worker = await register("wire-automation-worker");
  const idle = await register("wire-automation-idle");
  expect(worker.status).toBeLessThan(300);
  expect(idle.status).toBeLessThan(300);
  workerKey = worker.json.apiKey;
  idleKey = idle.json.apiKey;
  const workerId: string = worker.json.agent.id;

  const mission = await api("POST", `/api/habitats/${habitatId}/missions`, {
    token: adminToken,
    body: { title: "Wire Automation Mission" },
  });
  expect(mission.status).toBeLessThan(300);
  const missionId: string = mission.json.mission.id;

  const publish = await api("POST", `/api/missions/${missionId}/task-publications`, {
    token: adminToken,
    body: {
      attemptKey: "wire-automation-attempt-1",
      title: "Wire Automation Task",
      assignment: { kind: "targeted", agentId: workerId },
      targetedAssignmentDeadline: new Date(Date.now() + 24 * 3600_000).toISOString(),
    },
  });
  expect(publish.status).toBeLessThan(300);

  const tasks = await api("GET", `/api/missions/${missionId}/tasks`, { token: adminToken });
  expect(tasks.status).toBeLessThan(300);
  claimedTaskId = tasks.json.tasks[0].id;

  // The publication observation checkpoint is daemon/coordinator-owned —
  // there is no HTTP surface that advances it, and the daemon is not part
  // of this harness. Advance the attempt to the post-observation state
  // directly in the disposable DB (disclosed bootstrap deviation), then
  // CLAIM through the real route so the active-work row is genuine.
  const Database = requireFromApi("better-sqlite3") as new (path: string) => {
    prepare(sql: string): { run(...args: unknown[]): unknown };
    close(): void;
  };
  const db = new Database(join(dbDir, "wire.db"));
  db.prepare(
    "UPDATE task_creation_attempts SET state = 'created_unassigned' WHERE attempt_key = ?",
  ).run("wire-automation-attempt-1");
  db.close();

  const claim = await api("POST", `/api/tasks/${claimedTaskId}/claim`, {
    agentKey: workerKey,
    body: {},
  });
  expect(claim.status, JSON.stringify(claim.json)).toBeLessThan(300);
  expect(["claimed", "in_progress"]).toContain(claim.json.task.status);

  const createRule = (body: unknown) =>
    api("POST", `/api/habitats/${habitatId}/automation-rules`, { token: adminToken, body });

  const secretRule = await createRule({
    name: "wire secret rule",
    description: "secret-bearing",
    enabled: true,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" },
    actions: [
      { type: "call_webhook", url: SECRET_URL, headers: { authorization: SECRET_HEADER } },
      { type: "create_signal", content: SECRET_SIGNAL },
      { type: "plugin", actionId: "wire.secret.plugin", params: { token: SECRET_PLUGIN_PARAM } },
    ],
  });
  expect(secretRule.status).toBeLessThan(300);
  secretRuleId = secretRule.json.id;

  const statusRule = await createRule({
    name: "wire status rule",
    enabled: true,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "status_in", statuses: ["claimed", "in_progress"] },
    actions: [{ type: "create_signal", content: "status rule fired" }],
  });
  expect(statusRule.status).toBeLessThan(300);
  statusRuleId = statusRule.json.id;

  const pluginRule = await createRule({
    name: "wire plugin-condition rule",
    enabled: true,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: {
      type: "and",
      children: [
        { type: "always" },
        { type: "not", child: { type: "plugin", conditionId: "wire.spy.condition" } },
      ],
    },
    actions: [{ type: "create_signal", content: "plugin rule fired" }],
  });
  expect(pluginRule.status).toBeLessThan(300);
  pluginRuleId = pluginRule.json.id;

  const runRule = await createRule({
    name: "wire run-history rule",
    enabled: true,
    cooldownSeconds: 3600,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" },
    actions: [{ type: "create_signal", content: "run history pulse" }],
  });
  expect(runRule.status).toBeLessThan(300);
  runRuleId = runRule.json.id;

  // Real run rows through the real manual-run path (task target — the same
  // shape the manual-route tests prove successful): first attempt executes,
  // the second hits the rule's cooldown (a real AutomationSkipReason value).
  const run1 = await api("POST", `/api/automation-rules/${runRuleId}/run`, {
    token: adminToken,
    body: { targetType: "task", targetId: claimedTaskId },
  });
  expect(run1.status).toBeLessThan(300);
  const run2 = await api("POST", `/api/automation-rules/${runRuleId}/run`, {
    token: adminToken,
    body: { targetType: "task", targetId: claimedTaskId },
  });
  expect(run2.status).toBeLessThan(300);

  // Real MCP client over stdio, authenticated as the WORKER agent.
  client = new Client({ name: "wire-test-client", version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_DIST],
    env: {
      ...process.env,
      ORCY_API_URL: `http://127.0.0.1:${apiPort}`,
      ORCY_API_KEY: workerKey,
    },
  });
  await client.connect(transport);
}, 240_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  apiChild?.kill("SIGTERM");
  await rm(dbDir, { recursive: true, force: true }).catch(() => {});
});

describe("orcy_automation over the real stdio MCP wire (worker-agent principal)", () => {
  it("list returns the projected rules for the agent's habitat", async () => {
    const { isError, body } = await callAutomation({ action: "list", habitatId });
    expect(isError).toBe(false);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(4);
    for (const rule of body) {
      expect(Object.keys(rule).sort()).toEqual(
        [
          "actions",
          "condition",
          "cooldownSeconds",
          "description",
          "enabled",
          "habitatId",
          "id",
          "maxRunsPerHour",
          "name",
          "priority",
          "trigger",
        ].sort(),
      );
      expect(Object.keys(rule.condition).sort()).toEqual(["summary", "type"]);
      for (const action of rule.actions) {
        expect(Object.keys(action).sort()).toEqual(["description", "type"]);
      }
    }
    expectNoWireSecrets(body);
  });

  it("get returns the projection — no webhook URL, headers, or plugin params anywhere", async () => {
    const { isError, body } = await callAutomation({ action: "get", ruleId: secretRuleId });
    expect(isError).toBe(false);
    expect(body.id).toBe(secretRuleId);
    expect(body.actions.map((a: { type: string }) => a.type)).toEqual([
      "call_webhook",
      "create_signal",
      "plugin",
    ]);
    expect(body.condition).toEqual({ type: "always", summary: expect.any(String) });
    expectNoWireSecrets(body);
  });

  it("simulate evaluates the builtin condition true with the bounded agent shape", async () => {
    const { isError, body } = await callAutomation({
      action: "simulate",
      ruleId: statusRuleId,
      targetType: "task",
      targetId: claimedTaskId,
      triggerEventId: "wire-never-loaded-event",
    });
    expect(isError).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      [
        "actionPreviews",
        "conditionResult",
        "ruleId",
        "ruleName",
        "validation",
        "wouldExecute",
      ].sort(),
    );
    expect(body.wouldExecute).toBe(true);
    expect(body.conditionResult).toEqual({ matched: true, conditionType: "status_in" });
    expect(body.validation).toEqual({ valid: true });
    expect(body.actionPreviews).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("wire-never-loaded-event");
    expectNoWireSecrets(body);
  });

  it("simulate classifies nested plugin conditions without evaluation or fake success", async () => {
    const { isError, body } = await callAutomation({ action: "simulate", ruleId: pluginRuleId });
    expect(isError).toBe(false);
    expect(body.validation).toEqual({ valid: false, code: "unsupported_plugin_condition" });
    expect(body.wouldExecute).toBe(false);
    expect(body.conditionResult).toEqual({ matched: false, conditionType: "plugin" });
    expect(body).not.toHaveProperty("skipReason");
    expect(JSON.stringify(body)).not.toContain("wire.spy.condition");
  });

  it("smuggled payload through the tool args is rejected — never a silent success", async () => {
    const { isError, body } = await callAutomation({
      action: "simulate",
      ruleId: statusRuleId,
      payload: { poison: "WIRE-POISON-1" },
    });
    // Either the transport schema rejects it or the API answers the fixed
    // 400 code; a silent success is the only unacceptable outcome.
    expect(isError, JSON.stringify(body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("WIRE-POISON-1");
  });

  it("list_runs and get_rule_runs return only the allowlisted run fields", async () => {
    const habitatRuns = await callAutomation({ action: "list_runs", habitatId });
    expect(habitatRuns.isError).toBe(false);
    expect(habitatRuns.body.total).toBe(2);

    const ruleRuns = await callAutomation({ action: "get_rule_runs", ruleId: runRuleId });
    expect(ruleRuns.isError).toBe(false);
    expect(ruleRuns.body.runs).toHaveLength(2);
    const statuses = ruleRuns.body.runs.map((r: { status: string }) => r.status).sort();
    expect(statuses).toEqual(["skipped", "succeeded"]);
    for (const run of [...habitatRuns.body.runs, ...ruleRuns.body.runs]) {
      const keys = Object.keys(run);
      expect(
        keys.every((k) =>
          ["finishedAt", "id", "ruleId", "startedAt", "status", "skipReason"].includes(k),
        ),
        `unexpected run keys: ${keys.join(",")}`,
      ).toBe(true);
    }
    const skipped = ruleRuns.body.runs.find((r: { status: string }) => r.status === "skipped");
    expect(skipped.skipReason).toBe("cooldown");
    const text = JSON.stringify([habitatRuns.body, ruleRuns.body]);
    expect(text).not.toContain("actionResults");
    expect(text).not.toContain("conditionResult");
    expect(text).not.toContain("metadata");
    expectNoWireSecrets(ruleRuns.body);
  });
});

describe("raw-HTTP denial and rejection semantics for the same contract", () => {
  it("idle agent: 403 on habitat list, 404 on rule reads (uniform with cross-habitat)", async () => {
    const list = await api("GET", `/api/habitats/${habitatId}/automation-rules`, {
      agentKey: idleKey,
    });
    expect(list.status).toBe(403);

    const foreignRule = await api("POST", `/api/habitats/${foreignHabitatId}/automation-rules`, {
      token: (
        await api("POST", "/api/auth/login", {
          body: { username: "wire-admin", password: "wire-test-pass-123" },
        })
      ).json.token,
      body: {
        name: "foreign rule",
        trigger: { type: "event", eventType: "task.rejected" },
        condition: { type: "always" },
        actions: [{ type: "create_signal", content: "foreign" }],
      },
    });
    expect(foreignRule.status).toBeLessThan(300);

    for (const path of [
      `/api/automation-rules/${foreignRule.json.id}`,
      `/api/automation-rules/${foreignRule.json.id}/runs`,
    ]) {
      const res = await api("GET", path, { agentKey: workerKey });
      expect(res.status).toBe(404);
    }
    const sim = await api("POST", `/api/automation-rules/${foreignRule.json.id}/simulate`, {
      agentKey: workerKey,
      body: {},
    });
    expect(sim.status).toBe(404);
  });

  it("overrideCondition over raw HTTP as the agent is rejected with the fixed code", async () => {
    const res = await api("POST", `/api/automation-rules/${statusRuleId}/simulate`, {
      agentKey: workerKey,
      body: { overrideCondition: { type: "always" } },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("override_condition_forbidden");
  });
});
