import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { initTestDb, closeDb } from "../db/index.js";
import { sharedApiRoutes } from "../routes/sharedApi.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as boardRepo from "../repositories/habitat.js";
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
    function setupWorkflowFixture(setup: RemoteSetup) {
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
      grantRepo.addRemoteGrantTarget(setup.grant.id, "task", taskB.id);

      const workflowId = workflowService.attachWorkflow(
        mission.id,
        setup.habitat.id,
        {
          gates: [
            {
              upstreamTaskKey: taskA.id,
              downstreamTaskKey: taskB.id,
              gateType: "on_complete" as const,
            },
          ],
        },
        {},
        "test",
      );
      return { mission, taskA, taskB, workflowId };
    }

    it("GET /missions/:id/workflow returns workflow shape when attached", async () => {
      const setup = setupRemoteFixture();
      const { mission, workflowId } = setupWorkflowFixture(setup);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/workflow`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.workflow.id).toBe(workflowId);
      expect(body.workflow.status).toBe("active");
      expect(body.gates).toHaveLength(1);
      expect(body.gates[0].gateType).toBe("on_complete");
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
      const { mission } = setupWorkflowFixture(setup);

      const res = await app!.inject({
        method: "GET",
        url: `/api/shared/missions/${mission.id}/workflow`,
        headers: remoteHeaders(setup),
      });

      expect(res.statusCode).toBe(403);
    });

    it("GET /tasks/:id/workflow-context returns upstream and downstream gates", async () => {
      const setup = setupRemoteFixture();
      const { taskA, taskB } = setupWorkflowFixture(setup);

      // Downstream task has upstream gate
      const resDown = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskB.id}/workflow-context`,
        headers: remoteHeaders(setup),
      });
      expect(resDown.statusCode).toBe(200);
      const bodyDown = JSON.parse(resDown.body);
      expect(bodyDown.upstream).toHaveLength(1);
      expect(bodyDown.downstream).toHaveLength(0);

      // Upstream task has downstream gate
      const resUp = await app!.inject({
        method: "GET",
        url: `/api/shared/tasks/${taskA.id}/workflow-context`,
        headers: remoteHeaders(setup),
      });
      expect(resUp.statusCode).toBe(200);
      const bodyUp = JSON.parse(resUp.body);
      expect(bodyUp.upstream).toHaveLength(0);
      expect(bodyUp.downstream).toHaveLength(1);
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
      const { taskA } = setupWorkflowFixture(setup);

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

    it("1. INTENTIONALLY-CHANGE — D2 gap: remote claim succeeds with empty approvedCapabilities on a requiredCapabilities task", async () => {
      // Pin: today's route does NOT gate claim eligibility on capability
      // overlap between participant.approvedCapabilities and
      // task.requiredCapabilities. The participant's approvedCapabilities is
      // empty by default (setupRemoteFixture); the task requires "typescript".
      // Future T5/D2 closes the gap; this assertion then flips to "403".
      const setup = setupRemoteFixture();
      const { task } = seedTaskWithRequiredCapabilities(setup, ["typescript"]);

      const res = await app!.inject({
        method: "POST",
        url: `/api/shared/tasks/${task.id}/claim`,
        headers: remoteHeaders(setup, "test-char-d2-claim-1"),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.task.id).toBe(task.id);
      expect(body.task.status).toBe("claimed");
      expect(body.task.remoteAssignedParticipantId).toBe(setup.participant.id);
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

    it("3. claim event via wrapper tx: action:\"claimed\", fromStatus:\"pending\"", async () => {
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

    it("4. comment no-over-emit: remote comment does NOT create a manual action:\"updated\" Task Event", async () => {
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
});
