/**
 * T5c — Local↔Remote parity-contract test (Remote Participant Actions, v0.35.0).
 *
 * Proves that a remote claim/submit/release produces the SAME observable
 * lifecycle as a local one, modulo two DOCUMENTED differences:
 *
 *   D1. actorType: local is `"agent"`, remote is `"remote_orcy"` (or `remote_human`).
 *   D2. step-4.5 cross-pod notification: remote fires `emitRemoteOriginatedNotification`
 *       (claim + submit only); local does not. Release carries no notification on either side.
 *
 * For each mutation family, the test runs a LOCAL invocation and a REMOTE
 * invocation in comparable fixtures, captures the full side-effect set each
 * produces, and asserts set-equality of all channels modulo the two differences
 * above.
 *
 * Test-only — NO production changes. If a genuine parity gap surfaces, that is
 * a real finding; report it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";

// Repos & services for fixture setup
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as agentRepo from "../repositories/agent.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as taskEventRepo from "../repositories/events/event-crud.js";
import * as pluginManager from "../plugins/pluginManager.js";

// The two code paths under test
import { claimTask, startTask, submitTask, releaseTask } from "../services/tasks/task-lifecycle.js";
import {
  claimTaskForRemote,
  submitTaskForRemote,
  releaseTaskForRemote,
} from "../services/tasks/remote-task-lifecycle.js";

// Side-effect channels to spy on. These resolve to the same module instances
// that transition-emitter.ts imports, so vi.spyOn intercepts at call time.
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as watcherService from "../services/watcherService.js";
import * as missionService from "../services/missionService.js";
import * as pulseService from "../services/pulseService.js";
import * as remoteNotifications from "../services/remoteNotifications.js";
import { onTransition, setRecalcDebounceEnabled } from "../services/tasks/transition-emitter.js";

import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import type { RemoteActionScope } from "@orcy/shared/types";

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

interface LocalFixture {
  habitatId: string;
  missionId: string;
  taskId: string;
  agentId: string;
}

/** Creates a habitat + column + mission + task + agent for the LOCAL path. */
function setupLocalFixture(): LocalFixture {
  const habitat = habitatRepo.createHabitat({ name: "Parity-Local" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Local Mission",
    priority: "medium",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Local Task",
    description: "x",
    priority: "medium",
    requiredCapabilities: [],
    labels: [],
    createdBy: "test",
  });
  const { agent } = agentRepo.createAgent({
    name: "parity-local-agent",
    type: "claude-code",
    domain: "backend",
    capabilities: [],
  });
  return {
    habitatId: habitat.id,
    missionId: mission.id,
    taskId: task.id,
    agentId: agent.id,
  };
}

interface RemoteFixture {
  ctx: RemoteParticipantContext;
  habitatId: string;
  missionId: string;
  taskId: string;
}

/** Creates a habitat + column + mission + task + pod + participant + credential + grant for the REMOTE path. */
function setupRemoteFixture(): RemoteFixture {
  const habitat = habitatRepo.createHabitat({ name: "Parity-Remote" });
  columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Remote Mission",
    priority: "medium",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Remote Task",
    description: "x",
    priority: "medium",
    requiredCapabilities: [],
    labels: [],
    createdBy: "test",
  });

  const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: "Parity Pod" });
  const activatedPod = podRepo.activateRemotePod(pod.id) ?? pod;

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: habitat.id,
    participantType: "remote_orcy",
    displayName: "Parity Remote Worker",
    standing: "remote_contributor",
  });
  participantRepo.activateRemoteParticipant(participant.id);

  const { credential } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
    label: "parity-cred",
  });

  grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor",
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
    missionId: mission.id,
    taskId: task.id,
  };
}

// ---------------------------------------------------------------------------
// Side-effect recorder
// ---------------------------------------------------------------------------

/** Shape captured from one mutation run (local or remote). */
interface SideEffectCapture {
  /** Count of Task Event rows matching the mutation action. */
  actionEventCount: number;
  /** The single event row for this action (undefined if not found). */
  event: {
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorType: string;
    actorId: string;
  } | undefined;
  /** SSE publication type strings, in call order. */
  sseTypes: string[];
  /** Watcher event strings passed to notifyWatchers. */
  watcherEvents: string[];
  /** Number of mission recalc calls. */
  recalcCalls: number;
  /** Pulse signalType strings from emitAutoSignal. */
  pulseSignalTypes: string[];
  /** Transition hook action strings from onTransition callback. */
  transitionActions: string[];
  /** Event IDs forwarded to the transition hook. */
  transitionEventIds: (string | undefined)[];
  /** Count of emitRemoteOriginatedNotification calls. */
  remoteNotifCount: number;
}

/**
 * Creates a recorder that spies on all emitTransition outgoing-fan channels.
 * Call `capture(taskId, action)` after a mutation to snapshot side-effects.
 * Call `reset()` to clear spy histories between local and remote runs.
 * Call `dispose()` to remove the onTransition hook.
 */
function createRecorder() {
  const sseSpy = vi.spyOn(sseBroadcaster, "publish");
  const watcherSpy = vi.spyOn(watcherService, "notifyWatchers");
  const recalcSpy = vi.spyOn(missionService, "recalculateMissionStatus");
  const pulseSpy = vi.spyOn(pulseService, "emitAutoSignal");
  const notifSpy = vi.spyOn(remoteNotifications, "emitRemoteOriginatedNotification");
  const transitionHook = vi.fn();
  const unsub = onTransition(transitionHook);

  return {
    capture(taskId: string, action: string): SideEffectCapture {
      const { events } = taskEventRepo.getEventsByTaskId(taskId);
      const actionEvents = events.filter((e) => e.action === action);
      const ev = actionEvents[actionEvents.length - 1];
      return {
        actionEventCount: actionEvents.length,
        event: ev
          ? {
              action: ev.action,
              fromStatus: ev.fromStatus as string | null,
              toStatus: ev.toStatus as string | null,
              actorType: ev.actorType,
              actorId: ev.actorId,
            }
          : undefined,
        // Filter to task.* types — these come directly from emitTransition's
        // publishSseForAction. The mission.* SSE published INSIDE
        // missionService.recalculateMissionStatus is an indirect cascade
        // (a side-effect OF a side-effect) and depends on fixture DB state,
        // not on emitTransition's own fan.
        sseTypes: sseSpy.mock.calls
          .map((c) => (c[1] as { type: string }).type)
          .filter((t) => t.startsWith("task.")),
        watcherEvents: watcherSpy.mock.calls.map((c) => c[2] as string),
        recalcCalls: recalcSpy.mock.calls.length,
        pulseSignalTypes: pulseSpy.mock.calls.map(
          (c) => (c[0] as { signalType: string }).signalType,
        ),
        transitionActions: transitionHook.mock.calls.map((c) => c[0].action),
        transitionEventIds: transitionHook.mock.calls.map((c) => c[0].eventId),
        remoteNotifCount: notifSpy.mock.calls.length,
      };
    },
    reset() {
      sseSpy.mockClear();
      watcherSpy.mockClear();
      recalcSpy.mockClear();
      pulseSpy.mockClear();
      notifSpy.mockClear();
      transitionHook.mockClear();
    },
    dispose() {
      unsub();
    },
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initTestDb();
  setRecalcDebounceEnabled(false);
  pluginManager.resetPlugins();
  delete process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT;
  delete process.env.ORCY_PUBLIC_URL;
  delete process.env.ORCY_BASE_URL;
});

afterEach(() => {
  setRecalcDebounceEnabled(false);
  pluginManager.resetPlugins();
  vi.restoreAllMocks();
  closeDb();
  process.env = { ...ORIGINAL_ENV };
});

// ---------------------------------------------------------------------------
// CLAIM parity
// ---------------------------------------------------------------------------

describe("T5c claim parity — local claimTask vs remote claimTaskForRemote", () => {
  it("produces the same observable lifecycle (modulo D1 actorType + D2 cross-pod notification)", () => {
    const local = setupLocalFixture();
    const remote = setupRemoteFixture();

    const recorder = createRecorder();

    // --- LOCAL ---
    claimTask(local.taskId, local.agentId);
    const L = recorder.capture(local.taskId, "claimed");

    // --- REMOTE ---
    recorder.reset();
    claimTaskForRemote(remote.taskId, remote.ctx);
    const R = recorder.capture(remote.taskId, "claimed");

    recorder.dispose();

    // 1. Exactly-once Task Event with matching action/fromStatus/toStatus
    expect(L.actionEventCount).toBe(1);
    expect(R.actionEventCount).toBe(1);
    expect(L.event!.action).toBe("claimed");
    expect(R.event!.action).toBe("claimed");
    expect(L.event!.fromStatus).toBe(R.event!.fromStatus);
    expect(L.event!.fromStatus).toBe("pending");
    expect(L.event!.toStatus).toBe(R.event!.toStatus);
    expect(L.event!.toStatus).toBe("claimed");

    // D1: actorType differs — local "agent" vs remote "remote_orcy"
    expect(L.event!.actorType).toBe("agent");
    expect(R.event!.actorType).toBe("remote_orcy");

    // 2. SSE publications — same SET of types
    expect(L.sseTypes.sort()).toEqual(R.sseTypes.sort());
    expect(L.sseTypes).toEqual(expect.arrayContaining(["task.claimed", "task.updated"]));

    // 3. Watcher notifications — same event string
    expect(L.watcherEvents).toEqual(R.watcherEvents);
    expect(L.watcherEvents).toEqual(["task.claimed"]);

    // 4. Mission recalc — fires exactly once on each side
    expect(L.recalcCalls).toBe(1);
    expect(R.recalcCalls).toBe(1);

    // 5. Auto-pulse — same signalType
    expect(L.pulseSignalTypes).toEqual(R.pulseSignalTypes);
    expect(L.pulseSignalTypes).toEqual(["context"]);

    // 6. onTransition hook — same action, defined eventId on both
    expect(L.transitionActions).toEqual(R.transitionActions);
    expect(L.transitionActions).toEqual(["claimed"]);
    expect(L.transitionEventIds).toHaveLength(1);
    expect(R.transitionEventIds).toHaveLength(1);
    expect(L.transitionEventIds[0]).toBeDefined();
    expect(R.transitionEventIds[0]).toBeDefined();

    // D2: remote fires emitRemoteOriginatedNotification; local does NOT
    expect(L.remoteNotifCount).toBe(0);
    expect(R.remoteNotifCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SUBMIT parity
// ---------------------------------------------------------------------------

describe("T5c submit parity — local submitTask vs remote submitTaskForRemote", () => {
  it("produces the same observable lifecycle (modulo D1 actorType + D2 cross-pod notification)", () => {
    const local = setupLocalFixture();
    const remote = setupRemoteFixture();

    // Pre-condition: claim + start (no spies recording)
    claimTask(local.taskId, local.agentId);
    startTask(local.taskId, local.agentId);
    taskStateMachine.claimTaskByRemoteParticipant(remote.taskId, remote.ctx.participant.id);
    taskStateMachine.startTaskByRemoteParticipant(remote.taskId, remote.ctx.participant.id);

    const recorder = createRecorder();

    // --- LOCAL ---
    const localResult = submitTask(local.taskId, local.agentId, "Work done", []);
    expect(localResult.task).not.toBeNull();
    const L = recorder.capture(local.taskId, "submitted");

    // --- REMOTE ---
    recorder.reset();
    const remoteResult = submitTaskForRemote(remote.taskId, remote.ctx, "Work done", []);
    expect(remoteResult.success).toBe(true);
    const R = recorder.capture(remote.taskId, "submitted");

    recorder.dispose();

    // 1. Exactly-once Task Event
    expect(L.actionEventCount).toBe(1);
    expect(R.actionEventCount).toBe(1);
    expect(L.event!.action).toBe("submitted");
    expect(R.event!.action).toBe("submitted");
    expect(L.event!.fromStatus).toBe(R.event!.fromStatus);
    expect(L.event!.fromStatus).toBe("in_progress");
    expect(L.event!.toStatus).toBe(R.event!.toStatus);
    expect(L.event!.toStatus).toBe("submitted");

    // D1: actorType differs
    expect(L.event!.actorType).toBe("agent");
    expect(R.event!.actorType).toBe("remote_orcy");

    // 2. SSE publications — same SET of types
    expect(L.sseTypes.sort()).toEqual(R.sseTypes.sort());
    expect(L.sseTypes).toEqual(expect.arrayContaining(["task.submitted", "task.updated"]));

    // 3. Watcher notifications
    expect(L.watcherEvents).toEqual(R.watcherEvents);
    expect(L.watcherEvents).toEqual(["task.submitted"]);

    // 4. Mission recalc
    expect(L.recalcCalls).toBe(1);
    expect(R.recalcCalls).toBe(1);

    // 5. Auto-pulse — submit fires an "offer" signal
    expect(L.pulseSignalTypes).toEqual(R.pulseSignalTypes);
    expect(L.pulseSignalTypes).toEqual(["offer"]);

    // 6. onTransition hook
    expect(L.transitionActions).toEqual(R.transitionActions);
    expect(L.transitionActions).toEqual(["submitted"]);
    expect(L.transitionEventIds[0]).toBeDefined();
    expect(R.transitionEventIds[0]).toBeDefined();

    // D2: remote fires emitRemoteOriginatedNotification; local does NOT
    expect(L.remoteNotifCount).toBe(0);
    expect(R.remoteNotifCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RELEASE parity
// ---------------------------------------------------------------------------

describe("T5c release parity — local releaseTask vs remote releaseTaskForRemote", () => {
  it("produces the same observable lifecycle (no cross-pod notification on either side)", () => {
    const local = setupLocalFixture();
    const remote = setupRemoteFixture();

    // Pre-condition: claim (no spies recording)
    claimTask(local.taskId, local.agentId);
    taskStateMachine.claimTaskByRemoteParticipant(remote.taskId, remote.ctx.participant.id);

    const recorder = createRecorder();

    // --- LOCAL ---
    const localTask = releaseTask(local.taskId, local.agentId, "releasing");
    expect(localTask).not.toBeNull();
    const L = recorder.capture(local.taskId, "released");

    // --- REMOTE ---
    recorder.reset();
    const remoteResult = releaseTaskForRemote(remote.taskId, remote.ctx, "releasing");
    expect(remoteResult.success).toBe(true);
    const R = recorder.capture(remote.taskId, "released");

    recorder.dispose();

    // 1. Exactly-once Task Event
    expect(L.actionEventCount).toBe(1);
    expect(R.actionEventCount).toBe(1);
    expect(L.event!.action).toBe("released");
    expect(R.event!.action).toBe("released");
    expect(L.event!.fromStatus).toBe(R.event!.fromStatus);
    expect(L.event!.fromStatus).toBe("claimed");
    expect(L.event!.toStatus).toBe(R.event!.toStatus);
    expect(L.event!.toStatus).toBe("pending");

    // D1: actorType differs
    expect(L.event!.actorType).toBe("agent");
    expect(R.event!.actorType).toBe("remote_orcy");

    // 2. SSE publications
    expect(L.sseTypes.sort()).toEqual(R.sseTypes.sort());
    expect(L.sseTypes).toEqual(expect.arrayContaining(["task.released", "task.updated"]));

    // 3. Watcher notifications
    expect(L.watcherEvents).toEqual(R.watcherEvents);
    expect(L.watcherEvents).toEqual(["task.released"]);

    // 4. Mission recalc
    expect(L.recalcCalls).toBe(1);
    expect(R.recalcCalls).toBe(1);

    // 5. Auto-pulse — release fires a "context" signal
    expect(L.pulseSignalTypes).toEqual(R.pulseSignalTypes);
    expect(L.pulseSignalTypes).toEqual(["context"]);

    // 6. onTransition hook
    expect(L.transitionActions).toEqual(R.transitionActions);
    expect(L.transitionActions).toEqual(["released"]);
    expect(L.transitionEventIds[0]).toBeDefined();
    expect(R.transitionEventIds[0]).toBeDefined();

    // D2 (release variant): NO cross-pod notification on EITHER side
    expect(L.remoteNotifCount).toBe(0);
    expect(R.remoteNotifCount).toBe(0);
  });
});
