/**
 * T4 — Restored Finding Triage lifecycle: intent-route authority, lifecycle
 * HTTP transport, and the strict legacy PATCH compatibility matrix.
 *
 * Covers:
 *   - Local agent: route succeeds ONLY when currently claiming the admitted
 *     Task; route denied otherwise (unrelated/stale/released/completed claim).
 *   - Human: route/activate/resolve/wontfix; resolve/wontfix human-only.
 *   - T5 activate transport: expectedMissionVersion required (400 when
 *     omitted); activate is human-only (agent 403).
 *   - Legacy PATCH matrix: no-work accepted, work-bearing rejected, mixed
 *     rejected, target-release rejected, terminal-rejected, link-only first
 *     apply validated, stored-fingerprint replay before predicates.
 *   - Mutate/revert evidence for the exact-Task claim predicate and the
 *     stored-fingerprint-replay ordering.
 *   - Remote /api/shared route: active contributor + same active grant with
 *     both proofs → 200; observer/grace/baseline/rule-based/split/stale/
 *     disconnected all → 403; missing-finding → 403 (anti-probing).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { remoteAccessRoutes } from "../routes/remoteAccess.js";
import { sharedApiRoutes } from "../routes/sharedApi.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as agentRepo from "../repositories/agent.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { eq, sql } from "drizzle-orm";
import { findingTriage, tasks, users, organizations, habitats, teamMembers } from "../db/schema/index.js";
import { getDb } from "../db/index.js";
import { routeFinding as routeFindingLifecycle } from "../services/findingTriageLifecycle.js";

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

async function buildSharedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(sharedApiRoutes);
    },
    { prefix: "/api/shared" },
  );
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let habitatId: string;
let columnId: string;
let agentId: string;
let agentApiKey: string;
let otherAgentId: string;
let otherAgentApiKey: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM finding_triage`);
  db.run(sql`DELETE FROM pulses`);

  const habitat = habitatRepo.createHabitat({ name: "Triage Intent Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = col.id;

  const result = agentRepo.createAgent({
    name: "Claimant Agent",
    type: "claude-code",
    domain: "general",
  });
  agentId = result.agent.id;
  agentApiKey = result.plainApiKey;

  const other = agentRepo.createAgent({
    name: "Other Agent",
    type: "claude-code",
    domain: "general",
  });
  otherAgentId = other.agent.id;
  otherAgentApiKey = other.plainApiKey;
});

afterEach(() => {
  closeDb();
});

/**
 * Seeds a finding WITH an admitted investigation Task id. Returns the finding,
 * the seeded Task, and the admitting Mission.
 */
function seedAdmittedFinding(opts: {
  clusterKey?: string;
  findingKind?: string;
} = {}) {
  const clusterKey = opts.clusterKey ?? "test-cluster";
  const findingKind = opts.findingKind ?? "bug";

  const admittingMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Admitting Triage Mission",
    createdBy: "user-1",
  });
  const investigateTask = taskRepo.createTask({
    missionId: admittingMission.id,
    title: "Investigate",
    description: "investigate the cluster",
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
    subject: clusterKey,
    body: "Test body",
    metadata: { findingKind },
  });
  const finding = findingTriageRepo.createForPulse(pulse);

  // Stamp the admitted investigation Task id (the cluster participant does
  // this in production — for tests we set it directly via SQL).
  const db = getDb();
  db.update(findingTriage)
    .set({
      admittedByTriageMissionId: admittingMission.id,
      admittedByInvestigationTaskId: investigateTask.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();

  const refreshed = findingTriageRepo.getById(finding.id)!;
  return { finding: refreshed, admittingMission, investigateTask };
}

/** Make the agent the current claimant of the task. */
function claimTaskForAgent(taskId: string, agent: string) {
  const result = taskStateMachine.claimTask(taskId, agent);
  if (!result.success) {
    throw new Error(`claimTask failed: ${result.reason}`);
  }
  return result.task;
}

// ===========================================================================
// Local intent HTTP routes
// ===========================================================================

describe("T4 — Local intent routes: route/resolve/wontfix", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------- route --------------------

  it("local agent currently claiming the admitted Task can route a no-work bucket", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);

    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finding.status).toBe("triaged");
    expect(body.finding.bucket).toBe("document_as_known_limitation");
  });

  it("local agent NOT currently claiming the admitted Task is denied (anti-probing-ish: 403)", async () => {
    const { finding } = seedAdmittedFinding();
    // No claim made — agent is not the current claimant.
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("unrelated agent (different identity) is denied", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": otherAgentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("human with valid token can route", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("agent routing rejects malformed body (validation 400)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "fix_now" /* missing missionTitle/Description */ },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(400);
  });

  it("routing a terminal finding returns 409 FINDING_TERMINAL", async () => {
    const { finding } = seedAdmittedFinding();
    // Force the finding to resolved (terminal).
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        resolvedByType: "human",
        resolvedById: "user-1",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("FINDING_TERMINAL");
  });

  // -------------------- resolve --------------------

  it("human can resolve a finding", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/resolve`,
      payload: { resolution: "fixed in PR #123", resolutionKind: "code_fix" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).finding.status).toBe("resolved");
  });

  it("agent CANNOT resolve (human-only)", async () => {
    const { finding } = seedAdmittedFinding();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/resolve`,
      payload: { resolution: "agent fix", resolutionKind: "code_fix" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------- wontfix --------------------

  it("human can mark wontfix", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/wontfix`,
      payload: { reason: "out of scope" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).finding.status).toBe("wontfix");
  });

  it("agent CANNOT mark wontfix (human-only)", async () => {
    const { finding } = seedAdmittedFinding();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/wontfix`,
      payload: { reason: "agent wontfix" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------- activate (T5 kernel) --------------------

  it("POST /activate requires expectedMissionVersion (400 when omitted)", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/activate`,
      payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("EXPECTED_MISSION_VERSION_REQUIRED");
  });

  it("POST /activate is human-only: agent returns 403", async () => {
    const { finding } = seedAdmittedFinding();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/activate`,
      payload: { expectedMissionVersion: 1 },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------- FU1: stale-claim denial (local agent) --------------------
  //
  // The submitted/approved/done states RETAIN `assignedAgentId`. A pre-fix
  // authority predicate that checks assignment equality lets the previous
  // claimant route after the Task left the claimable set. FU1 closes this by
  // requiring status IN ('claimed','in_progress') AND by re-reading the Task
  // row inside the lifecycle transaction (closing the precheck→mutation TOCTOU
  // window).

  function startTaskAsAgent(taskId: string, agent: string): void {
    const started = taskStateMachine.startTask(taskId, agent);
    if (!started) throw new Error("startTask failed");
  }

  function submitTaskAsAgent(taskId: string, agent: string): void {
    const submitted = taskStateMachine.submitTask(taskId, agent, "result", []);
    if (!submitted) throw new Error("submitTask failed");
  }

  it("FU1 local agent: submitted Task claim is denied (stale-claim TOCTOU)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    startTaskAsAgent(investigateTask.id, agentId);
    submitTaskAsAgent(investigateTask.id, agentId);
    // Task is now status='submitted' but assignedAgentId is STILL agentId
    // (submitTask does not clear assignment). The authority predicate must
    // refuse — the route must reject.
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 local agent: approved Task claim is denied (stale-claim TOCTOU)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    startTaskAsAgent(investigateTask.id, agentId);
    submitTaskAsAgent(investigateTask.id, agentId);
    taskStateMachine.approveTask(investigateTask.id);
    // Task is now status='approved'; assignment still retained.
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 local agent: done Task claim is denied (stale-claim TOCTOU)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    startTaskAsAgent(investigateTask.id, agentId);
    submitTaskAsAgent(investigateTask.id, agentId);
    taskStateMachine.approveTask(investigateTask.id);
    taskStateMachine.markTaskDone(investigateTask.id);
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 local agent: released Task claim is denied (stale-claim TOCTOU)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    claimTaskForAgent(investigateTask.id, agentId);
    taskStateMachine.releaseTask(investigateTask.id, "manual release");
    // Task is now status='pending' AND assignment cleared. Stale claim must
    // still deny even if assignment weren't cleared.
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 in-tx recheck (local): claim released AFTER precheck but BEFORE mutation is denied", async () => {
    // Simulates the precheck→mutation TOCTOU window deterministically: seed
    // a valid claim, then release the claim BEFORE invoking routeFinding.
    // The lifecycle kernel must re-read the Task row on the supplied client
    // and refuse. The Finding must remain untouched (zero writes).
    const { finding, investigateTask } = seedAdmittedFinding();
    const claimRes = taskStateMachine.claimTask(investigateTask.id, agentId);
    expect(claimRes.success).toBe(true);

    // Simulate a concurrent release (the TOCTOU window) BEFORE the lifecycle
    // kernel runs its own in-tx recheck. The release clears assignment and
    // sets status='pending'. After the release, the kernel's in-tx predicate
    // re-reads the Task row — must refuse.
    const db = getDb();
    db.transaction((tx) => {
      tx.update(tasks)
        .set({ assignedAgentId: null, status: "pending", updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, investigateTask.id))
        .run();
    });

    const lifecycleResult = routeFindingLifecycle({
      findingId: finding.id,
      actor: {
        type: "agent",
        id: agentId,
        authority: { habitatAccess: undefined, remote: undefined },
      },
      route: { bucket: "document_as_known_limitation" },
    });

    expect(lifecycleResult.outcome).toBe("conflict");
    if (lifecycleResult.outcome === "conflict") {
      expect(lifecycleResult.reason).toBe("not_authorized");
    }

    // Verify zero writes — the Finding is still in its initial non-triaged
    // status and has no route fingerprint.
    const after = findingTriageRepo.getById(finding.id);
    expect(after).toBeTruthy();
    expect(after!.routeFingerprint).toBeNull();
    expect(after!.status).toBe("open");
  });
});

// ===========================================================================
// Strict legacy PATCH compatibility matrix
// ===========================================================================

describe("T4 — Strict legacy PATCH matrix", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("accepts no-work {status:'triaged', bucket:'document_as_known_limitation'} for human", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { bucket: "document_as_known_limitation", status: "triaged" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).finding.bucket).toBe("document_as_known_limitation");
  });

  it("accepts no-work {status:'triaged', bucket:'needs_investigation'} for human", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { bucket: "needs_investigation", status: "triaged" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects work-bearing bucket (fix_now/defer_to_*) via PATCH — must route through POST /:id/route", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { bucket: "fix_now", status: "triaged" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_WORK_BEARING_REJECTED");
  });

  it("rejects target-release mutations (superseded)", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { targetRelease: "v1.0.0" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_TARGET_RELEASE_SUPERSEDED");
  });

  it("rejects terminal status via PATCH (must use /resolve or /wontfix)", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { status: "resolved" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_TERMINAL_REQUIRES_RESOLUTION");
  });

  it("rejects mixed legacy PATCH shapes (status + link)", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        bucket: "document_as_known_limitation",
        status: "triaged",
        triageMissionId: "some-mission",
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_MIXED");
  });

  it("rejects legacy link-only PATCH without expectedMissionVersion", async () => {
    const { finding } = seedAdmittedFinding();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: { triageMissionId: "some-mission" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_VERSION_REQUIRED");
  });

  // ----- Link-only first apply -----

  it("legacy link-only first apply rejects an un-triaged Finding", async () => {
    const { finding } = seedAdmittedFinding();
    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Corrective",
      createdBy: "user-1",
    });
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_NOT_TRIAGED_DEFERRAL");
  });

  it("legacy link-only first apply rejects a non-gated Mission", async () => {
    const { finding } = seedAdmittedFinding();
    // Triaged deferral first (via PATCH no-work would set 'document_as_known_limitation';
    // use the lifecycle kernel to route as a deferral bucket directly via the API).
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const routeRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(routeRes.statusCode).toBe(200);

    // Switch to a deferral bucket via PATCH (legal — bucket-only update).
    // Actually, the route is locked once applied (different_route). Use SQL to
    // force the bucket to defer_to_patch for the test.
    const db = getDb();
    db.update(findingTriage)
      .set({ bucket: "defer_to_patch", updatedAt: new Date().toISOString() })
      .where(eq(findingTriage.id, finding.id))
      .run();

    // Mission without releaseGateType — must be rejected.
    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Ungated Corrective",
      createdBy: "user-1",
    });

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_NOT_GATED");
  });

  it("legacy link-only first apply succeeds for valid deferral + gated + version-matched Mission", async () => {
    const { finding } = seedAdmittedFinding();
    // Set the finding to triaged + defer_to_patch via lifecycle kernel.
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    // We can't route via defer bucket in the current no-work only world — use
    // the SQL direct set for the test (this is internal lifecycle state, the
    // first-apply path validates against the persisted state).
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "triaged",
        bucket: "defer_to_patch",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();

    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Gated Corrective",
      createdBy: "user-1",
      releaseGateType: "minor",
      releaseGateVersion: "1.2.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).finding.correctiveMissionId).toBe(corrective.id);
  });

  it("legacy link-only first apply rejects version mismatch", async () => {
    const { finding } = seedAdmittedFinding();
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "triaged",
        bucket: "defer_to_patch",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();

    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Gated Corrective",
      createdBy: "user-1",
      releaseGateType: "minor",
      releaseGateVersion: "1.2.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version + 99,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_VERSION_MISMATCH");
  });

  it("legacy link-only first apply rejects cross-Habitat Mission", async () => {
    const { finding } = seedAdmittedFinding();
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "triaged",
        bucket: "defer_to_patch",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();

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
      releaseGateType: "minor",
      releaseGateVersion: "1.0.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: otherMission.id,
        expectedMissionVersion: otherMission.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_HABITAT_MISMATCH");
  });

  // ----- Stored-fingerprint replay before predicates -----

  it("legacy link-only STORED-FINGERPRINT REPLAY succeeds BEFORE no-link/version predicates (mutate/revert ordering)", async () => {
    const { finding } = seedAdmittedFinding();
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "triaged",
        bucket: "defer_to_patch",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();

    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Gated Corrective",
      createdBy: "user-1",
      releaseGateType: "minor",
      releaseGateVersion: "1.2.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    // Commit the legacy link via PATCH (this writes a stored fingerprint + link).
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const firstRes = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(firstRes.statusCode).toBe(200);

    // Now simulate a "lost response" — the client retries with a STALE
    // expectedMissionVersion (the Mission has been bumped since the original
    // commit). The stored-fingerprint replay must WIN before the version
    // predicate; the stale version is ignored.
    const stale = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version - 1,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.statusCode).toBe(200);
    expect(JSON.parse(stale.body).replay).toBe(true);
  });

  it("legacy link-only NON-MATCHING link falls through to the no-link predicate and rejects", async () => {
    // Mutate/revert: ensure the no-link guard still rejects when the stored
    // fingerprint does not match the requested mission id.
    const { finding } = seedAdmittedFinding();
    const committed = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Committed Corrective",
      createdBy: "user-1",
      releaseGateType: "minor",
      releaseGateVersion: "1.2.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "triaged",
        bucket: "defer_to_patch",
        triageMissionId: committed.id,
        routeFingerprint: "stored-fp",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();

    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });
    const corrective = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Different Corrective",
      createdBy: "user-1",
      releaseGateType: "minor",
      releaseGateVersion: "1.2.0",
    } as Parameters<typeof missionRepo.createMission>[0]);

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    // Finding already has a stored link (committed); request for a different
    // mission fails the stored-fingerprint match and is rejected by the
    // no-link predicate (Finding is already linked).
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_ALREADY_LINKED");
  });
});

// ===========================================================================
// Remote /api/shared route command
// ===========================================================================

interface RemoteSetup {
  habitatId: string;
  podId: string;
  participantId: string;
  credentialSecret: string;
  grantId: string;
}

function setupRemote(habitatIdArg: string, opts: {
  actionScopes?: string[];
  standing?: "remote_contributor" | "remote_observer";
  addTaskTarget?: string;
  addMissionTarget?: string;
  ruleBased?: boolean;
} = {}): RemoteSetup {
  const pod = podRepo.createRemotePod({ habitatId: habitatIdArg, name: "RP" });
  const activatedPod = podRepo.activateRemotePod(pod.id) ?? pod;
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: activatedPod.id,
    habitatId: habitatIdArg,
    participantType: "remote_orcy",
    displayName: "RW",
    standing: opts.standing ?? "remote_contributor",
  });
  const activatedParticipant =
    participantRepo.activateRemoteParticipant(participant.id) ?? participant;
  const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: activatedParticipant.id,
    habitatId: habitatIdArg,
    credentialType: "api",
    label: "test",
  });
  void credential;
  const grant = grantRepo.createRemoteGrant({
    habitatId: habitatIdArg,
    remotePodId: activatedPod.id,
    remoteParticipantId: activatedParticipant.id,
    grantType: "scoped_elevation",
    standing: opts.standing ?? "remote_contributor",
    actionScopes: (opts.actionScopes ?? [
      "read",
      "comment",
      "triage.route",
    ]) as Parameters<typeof grantRepo.createRemoteGrant>[0]["actionScopes"],
    eligibilityMode: opts.ruleBased ? "rule_based" : "allowlist",
  });
  if (opts.addTaskTarget) {
    grantRepo.addRemoteGrantTarget(grant.id, "task", opts.addTaskTarget);
  }
  if (opts.addMissionTarget) {
    grantRepo.addRemoteGrantTarget(grant.id, "mission", opts.addMissionTarget);
  }
  return {
    habitatId: habitatIdArg,
    podId: activatedPod.id,
    participantId: activatedParticipant.id,
    credentialSecret: plaintextSecret,
    grantId: grant.id,
  };
}

describe("T4 — Remote /api/shared route command + claim-bound authority", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildSharedApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("active contributor + live exact claim + same active grant with both proofs → 200", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);

    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-1-active-contributor",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finding.status).toBe("triaged");
  });

  it("observer standing never authorizes (403, no existence leak)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, {
      standing: "remote_observer",
      actionScopes: ["read", "comment", "triage.route"],
      addTaskTarget: investigateTask.id,
    });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);

    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-2-observer",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    // Anti-probing: the failure collapses to a single 403.
    expect(res.statusCode).toBe(403);
  });

  it("contributor without live Task claim fails (403, no existence leak)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    // No claim made.

    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-3-no-claim",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("contributor with claim but grant lacks the exact Task target fails (403)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    // Grant targets a DIFFERENT task id (in the same habitat/mission).
    const otherAdmittingMission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Other Admitting",
      createdBy: "user-1",
    });
    const otherTask = taskRepo.createTask({
      missionId: otherAdmittingMission.id,
      title: "Other",
      description: "x",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const setup = setupRemote(habitatId, { addTaskTarget: otherTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);

    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-4-wrong-target",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("contributor with rule_based grant fails (rule_based never satisfies the exact-Task predicate)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, {
      ruleBased: true,
      addTaskTarget: investigateTask.id,
    });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);

    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-5-rule-based",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("non-existent Finding returns 403 (anti-probing: same code as auth denial)", async () => {
    const setup = setupRemote(habitatId);
    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/does-not-exist/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "test-key-6-no-finding",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("Idempotency-Key replay returns the stored response", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);

    const headers = {
      "x-orcy-remote-key": setup.credentialSecret,
      "idempotency-key": "replay-test-key",
    };
    const first = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers,
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers,
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-orcy-idempotent-replay"]).toBe("true");
  });

  // ----- FU1: stale-claim denial (remote) -----

  it("FU1 remote: stale-claim (submitted) is denied (403, anti-probing)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);
    const started = taskStateMachine.startTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    if (!started) throw new Error("startTaskByRemoteParticipant failed");
    const submitted = taskStateMachine.submitTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
      "result",
      [],
    );
    if (!submitted) throw new Error("submitTaskByRemoteParticipant failed");
    // status='submitted'; remoteAssignedParticipantId still set. Must 403.
    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "fu1-stale-claim-submitted",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 remote: stale-claim (released) is denied (403, anti-probing)", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);
    const released = taskStateMachine.releaseTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    if (!released) throw new Error("releaseTaskByRemoteParticipant failed");
    // status='pending'; remoteAssignedParticipantId cleared. Must 403.
    const res = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "fu1-stale-claim-released",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("FU1 remote: stale-claim + missing-finding + cross-habitat are indistinguishable 403", async () => {
    // Anti-probing: the same status (403), byte-identical body, and
    // equivalent work-must-be-done must surface for every probe path. This
    // is the timing/identity oracle collapse for the remote surface.
    //
    // Probe 1: stale-claim (real finding, claim moved to `submitted`).
    // Probe 2: missing-Finding id (`does-not-exist`).
    // Probe 3: cross-Habitat — Finding exists but in a different habitat.
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);
    taskStateMachine.startTaskByRemoteParticipant(investigateTask.id, setup.participantId);
    taskStateMachine.submitTaskByRemoteParticipant(investigateTask.id, setup.participantId, "r", []);

    const probeStaleClaim = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "fu1-probe-stale",
      },
      payload: { bucket: "document_as_known_limitation" },
    });

    const probeMissing = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/does-not-exist/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "fu1-probe-missing",
      },
      payload: { bucket: "document_as_known_limitation" },
    });

    // Status + body must be byte-identical across probes.
    expect(probeStaleClaim.statusCode).toBe(403);
    expect(probeMissing.statusCode).toBe(403);
    expect(probeStaleClaim.body).toBe(probeMissing.body);

    // Cross-Habitat: a finding in a different habitat the remote is not
    // member of — must also produce identical 403.
    const otherHabitat = habitatRepo.createHabitat({ name: "Cross-Habitat" });
    const otherCol = columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId: otherCol.id,
      title: "Cross",
      createdBy: "user-1",
    });
    const otherTask = taskRepo.createTask({
      missionId: otherMission.id,
      title: "Cross task",
      description: "x",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const otherPulse = pulseRepo.createPulse({
      habitatId: otherHabitat.id,
      missionId: otherMission.id,
      scope: "mission",
      fromType: "agent",
      fromId: agentId,
      signalType: "finding",
      subject: "cross-cluster",
      body: "x",
      metadata: { findingKind: "bug" },
    });
    const otherFinding = findingTriageRepo.createForPulse(otherPulse);
    getDb()
      .update(findingTriage)
      .set({
        admittedByTriageMissionId: otherMission.id,
        admittedByInvestigationTaskId: otherTask.id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, otherFinding.id))
      .run();

    const probeCrossHabitat = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${otherFinding.id}/route`,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": "fu1-probe-cross-habitat",
      },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(probeCrossHabitat.statusCode).toBe(403);
    expect(probeCrossHabitat.body).toBe(probeMissing.body);
  });
});

// ===========================================================================
// FU5 — Remote outcome mapper mirrors local typed lifecycle codes 1:1
// ===========================================================================

describe("FU5 — remote route returns typed lifecycle codes byte-equal to local", () => {
  let localApp: FastifyInstance | null = null;
  let remoteApp: FastifyInstance | null = null;

  beforeEach(async () => {
    localApp = await buildApp();
    remoteApp = await buildSharedApp();
  });
  afterEach(async () => {
    if (localApp) await localApp.close();
    if (remoteApp) await remoteApp.close();
  });

  const humanToken = () => makeToken({ sub: "user-1", username: "test", role: "admin" });
  const noWork = { bucket: "document_as_known_limitation" };
  const investigation = { bucket: "needs_investigation" };
  const fixNowBadDep = {
    bucket: "fix_now",
    missionTitle: "Fix",
    missionDescription: "Desc",
    dependencies: ["missing-dep-1"],
  };

  async function localRoute(findingId: string, payload: object) {
    return localApp!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/route`,
      payload,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
  }

  async function remoteRoute(
    findingId: string,
    payload: object,
    setup: RemoteSetup,
    key: string,
  ) {
    return remoteApp!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${findingId}/route`,
      payload,
      headers: {
        "x-orcy-remote-key": setup.credentialSecret,
        "idempotency-key": key,
      },
    });
  }

  /** The wire error shape clients branch on (status + code + message). */
  function errorShape(res: { statusCode: number; body: string }) {
    const body = JSON.parse(res.body) as { code?: string; message?: string };
    return { status: res.statusCode, code: body.code, message: body.message };
  }

  function claimRemotely(setup: RemoteSetup, taskId: string) {
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(taskId, setup.participantId);
    expect(claimRes.success).toBe(true);
  }

  function forceTerminal(findingId: string) {
    const db = getDb();
    db.update(findingTriage)
      .set({
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        resolvedByType: "human",
        resolvedById: "user-1",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, findingId))
      .run();
  }

  function setLegacyRepair(findingId: string) {
    getDb().run(sql`UPDATE finding_triage SET legacy_lineage_repair_required = 1 WHERE id = ${findingId}`);
  }

  it("terminal → 409 FINDING_TERMINAL (status + code + message byte-equal)", async () => {
    const lf = seedAdmittedFinding();
    forceTerminal(lf.finding.id);
    const localRes = await localRoute(lf.finding.id, noWork);
    expect(errorShape(localRes)).toEqual({
      status: 409,
      code: "FINDING_TERMINAL",
      message: "Finding is in terminal state (resolved). Recurrence creates a new row.",
    });

    const rf = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: rf.investigateTask.id });
    claimRemotely(setup, rf.investigateTask.id);
    forceTerminal(rf.finding.id);
    const remoteRes = await remoteRoute(rf.finding.id, noWork, setup, "fu5-terminal");
    expect(errorShape(remoteRes)).toEqual(errorShape(localRes));
  });

  it("different_route → 409 DIFFERENT_ROUTE (status + code + message byte-equal)", async () => {
    const lf = seedAdmittedFinding();
    expect((await localRoute(lf.finding.id, noWork)).statusCode).toBe(200);
    const localRes = await localRoute(lf.finding.id, investigation);
    expect(errorShape(localRes)).toEqual({
      status: 409,
      code: "DIFFERENT_ROUTE",
      message: "Finding already routed with a different bucket/fingerprint.",
    });

    const rf = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: rf.investigateTask.id });
    claimRemotely(setup, rf.investigateTask.id);
    expect((await remoteRoute(rf.finding.id, noWork, setup, "fu5-dr-1")).statusCode).toBe(200);
    const remoteRes = await remoteRoute(rf.finding.id, investigation, setup, "fu5-dr-2");
    expect(errorShape(remoteRes)).toEqual(errorShape(localRes));
  });

  it("legacy_lineage_repair_required → 409 LEGACY_LINEAGE_REPAIR_REQUIRED (byte-equal)", async () => {
    const lf = seedAdmittedFinding();
    setLegacyRepair(lf.finding.id);
    const localRes = await localRoute(lf.finding.id, noWork);
    expect(errorShape(localRes)).toEqual({
      status: 409,
      code: "LEGACY_LINEAGE_REPAIR_REQUIRED",
      message:
        "Finding legacy lineage repair required before automatic routing; operator action needed.",
    });

    const rf = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: rf.investigateTask.id });
    claimRemotely(setup, rf.investigateTask.id);
    setLegacyRepair(rf.finding.id);
    const remoteRes = await remoteRoute(rf.finding.id, noWork, setup, "fu5-legacy");
    expect(errorShape(remoteRes)).toEqual(errorShape(localRes));
  });

  it("invalid_dependency → 409 INVALID_DEPENDENCY (status + code + message byte-equal)", async () => {
    const lf = seedAdmittedFinding();
    const localRes = await localRoute(lf.finding.id, fixNowBadDep);
    expect(errorShape(localRes)).toEqual({
      status: 409,
      code: "INVALID_DEPENDENCY",
      message: "Dependency at position 0 is not a valid same-Habitat Mission.",
    });

    const rf = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: rf.investigateTask.id });
    claimRemotely(setup, rf.investigateTask.id);
    const remoteRes = await remoteRoute(rf.finding.id, fixNowBadDep, setup, "fu5-dep-1");
    expect(errorShape(remoteRes)).toEqual(errorShape(localRes));
  });
});

// ===========================================================================
// FU6 — viewer role gate, triage.route provisioning, unlink removal, link
// actor binding + atomicity
// ===========================================================================

async function buildAdminApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(remoteAccessRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

/** Inserts a real users row (the in-tx gate re-reads `users.role`). */
function seedUserRow(id: string, role: "admin" | "editor" | "viewer"): void {
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", role })
    .run();
}

/** Attaches a fresh team to the habitat; returns the team id. */
function attachTeamToHabitat(habitatIdArg: string): string {
  const db = getDb();
  const suffix = Math.random().toString(36).slice(2, 10);
  db.insert(organizations)
    .values({ id: `org-${suffix}`, name: "Org", slug: `org-${suffix}` })
    .run();
  const team = teamRepo.createTeam({
    organizationId: `org-${suffix}`,
    name: "Team",
    slug: `team-${suffix}`,
  });
  db.update(habitats)
    .set({ teamId: team.id })
    .where(eq(habitats.id, habitatIdArg))
    .run();
  return team.id;
}

/** Forces a finding into the legacy first-link-eligible state. */
function forceDeferredTriaged(findingId: string): void {
  getDb()
    .update(findingTriage)
    .set({ status: "triaged", bucket: "defer_to_patch", updatedAt: new Date().toISOString() })
    .where(eq(findingTriage.id, findingId))
    .run();
}

function createGatedMission() {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title: "Gated Corrective",
    createdBy: "user-1",
    releaseGateType: "minor",
    releaseGateVersion: "1.2.0",
  } as Parameters<typeof missionRepo.createMission>[0]);
}

describe("FU6 — viewer role gate on all four intent endpoints", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  const viewerToken = () => makeToken({ sub: "viewer-1", username: "v", role: "viewer" });
  const editorToken = () => makeToken({ sub: "editor-1", username: "e", role: "editor" });
  const adminToken = () => makeToken({ sub: "user-1", username: "test", role: "admin" });

  it("viewer is denied (403) on route/activate/resolve/wontfix in a NON-TEAM habitat", async () => {
    const noWork = { bucket: "document_as_known_limitation" };

    const rf = seedAdmittedFinding();
    const routeRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${rf.finding.id}/route`,
      payload: noWork,
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(routeRes.statusCode).toBe(403);

    const af = seedAdmittedFinding();
    const activateRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${af.finding.id}/activate`,
      payload: {},
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(activateRes.statusCode).toBe(403);

    const sf = seedAdmittedFinding();
    const resolveRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${sf.finding.id}/resolve`,
      payload: { resolution: "fixed elsewhere", resolutionKind: "code_fix" },
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(resolveRes.statusCode).toBe(403);

    const wf = seedAdmittedFinding();
    const wontfixRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${wf.finding.id}/wontfix`,
      payload: { reason: "not worth it" },
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(wontfixRes.statusCode).toBe(403);

    // Zero writes: every finding is still open.
    for (const f of [rf.finding, af.finding, sf.finding, wf.finding]) {
      expect(findingTriageRepo.getById(f.id)!.status).toBe("open");
    }
  });

  it("editor and admin succeed on route in the same non-team habitat", async () => {
    const ef = seedAdmittedFinding();
    const editorRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${ef.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${editorToken()}` },
    });
    expect(editorRes.statusCode).toBe(200);

    const af = seedAdmittedFinding();
    const adminRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${af.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(adminRes.statusCode).toBe(200);
  });

  it("viewer is denied in a TEAM habitat too (even as a team member); editor member succeeds; viewer READ still allowed", async () => {
    seedUserRow("viewer-1", "viewer");
    seedUserRow("editor-1", "editor");
    const teamId = attachTeamToHabitat(habitatId);
    memberRepo.addMember({ teamId, userId: "viewer-1" });
    memberRepo.addMember({ teamId, userId: "editor-1" });

    // Read path is NOT gated by the write-capability check.
    const listRes = await app!.inject({
      method: "GET",
      url: `/api/triage/findings?habitatId=${habitatId}`,
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(listRes.statusCode).toBe(200);

    const vf = seedAdmittedFinding();
    const viewerRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${vf.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${viewerToken()}` },
    });
    expect(viewerRes.statusCode).toBe(403);

    const ef = seedAdmittedFinding();
    const editorRes = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${ef.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: { authorization: `Bearer ${editorToken()}` },
    });
    expect(editorRes.statusCode).toBe(200);
  });

  it("in-tx gate: an editor JWT whose PERSISTED users.role is viewer is denied by the in-transaction re-check", async () => {
    // Transport passes (JWT says editor); the authoritative in-tx re-read of
    // users.role inside habitatAccessCheckerWithClient must deny.
    seedUserRow("sneaky-editor", "viewer");
    const f = seedAdmittedFinding();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${f.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "sneaky-editor", username: "e", role: "editor" })}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(findingTriageRepo.getById(f.finding.id)!.status).toBe("open");
  });

  it("a persisted EDITOR users row passes the in-tx re-check (control)", async () => {
    seedUserRow("real-editor", "editor");
    const f = seedAdmittedFinding();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${f.finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "real-editor", username: "e", role: "editor" })}`,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("FU6 — legacy first-link actor binding + atomic single write", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("unprivileged local agent key cannot first-link (403, zero writes)", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { "x-agent-api-key": otherAgentApiKey },
    });
    expect(res.statusCode).toBe(403);
    const after = findingTriageRepo.getById(finding.id)!;
    expect(after.correctiveMissionId).toBeNull();
    expect(after.routeFingerprint).toBeNull();
  });

  it("human editor first-link succeeds and lands link + fingerprint together (one write)", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "editor" })}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const after = findingTriageRepo.getById(finding.id)!;
    expect(after.correctiveMissionId).toBe(corrective.id);
    // The atomic apply stamps BOTH columns in one UPDATE — a link with a null
    // fingerprint (the old two-write crash window) can no longer exist.
    expect(after.routeFingerprint).not.toBeNull();
  });

  it("rejected apply leaves ZERO partial writes (no link-without-fingerprint)", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version + 99,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_VERSION_MISMATCH");
    const after = findingTriageRepo.getById(finding.id)!;
    expect(after.correctiveMissionId).toBeNull();
    expect(after.routeFingerprint).toBeNull();
  });

  it("stored-fingerprint replay still wins after the atomic apply", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });

    const first = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);

    // Replay with a STALE version still succeeds (fingerprint replay before
    // the version/no-link predicates).
    const replay = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version + 50,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body).replay).toBe(true);
  });

  it("a same-link retry still replays when a concurrent lineage repair has flagged the row", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });

    const first = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);

    // Simulate a lineage repair committing after the link: the row is now
    // flagged for repair. A same-link retry must STILL replay — the replay
    // contract wins over lineage eligibility, in the outer path AND inside
    // the writer reservation.
    getDb()
      .update(findingTriage)
      .set({ legacyLineageRepairRequired: 1, updatedAt: new Date().toISOString() })
      .where(eq(findingTriage.id, finding.id))
      .run();

    const replay = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body).replay).toBe(true);
  });

  it("in-tx gate: an editor JWT whose persisted users.role is viewer cannot first-link", async () => {
    seedUserRow("sneaky-linker", "viewer");
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    const corrective = createGatedMission();

    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "sneaky-linker", username: "e", role: "editor" })}`,
      },
    });
    expect(res.statusCode).toBe(403);
    const after = findingTriageRepo.getById(finding.id)!;
    expect(after.correctiveMissionId).toBeNull();
    expect(after.routeFingerprint).toBeNull();
  });

  it("rejects first-link onto a Mission whose existing member is already in_progress", async () => {
    const linked = seedAdmittedFinding();
    forceDeferredTriaged(linked.finding.id);
    const corrective = createGatedMission();
    const first = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${linked.finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
      },
    });
    expect(first.statusCode).toBe(200);
    getDb()
      .update(findingTriage)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(findingTriage.id, linked.finding.id))
      .run();

    const next = seedAdmittedFinding({ clusterKey: "other-cluster" });
    forceDeferredTriaged(next.finding.id);
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${next.finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: missionRepo.getMissionById(corrective.id)!.version,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_MIXED_GROUP");
    expect(findingTriageRepo.getById(next.finding.id)!.correctiveMissionId).toBeNull();
  });

  it("rejects first-link when the Finding still requires lineage repair", async () => {
    const { finding } = seedAdmittedFinding();
    forceDeferredTriaged(finding.id);
    getDb()
      .update(findingTriage)
      .set({ legacyLineageRepairRequired: 1, updatedAt: new Date().toISOString() })
      .where(eq(findingTriage.id, finding.id))
      .run();
    const corrective = createGatedMission();
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${finding.id}`,
      payload: {
        triageMissionId: corrective.id,
        expectedMissionVersion: corrective.version,
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("LEGACY_LINK_LINEAGE_REPAIR_REQUIRED");
    expect(findingTriageRepo.getById(finding.id)!.correctiveMissionId).toBeNull();
  });
});

describe("FU6 — admin API provisions triage.route end-to-end", () => {
  it("HTTP grant POST with triage.route → grant row → remote route authorized with it", async () => {
    const { finding, investigateTask } = seedAdmittedFinding();

    // Pod + participant + credential WITHOUT any grant (no direct grant writes).
    const pod = podRepo.createRemotePod({ habitatId, name: "Admin Prov Pod" });
    const activatedPod = podRepo.activateRemotePod(pod.id) ?? pod;
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: activatedPod.id,
      habitatId,
      participantType: "remote_orcy",
      displayName: "AdminProvisioned",
      standing: "remote_contributor",
    });
    const activatedParticipant =
      participantRepo.activateRemoteParticipant(participant.id) ?? participant;
    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: activatedParticipant.id,
      habitatId,
      credentialType: "api",
      label: "admin-provisioned",
    });

    // Provision the grant through the REAL admin API.
    const adminApp = await buildAdminApp();
    const grantRes = await adminApp.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/remote-access/grants`,
      payload: {
        remotePodId: activatedPod.id,
        remoteParticipantId: activatedParticipant.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["triage.route"],
        eligibilityMode: "allowlist",
        targets: [{ targetType: "task", targetId: investigateTask.id }],
      },
      headers: {
        authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
      },
    });
    expect(grantRes.statusCode).toBe(201);
    const grantId = (JSON.parse(grantRes.body) as { grant: { id: string } }).grant.id;
    const grantRow = grantRepo.getRemoteGrantById(grantId);
    expect(grantRow).not.toBeNull();
    expect(grantRow!.actionScopes).toContain("triage.route");
    await adminApp.close();

    // The provisioned grant authorizes the remote route end-to-end.
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      activatedParticipant.id,
    );
    expect(claimRes.success).toBe(true);

    const sharedApp = await buildSharedApp();
    const routeRes = await sharedApp.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: {
        "x-orcy-remote-key": plaintextSecret,
        "idempotency-key": "fu6-admin-provisioned-grant",
      },
    });
    expect(routeRes.statusCode).toBe(200);
    expect(JSON.parse(routeRes.body).finding.status).toBe("triaged");
    await sharedApp.close();
  });
});
