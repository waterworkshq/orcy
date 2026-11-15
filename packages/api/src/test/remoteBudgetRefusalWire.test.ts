import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { DEFAULT_TASK_TRANSITION_CEILING } from "@orcy/shared";
import type { ParticipantStanding, RemoteActionScope } from "@orcy/shared/types";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats, tasks } from "../db/schema/index.js";
import { sharedApiRoutes } from "../routes/sharedApi.js";
import { registerErrorHandler } from "../errors/plugin.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskEventRepo from "../repositories/events/event-crud.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as idempotencyRepo from "../repositories/remoteIdempotency.js";
import * as qualityGateService from "../services/qualityGateService.js";
import * as pluginManager from "../plugins/pluginManager.js";

interface RemoteSetup {
  habitatId: string;
  participantId: string;
  secret: string;
  grantId: string;
}

const ALL_SCOPES: RemoteActionScope[] = ["read", "claim", "submit", "release"];

function setupRemoteFixture(
  actionScopes: RemoteActionScope[] = ALL_SCOPES,
  participantType: "remote_orcy" | "remote_human" = "remote_orcy",
  standing: ParticipantStanding = "remote_contributor",
): RemoteSetup {
  const habitat = habitatRepo.createHabitat({ name: "Remote budget wire habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: "Remote budget wire pod" });
  podRepo.activateRemotePod(pod.id);
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: habitat.id,
    participantType,
    displayName: "Remote budget wire participant",
    standing,
  });
  participantRepo.activateRemoteParticipant(participant.id);
  const { plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
    label: "remote-budget-wire",
  });
  const grant = grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing,
    actionScopes,
  });
  return {
    habitatId: habitat.id,
    participantId: participant.id,
    secret: plaintextSecret,
    grantId: grant.id,
  };
}

function seedTask(setup: RemoteSetup) {
  const mission = missionRepo.createMission({
    habitatId: setup.habitatId,
    title: "Remote budget wire mission",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Remote budget wire task",
    createdBy: "test",
  });
  grantRepo.addRemoteGrantTarget(setup.grantId, "mission", mission.id);
  grantRepo.addRemoteGrantTarget(setup.grantId, "task", task.id);
  return task;
}

function claimTask(taskId: string, participantId: string): void {
  const claimed = taskStateMachine.claimTaskByRemoteParticipant(taskId, participantId);
  if (!claimed.success) throw new Error(`fixture claim failed: ${claimed.reason}`);
}

function claimAndStart(taskId: string, participantId: string): void {
  claimTask(taskId, participantId);
  if (!taskStateMachine.startTaskByRemoteParticipant(taskId, participantId)) {
    throw new Error("fixture start failed");
  }
}

function exhaustBudget(taskId: string): void {
  for (let i = 0; i < DEFAULT_TASK_TRANSITION_CEILING; i++) {
    taskEventRepo.createEvent({
      taskId,
      actorType: "remote_orcy",
      actorId: "remote-budget-wire-fixture",
      action: "claimed",
    });
  }
}

function headers(setup: RemoteSetup, key = randomUUID()): Record<string, string> {
  return { "x-orcy-remote-key": setup.secret, "idempotency-key": key };
}

function payloadFor(action: "submit" | "release"): { result: string } | { reason: string } {
  return action === "submit" ? { result: "completed remotely" } : { reason: "handing back" };
}

async function post(
  app: FastifyInstance,
  setup: RemoteSetup,
  action: "submit" | "release",
  taskId: string,
  key = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/api/shared/tasks/${taskId}/${action}`,
    headers: headers(setup, key),
    payload: payloadFor(action),
  });
}

function transitionEvents(taskId: string, action: "submitted" | "released") {
  return taskEventRepo
    .getEventsByTaskId(taskId)
    .events.filter((event) => event.action === action);
}

let app: FastifyInstance;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(sharedApiRoutes, { prefix: "/api/shared" });
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  pluginManager.resetPlugins();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await app.close();
  closeDb();
});

describe("remote transition-budget refusal wire", () => {
  it("submit keeps the generic conflict and adds only the budget reason", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);
    const before = taskRepo.getTaskById(task.id)!;
    const key = "00000000-0000-4000-8000-000000000001";

    const response = await post(app, setup, "submit", task.id, key);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Cannot submit task in current state",
      code: "TASK_SUBMIT_FAILED",
      details: { reason: "transition_budget_exhausted" },
    });
    expect(taskRepo.getTaskById(task.id)).toEqual(before);
    expect(transitionEvents(task.id, "submitted")).toHaveLength(0);
    const envelope = idempotencyRepo.getIdempotencyKey(
      setup.participantId,
      "task.submit",
      key,
    );
    expect(envelope).toMatchObject({
      status: "failed",
      errorMessage: "Route handler error",
    });
  });

  it("release keeps the generic conflict and adds only the budget reason", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);
    const before = taskRepo.getTaskById(task.id)!;
    const key = "00000000-0000-4000-8000-000000000002";

    const response = await post(app, setup, "release", task.id, key);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Cannot release task in current state",
      code: "TASK_RELEASE_FAILED",
      details: { reason: "transition_budget_exhausted" },
    });
    expect(taskRepo.getTaskById(task.id)).toEqual(before);
    expect(transitionEvents(task.id, "released")).toHaveLength(0);
    expect(
      idempotencyRepo.getIdempotencyKey(setup.participantId, "task.release", key),
    ).toMatchObject({ status: "failed" });
  });

  it("same-key retry replays the prior failure instead of the budget signal", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);
    const key = "00000000-0000-4000-8000-000000000003";

    const first = await post(app, setup, "submit", task.id, key);
    const replay = await post(app, setup, "submit", task.id, key);

    expect(first.statusCode).toBe(409);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({
      error: "Route handler error",
      code: "IDEMPOTENCY_KEY_PRIOR_FAILURE",
    });
    expect(replay.body).not.toContain("transition_budget_exhausted");
    expect(transitionEvents(task.id, "submitted")).toHaveLength(0);
  });

  it("raced reassignment after the snapshot precheck is never budget-branded", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);
    vi.spyOn(qualityGateService, "validateQualityGates").mockImplementation(() => {
      getDb()
        .update(tasks)
        .set({ remoteAssignedParticipantId: "raced-reassignment-owner" })
        .where(eq(tasks.id, task.id))
        .run();
      return { passed: true, failures: [] };
    });

    const response = await post(app, setup, "submit", task.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Cannot submit task in current state",
      code: "TASK_SUBMIT_FAILED",
    });
    expect(response.body).not.toContain("transition_budget_exhausted");
    expect(taskRepo.getTaskById(task.id)).toMatchObject({
      status: "in_progress",
      remoteAssignedParticipantId: "raced-reassignment-owner",
    });
    expect(transitionEvents(task.id, "submitted")).toHaveLength(0);
  });

  it("wrong-state refusal takes precedence over an exhausted budget", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimTask(task.id, setup.participantId);
    exhaustBudget(task.id);

    const response = await post(app, setup, "submit", task.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Cannot submit task in current state",
      code: "TASK_SUBMIT_FAILED",
    });
    expect(transitionEvents(task.id, "submitted")).toHaveLength(0);
  });

  it("flag-enabled interceptor veto wins over an exhausted budget", async () => {
    const setup = setupRemoteFixture();
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);
    getDb()
      .update(habitats)
      .set({
        remoteGovernanceSettings: {
          applyInterceptorsToRemote: true,
          enforceHostApprovedCapability: false,
        },
      })
      .where(eq(habitats.id, setup.habitatId))
      .run();
    vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValue({
      allow: false,
      reason: "policy veto",
    });

    const response = await post(app, setup, "submit", task.id);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Transition blocked by lifecycle interceptor",
      code: "INTERCEPTOR_VETO",
    });
    expect(response.body).not.toContain("transition_budget_exhausted");
    expect(taskRepo.getTaskById(task.id)!.status).toBe("in_progress");
    expect(transitionEvents(task.id, "submitted")).toHaveLength(0);
  });

  it("remote human submit remains exempt from an exhausted budget", async () => {
    const setup = setupRemoteFixture(ALL_SCOPES, "remote_human");
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    exhaustBudget(task.id);

    const response = await post(app, setup, "submit", task.id);

    expect(response.statusCode).toBe(200);
    expect(response.json().task.status).toBe("submitted");
    expect(response.body).not.toContain("transition_budget_exhausted");
  });
});

describe.each([
  { action: "submit" as const, code: "TASK_SUBMIT_FAILED", message: "Cannot submit task in current state" },
  { action: "release" as const, code: "TASK_RELEASE_FAILED", message: "Cannot release task in current state" },
])("remote $action non-budget refusal wire", ({ action, code, message }) => {
  it("missing task remains the exact 404 response", async () => {
    const setup = setupRemoteFixture([action]);

    const response = await post(app, setup, action, randomUUID());

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Task not found", code: "NOT_FOUND" });
  });

  it("foreign-habitat task remains the exact generic 403 response", async () => {
    const owner = setupRemoteFixture();
    const task = seedTask(owner);
    const foreign = setupRemoteFixture([action]);

    const response = await post(app, foreign, action, task.id);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Access denied", code: "FORBIDDEN" });
  });

  it("unowned task remains the exact TASK_NOT_OWNED response", async () => {
    const setup = setupRemoteFixture([action]);
    const task = seedTask(setup);

    const response = await post(app, setup, action, task.id);

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Task is not claimed by this participant",
      code: "TASK_NOT_OWNED",
    });
  });

  it("wrong-state refusal has the generic conflict without details", async () => {
    const setup = setupRemoteFixture([action]);
    const task = seedTask(setup);
    if (action === "submit") {
      claimTask(task.id, setup.participantId);
    } else {
      claimAndStart(task.id, setup.participantId);
      const submitted = taskStateMachine.submitTaskByRemoteParticipant(
        task.id,
        setup.participantId,
        "already submitted",
        [],
      );
      if (!submitted) throw new Error("fixture submit failed");
    }

    const response = await post(app, setup, action, task.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: message, code });
  });
});

describe("remote submit quality refusal wire", () => {
  it("quality-gate refusal has the generic conflict without details", async () => {
    const setup = setupRemoteFixture(["submit"]);
    const task = seedTask(setup);
    claimAndStart(task.id, setup.participantId);
    vi.spyOn(qualityGateService, "validateQualityGates").mockReturnValue({
      passed: false,
      failures: [{ category: "code-review", missingItems: ["PR approval"] }],
    });

    const response = await post(app, setup, "submit", task.id);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "Cannot submit task in current state",
      code: "TASK_SUBMIT_FAILED",
    });
    expect(taskRepo.getTaskById(task.id)!.status).toBe("in_progress");
  });
});
