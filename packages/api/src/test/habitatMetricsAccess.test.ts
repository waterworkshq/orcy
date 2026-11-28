import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { timeTrackingRoutes } from "../routes/timeTracking.js";
import * as metricsService from "../services/timeTrackingService.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";

const secret = "habitat-metrics-test-secret-at-least-32-characters";
const token = (id: string) => jwt.sign({ sub: id, username: id, role: "editor" }, secret, { issuer: "orcy" });

describe("habitat metrics access", () => {
  let app: FastifyInstance;
  let habitatId: string;
  let agentKey: string;
  let metrics: MockInstance<typeof metricsService.getHabitatMetrics>;

  beforeEach(async () => {
    await initTestDb();
    setJwtSecret(secret);
    const now = new Date().toISOString();
    for (const id of ["member", "outsider"]) {
      getDb().insert(users).values({ id, username: id, displayName: id, passwordHash: "hash", role: "editor", createdAt: now, updatedAt: now }).run();
    }
    const org = orgRepo.createOrganization({ name: "Test", slug: "test" });
    const team = teamRepo.createTeam({ organizationId: org.id, name: "Team", slug: "team" });
    habitatId = habitatRepo.createHabitat({ name: "Private", teamId: team.id }).id;
    memberRepo.addMember({ teamId: team.id, userId: "member", role: "member" });
    agentKey = agentRepo.createAgent({ name: "agent", type: "codex", domain: "ops" }).plainApiKey;
    metrics = vi.spyOn(metricsService, "getHabitatMetrics");
    app = Fastify({ logger: false });
    await registerErrorHandler(app);
    await app.register(timeTrackingRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeDb();
  });

  it.each(["member", "agent"])("returns the existing metrics shape for an authorized %s", async (actor) => {
    const headers = actor === "agent" ? { "x-agent-api-key": agentKey } : { authorization: `Bearer ${token(actor)}` };
    const response = await app.inject({ method: "GET", url: `/api/habitats/${habitatId}/metrics`, headers });
    expect(response.statusCode).toBe(200);
    expect(metrics).toHaveBeenCalledOnce();
    expect(metrics).toHaveBeenCalledWith(habitatId);
    expect(response.json()).toEqual(metrics.mock.results[0].value);
    expect(response.json()).toMatchObject({ overdueTasks: 0, agentMetrics: [] });
  });

  it("denies a nonmember without querying metrics", async () => {
    const response = await app.inject({ method: "GET", url: `/api/habitats/${habitatId}/metrics`, headers: { authorization: `Bearer ${token("outsider")}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("BOARD_ACCESS_DENIED");
    expect(metrics).not.toHaveBeenCalled();
  });

  it.each(["member", "agent"])("returns 404 for a missing habitat to an authenticated %s without querying metrics", async (actor) => {
    const headers = actor === "agent" ? { "x-agent-api-key": agentKey } : { authorization: `Bearer ${token(actor)}` };
    const response = await app.inject({ method: "GET", url: "/api/habitats/missing/metrics", headers });
    expect(response.statusCode).toBe(404);
    expect(metrics).not.toHaveBeenCalled();
  });
});
