import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamRepo from "../repositories/team.js";
import * as orgRepo from "../repositories/organization.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import { releases as releasesTable, users } from "../db/schema/index.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(triageRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

/**
 * AC-DETECT-10 — habitat access verification on POST /triage/release-trigger.
 * Mirrors the `triageRoutesAuth.test.ts` pattern: anonymous → 401,
 * authenticated but wrong (team) habitat → 403, correct → 200. Non-team
 * habitats allow any authenticated requester.
 */
describe("AC-DETECT-10: POST /triage/release-trigger habitat access control", () => {
  let app: FastifyInstance | null = null;
  let habitatId: string;
  let otherTeamHabitatId: string;
  let agentApiKey: string;
  let memberToken: string;
  let nonMemberToken: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(releasesTable).run();

    const habitat = habitatRepo.createHabitat({ name: "Release Auth Habitat" });
    habitatId = habitat.id;

    // Other habitat scoped to a team — verifyHabitatAccess rejects non-members.
    const org = orgRepo.createOrganization({ name: "Org", slug: "org-release-auth" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Team",
      slug: "team-release-auth",
    });
    const other = habitatRepo.createHabitat({ name: "Team Habitat", teamId: team.id });
    otherTeamHabitatId = other.id;

    // Register an agent + API key.
    const result = agentRepo.createAgent({
      name: "Auth Agent",
      type: "claude-code",
      domain: "general",
    });
    agentApiKey = result.plainApiKey;

    // Member of the team.
    memberToken = makeToken({ sub: "user-member", username: "member", role: "admin" });
    db.insert(users)
      .values({
        id: "user-member",
        username: "user-member",
        passwordHash: "hash",
        displayName: "Member",
        role: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    memberRepo.addMember({ teamId: team.id, userId: "user-member", role: "member" });

    // Non-member of team-abc.
    nonMemberToken = makeToken({ sub: "user-other", username: "other", role: "admin" });

    // Seed a prior release so the trigger doesn't hit first-release-must-declare.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    await releaseTriggerService.detectAndActivate(otherTeamHabitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("anonymous POST → 401", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId, version: "v0.1.1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("agent-authenticated POST to non-team habitat → 200", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId, version: "v0.1.1" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it("human team-member POST to team habitat → 200", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId: otherTeamHabitatId, version: "v0.1.1" },
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("human non-member POST to team habitat → 403", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId: otherTeamHabitatId, version: "v0.1.1" },
      headers: { authorization: `Bearer ${nonMemberToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("agent POST to team habitat → 403 (agents cannot access team habitats)", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId: otherTeamHabitatId, version: "v0.1.1" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("nonexistent habitat → 404", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: { habitatId: "nonexistent-habitat", version: "v0.1.0", releaseType: "patch" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(404);
  });
});
