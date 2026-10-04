import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { sharedApiRoutes } from "../routes/sharedApi.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { registerErrorHandler } from "../errors/plugin.js";
import * as boardRepo from "../repositories/habitat.js";
import * as commentRepo from "../repositories/comment.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as idempotencyRepo from "../repositories/remoteIdempotency.js";
import * as codeEvidenceLinking from "../services/codeEvidence/linking.js";
import * as workflowService from "../services/workflowService.js";
import * as transitionEmitter from "../services/tasks/transition-emitter.js";
import * as qualityGateService from "../services/qualityGateService.js";
import * as reviewAssignment from "../services/reviewAssignmentService.js";
import * as taskEventRepo from "../repositories/events/event-crud.js";
import * as remoteNotifications from "../services/remoteNotifications.js";
import type { RemoteActionScope, ParticipantStanding } from "@orcy/shared/types";
import { isAppError } from "../errors.js";
import { logger } from "../lib/logger.js";
import { randomUUID } from "crypto";
import { taskLifecycleRoutes } from "../routes/tasks/lifecycle.js";
import * as agentService from "../services/agentService.js";
import * as taskService from "../services/tasks/index.js";

const ORIGINAL_ENV = { ...process.env };

interface RemoteSetup {
  habitat: ReturnType<typeof boardRepo.createHabitat>;
  pod: ReturnType<typeof podRepo.createRemotePod> & { status: string };
  participant: ReturnType<typeof participantRepo.createRemoteParticipant> & { status: string };
  credential: ReturnType<typeof credentialService.verifyRemoteKeyById>;
  plaintextSecret: string;
  grant: ReturnType<typeof grantRepo.createRemoteGrant>;
}

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Phase D Test Habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  return habitat;
}

function setupActivePod(habitatId: string) {
  const pod = podRepo.createRemotePod({ habitatId, name: "Remote Pod" });
  return podRepo.activateRemotePod(pod.id) ?? pod;
}

function setupActiveParticipant(
  habitatId: string,
  podId: string,
  standing: ParticipantStanding = "remote_contributor",
): ReturnType<typeof participantRepo.createRemoteParticipant> & { status: string } {
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: podId,
    habitatId,
    participantType: "remote_orcy",
    displayName: "Remote Worker",
    standing,
  });
  return participantRepo.activateRemoteParticipant(participant.id) ?? participant;
}

function setupRemoteFixture(
  actionScopes: RemoteActionScope[] = [
    "read",
    "comment",
    "claim",
    "submit",
    "release",
    "heartbeat",
    "evidence_link",
    "pulse.post",
  ],
  options: {
    standing?: ParticipantStanding;
    addGrantTargets?: { missionId?: string; taskId?: string };
  } = {},
): RemoteSetup {
  const habitat = setupHabitat();
  const pod = setupActivePod(habitat.id);
  const participant = setupActiveParticipant(
    habitat.id,
    pod.id,
    options.standing ?? "remote_contributor",
  );

  const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
    label: "test-cred",
  });

  const grant = grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: options.standing ?? "remote_contributor",
    actionScopes,
  });

  if (options.addGrantTargets?.missionId) {
    grantRepo.addRemoteGrantTarget(grant.id, "mission", options.addGrantTargets.missionId);
  }
  if (options.addGrantTargets?.taskId) {
    grantRepo.addRemoteGrantTarget(grant.id, "task", options.addGrantTargets.taskId);
  }

  // Get the activated participant
  const activatedParticipant = participantRepo.getRemoteParticipantById(participant.id)!;
  const activatedPod = podRepo.getRemotePodById(pod.id)!;
  const activatedCredential = credentialService.verifyRemoteKeyById(credential.id)!;

  return {
    habitat,
    pod: activatedPod,
    participant: { ...activatedParticipant, status: activatedParticipant.status },
    credential: activatedCredential,
    plaintextSecret,
    grant,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Production error handler, installed by DIRECT root call — matching the
  // production assembly (httpApp.ts calls `registerErrorHandler(fastify)`
  // directly, not `fastify.register`). registerErrorHandler is a plain
  // function, not a Fastify plugin: `app.register` would encapsulate it as a
  // sibling and NOT install the root error handler despite the earlier
  // comment's claim. The direct call makes AppError bodies serialize exactly
  // as the served API does — {error, code, details}.
  await registerErrorHandler(app);
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

function remoteHeaders(setup: RemoteSetup, idempotencyKey?: string): Record<string, string> {
  return {
    "x-orcy-remote-key": setup.plaintextSecret,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

describe("Phase D — Shared Habitat API", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    process.env = { ...ORIGINAL_ENV };
    app = await buildApp();
  });

  it.skip("DEBUG prints routes", () => {
    if (app) {
      const routes = app.printRoutes({ commonPrefix: false });
      process.stdout.write("\n\n=== ROUTES ===\n" + routes + "\n=== END ===\n\n");
    }
    expect(true).toBe(true);
  });

  it.skip("DEBUG inspects claim failure", async () => {
    const setup = setupRemoteFixture();
    const habitat = setupHabitat();
    columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      title: "M",
      createdBy: "test",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "T",
      description: "x",
      requiredCapabilities: [],
      labels: [],
      createdBy: "test",
    });
    const claimResult = taskStateMachine.claimTaskByRemoteParticipant(
      task.id,
      setup.participant.id,
    );
    process.stdout.write(
      "\n\nCLAIM RESULT: " +
        JSON.stringify(claimResult) +
        "\n" +
        "TASK: " +
        JSON.stringify({
          id: task.id,
          status: task.status,
          assignedAgentId: task.assignedAgentId,
        }) +
        "\n" +
        "PARTICIPANT ID: " +
        setup.participant.id +
        "\n",
    );
    expect(true).toBe(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    closeDb();
    process.env = ORIGINAL_ENV;
  });

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  describe("Authentication", () => {
    it("returns 401 for anonymous requests", async () => {
      const res = await app!.inject({ method: "GET", url: "/api/shared/me" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for invalid remote key", async () => {
      const res = await app!.inject({
        method: "GET",
        url: "/api/shared/me",
        headers: { "x-orcy-remote-key": "orcy_remote_invalid_xyz" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with participant info on valid key", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: "/api/shared/me",
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.participant.id).toBe(setup.participant.id);
      expect(body.participant.displayName).toBe("Remote Worker");
      expect(body.participant.standing).toBe("remote_contributor");
      expect(body.pod.id).toBe(setup.pod.id);
      expect(body.habitatId).toBe(setup.habitat.id);
      expect(body.grants.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  describe("Discovery", () => {
    it("GET /habitats/:id returns scoped habitat summary", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/habitats/${setup.habitat.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.habitat.id).toBe(setup.habitat.id);
      expect(body.habitat.name).toBe("Phase D Test Habitat");
    });

    it("GET /habitats/:id rejects wrong habitat", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/habitats/${randomUUID()}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Missions
  // ---------------------------------------------------------------------------

  describe("Missions", () => {
    it("GET /habitats/:id/missions returns missions visible via grant", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Test Mission",
        description: "A test",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/habitats/${setup.habitat.id}/missions`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.missions).toHaveLength(1);
      expect(body.missions[0].id).toBe(mission.id);
    });

    it("GET /missions/:id returns the mission if visible", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Test Mission",
        description: "A test",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mission.id).toBe(mission.id);
    });

    it("GET /missions/:id rejects missions not covered by grants", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Hidden Mission",
        priority: "low",
        createdBy: "test",
      });
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  describe("Tasks", () => {
    function setupTaskFixture(setup: RemoteSetup) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Test Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        description: "A test task",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      return { mission, task };
    }

    it("GET /tasks/:id returns task if visible", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.task.id).toBe(task.id);
    });

    it("POST /tasks/:id/claim claims the task", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-claim-key-1234"),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.task.id).toBe(task.id);
      expect(body.task.status).toBe("claimed");
      expect(body.task.remoteAssignedParticipantId).toBe(setup.participant.id);
    });

    it("POST /tasks/:id/claim rejects when claim scope missing", async () => {
      const setup = setupRemoteFixture(["read", "comment"]);
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-claim-key-1235"),
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /tasks/:id/claim without idempotency key fails", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("POST /tasks/:id/claim with same idempotency key replays result", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const key = "test-claim-replay-key";

      const first = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, key),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body);
      expect(firstBody.task.status).toBe("claimed");

      const replay = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, key),
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.headers["x-orcy-idempotent-replay"]).toBe("true");
      const replayBody = JSON.parse(replay.body);
      expect(replayBody.task.id).toBe(task.id);
    });

    it("POST /tasks/:id/claim with same key but different body fails", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const key = "test-claim-mismatch-key";

      await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, key),
      });

      // Same key, different body (additional field changes requestHash)
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, key),
        payload: { differentField: true },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    });

    it("POST /tasks/:id/heartbeat acknowledges activity", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);

      // First claim the task
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);

      // Capture updatedAt BEFORE heartbeat to prove de-pollution
      const beforeTask = taskRepo.getTaskById(task.id)!;
      const updatedAtBefore = beforeTask.updatedAt;

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "test-heartbeat-key-1"),
        payload: { progress: "Halfway done" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.acknowledged).toBe(true);
      expect(body.progress).toBe("Halfway done");
      expect(body.task.lastActivityAt).toBeDefined();

      // lastActivityAt must be persisted in the DB (not fabricated in the response)
      const dbTask = taskRepo.getTaskById(task.id)!;
      expect(dbTask.lastActivityAt).not.toBeNull();
      expect(body.task.lastActivityAt).toBe(dbTask.lastActivityAt);

      // Heartbeat must NOT bump updatedAt (de-pollution proof)
      expect(dbTask.updatedAt).toBe(updatedAtBefore);
    });

    it("POST /tasks/:id/heartbeat — lastActivityAt is null before first heartbeat", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);

      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);

      // After claim, before any heartbeat — lastActivityAt should be null
      const claimedTask = taskRepo.getTaskById(task.id)!;
      expect(claimedTask.lastActivityAt).toBeNull();
    });

    it("POST /tasks/:id/heartbeat rejects if not claimed by participant", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      // Don't claim it first
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "test-heartbeat-key-2"),
        payload: { progress: "x" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /tasks/:id/submit submits the task", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);

      // Claim and start
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(setup, "test-submit-key-1"),
        payload: { result: "Task completed successfully" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.task.status).toBe("submitted");
    });

    it("POST /tasks/:id/release releases the task", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);

      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(setup, "test-release-key-1"),
        payload: { reason: "Cannot complete" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.task.status).toBe("pending");
      expect(body.task.assignedAgentId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Grace completion preservation
  // -------------------------------------------------------------------------

  describe("Grace completion — heartbeat / submit / release", () => {
    // This file's remote surface shares ONE per-IP rate-limit window (60/min)
    // across every test, so adding requests here would otherwise starve the
    // tests that run later in the file. Sliding the clock past the window in a
    // scoped beforeEach isolates these cases without touching the shared
    // limiter, and faking only `Date` leaves the async request machinery on real
    // timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function setupTaskFixture(setup: RemoteSetup) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Grace Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Grace Task",
        description: "A test task",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      return { mission, task };
    }

    /**
     * Put the participant's grant into grace without changing the fixture's
     * scope or standing: status `expired` plus a fresh sweep stamp on a row with
     * no configured deadline (the legacy path).
     */
    function intoGrace(grantId: string): void {
      grantRepo.updateRemoteGrantStatus(grantId, "expired", {
        expiredAt: new Date().toISOString(),
      });
    }

    it("heartbeat still works for a SUBMITTED task that retains this remote owner", async () => {
      const setup = setupRemoteFixture(["heartbeat"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.submitTaskByRemoteParticipant(task.id, setup.participant.id, "done", []);

      // A submitted/terminal row that RETAINS this remote owner: heartbeat has
      // no Task-state gate, so a terminal status must not silently end it.
      const db = (await import("../db/index.js")).getDb();
      const { tasks, eq } = await import("../db/schema/index.js").then(async (m) => ({
        tasks: m.tasks,
        eq: (await import("drizzle-orm")).eq,
      }));
      db.update(tasks)
        .set({ remoteAssignedParticipantId: setup.participant.id })
        .where(eq(tasks.id, task.id))
        .run();
      expect(taskRepo.getTaskById(task.id)!.status).toBe("submitted");

      intoGrace(setup.grant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "grace-heartbeat-terminal-1"),
        payload: { progress: "still finishing up" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).acknowledged).toBe(true);
    });

    it("heartbeat is still denied for the wrong owner during grace", async () => {
      const setup = setupRemoteFixture(["heartbeat"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);

      // Strip the remote assignment: same Habitat, same grant, wrong owner.
      const db = (await import("../db/index.js")).getDb();
      const schema = await import("../db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      db.update(schema.tasks)
        .set({ remoteAssignedParticipantId: null })
        .where(eq(schema.tasks.id, task.id))
        .run();

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "grace-heartbeat-wrong-owner-1"),
        payload: { progress: "x" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("heartbeat is denied during grace when the grant omits the heartbeat scope", async () => {
      const setup = setupRemoteFixture(["read"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "grace-heartbeat-no-scope-1"),
        payload: { progress: "x" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe("ACTION_NOT_IN_GRANT_SCOPES");
    });

    it("submit during grace works for a remote_contributor and is denied for a remote_observer", async () => {
      const contributor = setupRemoteFixture(["submit"]);
      const { task } = setupTaskFixture(contributor);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, contributor.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, contributor.participant.id);
      intoGrace(contributor.grant.id);

      const ok = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(contributor, "grace-submit-contributor-1"),
        payload: { result: "done" },
      });
      expect(ok.statusCode).toBe(200);

      // Same grant state, but the submit-in-grace standing rule is preserved.
      const observer = setupRemoteFixture(["submit"], { standing: "remote_observer" });
      const { task: observerTask } = setupTaskFixture(observer);
      taskStateMachine.claimTaskByRemoteParticipant(observerTask.id, observer.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(observerTask.id, observer.participant.id);
      intoGrace(observer.grant.id);

      const denied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${observerTask.id}/submit`,
        headers: remoteHeaders(observer, "grace-submit-observer-1"),
        payload: { result: "done" },
      });
      expect(denied.statusCode).toBe(403);
      expect(JSON.parse(denied.body).code).toBe("GRANT_GRACE_STANDING_INSUFFICIENT");
    });

    it("release during grace works for the current owner and is denied for the wrong owner", async () => {
      const setup = setupRemoteFixture(["release"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);

      const other = setupRemoteFixture(["release"]);
      const { task: otherTask } = setupTaskFixture(other);
      taskStateMachine.claimTaskByRemoteParticipant(otherTask.id, other.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(otherTask.id, other.participant.id);
      intoGrace(other.grant.id);

      // A DIFFERENT Habitat's participant cannot release it — this is a
      // Habitat denial (the separate same-Habitat wrong-owner control lives in
      // its own test below).
      const wrongHabitat = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(other, "grace-release-wrong-habitat-1"),
        payload: { reason: "not mine" },
      });
      expect(wrongHabitat.statusCode).toBe(403);

      const ok = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(setup, "grace-release-owner-1"),
        payload: { reason: "handing back" },
      });
      expect(ok.statusCode).toBe(200);
    });

    it("heartbeat still works for a distinct TERMINAL (done) Task retaining this remote owner", async () => {
      const setup = setupRemoteFixture(["heartbeat"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.submitTaskByRemoteParticipant(task.id, setup.participant.id, "done", []);
      // A genuinely terminal state (done), still naming this remote owner: the
      // no-Task-state-gate rule must survive terminality, not just `submitted`.
      const db = (await import("../db/index.js")).getDb();
      const { tasks, eq } = await import("../db/schema/index.js").then(async (m) => ({
        tasks: m.tasks,
        eq: (await import("drizzle-orm")).eq,
      }));
      db.update(tasks)
        .set({ status: "done", remoteAssignedParticipantId: setup.participant.id })
        .where(eq(tasks.id, task.id))
        .run();
      expect(taskRepo.getTaskById(task.id)!.status).toBe("done");

      intoGrace(setup.grant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "grace-heartbeat-terminal-done-1"),
        payload: { progress: "final" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).acknowledged).toBe(true);
    });

    it("heartbeat during grace is denied for a Task in another Habitat", async () => {
      const setup = setupRemoteFixture(["heartbeat"]);
      const other = setupRemoteFixture(["heartbeat"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);
      intoGrace(other.grant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(other, "grace-heartbeat-wrong-habitat-1"),
        payload: { progress: "x" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("submit and release during grace are denied without their scope", async () => {
      const noSubmit = setupRemoteFixture(["read"]);
      const { task: submitTask } = setupTaskFixture(noSubmit);
      taskStateMachine.claimTaskByRemoteParticipant(submitTask.id, noSubmit.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(submitTask.id, noSubmit.participant.id);
      intoGrace(noSubmit.grant.id);

      const submitDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${submitTask.id}/submit`,
        headers: remoteHeaders(noSubmit, "grace-submit-no-scope-1"),
        payload: { result: "x" },
      });
      expect(submitDenied.statusCode).toBe(403);
      expect(JSON.parse(submitDenied.body).code).toBe("ACTION_NOT_IN_GRANT_SCOPES");

      const noRelease = setupRemoteFixture(["read"]);
      const { task: releaseTask } = setupTaskFixture(noRelease);
      taskStateMachine.claimTaskByRemoteParticipant(releaseTask.id, noRelease.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(releaseTask.id, noRelease.participant.id);
      intoGrace(noRelease.grant.id);

      const releaseDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${releaseTask.id}/release`,
        headers: remoteHeaders(noRelease, "grace-release-no-scope-1"),
        payload: { reason: "x" },
      });
      expect(releaseDenied.statusCode).toBe(403);
      expect(JSON.parse(releaseDenied.body).code).toBe("ACTION_NOT_IN_GRANT_SCOPES");
    });

    it("submit during grace is denied for the OWNER from a non-submittable state, by the actual seam's conflict code", async () => {
      const setup = setupRemoteFixture(["submit"]);
      const { task } = setupTaskFixture(setup);
      // Owned by this participant (so ownership cannot be what denies), but held
      // in `claimed` rather than `in_progress`: only the lifecycle-state guard of
      // the submit seam can deny. Its real code is a 409 CONFLICT, not a 403.
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);
      expect(taskRepo.getTaskById(task.id)!.status).toBe("claimed");

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(setup, "grace-submit-invalid-state-1"),
        payload: { result: "x" },
      });
      expect(res.statusCode).toBe(409);
      // The ACTUAL unchanged shared-route error object: `conflict(message,
      // details)` pins code to CONFLICT and carries the seam's reason in
      // `details`. The seam's TASK_SUBMIT_FAILED identity lives in details, not
      // in the code field.
      expect(JSON.parse(res.body)).toEqual({
        error: "Cannot submit task in current state",
        code: "CONFLICT",
        details: "TASK_SUBMIT_FAILED",
      });
      // The Task row is unchanged by the denial.
      expect(taskRepo.getTaskById(task.id)!.status).toBe("claimed");
    });

    it("release during grace is denied for the OWNER from a non-releasable state, by the actual seam's conflict code", async () => {
      const setup = setupRemoteFixture(["release"]);
      const { task } = setupTaskFixture(setup);
      // Owned, but ALREADY submitted: the release seam refuses to release a task
      // that is no longer in a claimable/executing state.
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.submitTaskByRemoteParticipant(
        task.id,
        setup.participant.id,
        "already submitted",
        [],
      );
      intoGrace(setup.grant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(setup, "grace-release-invalid-state-1"),
        payload: { reason: "x" },
      });
      expect(res.statusCode).toBe(409);
      // Complete actual conflict object (code CONFLICT; the seam's
      // TASK_RELEASE_FAILED identity is the details argument).
      expect(JSON.parse(res.body)).toEqual({
        error: "Cannot release task in current state",
        code: "CONFLICT",
        details: "TASK_RELEASE_FAILED",
      });
      expect(taskRepo.getTaskById(task.id)!.status).toBe("submitted");
    });

    it("same-Habitat WRONG OWNER is denied for submit and release during grace, with the row unchanged", async () => {
      const owner = setupRemoteFixture(["submit", "release"]);
      const { task } = setupTaskFixture(owner);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, owner.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, owner.participant.id);
      intoGrace(owner.grant.id);

      // A SECOND active participant in the SAME Habitat/pod, holding the same
      // scopes, so only ownership can distinguish them.
      const rival = participantRepo.createRemoteParticipant({
        remotePodId: owner.pod.id,
        habitatId: owner.habitat.id,
        participantType: "remote_orcy",
        displayName: "Same-Habitat Rival",
        standing: "remote_contributor",
      });
      participantRepo.activateRemoteParticipant(rival.id);
      const { plaintextSecret: rivalSecret } = credentialService.createCredentialWithSecret({
        remoteParticipantId: rival.id,
        habitatId: owner.habitat.id,
        credentialType: "api",
      });
      const rivalGrant = grantRepo.createRemoteGrant({
        habitatId: owner.habitat.id,
        remotePodId: owner.pod.id,
        remoteParticipantId: rival.id,
        grantType: "scoped_elevation",
        standing: "remote_contributor",
        actionScopes: ["submit", "release", "read"],
      });
      grantRepo.addRemoteGrantTarget(rivalGrant.id, "task", task.id);
      // The RIVAL's grant must also be in grace: otherwise the rival's requests
      // authorize under ACTIVE authority and the control proves nothing about
      // grace. Both grants are now in the same effective state.
      intoGrace(rivalGrant.id);
      // Re-read BOTH grants from the repository: intoGrace persists new rows and
      // does NOT mutate the in-memory objects returned at creation, so evaluating
      // those originals would describe stale active/null-expiry rows. One shared
      // clock value evaluates both live rows.
      const { evaluateGrantTime } = await import("../services/remoteGrantTime.js");
      const liveRival = grantRepo.getRemoteGrantById(rivalGrant.id)!;
      const liveOwner = grantRepo.getRemoteGrantById(owner.grant.id)!;
      const now = Date.now();
      expect(evaluateGrantTime(liveRival, now).state).toBe("grace");
      expect(evaluateGrantTime(liveOwner, now).state).toBe("grace");
      const rivalSetupLike = {
        ...owner,
        participant: rival,
        plaintextSecret: rivalSecret,
        grant: rivalGrant,
      };

      const submitDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(rivalSetupLike, "grace-submit-wrong-owner-same-habitat-1"),
        payload: { result: "x" },
      });
      expect(submitDenied.statusCode).toBe(403);
      expect(JSON.parse(submitDenied.body).code).toBe("TASK_NOT_OWNED");

      const releaseDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(rivalSetupLike, "grace-release-wrong-owner-same-habitat-1"),
        payload: { reason: "x" },
      });
      expect(releaseDenied.statusCode).toBe(403);
      expect(JSON.parse(releaseDenied.body).code).toBe("TASK_NOT_OWNED");

      // The row is unchanged by both denials, and the true owner can still act.
      expect(taskRepo.getTaskById(task.id)!.status).toBe("in_progress");
      expect(taskRepo.getTaskById(task.id)!.remoteAssignedParticipantId).toBe(owner.participant.id);
      const ok = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(owner, "grace-submit-owner-after-rival-1"),
        payload: { result: "owner submits" },
      });
      expect(ok.statusCode).toBe(200);
    });

    it("heartbeat and release are denied for a disallowed standing during grace", async () => {
      // remote_observer cannot hold `heartbeat` or `release` under the standing
      // policy, even when the grant text lists the scope.
      const observer = setupRemoteFixture(["heartbeat", "release"], {
        standing: "remote_observer",
      });
      const { task } = setupTaskFixture(observer);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, observer.participant.id);
      intoGrace(observer.grant.id);

      const heartbeat = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(observer, "grace-heartbeat-disallowed-standing-1"),
        payload: { progress: "x" },
      });
      expect(heartbeat.statusCode).toBe(403);
      expect(JSON.parse(heartbeat.body).code).toBe("STANDING_ACTION_NOT_PERMITTED");

      const release = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(observer, "grace-release-disallowed-standing-1"),
        payload: { reason: "x" },
      });
      expect(release.statusCode).toBe(403);
      expect(JSON.parse(release.body).code).toBe("STANDING_ACTION_NOT_PERMITTED");
    });

    it("wrong-Habitat submit and release are denied as Habitat denials, separately classified", async () => {
      const owner = setupRemoteFixture(["submit", "release"]);
      const { task } = setupTaskFixture(owner);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, owner.participant.id);
      intoGrace(owner.grant.id);

      const foreign = setupRemoteFixture(["submit", "release"]);
      const { task: foreignTask } = setupTaskFixture(foreign);
      taskStateMachine.claimTaskByRemoteParticipant(foreignTask.id, foreign.participant.id);
      intoGrace(foreign.grant.id);

      // The foreign participant is the legitimate owner of ITS OWN task, so its
      // credential and grant are healthy; only the Habitat differs.
      const submitDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(foreign, "grace-submit-wrong-habitat-1"),
        payload: { result: "x" },
      });
      expect(submitDenied.statusCode).toBe(403);

      const releaseDenied = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/release`,
        headers: remoteHeaders(foreign, "grace-release-wrong-habitat-1"),
        payload: { reason: "x" },
      });
      expect(releaseDenied.statusCode).toBe(403);

      // Both denials leave the row untouched.
      expect(taskRepo.getTaskById(task.id)!.remoteAssignedParticipantId).toBe(owner.participant.id);
    });

    it("grace continuation works with ZERO active target-visibility sources, asserted explicitly", async () => {
      const setup = setupRemoteFixture(["heartbeat"]);
      const { task } = setupTaskFixture(setup);
      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      intoGrace(setup.grant.id);

      // EXPLICIT zero-visibility assertion: the sole grant is in grace (not
      // effectively active), so no effectively active grant covers this target.
      // This prevents an added visibility prerequisite from hiding behind another
      // fixture's row.
      const { evaluateGrantTime } = await import("../services/remoteGrantTime.js");
      const activeVisibilitySources = grantRepo
        .getGrantsByHabitat(setup.habitat.id)
        .filter(
          (g) =>
            evaluateGrantTime(g, Date.now()).state === "active" &&
            grantRepo
              .getRemoteGrantTargets(g.id)
              .some((t) => t.targetType === "task" && t.targetId === task.id),
        );
      expect(activeVisibilitySources, "there must be NO active visibility source").toEqual([]);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "grace-zero-visibility-1"),
        payload: { progress: "still finishing" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).acknowledged).toBe(true);
    });

    it("an expired grant does not revoke a sibling still-active grant", async () => {
      const setup = setupRemoteFixture(["read"]);
      const { task } = setupTaskFixture(setup);
      const taskId = task.id;
      intoGrace(setup.grant.id);

      // A second, still-active grant for the same participant/pod/Habitat.
      const survivor = grantRepo.createRemoteGrant({
        habitatId: setup.habitat.id,
        remotePodId: setup.pod.id,
        remoteParticipantId: setup.participant.id,
        grantType: "baseline_observer",
        standing: "remote_contributor",
        actionScopes: ["read", "comment"],
      });
      grantRepo.addRemoteGrantTarget(survivor.id, "task", taskId);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskId}`,
        headers: remoteHeaders(setup, "survivor-grant-read-1"),
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).task.id).toBe(taskId);
    });
  });

  describe("Comments", () => {
    function setupTaskFixture(setup: RemoteSetup) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Comment Test",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Comment Task",
        description: "A task",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      return { mission, task };
    }

    it("GET /tasks/:id/comments returns comments", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
    });

    it("POST /tasks/:id/comments adds a remote-attributed comment", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-1"),
        payload: { content: "Hello from remote!" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.comment.content).toBe("Hello from remote!");
      expect(body.comment.authorType).toBe("remote_orcy");
      expect(body.comment.authorId).toBe(setup.participant.id);
    });

    it("POST /tasks/:id/comments reply branch: remote reply keeps remote attribution; missing and wrong-Task parents are 400 on the shared wire", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      // Root created through the same shared transport first.
      const root = await app!.inject({
        remoteAddress: "127.0.0.77",
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-root"),
        payload: { content: "remote root" },
      });
      expect(root.statusCode).toBe(201);
      const rootComment = JSON.parse(root.body).comment;

      // Reply through the changed conditional-INSERT branch: parentId binds
      // to this exact Task and the reply keeps the remote typed attribution.
      const reply = await app!.inject({
        remoteAddress: "127.0.0.77",
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-reply"),
        payload: { content: "remote reply", parentId: rootComment.id },
      });
      expect(reply.statusCode).toBe(201);
      const replyComment = JSON.parse(reply.body).comment;
      expect(replyComment.parentId).toBe(rootComment.id);
      expect(replyComment.taskId).toBe(task.id);
      expect(replyComment.authorType).toBe("remote_orcy");
      expect(replyComment.authorId).toBe(setup.participant.id);

      // Missing parent: shared wire converts the service 404 to 400.
      const missing = await app!.inject({
        remoteAddress: "127.0.0.77",
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-missing"),
        payload: { content: "orphan", parentId: "00000000-0000-4000-8000-0000000000ec" },
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.body).toContain("Parent comment not found");

      // Parent under another Task of the SAME habitat (still visible to the
      // participant): wrong-Task parent is 400, distinct message preserved.
      const otherTaskSetup = setupTaskFixture(setup);
      const otherRoot = await app!.inject({
        remoteAddress: "127.0.0.77",
        method: "POST",
        url: `/api/shared/tasks/${otherTaskSetup.task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-other-root"),
        payload: { content: "other task root" },
      });
      const otherRootComment = JSON.parse(otherRoot.body).comment;
      const wrongTask = await app!.inject({
        remoteAddress: "127.0.0.77",
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-wrong"),
        payload: { content: "cross reply", parentId: otherRootComment.id },
      });
      expect(wrongTask.statusCode).toBe(400);
      expect(wrongTask.body).toContain("Parent comment belongs to a different task");

      // Only the matched root and reply persisted on the target Task.
      const rows = commentRepo.getCommentsByTaskId(task.id, 50, 0);
      expect(rows.total).toBe(2);
    });

    it("POST /tasks/:id/comments rejects empty content", async () => {
      const setup = setupRemoteFixture();
      const { task } = setupTaskFixture(setup);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-comment-key-2"),
        payload: { content: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /missions/:id/comments adds a remote-attributed comment", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Comment Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/missions/${mission.id}/comments`,
        headers: remoteHeaders(setup, "test-mission-comment-key"),
        payload: { content: "Mission observation" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.comment.authorType).toBe("remote_orcy");
    });
  });

  // ---------------------------------------------------------------------------
  // Pulse
  // ---------------------------------------------------------------------------

  describe("Pulse", () => {
    it("GET /missions/:id/pulse returns pulses if mission is visible", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Pulse Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/pulse`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
    });

    it("POST /missions/:id/pulse requires pulse.post scope", async () => {
      const setup = setupRemoteFixture(["read", "comment"]);
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Pulse Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/missions/${mission.id}/pulse`,
        headers: remoteHeaders(setup, "test-pulse-key-1"),
        payload: { signalType: "finding", subject: "Test" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /missions/:id/pulse with pulse.post scope posts successfully", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Pulse Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/missions/${mission.id}/pulse`,
        headers: remoteHeaders(setup, "test-pulse-key-2"),
        payload: { signalType: "finding", subject: "Heads up" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.pulse.fromType).toBe("remote_orcy");
    });
  });

  // ---------------------------------------------------------------------------
  // Evidence links
  // ---------------------------------------------------------------------------

  describe("Evidence links", () => {
    it("POST /tasks/:id/evidence-links links URL only (no branch/commit)", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Evidence Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Evidence Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/evidence-links`,
        headers: remoteHeaders(setup, "test-evidence-key-1"),
        payload: { url: "https://github.com/example/repo/pull/123" },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.link).toBeDefined();
    });

    it("POST /tasks/:id/evidence-links rejects branch input", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Evidence Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Evidence Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/evidence-links`,
        headers: remoteHeaders(setup, "test-evidence-key-2"),
        payload: {
          url: "https://github.com/example/repo/pull/123",
          branch: { name: "main" },
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Trust metadata
  // ---------------------------------------------------------------------------

  describe("Trust metadata", () => {
    it("GET /grants returns current grants", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: "/api/shared/grants",
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.grants.length).toBe(1);
      expect(body.grants[0].id).toBe(setup.grant.id);
    });

    it("GET /credentials/current returns credential metadata (no secret)", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: "/api/shared/credentials/current",
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.credential.id).toBe(setup.credential!.id);
      expect(body.credential.status).toBe("active");
      // CRITICAL: secretHash must NEVER leak
      expect(body.credential.secretHash).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Idempotency middleware (unit-level)
  // ---------------------------------------------------------------------------

  describe("Idempotency", () => {
    it("rejects requests without Idempotency-Key for write routes", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Idempotency Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Idempotency Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: { "x-orcy-remote-key": setup.plaintextSecret },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("rejects Idempotency-Key that is too short", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Short Key",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Short Key Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: { "x-orcy-remote-key": setup.plaintextSecret, "idempotency-key": "abc" },
      });
      expect(res.statusCode).toBe(409);
    });

    it("stores idempotency records in the database", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Storage Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Storage Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const key = "test-storage-key-1234";
      await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, key),
      });

      const record = idempotencyRepo.getIdempotencyKey(setup.participant.id, "task.claim", key);
      expect(record).not.toBeNull();
      expect(record!.status).toBe("completed");
      expect(record!.responseStatus).toBe(200);
    });
  });

  describe("Workflow context routes", () => {
    /**
     * A Mission with two Tasks joined by ONE gate, carrying opaque config and a
     * Recovery reference the readers must drop. `grantBothTasks: false` produces
     * the deliberately PARTIAL grant (Mission + upstream Task A only) needed to
     * discriminate: the requested Task is visible while its opposite endpoint
     * is not.
     */
    async function setupWorkflowFixture(setup: RemoteSetup, opts?: { grantBothTasks?: boolean }) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Workflow Mission",
        priority: "medium",
        createdBy: "test",
      });
      const taskA = taskRepo.createTask({
        missionId: mission.id,
        title: "Upstream Task",
        description: "",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      const taskB = taskRepo.createTask({
        missionId: mission.id,
        title: "Downstream Task",
        description: "",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", taskA.id);
      if (opts?.grantBothTasks !== false) {
        grantRepo.addRemoteGrantTarget(setup.grant.id, "task", taskB.id);
      }

      const workflowId = workflowService.attachWorkflow(
        mission.id,
        setup.habitat.id,
        {
          gates: [
            {
              upstreamTaskKey: taskA.id,
              downstreamTaskKey: taskB.id,
              gateType: "on_complete" as const,
              matchConfig: {
                signalType: "experience",
                subjectContains: "shared-opaque-config-sentinel",
              },
            },
          ],
        },
        { secretVariable: "shared-resolved-variable-sentinel" },
        "test",
      );
      const [{ eq }, { taskWorkflowGates }] = await Promise.all([
        import("drizzle-orm"),
        import("../db/schema/index.js"),
      ]);
      const gate = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.workflowId, workflowId))
        .all()[0]!;
      // A Recovery reference on the gate is a distinct hidden-id class.
      const recoveryTask = taskRepo.createTask({
        missionId: mission.id,
        title: "Recovery Task",
        description: "",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      getDb()
        .update(taskWorkflowGates)
        .set({ recoveryTaskId: recoveryTask.id, recoveryDepth: 3 })
        .where(eq(taskWorkflowGates.id, gate.id))
        .run();
      return { mission, taskA, taskB, recoveryTask, gate, workflowId };
    }

    it("GET /missions/:id/workflow returns workflow shape when attached", async () => {
      const setup = setupRemoteFixture();
      const { mission, workflowId, taskA, taskB, recoveryTask, gate } = await setupWorkflowFixture(setup);
      // MISSION-ONLY visibility: drop both Task grant targets so the child Tasks
      // are NOT visible to this participant. The Mission projection must still
      // serve the restricted shape and must not leak the child Task ids.
      // Imported locally, matching this file's existing dynamic-import idiom, so
      // the module-scope `eq` is not shadowed by the local ones.
      const [{ and, eq }, { remoteGrantTargets }] = await Promise.all([
        import("drizzle-orm"),
        import("../db/schema/index.js"),
      ]);
      getDb()
        .delete(remoteGrantTargets)
        .where(
          and(
            eq(remoteGrantTargets.grantId, setup.grant.id),
            eq(remoteGrantTargets.targetType, "task"),
          ),
        )
        .run();

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/workflow`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // EXACT restricted Mission projection: status/version only, plus the
      // restricted gate. The Workflow id is not disclosed here.
      expect(body.workflow).toEqual({ status: "active", version: 1 });
      expect(Object.keys(body.workflow).toSorted()).toEqual(["status", "version"]);
      expect(body.gates).toEqual([{ gateType: "on_complete", satisfied: false, restricted: true }]);
      // Child Task ids, the opaque config sentinel, resolved variables and the
      // Recovery reference are absent from the whole response body.
      const text = res.body;
      for (const [what, value] of Object.entries({
        workflowId,
        upstreamTask: taskA.id,
        downstreamTask: taskB.id,
        recoveryTask: recoveryTask.id,
        gateId: gate.id,
        missionId: mission.id,
        "config sentinel": "shared-opaque-config-sentinel",
        "resolved variable sentinel": "shared-resolved-variable-sentinel",
      })) {
        expect(text, `shared Mission workflow must not disclose ${what}`).not.toContain(value);
      }
    });

    it("GET /missions/:id/workflow returns 404 when no workflow attached", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "No-Workflow Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/workflow`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(404);
    });

    it("GET /missions/:id/workflow rejects when read scope missing", async () => {
      const setup = setupRemoteFixture(["comment", "claim"]);
      const { mission } = await setupWorkflowFixture(setup);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/workflow`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(403);
    });

    it("GET /tasks/:id/workflow-context returns the restricted gate DTO under a PARTIAL same-Mission grant", async () => {
      const setup = setupRemoteFixture();
      // DELIBERATELY PARTIAL: only taskA is a grant target, so taskB is a hidden
      // same-Mission neighbour. Admission for the REQUESTED Task must be
      // sufficient, and its response must still hide the opposite endpoint.
      const { taskA, taskB, workflowId, gate, recoveryTask } = await setupWorkflowFixture(setup, {
        grantBothTasks: false,
      });

      // Visible upstream task has its downstream gate.
      const resUp = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskA.id}/workflow-context`,
        headers: remoteHeaders(setup),
      });
      expect(resUp.statusCode).toBe(200);
      expect(JSON.parse(resUp.body)).toEqual({
        upstream: [],
        downstream: [{ gateType: "on_complete", satisfied: false, restricted: true }],
      });
      expect(resUp.body).not.toContain(taskB.id);

      // Hidden downstream task is refused by exact visibility, and the refusal
      // leaks no gate type or state.
      const resDown = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskB.id}/workflow-context`,
        headers: remoteHeaders(setup),
      });
      expect(resDown.statusCode).toBe(403);
      expect(resDown.body).not.toContain("on_complete");

      // Exactly three keys per entry, asserted on the served bytes.
      expect(Object.keys(JSON.parse(resUp.body).downstream[0]).toSorted()).toEqual([
        "gateType",
        "restricted",
        "satisfied",
      ]);

      // No id, config, provenance or sentinel anywhere in the served payload.
      for (const [what, value] of Object.entries({
        upstreamTask: taskA.id,
        downstreamTask: taskB.id,
        workflowId,
        gateId: gate.id,
        recoveryTaskId: recoveryTask.id,
        "config sentinel": "shared-opaque-config-sentinel",
      })) {
        expect(resUp.body, `shared Task workflow-context must not disclose ${what}`).not.toContain(
          value,
        );
      }
    });

    it("GET /tasks/:id/workflow-context returns 404 when task not in any workflow", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Lone Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Lone Task",
        description: "",
        priority: "medium",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}/workflow-context`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(404);
    });

    it("GET /tasks/:id/workflow-context rejects without authentication", async () => {
      const setup = setupRemoteFixture();
      const { taskA } = await setupWorkflowFixture(setup);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskA.id}/workflow-context`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Anti-probing — info-disclosure hardening (T12)
  // Verifies that existence-leaking error codes are collapsed to a generic 403
  // on the remote `/api/shared/*` surface. The distinct reason is logged
  // server-side only.
  // ---------------------------------------------------------------------------

  describe("Anti-probing — remote surface disclosure hardening", () => {
    it("habitat-mismatch probe returns 403 with generic FORBIDDEN (not HABITAT_MISMATCH)", async () => {
      const setup = setupRemoteFixture();
      // Create a task in a DIFFERENT habitat
      const otherHabitat = setupHabitat();
      const mission = missionRepo.createMission({
        habitatId: otherHabitat.id,
        title: "Other Habitat Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Other Habitat Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("FORBIDDEN");
      expect(body.code).not.toBe("HABITAT_MISMATCH");
    });

    it("not-visible probe returns 403 with generic FORBIDDEN (not TARGET_NOT_VISIBLE)", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Hidden Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Hidden Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      // No grant target added — task is in same habitat but not visible

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("FORBIDDEN");
      expect(body.code).not.toBe("TARGET_NOT_VISIBLE");
    });

    it("habitat-mismatch reason is logged server-side via logger.warn", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const setup = setupRemoteFixture();
      const otherHabitat = setupHabitat();
      const mission = missionRepo.createMission({
        habitatId: otherHabitat.id,
        title: "Other Habitat Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Other Habitat Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });

      await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}`,
        headers: remoteHeaders(setup),
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "HABITAT_MISMATCH",
          targetId: task.id,
        }),
        "remote access denied",
      );
    });

    it("not-visible reason is logged server-side via logger.warn", async () => {
      const warnSpy = vi.spyOn(logger, "warn");
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Hidden Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Hidden Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });

      await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${task.id}`,
        headers: remoteHeaders(setup),
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "TARGET_NOT_VISIBLE",
          targetId: task.id,
        }),
        "remote access denied",
      );
    });

    it("TASK_NOT_OWNED remains a distinct 403 (not collapsed)", async () => {
      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Unclaimed Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Unclaimed Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      // Task is visible but not claimed by this participant

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/heartbeat`,
        headers: remoteHeaders(setup, "test-not-owned-key-1"),
        payload: { progress: "x" },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("TASK_NOT_OWNED");
    });

    it("genuinely-missing task returns 404 NOT_FOUND (unchanged)", async () => {
      const setup = setupRemoteFixture();
      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${randomUUID()}`,
        headers: remoteHeaders(setup),
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("NOT_FOUND");
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 0 — Characterization safety net for Remote Participant Actions
  // (release v0.35.0). Each test below is tagged `INTENTIONALLY-CHANGE` — it
  // pins the CURRENT (defective) behavior of the route handlers in
  // `routes/sharedApi.ts`. Future T2/T5 tickets prove their changes by
  // flipping these assertions (e.g. "not called" → "called", "200" → "403",
  // event action:"updated" → no event). Do not weaken these assertions to
  // make them pass; if a characterization assertion fails against current
  // code, stop and report.
  //
  // These are the ROUTE-HANDLER-LAYER counterpart to
  // `packages/api/src/test/claimPathCharacterization.test.ts`, which covers
  // the repo/service-wrapper layer (taskStateMachine.claimTaskByRemoteParticipant
  // result-shape parity). Tests here exercise the HTTP surface end-to-end
  // through sharedApiRoutes and pin route-side-effects (events, notifications,
  // module-level spies), so the two suites do not duplicate.
  // ---------------------------------------------------------------------------

  describe("Characterization — Remote Participant Actions (Phase 0, INTENTIONALLY-CHANGE)", () => {
    function seedTaskWithRequiredCapabilities(
      setup: ReturnType<typeof setupRemoteFixture>,
      requiredCapabilities: string[],
    ) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Char Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Char Task",
        description: "x",
        priority: "medium",
        requiredCapabilities,
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      return { mission, task };
    }

    function seedTaskWithRequiredDomain(
      setup: ReturnType<typeof setupRemoteFixture>,
      requiredDomain: string,
    ) {
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "Char Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Char Task",
        description: "x",
        priority: "medium",
        requiredCapabilities: [],
        requiredDomain,
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);
      return { mission, task };
    }

    it("1. D2 enforced — remote claim refused (capability_mismatch) with empty approvedCapabilities on a requiredCapabilities task", async () => {
      // D2 (enforceHostApprovedCapability) now defaults ON. The participant's
      // approvedCapabilities is empty by default (setupRemoteFixture); the task
      // requires "typescript" → capability_mismatch → 409 CONFLICT.
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, ["typescript"]);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-d2-claim-1"),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("capability_mismatch");
      expect(body.code).toBe("CONFLICT");
    });

    it("1b. D2 enforced — remote claim refused (domain_mismatch) with empty approvedDomains on a requiredDomain task", async () => {
      // D2 gate also enforces approvedDomains against task.requiredDomain.
      // The participant's approvedDomains is empty by default; the task
      // requires "infra" → domain_mismatch → 409 CONFLICT. Mirrors the
      // local task-delegation.ts:73-83 domain check, but with an array
      // (remote participants cover many domains; local agents have one).
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredDomain(setup, "infra");

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-d2-domain-1"),
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("domain_mismatch");
      expect(body.code).toBe("CONFLICT");
    });

    it("1c. D2 enforced — remote claim passes when approvedDomains covers requiredDomain", async () => {
      // Positive test for the domain gate: when the participant's
      // approvedDomains includes the task's requiredDomain, the claim
      // proceeds (returns 200 + task payload).
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredDomain(setup, "infra");
      participantRepo.updateHostApprovedCapabilities(setup.participant.id, [], ["infra"]);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-d2-domain-2"),
      });

      expect(res.statusCode).toBe(200);
    });

    it("2. onTransition wiring: remote claim invokes emitTransition", async () => {
      // The remote claim wrapper routes through emitTransition, firing its
      // outgoing fan (recalculateMissionStatus, emitAutoSignal,
      // notifyWatchers/SSE, notifyTransition) for remote claim.
      const emitSpy = vi.spyOn(transitionEmitter, "emitTransition");

      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, []);
      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-bypass-claim-2"),
      });

      expect(res.statusCode).toBe(200);
      expect(emitSpy).toHaveBeenCalled();
    });

    it('3. claim event via wrapper tx: action:"claimed", fromStatus:"pending"', async () => {
      // The remote claim wrapper creates exactly one `action:"claimed"` event
      // inside its atomic tx (via createEventWithClient). fromStatus is the
      // task's real prior status ("pending" — a valid claim always originates
      // from pending). The event is created through the wrapper's tx path,
      // not a manual hardcoded event in the route.
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, []);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-manual-event-3"),
      });
      expect(res.statusCode).toBe(200);

      const { events } = taskEventRepo.getEventsByTaskId(task.id);
      const claimed = events.find((e) => e.action === "claimed");
      expect(claimed).toBeDefined();
      expect(claimed!.action).toBe("claimed");
      // Phase-1 Edit B: fromStatus now reads task.status (the real prior
      // status); still "pending" because a valid claim always originates
      // from pending.
      expect(claimed!.fromStatus).toBe("pending");
      expect(claimed!.toStatus).toBe("claimed");
      expect(claimed!.actorType).toBe("remote_orcy");
      expect(claimed!.actorId).toBe(setup.participant.id);
    });

    it('4. comment no-over-emit: remote comment does NOT create a manual action:"updated" Task Event', async () => {
      // Phase-1 comment Option A fix: the remote task-comment handler no
      // longer hand-rolls an action:"updated" event nor a
      // pulse.signal_posted notification after a comment create.
      // commentService.addComment is the sole seam (it fires the real SSE +
      // hooks). This asserts the FIXED behavior — no action:"updated" Task
      // Event exists for a remote comment.
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, []);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/comments`,
        headers: remoteHeaders(setup, "test-char-comment-overemit-4"),
        payload: { content: "Hello from remote" },
      });
      expect(res.statusCode).toBe(201);

      const { events } = taskEventRepo.getEventsByTaskId(task.id);
      expect(events.find((e) => e.action === "updated")).toBeUndefined();
    });

    it("5. submit parity: remote submit runs quality-gate validation and assignReviewers", async () => {
      // The submit wrapper calls validateQualityGates + assignReviewers,
      // matching local submitTask parity.
      const qualitySpy = vi.spyOn(qualityGateService, "validateQualityGates");
      const assignSpy = vi.spyOn(reviewAssignment, "assignReviewers");

      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, []);

      taskStateMachine.claimTaskByRemoteParticipant(task.id, setup.participant.id);
      taskStateMachine.startTaskByRemoteParticipant(task.id, setup.participant.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/submit`,
        headers: remoteHeaders(setup, "test-char-submit-parity-5"),
        payload: { result: "done", artifacts: [] },
      });
      expect(res.statusCode).toBe(200);

      expect(qualitySpy).toHaveBeenCalled();
      expect(assignSpy).toHaveBeenCalled();

      const { events } = taskEventRepo.getEventsByTaskId(task.id);
      const submitted = events.find((e) => e.action === "submitted");
      expect(submitted).toBeDefined();
      // fromStatus is the task's real prior status ("in_progress" — the
      // state machine gates submit on in_progress).
      expect(submitted!.fromStatus).toBe("in_progress");
      expect(submitted!.toStatus).toBe("submitted");
      expect(submitted!.actorType).toBe("remote_orcy");
      expect(submitted!.actorId).toBe(setup.participant.id);
    });

    it("6. §5.3 removed: a tx-internal failure is reported as honest failure, not masked as 200", async () => {
      // The §5.3 swallow (re-fetch task → if looks claimed → 200) is removed.
      // The wrapper creates the event inside its atomic tx via
      // createEventWithClient. When that throws, the entire tx rolls back
      // (undoing the claim) and the route reports an honest failure.
      const createEventSpy = vi.spyOn(taskEventRepo, "createEventWithClient");
      createEventSpy.mockImplementation(() => {
        throw new Error("synthetic tx-internal event write failure");
      });

      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, []);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-swallow-6"),
      });

      // Under the new atomicity, the throw rolls back the tx → honest failure.
      expect(res.statusCode).not.toBe(200);
      // The spy was invoked (proves the throw was inside the tx, not before).
      expect(createEventSpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // T10 — Pulse + Evidence-link notification emit guards
  // Pins the single-emit (pulse) and zero-emit (evidence-link) behavior at the
  // route layer so a future regression — e.g. someone adding a route-side
  // notification to evidence-link, or a duplicate notification to pulse — is
  // caught. Test-only; no production code changed.
  // ---------------------------------------------------------------------------

  describe("T10 — Pulse + Evidence-link notification emit guards", () => {
    it("pulse route fires emitRemoteOriginatedNotification exactly once (no double-emit)", async () => {
      const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");

      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "T10 Pulse Mission",
        priority: "medium",
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "mission", mission.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/missions/${mission.id}/pulse`,
        headers: remoteHeaders(setup, "test-t10-pulse-guard-1"),
        payload: { signalType: "finding", subject: "T10 guard" },
      });
      expect(res.statusCode).toBe(201);

      // Exactly one cross-pod notification — no double.
      expect(notifSpy).toHaveBeenCalledTimes(1);
      expect(notifSpy.mock.calls[0]?.[0]?.eventType).toBe("pulse.signal_posted");
    });

    it("evidence-link route fires NO emitRemoteOriginatedNotification (no route-side notification)", async () => {
      const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");

      const setup = setupRemoteFixture();
      const mission = missionRepo.createMission({
        habitatId: setup.habitat.id,
        title: "T10 Evidence Mission",
        priority: "medium",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "T10 Evidence Task",
        description: "x",
        priority: "low",
        requiredCapabilities: [],
        labels: [],
        createdBy: "test",
      });
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", task.id);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/evidence-links`,
        headers: remoteHeaders(setup, "test-t10-evidence-guard-1"),
        payload: { url: "https://github.com/example/repo/pull/123" },
      });
      expect(res.statusCode).toBe(201);

      // The route fires no notification — single service emission only.
      expect(notifSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Local Delegated Claim Path — missingCapabilities forwarding
  // ---------------------------------------------------------------------------

  describe("Characterization — Local Delegated Claim Path (missingCapabilities forwarding)", () => {
    it("delegated claim refusal surfaces missingCapabilities in the 409 body", async () => {
      // The route handler at `routes/tasks/lifecycle.ts:74` must forward
      // `missingCapabilities` from `claimDelegatedTask`'s capability_mismatch
      // result to the 409 response body — mirroring the local-claim path at
      // line 90.  The route-level pre-check at lines 57-65 normally
      // intercepts capability mismatches first (403), so the service is
      // mocked to simulate the defense-in-depth 409 path.
      const localApp = Fastify({ logger: false });
      localApp.setValidatorCompiler(validatorCompiler);
      localApp.setSerializerCompiler(serializerCompiler);
      // Set the error handler at root level so it catches errors from all
      // child route contexts (Fastify encapsulation: sibling plugins don't
      // share error handlers).
      localApp.setErrorHandler((error, _request, reply) => {
        if (isAppError(error)) {
          reply.status(error.statusCode).send({
            error: error.message,
            code: error.code,
            details: error.details,
          });
          return;
        }
        const err = error as Error & { statusCode?: number };
        reply.status(err.statusCode || 500).send({
          error: err.message,
          statusCode: err.statusCode || 500,
        });
      });
      await localApp.register(taskLifecycleRoutes);
      await localApp.ready();

      try {
        // Agent with all required capabilities (passes the pre-check at 57-65)
        const { agent: delegate, plainApiKey: delegateKey } = agentService.createAgent({
          name: "delegated-409-delegate",
          type: "claude-code",
          domain: "fullstack",
          capabilities: ["python", "docker"],
        });
        const { agent: assignee } = agentService.createAgent({
          name: "delegated-409-assignee",
          type: "claude-code",
          domain: "fullstack",
          capabilities: [],
        });

        const habitat = boardRepo.createHabitat({ name: "Delegated 409 Habitat" });
        columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
        const mission = missionRepo.createMission({
          habitatId: habitat.id,
          title: "Delegated 409 Mission",
          priority: "medium",
          createdBy: "test",
        });
        const task = taskRepo.createTask({
          missionId: mission.id,
          title: "Delegated 409 Task",
          description: "needs python+docker",
          priority: "medium",
          requiredCapabilities: ["python", "docker"],
          labels: [],
          createdBy: "test",
        });

        updateTaskFixtureForTests(task.id, {
          delegatedToAgentId: delegate.id,
          status: "claimed",
          assignedAgentId: assignee.id,
        });

        // Mock the service to return capability_mismatch — simulates the
        // defense-in-depth path where the service-level check fires even
        // though the route pre-check passed.
        vi.spyOn(taskService, "claimDelegatedTask").mockReturnValueOnce({
          success: false,
          reason: "capability_mismatch",
          message: "Agent lacks required capabilities: python, docker",
          missingCapabilities: ["python", "docker"],
        });

        const res = await localApp.inject({
          method: "POST",
          url: `/tasks/${task.id}/claim`,
          headers: { "x-agent-api-key": delegateKey },
          payload: {},
        });

        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("CONFLICT");
        expect(body.details.missingCapabilities).toEqual(["python", "docker"]);
      } finally {
        await localApp.close();
      }
    });
  });
});
