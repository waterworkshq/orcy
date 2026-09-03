/**
 * Transition budget Ticket 2 — budget guard + mutation wiring discriminators.
 *
 * Seeded-event discriminators against the metered-mutation wiring (plan §5):
 * the meter is the `task_events` trail (metered actions, non-human actors);
 * the guard refuses the (N+1)th metered attempt at `count >= ceiling`.
 *
 * Module-contract tests import `transitionBudget.ts` DYNAMICALLY so the
 * behavioral discriminators stay per-test attributable while the module does
 * not exist (RED phase) — the ticket-1 lifecycleSettings precedent.
 *
 * Coverage (each test states its discriminating failure mode in a tail
 * comment):
 *   - default ceiling 12 (null blob) → 13th metered claim refuses [RED]
 *   - repo-level claim flattens to legacy "transition_budget_exhausted" [RED]
 *   - submit refuses with typed error, status unchanged [RED]
 *   - start / release / fail / agent-reject refuse (null convention) [RED]
 *   - retryService.executeRetry refuses over budget [RED]
 *   - remote claim/submit/release refuse; remote_human submit exempt [RED/GREEN-stays]
 *   - approved / completed succeed regardless of count (exits untaxed) [GREEN-stays]
 *   - human rejection succeeds over budget (exemption) [GREEN-stays]
 *   - ceiling 0 → opt-out unmetered [GREEN-stays]
 *   - ceiling n → (n+1)th refuses [RED]
 *   - created/updated/delegated events consume nothing [GREEN-stays]
 *   - human-actor metered events do not count (actor_type filter) [GREEN-stays]
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats, tasks, taskEvents } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as eventRepo from "../repositories/events/event-crud.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";
import * as retryService from "../services/retryService.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import {
  claimTaskForRemote,
  submitTaskForRemote,
  releaseTaskForRemote,
} from "../services/tasks/remote-task-lifecycle.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import type {
  LifecycleSettings,
  ParticipantStanding,
  RemoteActionScope,
} from "@orcy/shared";

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

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Transition Budget Habitat" });
  habitatId = habitat.id;
  columnRepo.createColumn({ habitatId, name: "To Do", order: 0 });
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent;
}

function seedTask(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    title: `Mission ${title}`,
    priority: "medium",
    createdBy: "user-1",
  });
  return taskCrud.createTask({
    missionId: mission.id,
    title,
    description: "",
    priority: "medium",
    labels: [],
    createdBy: "user-1",
  });
}

function setLifecycle(value: LifecycleSettings | null) {
  getDb()
    .update(habitats)
    .set({ lifecycleSettings: value })
    .where(eq(habitats.id, habitatId))
    .run();
}

/** Seeds `count` task_events rows on taskId with the given action/actor. */
function seedEvents(
  taskId: string,
  count: number,
  action: Parameters<typeof eventRepo.createEvent>[0]["action"] = "claimed",
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod" = "agent",
) {
  for (let i = 0; i < count; i++) {
    eventRepo.createEvent({
      taskId,
      actorType,
      actorId: `${actorType}-seed`,
      action,
    });
  }
}

function countEvents(taskId: string): number {
  return getDb()
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all().length;
}

/** Drives pending → claimed → in_progress at the REPO level (no events, no
 * quality-checklist side effects) so behavioral tests control the meter exactly. */
function claimAndStartRepo(taskId: string, agentId: string) {
  const claimed = taskStateMachine.claimTask(taskId, agentId);
  if (!claimed.success) throw new Error(`setup claim failed: ${claimed.reason}`);
  const started = taskStateMachine.startTask(taskId, agentId);
  if (!started) throw new Error("setup start failed");
}

/** Drives pending → submitted via repo claim+start+submit (no events). */
function driveToSubmittedRepo(taskId: string, agentId: string) {
  claimAndStartRepo(taskId, agentId);
  const submitted = taskStateMachine.submitTask(taskId, agentId, "result", []);
  if (!submitted) throw new Error("setup submit failed");
}

// ---------------------------------------------------------------------------
// Remote fixture (mirrors remoteTaskLifecycle.test.ts setupRemoteFixture)
// ---------------------------------------------------------------------------

interface RemoteFixture {
  ctx: RemoteParticipantContext;
}

function setupRemoteFixture(participantType: "remote_orcy" | "remote_human"): RemoteFixture {
  const pod = podRepo.createRemotePod({ habitatId, name: "Budget Remote Pod" });
  podRepo.activateRemotePod(pod.id);

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId,
    participantType,
    displayName: `Budget ${participantType}`,
    standing: "remote_contributor" as ParticipantStanding,
  });
  participantRepo.activateRemoteParticipant(participant.id);

  const { credential } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId,
    credentialType: "api",
    label: "budget-test-cred",
  });

  grantRepo.createRemoteGrant({
    habitatId,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor" as ParticipantStanding,
    actionScopes: ALL_SCOPES,
  });

  const freshParticipant = participantRepo.getRemoteParticipantById(participant.id)!;
  const freshPod = podRepo.getRemotePodById(pod.id)!;
  const grants = grantRepo
    .getGrantsByHabitat(habitatId)
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
      habitatId,
      grants,
    },
  };
}

/** Claim + start at the repo level for a remote participant (no events). */
function claimAndStartRemoteRepo(taskId: string, participantId: string) {
  const claimResult = taskStateMachine.claimTaskByRemoteParticipant(taskId, participantId);
  if (!claimResult.success) throw new Error(`setup remote claim failed: ${claimResult.reason}`);
  const started = taskStateMachine.startTaskByRemoteParticipant(taskId, participantId);
  if (!started) throw new Error("setup remote start failed");
}

// ---------------------------------------------------------------------------
// Module contract (dynamic import — the module does not exist in RED phase)
// ---------------------------------------------------------------------------

describe("transitionBudget module contract", () => {
  it("resolves the ceiling: null/absent blob → 12, 0 → opt-out, n → n", async () => {
    const mod = await import("../services/tasks/transitionBudget.js");
    const db = getDb();
    // Fresh habitat: blob null → default 12
    expect(mod.resolveCeiling(db, habitatId)).toBe(12);
    setLifecycle({ taskTransitionCeiling: null });
    expect(mod.resolveCeiling(db, habitatId)).toBe(12);
    setLifecycle({ taskTransitionCeiling: 0 });
    expect(mod.resolveCeiling(db, habitatId)).toBe(0);
    setLifecycle({ taskTransitionCeiling: 7 });
    expect(mod.resolveCeiling(db, habitatId)).toBe(7);
    // Missing habitat → finite default, never unbounded
    expect(mod.resolveCeiling(db, "no-such-habitat")).toBe(12);
  });

  it("counts only metered actions by non-human actors", async () => {
    const mod = await import("../services/tasks/transitionBudget.js");
    const task = seedTask("count-contract");
    expect(mod.countMeteredTransitions(getDb(), task.id)).toBe(0);
    seedEvents(task.id, 3, "claimed", "agent");
    seedEvents(task.id, 2, "rejected", "remote_orcy");
    seedEvents(task.id, 4, "created", "agent");
    seedEvents(task.id, 1, "claimed", "human");
    seedEvents(task.id, 1, "started", "remote_human");
    expect(mod.countMeteredTransitions(getDb(), task.id)).toBe(5);
  });

  it("guardTransition: refuses at count>=ceiling, skips human actors and opt-out", async () => {
    const mod = await import("../services/tasks/transitionBudget.js");
    const task = seedTask("guard-contract");
    seedEvents(task.id, 12, "claimed", "agent");
    const refused = mod.guardTransition(getDb(), task.id, habitatId, "agent");
    expect(refused.outcome).toBe("refused");
    const human = mod.guardTransition(getDb(), task.id, habitatId, "human");
    expect(human.outcome).not.toBe("refused");
    setLifecycle({ taskTransitionCeiling: 0 });
    const optedOut = mod.guardTransition(getDb(), task.id, habitatId, "agent");
    expect(optedOut.outcome).not.toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// Behavioral discriminators — local paths
// ---------------------------------------------------------------------------

describe("transition budget — claim wiring", () => {
  it("refuses the 13th metered claim at the default ceiling (null habitat blob) and leaves the task pending", () => {
    const agent = seedAgent("budget-claimer");
    const task = seedTask("claim-13th");
    seedEvents(task.id, 12, "claimed", "agent");

    const result = taskStateMachine.claimTask(task.id, agent.id);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("transition_budget_exhausted");
    expect(taskCrud.getTaskById(task.id)?.status).toBe("pending");
    expect(countEvents(task.id)).toBe(12);
  });

  it("refuses at a custom ceiling: ceiling 2, 2 seeded events → 3rd refuses; 1 event → allows", () => {
    setLifecycle({ taskTransitionCeiling: 2 });
    const agent = seedAgent("budget-ceiling-2");
    const exhausted = seedTask("ceiling-2-exhausted");
    seedEvents(exhausted.id, 2, "claimed", "agent");
    const refused = taskStateMachine.claimTask(exhausted.id, agent.id);
    expect(refused.success).toBe(false);

    const fresh = seedTask("ceiling-2-fresh");
    seedEvents(fresh.id, 1, "claimed", "agent");
    const allowed = taskStateMachine.claimTask(fresh.id, agent.id);
    expect(allowed.success).toBe(true);
  });

  it("opt-out ceiling 0 leaves the habitat unmetered regardless of count", () => {
    setLifecycle({ taskTransitionCeiling: 0 });
    const agent = seedAgent("budget-optout");
    const task = seedTask("opt-out");
    seedEvents(task.id, 40, "claimed", "agent");

    const result = taskStateMachine.claimTask(task.id, agent.id);
    expect(result.success).toBe(true);
  });

  it("created/updated/delegated events consume nothing", () => {
    const agent = seedAgent("budget-exempt-events");
    const task = seedTask("exempt-actions");
    seedEvents(task.id, 20, "created", "agent");
    seedEvents(task.id, 20, "updated", "agent");
    seedEvents(task.id, 20, "delegated", "agent");

    const result = taskStateMachine.claimTask(task.id, agent.id);
    expect(result.success).toBe(true);
  });

  it("human-actor metered events do not count (actor_type filter at count time)", () => {
    const agent = seedAgent("budget-human-events");
    const task = seedTask("human-actor-events");
    seedEvents(task.id, 12, "claimed", "human");
    seedEvents(task.id, 12, "submitted", "remote_human");

    const result = taskStateMachine.claimTask(task.id, agent.id);
    expect(result.success).toBe(true);
  });
});

describe("transition budget — exempt exits and human actors", () => {
  it("approveTask succeeds over budget (approved is untaxed)", () => {
    const agent = seedAgent("budget-approver");
    const task = seedTask("approve-over-budget");
    driveToSubmittedRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const approved = taskLifecycle.approveTask(task.id, "reviewer-1");
    expect(approved).not.toBeNull();
    expect(approved?.status).toBe("approved");
  });

  it("completeTask succeeds over budget (completed is untaxed)", () => {
    const agent = seedAgent("budget-completer");
    const task = seedTask("complete-over-budget");
    driveToSubmittedRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const completed = taskLifecycle.completeTask(task.id, agent.id, "note", [], true);
    expect(completed.task).not.toBeNull();
    expect(completed.task?.status).toBe("done");
  });

  it("human rejection succeeds over budget (human actors are unmetered)", () => {
    const agent = seedAgent("budget-human-rejector");
    const task = seedTask("human-reject-over-budget");
    driveToSubmittedRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const rejected = taskLifecycle.rejectTask(task.id, "reviewer-1", "needs work", "human");
    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe("rejected");
  });

  it("agent rejection refuses over budget", () => {
    const agent = seedAgent("budget-agent-rejector");
    const task = seedTask("agent-reject-over-budget");
    driveToSubmittedRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const rejected = taskLifecycle.rejectTask(task.id, "agent-reviewer", "needs work", "agent");
    expect(rejected).toBeNull();
    expect(taskCrud.getTaskById(task.id)?.status).toBe("submitted");
  });
});

describe("transition budget — local mutation wiring", () => {
  it("submitTask refuses with the typed error and leaves the task in_progress", () => {
    const agent = seedAgent("budget-submitter");
    const task = seedTask("submit-over-budget");
    claimAndStartRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const submitted = taskLifecycle.submitTask(task.id, agent.id, "result", []);

    expect(submitted.task).toBeNull();
    expect(submitted.error).toBe("TRANSITION_BUDGET_EXHAUSTED");
    expect(taskCrud.getTaskById(task.id)?.status).toBe("in_progress");
  });

  it("startTask refuses over budget (null convention)", () => {
    const agent = seedAgent("budget-starter");
    const task = seedTask("start-over-budget");
    const claimed = taskStateMachine.claimTask(task.id, agent.id);
    if (!claimed.success) throw new Error("setup claim failed");
    seedEvents(task.id, 12, "claimed", "agent");

    expect(taskLifecycle.startTask(task.id, agent.id)).toBeNull();
    expect(taskCrud.getTaskById(task.id)?.status).toBe("claimed");
  });

  it("releaseTask refuses over budget for the assigned agent (null convention)", () => {
    const agent = seedAgent("budget-releaser");
    const task = seedTask("release-over-budget");
    const claimed = taskStateMachine.claimTask(task.id, agent.id);
    if (!claimed.success) throw new Error("setup claim failed");
    seedEvents(task.id, 12, "claimed", "agent");

    expect(taskLifecycle.releaseTask(task.id, agent.id, "done for now")).toBeNull();
    expect(taskCrud.getTaskById(task.id)?.status).toBe("claimed");
  });

  it("releaseTask by a human (unassigned task) succeeds over budget", () => {
    const task = seedTask("human-release-over-budget");
    // Model the human release path: a task in_progress with NO assignee is
    // released by a human operator (derived actor "human" → exempt).
    const claimed = taskStateMachine.claimTask(task.id, seedAgent("holder").id);
    if (!claimed.success) throw new Error("setup claim failed");
    getDb()
      .update(tasks)
      .set({ assignedAgentId: null })
      .where(eq(tasks.id, task.id))
      .run();
    seedEvents(task.id, 12, "claimed", "agent");

    const released = taskLifecycle.releaseTask(task.id, "human-operator", "taking over");
    expect(released).not.toBeNull();
    expect(released?.status).toBe("pending");
  });

  it("failTask refuses over budget (null convention)", () => {
    const agent = seedAgent("budget-failer");
    const task = seedTask("fail-over-budget");
    claimAndStartRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");

    expect(taskLifecycle.failTask(task.id, agent.id, "agent", "boom")).toBeNull();
    expect(taskCrud.getTaskById(task.id)?.status).toBe("in_progress");
  });

  it("retryService.executeRetry refuses over budget (system actor, metered)", () => {
    const agent = seedAgent("budget-retry");
    const task = seedTask("retry-over-budget");
    claimAndStartRepo(task.id, agent.id);
    seedEvents(task.id, 12, "claimed", "agent");
    const before = taskCrud.getTaskById(task.id)!;

    const retried = retryService.executeRetry(before);

    expect(retried).toBeNull();
    expect(taskCrud.getTaskById(task.id)?.retryCount).toBe(before.retryCount);
    expect(taskCrud.getTaskById(task.id)?.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Behavioral discriminators — remote wrapper wiring
// ---------------------------------------------------------------------------

describe("transition budget — remote wrapper wiring", () => {
  it("claimTaskForRemote refuses over budget with the legacy reason", () => {
    const { ctx } = setupRemoteFixture("remote_orcy");
    const task = seedTask("remote-claim-over-budget");
    seedEvents(task.id, 12, "claimed", "remote_orcy");

    const result = claimTaskForRemote(task.id, ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("transition_budget_exhausted");
  });

  it("submitTaskForRemote refuses over budget for a remote_orcy participant", () => {
    const { ctx } = setupRemoteFixture("remote_orcy");
    const task = seedTask("remote-submit-over-budget");
    claimAndStartRemoteRepo(task.id, ctx.participant.id);
    seedEvents(task.id, 12, "claimed", "remote_orcy");

    const result = submitTaskForRemote(task.id, ctx, "result", []);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("transition_budget_exhausted");
    expect(taskCrud.getTaskById(task.id)?.status).toBe("in_progress");
  });

  it("submitTaskForRemote lets a remote_human participant through over budget", () => {
    const { ctx } = setupRemoteFixture("remote_human");
    const task = seedTask("remote-human-submit-over-budget");
    claimAndStartRemoteRepo(task.id, ctx.participant.id);
    seedEvents(task.id, 12, "claimed", "agent");

    const result = submitTaskForRemote(task.id, ctx, "human fixes", []);

    expect(result.success).toBe(true);
    expect(taskCrud.getTaskById(task.id)?.status).toBe("submitted");
  });

  it("releaseTaskForRemote refuses over budget for a remote_orcy participant", () => {
    const { ctx } = setupRemoteFixture("remote_orcy");
    const task = seedTask("remote-release-over-budget");
    const claimed = taskStateMachine.claimTaskByRemoteParticipant(task.id, ctx.participant.id);
    if (!claimed.success) throw new Error("setup remote claim failed");
    seedEvents(task.id, 12, "claimed", "remote_orcy");

    const result = releaseTaskForRemote(task.id, ctx, "reason");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe("transition_budget_exhausted");
    expect(taskCrud.getTaskById(task.id)?.status).toBe("claimed");
  });
});
