/**
 * REC-07 family 2 — automation inspection for agent principals.
 *
 * Real HTTP route tests (Fastify inject with the production auth-policy
 * guards installed by `applyDeclaredAuthPolicies` inside
 * `automationRoutes`). The 5 inspection routes (list rules, get rule,
 * simulate, list habitat runs, get rule runs) admit local agents holding
 * ACTIVE work in the habitat (`agentHasHabitatWork`:
 * claimed/in_progress/submitted); agents without active work are denied
 * (403 on habitat-scoped routes, uniform 404 on rule-id routes — including
 * cross-habitat rules, so no existence oracle). Rule-id routes now derive
 * `rule.habitatId` and enforce habitat access for HUMANS too (a disclosed
 * tightening of three previously unguarded reads).
 *
 * Agent projections:
 *  - rules: structural allowlist + fixed condition summaries + static
 *    per-action-type labels — NO webhook urls/headers, signal content,
 *    plugin params, or any operand values.
 *  - runs: {id, ruleId, status, startedAt, finishedAt} + skipReason only
 *    when it is one of the 8 AutomationSkipReason values.
 *  - simulate: the restricted agent contract — overrideCondition/payload
 *    rejected with fixed 400 codes, agent targetType rejected, targets
 *    scoped by checkHabitatOwnership before any context build, stored
 *    condition schema-validated (invalid_condition), plugin nodes anywhere
 *    in the tree never dispatched (unsupported_plugin_condition), response
 *    bounded to {ruleId, ruleName, wouldExecute, skipReason?, validation,
 *    actionPreviews, conditionResult} with NO context/reason/payload echo.
 *
 * Human paths: same-habitat responses keep the raw rows (byte-unchanged
 * shapes); cross-habitat humans now get 403. Mutations/run/inbox stay
 * human-only.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskFullRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { automationRuleRuns, users, tasks as tasksSchema } from "../db/schema/index.js";
import { automationRoutes } from "../routes/automationRules.js";
import type { AutomationCondition, Habitat } from "@orcy/shared";

const JWT_SECRET = "dev-secret-change-in-production";
const HUMAN_ID = "automation-inspection-human";

const SECRET_URL = "https://hooks.secret.example/SECRETTOKEN123";
const SECRET_HEADER_VALUE = "Bearer HEADERSECRET456";
const SECRET_SIGNAL_CONTENT = "SECRET-SIGNAL-CONTENT-789";
const SECRET_PLUGIN_PARAM = "PLUGINPARAMSECRET012";
const SECRET_PLUGIN_CONDITION_ID = "spy-condition-id";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function ensureUser(userId: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username: userId,
        passwordHash: "hash",
        displayName: userId,
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

let app: FastifyInstance;
let habitatA: Habitat;
let habitatB: Habitat;
let humanToken: string;
let workAgentKey: string;
let workAgentId: string;
let idleAgentKey: string;
let approvedOnlyAgentKey: string;
let approvedOnlyAgentId: string;
let workAgentTaskId: string;
let secretRuleId: string;
let plainRuleId: string;
let foreignRuleId: string;

function agentHeaders(key: string) {
  return { "x-agent-api-key": key };
}
function humanHeaders() {
  return { authorization: `Bearer ${humanToken}` };
}

type RuleOverrides = Partial<{
  name: string;
  condition: AutomationCondition;
  actions: Array<Record<string, unknown>>;
  enabled: boolean;
  trigger: Record<string, unknown>;
}>;

function createRule(habitatId: string, overrides?: RuleOverrides) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "Inspection Rule",
    description: "rule description text",
    priority: 0,
    trigger: (overrides?.trigger ?? { type: "event", eventType: "task.rejected" }) as never,
    condition: (overrides?.condition ?? { type: "always" }) as never,
    actions: (overrides?.actions ?? [{ type: "create_signal", content: "plain content" }]) as never,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: overrides?.enabled ?? true,
    createdBy: "test",
  });
}

/** The secret-bearing rule: every projection-hazard field family in one row. */
function createSecretRule(habitatId: string) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Secret-bearing rule",
    description: "carries config secrets",
    priority: 1,
    trigger: { type: "event", eventType: "task.rejected" } as never,
    condition: {
      type: "and",
      children: [
        { type: "always" },
        { type: "assigned_to", recipientType: "agent", recipientId: "SECRET-RECIPIENT-ID" },
      ],
    } as never,
    actions: [
      {
        type: "call_webhook",
        url: SECRET_URL,
        headers: { authorization: SECRET_HEADER_VALUE, "x-custom": "x" },
        bodyTemplate: "SECRET-BODY-TEMPLATE",
      },
      { type: "create_signal", content: SECRET_SIGNAL_CONTENT },
      { type: "plugin", actionId: "secret.plugin.action", params: { token: SECRET_PLUGIN_PARAM } },
      {
        type: "notify",
        recipients: [{ type: "agent", agentId: "SECRET-AGENT-ID" }],
        template: "SECRET-TEMPLATE",
      },
    ] as never,
    cooldownSeconds: 60,
    maxRunsPerHour: 10,
    enabled: true,
    createdBy: "test",
  });
}

function seedRun(
  ruleId: string,
  habitatId: string,
  overrides?: Partial<{ skipReason: string | null; status: string }>,
) {
  const started = runRepo.startRuleRun({
    ruleId,
    habitatId,
    triggerType: "task.rejected",
    targetType: "task",
    targetId: "t",
  });
  if (overrides?.skipReason !== undefined || overrides?.status) {
    getDb()
      .update(automationRuleRuns)
      .set({
        ...(overrides?.skipReason !== undefined ? { skipReason: overrides.skipReason } : {}),
        ...(overrides?.status ? { status: overrides.status } : {}),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(automationRuleRuns.id, started.run.id))
      .run();
  }
  return started.run.id;
}

/** Assert no secret sentinel appears anywhere in a JSON-serialized payload tree. */
function expectNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const sentinel of [
    SECRET_URL,
    "SECRETTOKEN123",
    SECRET_HEADER_VALUE,
    "HEADERSECRET456",
    SECRET_SIGNAL_CONTENT,
    SECRET_PLUGIN_PARAM,
    "PLUGINPARAMSECRET012",
    "SECRET-BODY-TEMPLATE",
    "SECRET-RECIPIENT-ID",
    "SECRET-AGENT-ID",
    "SECRET-TEMPLATE",
    "secret.plugin.action",
    "hooks.secret.example",
  ]) {
    if (text.includes(sentinel)) {
      throw new Error(`secret sentinel leaked into agent payload: ${sentinel}\n${text}`);
    }
  }
}

const RULE_PROJECTION_KEYS = [
  "id",
  "habitatId",
  "name",
  "description",
  "enabled",
  "priority",
  "trigger",
  "cooldownSeconds",
  "maxRunsPerHour",
  "condition",
  "actions",
].sort();

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(automationRoutes);
  await app.ready();
});

afterAll(() => app.close());

beforeEach(async () => {
  await initTestDb();
  setJwtSecret(JWT_SECRET);

  // Human is a member of habitat A's team only.
  const org = organizationRepo.createOrganization({
    name: "Inspection Org",
    slug: "inspection-org",
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "Team A",
    slug: "inspection-team-a",
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "Team B",
    slug: "inspection-team-b",
  });
  habitatA = habitatRepo.createHabitat({ name: "Habitat A", teamId: teamA.id });
  habitatB = habitatRepo.createHabitat({ name: "Habitat B", teamId: teamB.id });
  for (const h of [habitatA, habitatB]) {
    columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  }
  ensureUser(HUMAN_ID);
  teamMemberRepo.addMember({ teamId: teamA.id, userId: HUMAN_ID, role: "member" });
  humanToken = makeToken({ sub: HUMAN_ID, username: "Inspection Human", role: "user" });

  const workAgent = agentRepo.createAgent({
    name: `inspection-work-agent-${Date.now()}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  workAgentId = workAgent.agent.id;
  workAgentKey = workAgent.plainApiKey;

  const idleAgent = agentRepo.createAgent({
    name: `inspection-idle-agent-${Date.now()}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  idleAgentKey = idleAgent.plainApiKey;

  const approvedOnly = agentRepo.createAgent({
    name: `inspection-approved-agent-${Date.now()}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: ["typescript"],
  });
  approvedOnlyAgentId = approvedOnly.agent.id;
  approvedOnlyAgentKey = approvedOnly.plainApiKey;

  // Active work for workAgent in habitat A: claimed task in a mission there.
  const mission = missionRepo.createMission({
    habitatId: habitatA.id,
    title: "Inspection Mission",
    createdBy: HUMAN_ID,
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Inspection Task",
    createdBy: HUMAN_ID,
  });
  taskFullRepo.claimTask(task.id, workAgentId);
  workAgentTaskId = task.id;

  // Approved-only work in habitat A: claimed then terminal-approved.
  const mission2 = missionRepo.createMission({
    habitatId: habitatA.id,
    title: "Approved Mission",
    createdBy: HUMAN_ID,
  });
  const task2 = taskRepo.createTask({
    missionId: mission2.id,
    title: "Approved Task",
    createdBy: HUMAN_ID,
  });
  taskFullRepo.claimTask(task2.id, approvedOnlyAgentId);
  getDb().update(tasksSchema).set({ status: "approved" }).where(eq(tasksSchema.id, task2.id)).run();

  plainRuleId = createRule(habitatA.id, { condition: { type: "always" } }).id;
  secretRuleId = createSecretRule(habitatA.id).id;
  foreignRuleId = createRule(habitatB.id).id;
});

afterEach(async () => {
  closeDb();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rules projection (list / get)
// ---------------------------------------------------------------------------

describe("agent rules inspection — list", () => {
  it("admits an agent with active habitat work and returns the allowlisted projection", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/habitats/${habitatA.id}/automation-rules`,
      headers: agentHeaders(workAgentKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const rule of body) {
      expect(Object.keys(rule).sort()).toEqual(RULE_PROJECTION_KEYS);
      expect(Object.keys(rule.condition).sort()).toEqual(["summary", "type"]);
      for (const action of rule.actions) {
        expect(Object.keys(action).sort()).toEqual(["description", "type"]);
      }
    }
    expectNoSecrets(body);
  });

  it("403 for an agent with no habitat work (and for approved-only work)", async () => {
    for (const key of [idleAgentKey, approvedOnlyAgentKey]) {
      const res = await app.inject({
        method: "GET",
        url: `/habitats/${habitatA.id}/automation-rules`,
        headers: agentHeaders(key),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("human member keeps the raw rule rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/habitats/${habitatA.id}/automation-rules`,
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const secret = body.find((r: { id: string }) => r.id === secretRuleId);
    expect(secret.url ?? secret.actions[0].url).toBe(SECRET_URL);
    expect(secret.actions[0].headers.authorization).toBe(SECRET_HEADER_VALUE);
  });
});

describe("agent rules inspection — get", () => {
  it("returns the projection for the agent's own habitat rule", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/automation-rules/${secretRuleId}`,
      headers: agentHeaders(workAgentKey),
    });
    expect(res.statusCode).toBe(200);
    const rule = res.json();
    expect(Object.keys(rule).sort()).toEqual(RULE_PROJECTION_KEYS);
    expect(rule.condition).toEqual({
      type: "and",
      summary: expect.any(String),
    });
    expect(rule.actions.map((a: { type: string }) => a.type)).toEqual([
      "call_webhook",
      "create_signal",
      "plugin",
      "notify",
    ]);
    expectNoSecrets(rule);
  });

  it("404 uniform for cross-habitat rule, missing rule id, and no-work agent", async () => {
    for (const [url, headers] of [
      [`/automation-rules/${foreignRuleId}`, agentHeaders(workAgentKey)],
      [`/automation-rules/does-not-exist`, agentHeaders(workAgentKey)],
      [`/automation-rules/${plainRuleId}`, agentHeaders(idleAgentKey)],
      [`/automation-rules/${plainRuleId}`, agentHeaders(approvedOnlyAgentKey)],
    ] as const) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode).toBe(404);
    }
  });

  it("human cross-habitat get is now 403 (tightened); same-habitat human keeps the raw row", async () => {
    const foreign = await app.inject({
      method: "GET",
      url: `/automation-rules/${foreignRuleId}`,
      headers: humanHeaders(),
    });
    expect(foreign.statusCode).toBe(403);

    const own = await app.inject({
      method: "GET",
      url: `/automation-rules/${secretRuleId}`,
      headers: humanHeaders(),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().actions[0].url).toBe(SECRET_URL);
  });

  it("F2: trigger is a newly CONSTRUCTED object — valid shape + extra secret keys carry NOTHING over", async () => {
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitatA.id,
      name: "extra-keys trigger rule",
      description: "",
      priority: 0,
      // Repo-level insert: valid discriminator/enum, plus secret-bearing
      // extra keys that a raw spread/copy would leak.
      trigger: {
        type: "event",
        eventType: "task.rejected",
        url: "https://trigger-secret.example/TOKEN222",
        headers: { authorization: "Bearer TRIGGERHEADER333" },
        params: { token: "TRIGGERPARAM444" },
      } as never,
      condition: { type: "always" } as never,
      actions: [{ type: "create_signal", content: "x" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 10,
      enabled: true,
      createdBy: "test",
    });

    const res = await app.inject({
      method: "GET",
      url: `/automation-rules/${rule.id}`,
      headers: agentHeaders(workAgentKey),
    });
    expect(res.statusCode).toBe(200);
    // Exact constructed object — deep equality pins that NO extra key rides along.
    expect(res.json().trigger).toEqual({ type: "event", eventType: "task.rejected" });

    const listRes = await app.inject({
      method: "GET",
      url: `/habitats/${habitatA.id}/automation-rules`,
      headers: agentHeaders(workAgentKey),
    });
    const listed = listRes.json().find((r: { id: string; trigger?: unknown }) => r.id === rule.id);
    expect(listed.trigger).toEqual({ type: "event", eventType: "task.rejected" });
    expect(listRes.body).not.toContain("trigger-secret.example");
    expect(listRes.body).not.toContain("TRIGGERHEADER333");
    expect(listRes.body).not.toContain("TRIGGERPARAM444");
  });

  it("F2: malformed / unknown / missing triggers OMIT the field; valid scan enum round-trips", async () => {
    const cases: Array<{ trigger: unknown; expectTrigger?: unknown }> = [
      {
        trigger: { type: "event", eventType: "not.a.real.event", secret: "SECRET-BAD-EVENT" },
        expectTrigger: undefined,
      },
      { trigger: { type: "scan", scanType: 123 }, expectTrigger: undefined },
      {
        trigger: { type: "webhook", url: "https://x.example/SECRET-BAD-TYPE" },
        expectTrigger: undefined,
      },
      { trigger: {}, expectTrigger: undefined },
      { trigger: "just-a-string", expectTrigger: undefined },
      {
        trigger: { type: "scan", scanType: "agent_silent" },
        expectTrigger: { type: "scan", scanType: "agent_silent" },
      },
    ];
    for (const c of cases) {
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitatA.id,
        name: "trigger case rule",
        description: "",
        priority: 0,
        trigger: c.trigger as never,
        condition: { type: "always" } as never,
        actions: [{ type: "create_signal", content: "x" }] as never,
        cooldownSeconds: 0,
        maxRunsPerHour: 10,
        enabled: true,
        createdBy: "test",
      });
      const res = await app.inject({
        method: "GET",
        url: `/automation-rules/${rule.id}`,
        headers: agentHeaders(workAgentKey),
      });
      expect(res.statusCode).toBe(200);
      const rule2 = res.json();
      if (c.expectTrigger === undefined) {
        expect(rule2).not.toHaveProperty("trigger");
      } else {
        expect(rule2.trigger).toEqual(c.expectTrigger);
      }
      expect(res.body).not.toContain("SECRET-BAD-EVENT");
      expect(res.body).not.toContain("SECRET-BAD-TYPE");
    }
  });
});

// ---------------------------------------------------------------------------
// Runs projection (list habitat runs / get rule runs)
// ---------------------------------------------------------------------------

describe("agent runs inspection", () => {
  it("projects runs to the allowlist with skipReason whitelisted against the 8-value union", async () => {
    seedRun(plainRuleId, habitatA.id, { skipReason: "cooldown", status: "skipped" });
    seedRun(plainRuleId, habitatA.id, { skipReason: "weird free text skip", status: "skipped" });
    seedRun(plainRuleId, habitatA.id, { status: "succeeded" });

    for (const url of [
      `/habitats/${habitatA.id}/automation-runs`,
      `/automation-rules/${plainRuleId}/runs`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: agentHeaders(workAgentKey) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.total).toBe("number");
      expect(body.runs.length).toBe(3);
      const runKeySets = body.runs.map((run: Record<string, unknown>) => Object.keys(run).sort());
      for (const keys of runKeySets) {
        // Only allowlisted keys; skipReason appears only with a whitelisted value.
        const allowed = new Set([
          "finishedAt",
          "id",
          "ruleId",
          "startedAt",
          "status",
          "skipReason",
        ]);
        expect(keys.length).toBeLessThanOrEqual(6);
        for (const k of keys) {
          expect(allowed.has(k), `unexpected run key: ${k}`).toBe(true);
        }
      }
      // cooldown row keeps its whitelisted skipReason; weird free text is omitted.
      const bySkip = body.runs.filter((r: Record<string, unknown>) => "skipReason" in r);
      expect(bySkip.length).toBe(1);
      expect(bySkip[0].skipReason).toBe("cooldown");
      expect(JSON.stringify(body)).not.toContain("weird free text skip");
      expectNoSecrets(body);
    }
  });

  it("denies habitat runs 403 / rule runs 404 for agents without active work", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/habitats/${habitatA.id}/automation-runs`,
      headers: agentHeaders(idleAgentKey),
    });
    expect(listRes.statusCode).toBe(403);

    const ruleRunsRes = await app.inject({
      method: "GET",
      url: `/automation-rules/${plainRuleId}/runs`,
      headers: agentHeaders(idleAgentKey),
    });
    expect(ruleRunsRes.statusCode).toBe(404);
  });

  it("human keeps raw runs rows with action_results/conditionResult/metadata", async () => {
    seedRun(plainRuleId, habitatA.id, { skipReason: "cooldown", status: "skipped" });
    const res = await app.inject({
      method: "GET",
      url: `/automation-rules/${plainRuleId}/runs`,
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs[0]).toHaveProperty("metadata");
    expect(res.json().runs[0]).toHaveProperty("actionResults");
  });

  it("omits a non-canonical stored run status entirely (F1: no raw free-text echo)", async () => {
    seedRun(plainRuleId, habitatA.id, { status: "weird-free-text-status-SECRETRUNSTATUS" });
    const res = await app.inject({
      method: "GET",
      url: `/automation-rules/${plainRuleId}/runs`,
      headers: agentHeaders(workAgentKey),
    });
    expect(res.statusCode).toBe(200);
    const run = res.json().runs[0];
    expect(run).not.toHaveProperty("status");
    expect(run).not.toHaveProperty("skipReason");
    expect(Object.keys(run).sort()).toEqual(["finishedAt", "id", "ruleId", "startedAt"]);
    expect(res.body).not.toContain("weird-free-text-status");
    expectNoSecrets(run);
  });

  it("valid run statuses pass the whitelist and every union member is accepted", async () => {
    const statuses = [
      "matched",
      "skipped",
      "running",
      "succeeded",
      "partial_failed",
      "failed",
      "simulated",
    ];
    for (const status of statuses) {
      seedRun(plainRuleId, habitatA.id, { status });
    }
    const res = await app.inject({
      method: "GET",
      url: `/automation-rules/${plainRuleId}/runs`,
      headers: agentHeaders(workAgentKey),
    });
    expect(res.statusCode).toBe(200);
    const seen = res
      .json()
      .runs.map((r: { status?: string }) => r.status)
      .sort();
    expect(seen).toEqual([...statuses].sort());
  });
});

// ---------------------------------------------------------------------------
// Agent simulation
// ---------------------------------------------------------------------------

describe("agent simulate — restricted contract", () => {
  it("evaluates a builtin condition true and previews static action labels", async () => {
    const rule = createRule(habitatA.id, {
      condition: { type: "status_in", statuses: ["claimed", "in_progress"] },
      actions: [{ type: "create_signal", content: SECRET_SIGNAL_CONTENT }],
    });
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { targetType: "task", targetId: workAgentTaskId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
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
    expect(body.ruleId).toBe(rule.id);
    expect(body.wouldExecute).toBe(true);
    expect(body.validation).toEqual({ valid: true });
    expect(body.conditionResult).toEqual({ matched: true, conditionType: "status_in" });
    expect(body.actionPreviews).toEqual([
      { actionType: "create_signal", actionIndex: 0, description: expect.any(String) },
    ]);
    expectNoSecrets(body);
  });

  it("evaluates a builtin condition false with the real skipReason condition_false", async () => {
    const rule = createRule(habitatA.id, {
      condition: { type: "status_in", statuses: ["done"] },
    });
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { targetType: "task", targetId: workAgentTaskId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wouldExecute).toBe(false);
    expect(body.skipReason).toBe("condition_false");
    expect(body.conditionResult).toEqual({ matched: false, conditionType: "status_in" });
    expect(body.validation).toEqual({ valid: true });
  });

  it("rejects overrideCondition with a fixed 400 code", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${plainRuleId}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { overrideCondition: { type: "always" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("override_condition_forbidden");
  });

  it("rejects agent-supplied payload with a fixed 400 code (not silently ignored)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${plainRuleId}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { payload: { secret: "POISONED-PAYLOAD-1" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("payload_forbidden");
    expect(JSON.stringify(res.json())).not.toContain("POISONED-PAYLOAD-1");
  });

  it("rejects targetType 'agent' with unsupported_target_type", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${plainRuleId}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { targetType: "agent", targetId: workAgentId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("unsupported_target_type");
  });

  it("404 (uniform, no row data) for foreign and missing targets before any context build", async () => {
    const missionB = missionRepo.createMission({
      habitatId: habitatB.id,
      title: "Foreign Mission",
      createdBy: HUMAN_ID,
    });
    const taskB = taskRepo.createTask({
      missionId: missionB.id,
      title: "Foreign Task",
      createdBy: HUMAN_ID,
    });
    for (const payload of [
      { targetType: "task", targetId: taskB.id },
      { targetType: "task", targetId: "missing-target-id" },
      { targetType: "mission", targetId: "missing-mission-id" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/automation-rules/${plainRuleId}/simulate`,
        headers: agentHeaders(workAgentKey),
        payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("Foreign");
    }
  });

  it("accepts triggerEventId without dereferencing or echoing it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${plainRuleId}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: { triggerEventId: "evt-never-loaded-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("evt-never-loaded-123");
  });

  it("F4 pin: malformed bodies (null/array/string/number) stay safe — bounded response, no echo, no dispatch", async () => {
    const evaluateSpy = vi.spyOn(
      await import("../services/automationEvaluator.js"),
      "evaluateCondition",
    );
    const rawBodies = ["null", "[1,2,3]", '"a-string-body"', "42"];
    for (const raw of rawBodies) {
      const res = await app.inject({
        method: "POST",
        url: `/automation-rules/${plainRuleId}/simulate`,
        headers: { ...agentHeaders(workAgentKey), "content-type": "application/json" },
        payload: raw,
      });
      expect(res.statusCode, `body ${raw}`).toBe(200);
      const body = res.json();
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
      // always-condition rule with no target: matched, valid → wouldExecute true.
      expect(body.wouldExecute).toBe(true);
      expect(res.body).not.toContain("a-string-body");
    }
    // No unknown/typed-dispatch evaluator calls beyond the builtin evaluation
    // of the rule's own always-condition (4 requests → exactly 4 calls).
    expect(evaluateSpy).toHaveBeenCalledTimes(4);
    for (const call of evaluateSpy.mock.calls) {
      expect((call[0] as { type: string }).type).toBe("always");
    }
  });

  it("F4 pin: half target pairs and non-string target fields never load context rows", async () => {
    const rule = createRule(habitatA.id, {
      condition: { type: "status_in", statuses: ["done"] },
    });
    for (const payload of [
      { targetType: "task" }, // targetType without targetId
      { targetId: workAgentTaskId }, // targetId without targetType
      { targetType: 123, targetId: 456 }, // non-string fields — no ownership bypass
      { targetType: ["task"], targetId: workAgentTaskId },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/automation-rules/${rule.id}/simulate`,
        headers: agentHeaders(workAgentKey),
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(200);
      const body = res.json();
      // No target context loaded: the status_in condition cannot match a
      // missing task — bounded false with the real skipReason.
      expect(body.wouldExecute).toBe(false);
      expect(body.skipReason).toBe("condition_false");
      expect(body.conditionResult).toEqual({ matched: false, conditionType: "status_in" });
    }
  });

  it("F4 pin: malformed body against a plugin-condition rule still classifies without evaluation", async () => {
    const rule = createRule(habitatA.id, {
      condition: {
        type: "and",
        children: [{ type: "plugin", conditionId: "spy.cond.f4", params: { s: "SECRET-F4" } }],
      } as AutomationCondition,
    });
    const evaluateSpy = vi.spyOn(
      await import("../services/automationEvaluator.js"),
      "evaluateCondition",
    );
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { ...agentHeaders(workAgentKey), "content-type": "application/json" },
      payload: "[1,2,3]",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().validation).toEqual({ valid: false, code: "unsupported_plugin_condition" });
    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(res.body).not.toContain("SECRET-F4");
  });

  it("classifies plugin nodes nested anywhere in the tree WITHOUT dispatching the handler and without writes", async () => {
    const evaluateSpy = vi.spyOn(
      await import("../services/automationEvaluator.js"),
      "evaluateCondition",
    );
    const rule = createRule(habitatA.id, {
      condition: {
        type: "and",
        children: [
          { type: "always" },
          {
            type: "or",
            children: [
              {
                type: "not",
                child: {
                  type: "plugin",
                  conditionId: SECRET_PLUGIN_CONDITION_ID,
                  params: { token: SECRET_PLUGIN_PARAM },
                },
              },
            ],
          },
        ],
      } as AutomationCondition,
    });

    const runsBefore =
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(automationRuleRuns)
        .get()?.n ?? 0;

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.validation).toEqual({ valid: false, code: "unsupported_plugin_condition" });
    expect(body.wouldExecute).toBe(false);
    expect(body.conditionResult).toEqual({ matched: false, conditionType: "plugin" });
    expect(body).not.toHaveProperty("skipReason");
    expectNoSecrets(body);
    // The stored evaluator (which dispatches plugin handlers) never ran.
    expect(evaluateSpy).not.toHaveBeenCalled();

    const runsAfter =
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(automationRuleRuns)
        .get()?.n ?? 0;
    expect(runsAfter).toBe(runsBefore);
  });

  it("never echoes unknown/corrupt stored action types (sentinel type, no config)", async () => {
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitatA.id,
      name: "Corrupt action rule",
      description: "",
      priority: 0,
      trigger: { type: "event", eventType: "task.rejected" } as never,
      condition: { type: "always" } as never,
      actions: [{ type: "weird-legacy-type", secretValue: "SECRET-UNKNOWN-ACTION" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 10,
      enabled: true,
      createdBy: "test",
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/automation-rules/${rule.id}`,
      headers: agentHeaders(workAgentKey),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().actions).toEqual([
      { type: "unknown", description: "Unrecognized stored action type" },
    ]);
    expect(getRes.body).not.toContain("weird-legacy-type");
    expect(getRes.body).not.toContain("SECRET-UNKNOWN-ACTION");

    const simRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: {},
    });
    expect(simRes.statusCode).toBe(200);
    expect(simRes.json().actionPreviews).toEqual([
      { actionType: "unknown", actionIndex: 0, description: "Unrecognized stored action type" },
    ]);
    expect(simRes.body).not.toContain("SECRET-UNKNOWN-ACTION");
  });

  it("classifies schema-invalid stored trees as invalid_condition with no node echo", async () => {
    const rule = ruleRepo.createAutomationRule({
      habitatId: habitatA.id,
      name: "Corrupt condition rule",
      description: "",
      priority: 0,
      trigger: { type: "event", eventType: "task.rejected" } as never,
      condition: { type: "bogus", secretValue: "SECRET-INVALID-NODE" } as never,
      actions: [{ type: "create_signal", content: "x" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 10,
      enabled: true,
      createdBy: "test",
    });

    const getRes = await app.inject({
      method: "GET",
      url: `/automation-rules/${rule.id}`,
      headers: agentHeaders(workAgentKey),
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().condition).toEqual({
      type: "invalid",
      summary: expect.any(String),
    });
    expect(getRes.body).not.toContain("SECRET-INVALID-NODE");

    const simRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: agentHeaders(workAgentKey),
      payload: {},
    });
    expect(simRes.statusCode).toBe(200);
    const body = simRes.json();
    expect(body.validation).toEqual({ valid: false, code: "invalid_condition" });
    expect(body.wouldExecute).toBe(false);
    expect(body).not.toHaveProperty("skipReason");
    expect(simRes.body).not.toContain("SECRET-INVALID-NODE");
  });

  it("denies simulate 404 for no-work agents, cross-habitat rules, and missing rules", async () => {
    for (const [url, headers] of [
      [`/automation-rules/${plainRuleId}/simulate`, agentHeaders(idleAgentKey)],
      [`/automation-rules/${plainRuleId}/simulate`, agentHeaders(approvedOnlyAgentKey)],
      [`/automation-rules/${foreignRuleId}/simulate`, agentHeaders(workAgentKey)],
      [`/automation-rules/does-not-exist/simulate`, agentHeaders(workAgentKey)],
    ] as const) {
      const res = await app.inject({ method: "POST", url, headers, payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------
// Principal boundaries
// ---------------------------------------------------------------------------

describe("principal boundaries", () => {
  it("remote credentials are refused on all 5 inspection routes", async () => {
    for (const [method, url] of [
      ["GET", `/habitats/${habitatA.id}/automation-rules`],
      ["GET", `/automation-rules/${plainRuleId}`],
      ["POST", `/automation-rules/${plainRuleId}/simulate`],
      ["GET", `/habitats/${habitatA.id}/automation-runs`],
      ["GET", `/automation-rules/${plainRuleId}/runs`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { "x-orcy-remote-key": "some-remote-key" },
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("mutations, manual run, and inbox stay human-only (agents refused)", async () => {
    for (const [method, url] of [
      ["POST", `/habitats/${habitatA.id}/automation-rules`],
      ["PUT", `/automation-rules/${plainRuleId}`],
      ["DELETE", `/automation-rules/${plainRuleId}`],
      ["POST", `/automation-rules/${plainRuleId}/enable`],
      ["POST", `/automation-rules/${plainRuleId}/disable`],
      ["POST", `/automation-rules/${plainRuleId}/run`],
      ["GET", `/habitats/${habitatA.id}/automation-inbox`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: agentHeaders(workAgentKey),
        ...(method !== "GET" && method !== "DELETE" ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("human cross-habitat simulate and rule runs are now 403 (tightened reads)", async () => {
    for (const [method, url] of [
      ["POST", `/automation-rules/${foreignRuleId}/simulate`],
      ["GET", `/automation-rules/${foreignRuleId}/runs`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: humanHeaders(),
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("human simulate on own habitat is unchanged (raw shape with context and validation details)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${plainRuleId}/simulate`,
      headers: humanHeaders(),
      payload: { targetType: "task", targetId: workAgentTaskId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("context");
    expect(body).toHaveProperty("validation");
    expect(body.conditionResult).toHaveProperty("reason");
  });
});
