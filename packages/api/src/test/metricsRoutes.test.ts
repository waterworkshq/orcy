import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { registerErrorHandler } from "../errors/plugin.js";

vi.mock("../services/experienceMetricsService.js", () => ({
  getExperienceMetrics: vi.fn(),
}));

import { metricsRoutes } from "../routes/metrics.js";
import { getExperienceMetrics } from "../services/experienceMetricsService.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function adminToken(): string {
  return makeToken({ sub: "admin-1", username: "admin", role: "admin" });
}

function viewerToken(): string {
  return makeToken({ sub: "viewer-1", username: "viewer", role: "viewer" });
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(metricsRoutes);
  await f.ready();
  return f;
}

describe("metricsRoutes — GET /habitats/:id/experience-metrics", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns metrics for an admin", async () => {
    vi.mocked(getExperienceMetrics).mockReturnValue({
      agents: [],
      medianSignalsTaskRatio: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agents).toEqual([]);
    expect(body.medianSignalsTaskRatio).toBe(0);
    expect(getExperienceMetrics).toHaveBeenCalledWith("hab-1", 30);
  });

  it("rejects a non-admin viewer with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics",
      headers: { authorization: `Bearer ${viewerToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getExperienceMetrics).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics",
    });

    expect(res.statusCode).toBe(401);
    expect(getExperienceMetrics).not.toHaveBeenCalled();
  });

  it("passes the days query param to the service", async () => {
    vi.mocked(getExperienceMetrics).mockReturnValue({
      agents: [],
      medianSignalsTaskRatio: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics?days=7",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(getExperienceMetrics).toHaveBeenCalledWith("hab-1", 7);
  });

  it("passes days=0 for all-time queries", async () => {
    vi.mocked(getExperienceMetrics).mockReturnValue({
      agents: [],
      medianSignalsTaskRatio: 0,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics?days=0",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(getExperienceMetrics).toHaveBeenCalledWith("hab-1", 0);
  });

  it("rejects a negative days param with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/habitats/hab-1/experience-metrics?days=-5",
      headers: { authorization: `Bearer ${adminToken()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(getExperienceMetrics).not.toHaveBeenCalled();
  });
});
