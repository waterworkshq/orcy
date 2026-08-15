import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
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

  it("human-authenticated PATCH /triage/findings/:id no-work shape is retired (400 LEGACY_PATCH_RETIRED)", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findings[0].id}`,
      // The legacy PATCH adapter was RETIRED (FU13): every shape — including
      // the formerly accepted no-work one — gets the single retirement
      // response. Work-bearing buckets were already command-only.
      payload: { bucket: "document_as_known_limitation", status: "triaged" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");
  });

  it("PATCH /triage/findings/:id with work-bearing bucket is retired", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findings[0].id}`,
      payload: { bucket: "fix_now", status: "triaged" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");
  });

  it("agent-authenticated PATCH /triage/findings/:id no-work is retired (auth passes, authority never runs)", async () => {
    // Legacy/un-admitted rows have `admittedByInvestigationTaskId = null`. The
    // retired stub fires after auth but before any authority check or write.
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findings[0].id}`,
      payload: { bucket: "document_as_known_limitation", status: "triaged" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");
  });

  it("FU13: PATCH /triage/findings/:id with triageMissionId:null returns 400 LEGACY_PATCH_RETIRED with zero writes", async () => {
    const findings = findingTriageRepo.findByHabitat(habitatId);
    const findingId = findings[0].id;
    // Seed a link, then attempt the retired unlink shape. It used to bypass
    // the actor matrix entirely (any local agent key could sever the link);
    // the adapter is now retired — assert the single 400 code + no writes.
    findingTriageRepo.setTriageMissionId(findingId, missionId);
    expect(findingTriageRepo.getById(findingId)!.triageMissionId).toBe(missionId);

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findingId}`,
      payload: { triageMissionId: null },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { code?: string };
    expect(body.code).toBe("LEGACY_PATCH_RETIRED");
    // Zero writes: the link survives untouched.
    const after = findingTriageRepo.getById(findingId)!;
    expect(after.triageMissionId).toBe(missionId);
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
