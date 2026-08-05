/**
 * T5a — Unit tests for the remote-task-lifecycle seam.
 *
 * Tests the three wrappers (`claimTaskForRemote`, `submitTaskForRemote`,
 * `releaseTaskForRemote`) directly at the service layer — no Fastify, no HTTP.
 * Fixtures mirror `sharedApi.test.ts` / `claimPathCharacterization.test.ts`.
 *
 * Coverage:
 *   - Claim: happy path, D2 capability refusal, D1 interceptor veto, no-double-event
 *   - Submit: happy path, quality-gate refusal, assignReviewers called, no-double-event
 *   - Release: happy path, no notification
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
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
import * as pluginManager from "../plugins/pluginManager.js";
import * as qualityGateService from "../services/qualityGateService.js";
import * as reviewAssignment from "../services/reviewAssignmentService.js";
import * as transitionEmitter from "../services/tasks/transition-emitter.js";
import * as remoteNotifications from "../services/remoteNotifications.js";
import { InterceptorVetoError } from "../errors.js";
import {
  claimTaskForRemote,
  submitTaskForRemote,
  releaseTaskForRemote,
} from "../services/tasks/remote-task-lifecycle.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import type {
  RemoteGovernanceSettings,
  ParticipantStanding,
  RemoteActionScope,
} from "@orcy/shared/types";

const ORIGINAL_ENV = { ...process.env };

const ALL_SCOPES: RemoteActionScope[] = [
  "read",
  "comment",
  "claim",
  "submit",
  "release",
  "heartbeat",
  "evidence_link",
  "pulse.post",
];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface Fixture {
  ctx: RemoteParticipantContext;
  habitatId: string;
}

function setupRemoteFixture(
  standing: ParticipantStanding = "remote_contributor",
): Fixture {
  const habitat = habitatRepo.createHabitat({ name: "T5a Test Habitat" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });

  const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: "Remote Pod" });
  const activatedPod = podRepo.activateRemotePod(pod.id) ?? pod;

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: habitat.id,
    participantType: "remote_orcy",
    displayName: "Remote Worker",
    standing,
  });
  const activatedParticipant = participantRepo.activateRemoteParticipant(participant.id) ?? participant;

  const { credential } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
    label: "test-cred",
  });

  grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing,
    actionScopes: ALL_SCOPES,
  });

  const freshParticipant = participantRepo.getRemoteParticipantById(participant.id)!;
  const freshPod = podRepo.getRemotePodById(pod.id)!;
  const grants = grantRepo
    .getGrantsByHabitat(habitat.id)
    .filter(
      (g) =>
        g.remoteParticipantId === participant.id ||
        (g.remotePodId === pod.id && g.remoteParticipantId === null),
    );

  return {
    ctx: {
      participant: freshParticipant,
      pod: freshPod,
      credentialId: credential.id,
      habitatId: habitat.id,
      grants,
    },
    habitatId: habitat.id,
  };
}

function seedTask(habitatId: string, requiredCapabilities: string[] = []) {
  const mission = missionRepo.createMission({
    habitatId,
    title: "Test Mission",
    priority: "medium",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Test Task",
    description: "x",
    priority: "medium",
    requiredCapabilities,
    labels: [],
    createdBy: "test",
  });
  return task;
}

/** Update the habitat's `remoteGovernanceSettings` JSON column. */
function setGovernance(habitatId: string, value: RemoteGovernanceSettings | null) {
  const db = getDb();
  db.update(habitats)
    .set({ remoteGovernanceSettings: value })
    .where(eq(habitats.id, habitatId))
    .run();
}

/** Claim + start a task for a remote participant (precondition for submit tests). */
function claimAndStart(taskId: string, participantId: string): void {
  const claimResult = taskStateMachine.claimTaskByRemoteParticipant(taskId, participantId);
  if (!claimResult.success) throw new Error(`claim failed: ${claimResult.reason}`);
  const started = taskStateMachine.startTaskByRemoteParticipant(taskId, participantId);
  if (!started) throw new Error("start failed");
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initTestDb();
  // Ensure governance env doesn't leak — flags default OFF
  delete process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT;
  delete process.env.ORCY_PUBLIC_URL;
  delete process.env.ORCY_BASE_URL;
  pluginManager.resetPlugins();
});

afterEach(() => {
  pluginManager.resetPlugins();
  vi.restoreAllMocks();
  closeDb();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// claimTaskForRemote
// ---------------------------------------------------------------------------

describe("claimTaskForRemote", () => {
  it("happy path — claims the task and returns {success, task}", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    const result = claimTaskForRemote(task.id, ctx);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.task.status).toBe("claimed");
    expect(result.task.remoteAssignedParticipantId).toBe(ctx.participant.id);
  });

  it("returns not_found when the task does not exist", () => {
    const { ctx } = setupRemoteFixture();

    const result = claimTaskForRemote("nonexistent-task-id", ctx);

    expect(result).toEqual({ success: false, reason: "not_found" });
  });

  it("D2 refusal — capability_mismatch when enforceHostApprovedCapability is ON", () => {
    const { ctx, habitatId } = setupRemoteFixture();
    const task = seedTask(habitatId, ["typescript", "react"]);

    // Participant has NO approved capabilities; flag ON
    setGovernance(habitatId, {
      applyInterceptorsToRemote: false,
      enforceHostApprovedCapability: true,
    });

    const result = claimTaskForRemote(task.id, ctx);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe("capability_mismatch");
    expect(result.missingCapabilities).toEqual(
      expect.arrayContaining(["typescript", "react"]),
    );
  });

  it("D2 passes when participant has the required capabilities (flag ON)", () => {
    const { ctx, habitatId } = setupRemoteFixture();
    const task = seedTask(habitatId, ["typescript"]);

    // Give the participant the required capability
    participantRepo.updateHostApprovedCapabilities(
      ctx.participant.id,
      ["typescript"],
      [],
    );
    // Refresh the participant in the context so the wrapper sees updated capabilities
    ctx.participant = participantRepo.getRemoteParticipantById(ctx.participant.id)!;

    setGovernance(habitatId, {
      applyInterceptorsToRemote: false,
      enforceHostApprovedCapability: true,
    });

    const result = claimTaskForRemote(task.id, ctx);

    expect(result.success).toBe(true);
  });

  it("D2 NOT enforced when flag is OFF — claim succeeds even without capabilities", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId, ["typescript"]);

    // Flags OFF (default) — no capability enforcement
    const result = claimTaskForRemote(task.id, ctx);

    expect(result.success).toBe(true);
  });

  it("D1 veto — throws InterceptorVetoError when applyInterceptorsToRemote is ON", () => {
    const { ctx, habitatId } = setupRemoteFixture();
    const task = seedTask(habitatId);

    setGovernance(habitatId, {
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: false,
    });

    // Mock the pre-interceptor to return a veto
    vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValue({
      allow: false,
      reason: "Blocked by test interceptor",
    });

    expect(() => claimTaskForRemote(task.id, ctx)).toThrow(InterceptorVetoError);

    // Verify the task was NOT claimed (no DB write occurred)
    const unchanged = taskRepo.getTaskById(task.id);
    expect(unchanged?.status).toBe("pending");
    expect(unchanged?.remoteAssignedParticipantId).toBeNull();
  });

  it("D1 NOT enforced when flag is OFF — interceptor not called", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    // Flags OFF (default)
    const spy = vi.spyOn(pluginManager, "runPreInterceptors");

    claimTaskForRemote(task.id, ctx);

    expect(spy).not.toHaveBeenCalled();
  });

  it("no double event — exactly one 'claimed' event created; emitTransition uses existingEventId", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    const emitSpy = vi.spyOn(transitionEmitter, "emitTransition");

    claimTaskForRemote(task.id, ctx);

    // emitTransition was called with existingEventId set (invariant #9)
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const callArgs = emitSpy.mock.calls[0];
    const context = callArgs?.[3]; // 4th arg is TransitionContext
    expect(context?.existingEventId).toBeDefined();
    expect(typeof context?.existingEventId).toBe("string");

    // Exactly ONE 'claimed' event in the DB (not two — no double event)
    const { events } = taskEventRepo.getEventsByTaskId(task.id);
    const claimedEvents = events.filter((e) => e.action === "claimed");
    expect(claimedEvents).toHaveLength(1);
    // The event id should match the existingEventId passed to emitTransition
    expect(claimedEvents[0]!.id).toBe(context!.existingEventId);
  });

  it("fires the step-4.5 notification on success", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");

    claimTaskForRemote(task.id, ctx);

    expect(notifSpy).toHaveBeenCalledTimes(1);
    const notifArgs = notifSpy.mock.calls[0]?.[0];
    expect(notifArgs?.eventType).toBe("task.assigned");
    expect(notifArgs?.targetId).toBe(task.id);
  });
});

// ---------------------------------------------------------------------------
// submitTaskForRemote
// ---------------------------------------------------------------------------

describe("submitTaskForRemote", () => {
  it("happy path — submits the task and returns {success, task}", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    claimAndStart(task.id, ctx.participant.id);

    const result = submitTaskForRemote(task.id, ctx, "Work completed", []);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.task.status).toBe("submitted");
    expect(result.task.result).toBe("Work completed");
  });

  it("returns not_found when the task does not exist", () => {
    const { ctx } = setupRemoteFixture();

    const result = submitTaskForRemote("nonexistent", ctx, "result", []);

    expect(result).toEqual({ success: false, reason: "not_found" });
  });

  it("returns not_owned when the task is not owned by this participant", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    // Task is NOT claimed by this participant
    const result = submitTaskForRemote(task.id, ctx, "result", []);

    expect(result).toEqual({ success: false, reason: "not_owned" });
  });

  it("quality-gate refusal — returns quality_gates_not_met when gates fail", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    claimAndStart(task.id, ctx.participant.id);

    // Mock quality gates to fail
    vi.spyOn(qualityGateService, "validateQualityGates").mockReturnValue({
      passed: false,
      failures: [{ category: "code-review", missingItems: ["PR approval"] }],
    });

    const result = submitTaskForRemote(task.id, ctx, "result", []);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason).toBe("quality_gates_not_met");
    expect(result.missingQualityItems).toHaveLength(1);
  });

  it("calls assignReviewers on successful submit", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    claimAndStart(task.id, ctx.participant.id);

    const assignSpy = vi.spyOn(reviewAssignment, "assignReviewers");

    submitTaskForRemote(task.id, ctx, "result", []);

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(task.id, ctx.habitatId, ctx.participant.id);
  });

  it("D1 veto — throws InterceptorVetoError when applyInterceptorsToRemote is ON", () => {
    const { ctx, habitatId } = setupRemoteFixture();
    const task = seedTask(habitatId);
    claimAndStart(task.id, ctx.participant.id);

    setGovernance(habitatId, {
      applyInterceptorsToRemote: true,
      enforceHostApprovedCapability: false,
    });

    vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValue({
      allow: false,
      reason: "Submit blocked by interceptor",
    });

    expect(() => submitTaskForRemote(task.id, ctx, "result", [])).toThrow(InterceptorVetoError);

    // Task should still be in_progress (no mutation)
    const unchanged = taskRepo.getTaskById(task.id);
    expect(unchanged?.status).toBe("in_progress");
  });

  it("no double event — exactly one 'submitted' event; emitTransition uses existingEventId", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    claimAndStart(task.id, ctx.participant.id);

    const emitSpy = vi.spyOn(transitionEmitter, "emitTransition");

    submitTaskForRemote(task.id, ctx, "result", []);

    const submitCall = emitSpy.mock.calls.find(
      (c) => c[1] === "submitted",
    );
    expect(submitCall).toBeDefined();
    const context = submitCall?.[3];
    expect(context?.existingEventId).toBeDefined();

    // Exactly ONE 'submitted' event in the DB
    const { events } = taskEventRepo.getEventsByTaskId(task.id);
    const submittedEvents = events.filter((e) => e.action === "submitted");
    expect(submittedEvents).toHaveLength(1);
    expect(submittedEvents[0]!.id).toBe(context!.existingEventId);
  });

  it("fires the step-4.5 notification on success", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    claimAndStart(task.id, ctx.participant.id);

    const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");

    submitTaskForRemote(task.id, ctx, "result", []);

    expect(notifSpy).toHaveBeenCalledTimes(1);
    const notifArgs = notifSpy.mock.calls[0]?.[0];
    expect(notifArgs?.eventType).toBe("task.review_requested");
  });
});

// ---------------------------------------------------------------------------
// releaseTaskForRemote
// ---------------------------------------------------------------------------

describe("releaseTaskForRemote", () => {
  it("happy path — releases the task back to pending", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    // Claim first
    taskStateMachine.claimTaskByRemoteParticipant(task.id, ctx.participant.id);

    const result = releaseTaskForRemote(task.id, ctx, "done for now");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.task.status).toBe("pending");
    expect(result.task.remoteAssignedParticipantId).toBeNull();
  });

  it("returns not_found when the task does not exist", () => {
    const { ctx } = setupRemoteFixture();

    const result = releaseTaskForRemote("nonexistent", ctx);

    expect(result).toEqual({ success: false, reason: "not_found" });
  });

  it("returns not_owned when the task is not owned by this participant", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);

    // Task is NOT claimed
    const result = releaseTaskForRemote(task.id, ctx);

    expect(result).toEqual({ success: false, reason: "not_owned" });
  });

  it("NO notification — release does not fire emitRemoteOriginatedNotification", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    taskStateMachine.claimTaskByRemoteParticipant(task.id, ctx.participant.id);

    const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");

    releaseTaskForRemote(task.id, ctx, "releasing");

    expect(notifSpy).not.toHaveBeenCalled();
  });

  it("no double event — exactly one 'released' event; emitTransition uses existingEventId", () => {
    const { ctx } = setupRemoteFixture();
    const task = seedTask(ctx.habitatId);
    taskStateMachine.claimTaskByRemoteParticipant(task.id, ctx.participant.id);

    const emitSpy = vi.spyOn(transitionEmitter, "emitTransition");

    releaseTaskForRemote(task.id, ctx, "releasing");

    const releaseCall = emitSpy.mock.calls.find(
      (c) => c[1] === "released",
    );
    expect(releaseCall).toBeDefined();
    const context = releaseCall?.[3];
    expect(context?.existingEventId).toBeDefined();

    // Exactly ONE 'released' event in the DB
    const { events } = taskEventRepo.getEventsByTaskId(task.id);
    const releasedEvents = events.filter((e) => e.action === "released");
    expect(releasedEvents).toHaveLength(1);
    expect(releasedEvents[0]!.id).toBe(context!.existingEventId);
  });
});
