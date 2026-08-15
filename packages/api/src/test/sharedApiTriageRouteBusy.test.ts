/**
 * FU5 — Remote `/api/shared/triage/findings/:id/route` busy outcome maps to
 * 503 + `Retry-After` (contract: plan line 137 + T4), and the idempotency
 * envelope is NOT finalized as failed (a retry with the same key may succeed).
 *
 * FU12 — The retry-aware pending window: a pending envelope past the window
 * (30s ≫ the busy path's ≤2s Retry-After cap) no longer blocks same-key
 * re-execution — the retry atomically TAKES OVER the record. Inside the
 * window, concurrent duplicates still get IDEMPOTENCY_KEY_IN_FLIGHT.
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
import { routeFinding } from "../services/findingTriageLifecycle.js";
import { eq, and, sql } from "drizzle-orm";
import { findingTriage, remoteIdempotencyKeys } from "../db/schema/index.js";

vi.mock("../services/findingTriageLifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/findingTriageLifecycle.js")>();
  return {
    ...actual,
    routeFinding: vi.fn(() => ({ outcome: "busy" as const, retryAfterMs: 2500 })),
  };
});

const routeFindingMock = vi.mocked(routeFinding);

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

describe("FU12 — retry-aware pending window for the busy-retried envelope", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    routeFindingMock.mockClear();
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
    routeFindingMock.mockClear();
  });

  /** Push a pending envelope's `created_at` back by `ms` (past the window). */
  function agePendingKey(participantId: string, key: string, ms: number) {
    getDb().run(sql`UPDATE remote_idempotency_keys
      SET created_at = ${new Date(Date.now() - ms).toISOString()}
      WHERE remote_participant_id = ${participantId} AND idempotency_key = ${key}`);
  }

  async function setupRoutedContext() {
    const { finding, investigateTask } = seedAdmittedFinding();
    const setup = setupRemote(habitatId, { addTaskTarget: investigateTask.id });
    const claimRes = taskStateMachine.claimTaskByRemoteParticipant(
      investigateTask.id,
      setup.participantId,
    );
    expect(claimRes.success).toBe(true);
    const headers = {
      "x-orcy-remote-key": setup.credentialSecret,
      "idempotency-key": "fu12-retry-key",
    };
    const payload = { bucket: "document_as_known_limitation" };
    const inject = () =>
      app!.inject({
        method: "POST",
        url: `/api/shared/triage/findings/${finding.id}/route`,
        headers,
        payload,
      });
    return { finding, setup, inject };
  }

  it("busy → pending past the window → same-key retry RE-EXECUTES (200, not IDEMPOTENCY_KEY_IN_FLIGHT)", async () => {
    const { finding, setup, inject } = await setupRoutedContext();

    const first = await inject();
    expect(first.statusCode).toBe(503);

    // Wait ≥ the Retry-After we advertised — simulated by aging the pending
    // envelope past the middleware's takeover window (30s ≫ the 2s busy cap).
    agePendingKey(setup.participantId, "fu12-retry-key", 31_000);

    routeFindingMock.mockImplementationOnce(() => ({
      outcome: "applied" as const,
      value: finding,
    }));
    const retry = await inject();
    expect(retry.statusCode).toBe(200);
    // Re-executed — NOT a stored-response replay.
    expect(retry.headers["x-orcy-idempotent-replay"]).toBeUndefined();
    expect((JSON.parse(retry.body) as { finding?: { id?: string } }).finding?.id).toBe(
      finding.id,
    );
    expect(routeFindingMock).toHaveBeenCalledTimes(2); // first (busy) + the retry reached the command

    const rec = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "triage.route",
      "fu12-retry-key",
    );
    expect(rec?.status).toBe("completed");
    expect(rec?.responseStatus).toBe(200);
  });

  it("concurrent duplicate INSIDE the window still gets IDEMPOTENCY_KEY_IN_FLIGHT", async () => {
    const { setup, inject } = await setupRoutedContext();

    const first = await inject();
    expect(first.statusCode).toBe(503);

    // No aging — the record is pending and fresh, so a duplicate (retry the
    // instant the original could still be executing) must still be blocked.
    const dup = await inject();
    expect(dup.statusCode).toBe(409);
    const body = JSON.parse(dup.body) as { code?: string };
    expect(body.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect(routeFindingMock).toHaveBeenCalledTimes(1); // only the first call executed
  });

  it("a different request body with the same key mismatches even past the window", async () => {
    const { finding, setup } = await setupRoutedContext();
    const headers = {
      "x-orcy-remote-key": setup.credentialSecret,
      "idempotency-key": "fu12-retry-key",
    };
    const first = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers,
      payload: { bucket: "document_as_known_limitation" },
    });
    expect(first.statusCode).toBe(503);
    agePendingKey(setup.participantId, "fu12-retry-key", 31_000);

    const mismatch = await app!.inject({
      method: "POST",
      url: `/api/shared/triage/findings/${finding.id}/route`,
      headers,
      payload: { bucket: "needs_investigation" },
    });
    expect(mismatch.statusCode).toBe(409);
    const body = JSON.parse(mismatch.body) as { code?: string };
    expect(body.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
  });

  it("two post-window same-key retries → exactly one executes; the second gets IDEMPOTENCY_KEY_IN_FLIGHT", async () => {
    const { setup, inject } = await setupRoutedContext();

    const first = await inject();
    expect(first.statusCode).toBe(503);
    const recordBefore = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "triage.route",
      "fu12-retry-key",
    );
    agePendingKey(setup.participantId, "fu12-retry-key", 31_000);

    // Post-window retry #1: takes over the record (fresh id + createdAt) and
    // reaches the command, which is busy again → stays pending, fresh window.
    const retry1 = await inject();
    expect(retry1.statusCode).toBe(503);
    const recordAfterTakeover = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "triage.route",
      "fu12-retry-key",
    );
    expect(recordAfterTakeover?.id).not.toBe(recordBefore?.id); // generation swapped
    expect(recordAfterTakeover?.status).toBe("pending");

    // Post-window retry #2, simultaneous with #1's generation: blocked — the
    // takeover refreshed the window, so exactly one of the two executed.
    const retry2 = await inject();
    expect(retry2.statusCode).toBe(409);
    const body = JSON.parse(retry2.body) as { code?: string };
    expect(body.code).toBe("IDEMPOTENCY_KEY_IN_FLIGHT");
    expect(routeFindingMock).toHaveBeenCalledTimes(2); // first call + retry #1 only
  });

  it("CAS predicate: a loser's swap against its pre-takeover observation no-ops (takeover atomicity)", async () => {
    // Repo-level proof of the compare-and-set that backs the window: the
    // WHERE predicate encodes the OBSERVED (id, status, createdAt), so once a
    // winner swaps the id, a concurrent loser's identical UPDATE matches zero
    // rows. (True overlapping writers need a forked process; this exercises
    // the predicate itself, the acquireAttemptLeaseWithClient convention.)
    const setup = setupRemote(habitatId);
    const created = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId,
      remoteParticipantId: setup.participantId,
      action: "triage.route",
      idempotencyKey: "fu12-cas-key",
      requestHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(created.created).toBe(true);
    const observed = created.row;

    getDb()
      .run(sql`UPDATE remote_idempotency_keys
        SET created_at = ${new Date(Date.now() - 31_000).toISOString()}
        WHERE id = ${observed.id}`);

    const winner = idempotencyRepo.takeoverStalePendingIdempotencyKey(
      { remoteParticipantId: setup.participantId, action: "triage.route", idempotencyKey: "fu12-cas-key" },
      { olderThanMs: 30_000 },
    );
    expect(winner.taken).toBe(true);
    expect(winner.row?.id).not.toBe(observed.id);

    // The loser — still holding the pre-takeover observation — issues the
    // identical swap. The predicate must reject it.
    getDb()
      .update(remoteIdempotencyKeys)
      .set({ id: "loser-takeover-uuid", createdAt: new Date().toISOString() })
      .where(
        and(
          eq(remoteIdempotencyKeys.id, observed.id),
          eq(remoteIdempotencyKeys.status, "pending"),
          eq(remoteIdempotencyKeys.createdAt, observed.createdAt),
        ),
      )
      .run();
    const after = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "triage.route",
      "fu12-cas-key",
    );
    expect(after?.id).not.toBe("loser-takeover-uuid");
    expect(after?.id).toBe(winner.row?.id);
  });

  it("legacy non-ISO createdAt rows (datetime('now') default) still age into takeover eligibility", async () => {
    const setup = setupRemote(habitatId);
    const created = idempotencyRepo.getOrCreateIdempotencyKey({
      habitatId,
      remoteParticipantId: setup.participantId,
      action: "triage.route",
      idempotencyKey: "fu12-legacy-key",
      requestHash: "b".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // Simulate a pre-ISO-convention row written by the column default.
    const legacyStamp = new Date(Date.now() - 31_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    getDb()
      .run(sql`UPDATE remote_idempotency_keys
        SET created_at = ${legacyStamp}
        WHERE id = ${created.row.id}`);

    const takeover = idempotencyRepo.takeoverStalePendingIdempotencyKey(
      { remoteParticipantId: setup.participantId, action: "triage.route", idempotencyKey: "fu12-legacy-key" },
      { olderThanMs: 30_000 },
    );
    expect(takeover.taken).toBe(true);
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
