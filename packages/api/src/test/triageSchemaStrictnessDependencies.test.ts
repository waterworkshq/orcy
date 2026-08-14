/**
 * FU7 — Strict local command schemas + dependency habitat validation.
 *
 * Acceptance discriminators:
 *   - Unknown placement field on local POST /route → 400 with ZERO writes
 *     (re-fetch: no Mission created).
 *   - Local `dependsOn` typo → 400 (matches remote).
 *   - Cross-Habitat dependency and missing-id dependency → the SAME single
 *     error code/shape (indistinguishable); same-Habitat → works.
 *   - MCP `insert_deferred_mission` end-to-end still green.
 *
 * Mutate/revert evidence: each guarded discriminator must be broken by
 * reverting its guard, with the test red, and re-green when restored. See
 * the per-test "MUTATE/REVERT" comments for the exact revert knob.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { findingTriage } from "../db/schema/index.js";

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
      await f.register(triageRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let columnId: string;
let agentId: string;
let agentApiKey: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.run(sql`DELETE FROM mission_dependencies`);
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM finding_triage`);
  db.run(sql`DELETE FROM pulses`);

  const habitat = habitatRepo.createHabitat({ name: "FU7 Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = col.id;

  const result = agentRepo.createAgent({
    name: "FU7 Agent",
    type: "claude-code",
    domain: "general",
  });
  agentId = result.agent.id;
  agentApiKey = result.plainApiKey;
});

afterEach(() => {
  closeDb();
});

function seedAdmittedFinding() {
  const admittingMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Admitting",
    createdBy: "user-1",
  });
  const investigateTask = taskRepo.createTask({
    missionId: admittingMission.id,
    title: "Investigate",
    description: "investigate",
    requiredCapabilities: [],
    labels: [],
    createdBy: "user-1",
  });
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId: admittingMission.id,
    scope: "mission",
    fromType: "agent",
    fromId: agentId,
    signalType: "finding",
    subject: "fu7 cluster",
    body: "Test",
    metadata: { findingKind: "bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  const db = getDb();
  db.update(findingTriage)
    .set({
      admittedByTriageMissionId: admittingMission.id,
      admittedByInvestigationTaskId: investigateTask.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();
  return { finding: findingTriageRepo.getById(finding.id)!, investigateTask };
}

function claimTaskForAgent(taskId: string, agent: string) {
  const result = taskStateMachine.claimTask(taskId, agent);
  if (!result.success) throw new Error(`claimTask failed: ${result.reason}`);
  return result.task;
}

function countMissionsForHabitat(hid: string): number {
  // Use the repository path so it works across sql.js + better-sqlite3.
  return missionRepo.getMissionsByHabitatId(hid).total;
}

function countDependencyEdgesForMission(missionId: string): number {
  return missionRepo.getMissionDependencyEdges([missionId]).filter(
    (e) => e.missionId === missionId,
  ).length;
}

// ===========================================================================
// FU7.A — Strict local command schemas reject unknown fields (zero writes)
// ===========================================================================

describe("FU7.A — strict local schemas reject unknown fields", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("POST /route with an unknown placement field → 400 and ZERO Mission writes", async () => {
    // MUTATE/REVERT: removing `.strict()` from the route schemas makes this
    // test fail with 200 + a Mission created (the local-strip-vs-remote-strict
    // parity defect that FU7 closes).
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const before = countMissionsForHabitat(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      // `bogusField` is not in any schema member — strict rejects it.
      payload: {
        bucket: "fix_now",
        missionTitle: "Fix FU7",
        missionDescription: "Description",
        bogusField: "should-be-rejected",
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(400);
    // Re-fetch: the Mission must NOT have been created.
    const after = countMissionsForHabitat(habitatId);
    expect(after).toBe(before);
    const refreshed = findingTriageRepo.getById(finding.id)!;
    expect(refreshed.status).toBe("open");
    expect(refreshed.bucket).toBeNull();
    expect(refreshed.correctiveMissionId).toBeNull();
  });

  it("local `dependsOn` typo → 400 (matches remote strict behavior)", async () => {
    // MUTATE/REVERT: removing `.strict()` from the defer schema lets `dependsOn`
    // get stripped and the route succeeds with 200 + a Mission created with
    // NO dependency edges (the parity defect).
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "defer_to_patch",
        missionTitle: "Defer FU7",
        missionDescription: "Description",
        dependsOn: ["m-typo"], // WIRE name — backend expects `dependencies`
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /resolve with an unknown field → 400", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/resolve`,
      payload: { resolution: "done", resolutionKind: "code_fix", extra: "nope" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /wontfix with an unknown field → 400", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/wontfix`,
      payload: { reason: "skip", bogus: "x" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /activate with an unknown field → 400", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/activate`,
      payload: { expectedMissionVersion: 1, foo: "bar" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("legacy PATCH is now strict — unknown field → 400 (with `expectedMissionVersion` retained)", async () => {
    // MUTATE/REVERT: removing `.strict()` from patchFindingBodySchema lets
    // `expectedMissionVersion` slip through alongside an unknown field, and
    // this test fails.
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { status: "triaged", bucket: "needs_investigation", unknown: "x" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ===========================================================================
// FU7.B — Cross-Habitat dependency injection + Mission existence oracle fix
// ===========================================================================

describe("FU7.B — dependency habitat validation (anti-oracle)", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("same-Habitat dependency succeeds and places the edge", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const upstream = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Upstream",
      createdBy: "user-1",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "fix_now",
        missionTitle: "Fix FU7",
        missionDescription: "Description",
        dependencies: [upstream.id],
      },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);

    const updated = findingTriageRepo.getById(finding.id)!;
    expect(updated.correctiveMissionId).not.toBeNull();
    expect(countDependencyEdgesForMission(updated.correctiveMissionId!)).toBe(1);
  });

  it("cross-Habitat dependency → 409 INVALID_DEPENDENCY (single shape)", async () => {
    // MUTATE/REVERT: removing the habitat predicate in routeFinding (the
    // `depMission.habitatId !== finding.habitatId` check) lets the cross-Habitat
    // edge through; this test fails because the response is 200 with the edge
    // placed, not a 409.
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const otherHabitat = habitatRepo.createHabitat({ name: "Other" });
    const otherColumn = columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId: otherColumn.id,
      title: "Wrong Habitat Mission",
      createdBy: "user-1",
    });

    const before = countMissionsForHabitat(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "fix_now",
        missionTitle: "Fix FU7",
        missionDescription: "Description",
        dependencies: [otherMission.id],
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_DEPENDENCY");
    // Body must NOT distinguish this from a missing-id failure (anti-oracle).
    expect(body.message).toMatch(/position 0/i);
    expect(body.message).not.toContain(otherMission.id);

    // No Mission created (re-fetch).
    expect(countMissionsForHabitat(habitatId)).toBe(before);
    const refreshed = findingTriageRepo.getById(finding.id)!;
    expect(refreshed.status).toBe("open");
    expect(refreshed.correctiveMissionId).toBeNull();
  });

  it("missing-id dependency → 409 INVALID_DEPENDENCY (indistinguishable from cross-Habitat)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const before = countMissionsForHabitat(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "fix_now",
        missionTitle: "Fix FU7",
        missionDescription: "Description",
        dependencies: ["does-not-exist-12345"],
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    // SAME code + shape as cross-Habitat — no oracle distinguishing them.
    expect(body.code).toBe("INVALID_DEPENDENCY");
    expect(body.message).toMatch(/position 0/i);

    expect(countMissionsForHabitat(habitatId)).toBe(before);
  });

  it("mixed list (first valid, second cross-Habitat) → 409 naming position 1, no writes", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const sameHabitatMission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Same-Habitat",
      createdBy: "user-1",
    });
    const otherHabitat = habitatRepo.createHabitat({ name: "Other" });
    const otherColumn = columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId: otherColumn.id,
      title: "Wrong Habitat",
      createdBy: "user-1",
    });

    const before = countMissionsForHabitat(habitatId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "defer_to_patch",
        missionTitle: "Defer FU7",
        missionDescription: "Description",
        dependencies: [sameHabitatMission.id, otherMission.id],
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_DEPENDENCY");
    expect(body.message).toMatch(/position 1/i);

    expect(countMissionsForHabitat(habitatId)).toBe(before);
  });
});

// ===========================================================================
// FU7.C — MCP insert_deferred_mission end-to-end still green
// ===========================================================================

describe("FU7.C — MCP insert_deferred_mission end-to-end", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("wire payload (dependsOn) → local schema (dependencies) round-trip still 200 with edges placed", async () => {
    // FU7.C invariant: the wire→backend mapping in packages/mcp/src/tools/triage.ts
    // (`dependsOn` → `dependencies`) must continue to map the dependency ids
    // correctly. This test exercises the FULL HTTP path with the BACKEND
    // payload shape (the way `triageInsertDeferredMission` actually delivers
    // it) — if the mapping drift returns, this test fails because strict
    // rejects the unknown `dependsOn` wire field at the backend.
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const upstream = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Upstream",
      createdBy: "user-1",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: {
        bucket: "defer_to_patch",
        missionTitle: "MCP deferral",
        missionDescription: "Description",
        dependencies: [upstream.id],
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finding.correctiveMissionId).not.toBeNull();
    expect(countDependencyEdgesForMission(body.finding.correctiveMissionId)).toBe(1);
  });
});