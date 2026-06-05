import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { habitatAnalyticsRoutes } from "../routes/board-analytics.js";
import { habitatExportRoutes } from "../routes/board-export.js";
import { auditExportRoutes } from "../routes/auditExport.js";
import { sprintRoutes } from "../routes/sprints.js";
import { agentRoutes } from "../routes/agents.js";
import { authRoutes } from "../routes/auth.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatRoutes);
      await f.register(habitatAnalyticsRoutes);
      await f.register(habitatExportRoutes);
      await f.register(auditExportRoutes);
      await f.register(sprintRoutes);
      await f.register(agentRoutes);
      await f.register(authRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

describe("Habitat Route Authentication", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("anonymous GET /habitats/:id returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Test Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/stats returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Stats Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}/stats` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/events returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Events Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}/events` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/anomalies returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Anomaly Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}/anomalies` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/capacity returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Cap Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}/capacity` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/predictions returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Pred Habitat" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/predictions`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/burndown returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Burndown Habitat" });
    const res = await app!.inject({ method: "GET", url: `/api/habitats/${habitat.id}/burndown` });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/cumulative-flow returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "CF Habitat" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/cumulative-flow`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/bottlenecks returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "BN Habitat" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/bottlenecks`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/agent-quality returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "AQ Habitat" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/agent-quality`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /habitats/:id/audit/events returns 401", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const habitat = createHabitat({ name: "Audit Habitat" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}/audit/events`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticated unauthorized human cannot read another team habitat", async () => {
    const { createHabitat } = await import("../repositories/board.js");
    const { createTeam } = await import("../repositories/team.js");
    const { createOrganization } = await import("../repositories/organization.js");

    const org = createOrganization({ name: "Org A", slug: "org-a-int" });
    const team = createTeam({ organizationId: org.id, name: "Team X", slug: "team-x-int" });
    const habitat = createHabitat({ name: "Protected Habitat", teamId: team.id });

    const token = makeToken({ sub: "stranger", username: "stranger", role: "viewer" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitat.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Agent Route Authentication", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("anonymous GET /agents returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /agents/:id returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/agents/nonexistent-id" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /agents/:id/stats returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/agents/nonexistent-id/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /agents/stats returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/agents/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /agents/:id/suggestions returns 401", async () => {
    const res = await app!.inject({
      method: "GET",
      url: "/api/agents/nonexistent-id/suggestions?habitatId=x",
    });
    expect(res.statusCode).toBe(401);
  });

  it("authenticated human can list agents", async () => {
    const token = makeToken({ sub: "user-1", username: "testuser", role: "admin" });
    const res = await app!.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agents).toBeDefined();
  });

  it("agent with API key can list agents", async () => {
    const agentService = await import("../services/agentService.js");
    const { plainApiKey } = agentService.createAgent({
      name: "Auth Test Agent",
      type: "claude-code",
      domain: "fullstack",
      capabilities: ["typescript"],
    });
    const res = await app!.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-agent-api-key": plainApiKey },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Sprint Route Authentication", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("anonymous GET /sprints/:id/metrics returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/sprints/nonexistent/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /sprints/:id/burndown returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/sprints/nonexistent/burndown" });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /sprints/:id/carry-over returns 401", async () => {
    const res = await app!.inject({ method: "GET", url: "/api/sprints/nonexistent/carry-over" });
    expect(res.statusCode).toBe(401);
  });
});
