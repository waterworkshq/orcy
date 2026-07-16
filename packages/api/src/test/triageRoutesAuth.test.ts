import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as agentRepo from "../repositories/agent.js";
import { pulses } from "../db/schema/index.js";

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

let habitatId: string;
let otherHabitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;
let agentApiKey: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Triage Auth Habitat" });
  habitatId = habitat.id;
  const other = habitatRepo.createHabitat({ name: "Other Habitat" });
  otherHabitatId = other.id;

  const col = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = col.id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Test Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;

  const result = agentRepo.createAgent({
    name: "Test Agent",
    type: "claude-code",
    domain: "general",
  });
  agentId = result.agent.id;
  agentApiKey = result.plainApiKey;

  // Seed a finding pulse + finding triage record for testing
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: agentId,
    signalType: "finding",
    subject: "Test finding for auth",
    body: "Test body",
    metadata: { findingKind: "bug" },
  });
  findingTriageRepo.createForPulse(pulse);
});

afterEach(() => {
  closeDb();
});

describe("Triage Route Authentication", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("anonymous GET /triage/findings returns 401", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/findings?habitatId=${habitatId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /triage/clusters/top returns 401", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/clusters/top?habitatId=${habitatId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous GET /triage/resolutions returns 401", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/resolutions?habitatId=${habitatId}&clusterKey=test`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous PATCH /triage/findings/:id returns 401", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findings[0].id}`,
      payload: { bucket: "fix_now" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("agent-authenticated GET /triage/findings succeeds for non-team habitat", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/findings?habitatId=${habitatId}`,
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings).toBeDefined();
    expect(body.findings.length).toBeGreaterThan(0);
  });

  it("agent-authenticated GET /triage/findings returns 404 for nonexistent habitat", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/findings?habitatId=nonexistent-habitat`,
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(404);
  });

  it("agent-authenticated PATCH /triage/findings/:id succeeds", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findings[0].id}`,
      payload: { bucket: "fix_now", status: "triaged" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
  });

  it("RM-10: agent-authenticated PATCH /triage/findings/:id with triageMissionId:null unlinks (no longer 400)", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const findingId = findings[0].id;
    // First link the finding to the seeded mission, then clear it.
    findingTriageRepo.setTriageMissionId(findingId, missionId);
    expect(findingTriageRepo.getById(findingId)!.triageMissionId).toBe(missionId);

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findingId}`,
      payload: { triageMissionId: null },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(findingTriageRepo.getById(findingId)!.triageMissionId).toBeNull();
  });

  it("human-authenticated GET /triage/findings succeeds for non-team habitat", async () => {
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "GET",
      url: `/api/triage/findings?habitatId=${habitatId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
