/**
 * CS-56 cold-review m3.2 — Fastify `app.inject` tests for the manual
 * Automation Rule execution route
 * (`POST /automation-rules/:ruleId/run`).
 *
 * The pre-fix characterization tests called `attemptRuleRun` directly and
 * therefore could not exercise the route's auth (`humanAuth`), Habitat
 * access (`checkHabitatAccess`), request schema, target-ownership guard,
 * or terminal response shape. This file injects real HTTP requests into
 * a Fastify instance so the route surface is exercised end-to-end.
 *
 * Coverage:
 *   - disabled rule → 400 (with the rule's disablement message)
 *   - cross-Habitat target → 400 (M1 fix verification at the route seam)
 *   - `integration` target type → 400
 *   - schema rejects unknown fields (no condition/causal/dedupe overrides)
 *   - terminal response shape: `{ runId, status, disposition, run }`
 *   - successful manual run returns the disposition + terminal row
 *   - missing targetId for a non-`none` targetType → 400
 *   - simulation target (`targetType: "none"`) is accepted
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskRepoAll from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as pulseRepo from "../repositories/pulse.js";
import { closeDb, initTestDb } from "../db/index.js";
import { tasks as tasksSchema } from "../db/schema/task.js";
import { automationRoutes } from "../routes/automationRules.js";
import type { AutomationCondition } from "@orcy/shared";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function adminToken(): string {
  return makeToken({ sub: "admin-1", username: "admin", role: "admin" });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(automationRoutes);
  await f.ready();
  return f;
}

// Fixtures -------------------------------------------------------

function setupHabitat(name = "Manual Habitat") {
  const h = boardRepo.createHabitat({ name });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({
    habitatId,
    title: "Manual Mission",
    createdBy: "user-1",
  });
}

function setupTask(missionId: string) {
  return taskRepo.createTask({ missionId, title: "Manual Task", createdBy: "user-1" });
}

function createEnabledRule(
  habitatId: string,
  overrides?: Partial<{
    name: string;
    condition: AutomationCondition;
    cooldownSeconds: number;
    triggerType: string;
    actions: Array<{ type: string; [k: string]: unknown }>;
  }>,
) {
  const triggerType = overrides?.triggerType ?? "task.rejected";
  const trigger = { type: "event", eventType: triggerType } as unknown as Parameters<
    typeof ruleRepo.createAutomationRule
  >[0]["trigger"];
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "Manual Rule",
    priority: 0,
    trigger,
    condition: overrides?.condition ?? ({ type: "always" } as AutomationCondition),
    actions: (overrides?.actions ?? [
      { type: "create_signal", content: "Manual fired" },
    ]) as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["actions"],
    cooldownSeconds: overrides?.cooldownSeconds ?? 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "test",
  });
}

// ---------------------------------------------------------------

describe("CS-56 cold-review m3.2 — POST /automation-rules/:ruleId/run inject tests", () => {
  beforeEach(async () => {
    await initTestDb();
    setJwtSecret(JWT_SECRET);
  });
  afterEach(async () => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("returns 400 when the rule is disabled", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Disabled",
      priority: 0,
      trigger: { type: "event", eventType: "task.rejected" },
      enabled: false,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      condition: { type: "always" } as AutomationCondition,
      actions: [{ type: "create_signal", content: "Disabled" }] as unknown as Parameters<
        typeof ruleRepo.createAutomationRule
      >[0]["actions"],
      createdBy: "test",
    });

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "none" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/disabled/i);
  });

  it("returns 400 when the cross-Habitat target is supplied (M1 fix at the route seam)", async () => {
    const app = await buildApp();
    const h1 = setupHabitat("Habitat 1");
    const h2 = setupHabitat("Habitat 2");
    const mission = setupMission(h2.id);
    const task = setupTask(mission.id);
    // Rule belongs to h1; target Task belongs to h2 — cross-Habitat.
    const rule = createEnabledRule(h1.id);

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "task", targetId: task.id },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/different Habitat/i);
  });

  it("returns 400 when the agent has only completed Habitat work (M1 fix at the route seam)", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    taskRepoAll.claimTask(task.id, "agent-1");
    // Mark the agent's Habitat Task as done — agentHasHabitatWork now
    // (with the active-status predicate) returns false.
    const db = (await import("../db/index.js")).getDb();
    db.update(tasksSchema).set({ status: "done" }).where(eq(tasksSchema.id, task.id)).run();

    const rule = createEnabledRule(h.id);

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "agent", targetId: "agent-1" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/no active Habitat work/i);
  });

  it("rejects targetType='integration' (rejected by the route's .strict() schema enum, NOT in [task, mission, agent, sprint, pulse, habitat, none])", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const rule = createEnabledRule(h.id);

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "integration", targetId: "integration-1" },
    });

    // `integration` is not part of the manual-run targetType enum, so the
    // route's .strict() Zod schema rejects the request at validation time
    // (before the route's explicit `integration → 400` branch is reached).
    // Both paths produce a 400 — the load-bearing property is "integration
    // is not yet supported for manual runs".
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(res.statusCode).toBe(400);
    expect(body.error ?? body.message ?? "").toMatch(/validation|integration|invalid_enum_value/i);
  });

  it("returns 400 when the body has unknown fields (schema is .strict())", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const rule = createEnabledRule(h.id);

    // `condition` is not part of the manual schema — its presence MUST be
    // rejected so callers cannot inject a runtime condition override (the
    // stored condition is what the lifecycle evaluates).
    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "none", condition: { type: "always" } },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(JSON.stringify(body)).toMatch(/condition|VALIDATION_ERROR|Invalid/);
  });

  it("returns 400 when targetType is set but targetId is missing", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const rule = createEnabledRule(h.id);

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "task" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toMatch(/targetId is required/i);
  });

  it("executes a successful manual run and returns the terminal response shape", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    const mission = setupMission(h.id);
    const task = setupTask(mission.id);
    const rule = createEnabledRule(h.id, { condition: { type: "always" } });

    const baselinePulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "task", targetId: task.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Terminal response shape: runId + status + disposition + run.
    expect(typeof body.runId).toBe("string");
    expect(body.status).toBe("succeeded");
    expect(body.disposition.kind).toBe("executed");
    expect(body.disposition.outcome).toBe("succeeded");
    expect(body.run.id).toBe(body.runId);
    expect(body.run.status).toBe("succeeded");
    expect(body.run.finishedAt).not.toBeNull();
    expect(body.run.conditionResult?.matched).toBe(true);

    // Side effect: one new pulse emitted (create_signal action).
    const afterPulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 }).total;
    expect(afterPulses).toBe(baselinePulses + 1);
  });

  it("accepts targetType='none' without targetId (simulation target)", async () => {
    const app = await buildApp();
    const h = setupHabitat();
    // `notify` with an explicit human recipient — succeeds without
    // requiring a Task or Mission in the evaluation context (the
    // `targetType=none` case yields a Habitat-level run with no entity
    // contexts). This is the simulation seam: the route accepts
    // targetType=none + no targetId and the lifecycle reaches `executed`.
    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "NoTarget",
      priority: 0,
      trigger: { type: "event", eventType: "task.rejected" },
      enabled: true,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      condition: { type: "always" } as AutomationCondition,
      actions: [
        {
          type: "notify",
          recipients: [{ type: "human", userId: "admin-1" }],
          template: "manual simulation",
        },
      ] as unknown as Parameters<typeof ruleRepo.createAutomationRule>[0]["actions"],
      createdBy: "test",
    });

    const res = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/run`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { targetType: "none" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // targetType=none → the lifecycle runs with null targetId/targetType
    // and the notify action completes cleanly.
    expect(body.disposition.kind).toBe("executed");
    expect(body.disposition.outcome).toBe("succeeded");
  });
});
