/**
 * Fastify `app.inject` contract tests for the human Automation Rule
 * simulation route (`POST /automation-rules/:ruleId/simulate`).
 *
 * Verifies the default omitted-`triggerEventId` contract, explicit valid
 * `triggerEventId`, typed schema rejection of `null` and non-string values,
 * human habitat authorization, and zero side-effect persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pulseRepo from "../repositories/pulse.js";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { users } from "../db/schema/user.js";
import { automationRoutes } from "../routes/automationRules.js";
import type { AutomationCondition } from "@orcy/shared";

let signingKey = "";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, signingKey, { issuer: "orcy" });
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

function seedHabitat(name = "Simulate Habitat", teamId?: string) {
  return habitatRepo.createHabitat({ name, teamId });
}

function seedRule(habitatId: string) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Simulate Rule",
    priority: 0,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" } as AutomationCondition,
    actions: [{ type: "create_signal", content: "simulated pulse" }],
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "admin-1",
  });
}

describe("POST /automation-rules/:ruleId/simulate (human)", () => {
  beforeEach(async () => {
    await initTestDb();
    getDb()
      .insert(users)
      .values([
        { id: "admin-1", username: "admin-1", passwordHash: "fixture", role: "admin" },
        { id: "member-1", username: "member-1", passwordHash: "fixture", role: "editor" },
        { id: "outsider-1", username: "outsider-1", passwordHash: "fixture", role: "editor" },
      ])
      .run();
    signingKey = randomBytes(32).toString("hex");
    setJwtSecret(signingKey);
  });

  afterEach(() => {
    closeDb();
  });

  it("accepts default empty payload and explicit valid triggerEventId without persisting runs or signals", async () => {
    const app = await buildApp();
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id);
    const token = makeToken({ sub: "admin-1", username: "admin-1", role: "admin" });

    const defaultRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(defaultRes.statusCode).toBe(200);
    const defaultBody = defaultRes.json();
    expect(defaultBody.wouldExecute).toBe(true);
    expect(defaultBody.ruleId).toBe(rule.id);
    expect(defaultBody.context.habitat.id).toBe(habitat.id);
    expect(defaultBody.actionPreviews).toHaveLength(1);

    const explicitRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { triggerEventId: "evt-1", payload: { reason: "unit-check" } },
    });
    expect(explicitRes.statusCode).toBe(200);
    const explicitBody = explicitRes.json();
    expect(explicitBody.wouldExecute).toBe(true);
    expect(explicitBody.context.raw).toEqual({ reason: "unit-check" });

    expect(pulseRepo.getPulsesByHabitat(habitat.id, { limit: 100, offset: 0 }).total).toBe(0);
    expect(runRepo.listRunsByRule(rule.id, { limit: 100, offset: 0 }).total).toBe(0);
    await app.close();
  });

  it("rejects null and non-string triggerEventId with typed VALIDATION_ERROR", async () => {
    const app = await buildApp();
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id);
    const token = makeToken({ sub: "admin-1", username: "admin-1", role: "admin" });

    const nullRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { triggerEventId: null },
    });
    expect(nullRes.statusCode).toBe(400);
    expect(nullRes.json().code).toBe("VALIDATION_ERROR");
    expect(nullRes.json().details.fieldErrors.triggerEventId).toEqual([
      "Invalid input: expected string, received null",
    ]);

    const numRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { triggerEventId: 42 },
    });
    expect(numRes.statusCode).toBe(400);
    expect(numRes.json().code).toBe("VALIDATION_ERROR");
    expect(numRes.json().details.fieldErrors.triggerEventId).toEqual([
      "Invalid input: expected string, received number",
    ]);

    await app.close();
  });

  it("preserves human authentication and team-habitat authorization", async () => {
    const app = await buildApp();
    const org = organizationRepo.createOrganization({
      name: "Simulate Org",
      slug: "simulate-org",
    });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Private Team",
      slug: "private-team",
    });
    teamMemberRepo.addMember({ teamId: team.id, userId: "member-1", role: "member" });
    const habitat = seedHabitat("Team Habitat", team.id);
    const rule = seedRule(habitat.id);

    const unauthRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      payload: {},
    });
    expect(unauthRes.statusCode).toBe(401);

    const memberToken = makeToken({ sub: "member-1", username: "member-1", role: "editor" });
    const memberRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${memberToken}` },
      payload: {},
    });
    expect(memberRes.statusCode).toBe(200);

    const outsiderToken = makeToken({ sub: "outsider-1", username: "outsider-1", role: "editor" });
    const forbiddenRes = await app.inject({
      method: "POST",
      url: `/automation-rules/${rule.id}/simulate`,
      headers: { authorization: `Bearer ${outsiderToken}` },
      payload: {},
    });
    expect(forbiddenRes.statusCode).toBe(403);

    await app.close();
  });
});
