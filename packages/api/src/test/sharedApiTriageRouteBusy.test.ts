/**
 * FU5 — Remote `/api/shared/triage/findings/:id/route` busy outcome maps to
 * 503 + `Retry-After` (contract: plan line 137 + T4), and the idempotency
 * envelope is NOT finalized as failed (a retry with the same key may succeed).
 *
 * The lifecycle's `routeFinding` is mocked to return a forced `busy` outcome —
 * real SQLite writer-reservation contention cannot be reproduced on the
 * single-connection sql.js test backend without a worker process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { sharedApiRoutes } from "../routes/sharedApi.js";
import { triageRoutes } from "../routes/triage.js";
import jwt from "jsonwebtoken";
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
import * as credentialService from "../services/remoteCredentialService.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as idempotencyRepo from "../repositories/remoteIdempotency.js";
import { eq, sql } from "drizzle-orm";
import { findingTriage } from "../db/schema/index.js";

vi.mock("../services/findingTriageLifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/findingTriageLifecycle.js")>();
  return {
    ...actual,
    routeFinding: vi.fn(() => ({ outcome: "busy" as const, retryAfterMs: 2500 })),
  };
});

let habitatId: string;
let columnId: string;
let agentId: string;

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
    description: "x",
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
    subject: "cluster",
    body: "x",
    metadata: { findingKind: "bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  getDb()
    .update(findingTriage)
    .set({
      admittedByTriageMissionId: admittingMission.id,
      admittedByInvestigationTaskId: investigateTask.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();
  return { finding: findingTriageRepo.getById(finding.id)!, investigateTask };
}

function setupRemote(habitatIdArg: string, opts: { addTaskTarget?: string } = {}) {
  const pod = podRepo.createRemotePod({ habitatId: habitatIdArg, name: "RP" });
  const activatedPod = podRepo.activateRemotePod(pod.id) ?? pod;
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: activatedPod.id,
    habitatId: habitatIdArg,
    participantType: "remote_orcy",
    displayName: "RW",
    standing: "remote_contributor",
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
    standing: "remote_contributor",
    actionScopes: ["read", "comment", "triage.route"] as never,
    eligibilityMode: "allowlist",
  });
  if (opts.addTaskTarget) grantRepo.addRemoteGrantTarget(grant.id, "task", opts.addTaskTarget);
  return { participantId: activatedParticipant.id, credentialSecret: plaintextSecret };
}

describe("FU5 — remote route busy → 503 + Retry-After, envelope left pending", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.run(sql`DELETE FROM tasks`);
    db.run(sql`DELETE FROM finding_triage`);
    db.run(sql`DELETE FROM pulses`);
    const habitat = habitatRepo.createHabitat({ name: "H" });
    habitatId = habitat.id;
    const col = columnRepo.createColumn({
      habitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    columnId = col.id;
    const result = agentRepo.createAgent({ name: "A", type: "claude-code", domain: "general" });
    agentId = result.agent.id;
    app = await buildSharedApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("busy → 503 + Retry-After header + code LIFECYCLE_BUSY", async () => {
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
        "idempotency-key": "fu5-busy-key",
      },
      payload: { bucket: "document_as_known_limitation" },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("3"); // 2500ms → ceil(2.5) = 3
    const body = JSON.parse(res.body) as { code?: string; message?: string };
    expect(body.code).toBe("LIFECYCLE_BUSY");
    expect(body.message).toBe("Lifecycle writer reservation exhausted; retry after 3s");

    // A retryable 503 must NOT finalize the envelope as failed — the record
    // stays pending so the same Idempotency-Key can re-execute after Retry-After.
    const rec = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "triage.route",
      "fu5-busy-key",
    );
    expect(rec?.status).toBe("pending");
    expect(rec?.responseStatus).toBeNull();
  });
});

describe("FU5 — LOCAL route busy → 503 + Retry-After (contract parity with remote)", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.run(sql`DELETE FROM tasks`);
    db.run(sql`DELETE FROM finding_triage`);
    db.run(sql`DELETE FROM pulses`);
    const habitat = habitatRepo.createHabitat({ name: "H" });
    habitatId = habitat.id;
    const col = columnRepo.createColumn({
      habitatId,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    columnId = col.id;
    const result = agentRepo.createAgent({ name: "A", type: "claude-code", domain: "general" });
    agentId = result.plainApiKey ? result.agent.id : result.agent.id;
    app = Fastify({ logger: false });
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
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("local busy → 503 + Retry-After header + code LIFECYCLE_BUSY (not 409 CONFLICT)", async () => {
    const { finding } = seedAdmittedFinding();
    const token = jwt.sign(
      { sub: "user-1", username: "t", role: "admin" },
      "dev-secret-change-in-production",
      { issuer: "orcy" },
    );
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${finding.id}/route`,
      headers: { authorization: `Bearer ${token}` },
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("3");
    const body = JSON.parse(res.body) as { code?: string };
    expect(body.code).toBe("LIFECYCLE_BUSY");
  });
});
