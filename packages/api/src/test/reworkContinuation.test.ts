/**
 * REC-10 — rejected-task rework continuation (Design A, RED-first suite).
 *
 * Contract (rework-restoration rev 3, Design A — root-adjudicated):
 *   - reject PRESERVES `executionToken` X as the rejected-continuation token
 *     (pointers `lastFailureEventId`/`lastReleaseEventId` still cleared;
 *     `rejectedCount`++ unchanged);
 *   - the owner's start admits `claimed|rejected` (local agent path only):
 *     `claimed → in_progress` PRESERVES the token byte-identically;
 *     `rejected → in_progress` mints Y in the same atomic write, under the
 *     existing epoch-guard disjunction (stored-NULL = genuine-legacy allow;
 *     a tokened rejected row demands the client's exact X — stale E0 or
 *     typed-null → typed 409 `ExecutionEpochMismatchError`);
 *   - the exact-X active daemon session (the continuation session) rebinds
 *     to Y in the SAME act-tx; known-stale X owners (standalone heartbeat
 *     ≥ 10 min numeric, embedded `!running ∧ stale beat`) terminalize `lost`
 *     in-tx BEFORE the rebind under the existing monotonic guard — terminal
 *     rows keep X forever (no Y laundering); legacy NULL rows mint Y with NO
 *     session inference (no NULL==NULL rebind);
 *   - reviewer rows survive reject untouched (pending stays pending, approved
 *     rows idempotent) — round 2 is decided by the same reviewers.
 *
 * Every test drives REAL production paths (service task lifecycle, real
 * session rows, the real recovery drive) against the real sql.js test DB.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("../services/taskSuggestion.js", () => ({
  getSuggestionsForAgent: vi.fn(() => ({ suggestions: [] })),
}));
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, daemonSessions, daemonInstances } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonRepo from "../repositories/daemon.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskService from "../services/tasks/index.js";
import {
  setEngineLivenessProbe,
  driveDaemonSessionOutcome,
} from "../services/daemonSessionRecovery.js";
import { ExecutionEpochMismatchError } from "../errors.js";

let habitatId: string;
let columnId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Rework Continuation Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
  agentId = agentRepo.createAgent({
    name: "rework-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
});

afterEach(() => {
  setEngineLivenessProbe(() => false); // restore standalone semantics
  closeDb();
});

afterAll(() => {
  setEngineLivenessProbe(() => false);
});

function seedTask(title = "rework-task") {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" });
}

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    status: string;
    executionToken: string | null;
    lastFailureEventId: string | null;
    lastReleaseEventId: string | null;
    rejectedCount: number;
    assignedAgentId: string | null;
    version: number;
  };
}

function sessionRow(sessionId: string) {
  return getDb().select().from(daemonSessions).where(eq(daemonSessions.id, sessionId)).get() as
    | {
        id: string;
        status: string;
        executionToken: string | null;
        endedAt: string | null;
      }
    | undefined;
}

function sessionsFor(taskId: string) {
  return getDb()
    .select()
    .from(daemonSessions)
    .where(eq(daemonSessions.taskId, taskId))
    .all() as Array<{ id: string; status: string; executionToken: string | null }>;
}

/** Claim (mints X) → start (preserves) → submit → reject; returns X. */
function seedRejected(title: string): { taskId: string; X: string } {
  const task = seedTask(title);
  const claim = taskStateMachine.claimTask(task.id, agentId);
  expect(claim.success).toBe(true);
  const X = (claim as { success: true; task: { executionToken: string | null } }).task
    .executionToken!;
  expect(taskService.startTask(task.id, agentId, X)).not.toBeNull();
  const submitted = taskService.submitTask(task.id, agentId, "round-1 result", [], X);
  expect(submitted.task).not.toBeNull();
  const rejected = taskService.rejectTask(task.id, "human-1", "needs rework", "human");
  expect(rejected).not.toBeNull();
  return { taskId: task.id, X };
}

function seedDaemonAndSession(taskId: string, token: string | null, name: string) {
  const daemon = daemonRepo.createDaemon({
    name,
    hostname: "h",
    maxConcurrent: 4,
    daemonVersion: "test",
    plainToken: `pt-${name}`,
    metadata: { habitatIds: [habitatId] },
  });
  const session = daemonRepo.createDaemonSession({
    daemonId: daemon.id,
    agentId,
    taskId,
    habitatId,
    workdir: "/w",
  });
  if (token !== null) {
    getDb()
      .update(daemonSessions)
      .set({ executionToken: token })
      .where(eq(daemonSessions.id, session.id))
      .run();
  }
  return { daemonId: daemon.id, sessionId: session.id };
}

function setHeartbeat(daemonId: string, iso: string | null) {
  getDb()
    .update(daemonInstances)
    .set({ lastHeartbeatAt: iso })
    .where(eq(daemonInstances.id, daemonId))
    .run();
}

// ---------------------------------------------------------------------------
// 1. Reject preserves X; owner start mints Y atomically
// ---------------------------------------------------------------------------

describe("rework continuation — reject preserves X, start mints Y", () => {
  it("reject preserves the execution token X and still clears both provenance pointers", () => {
    const { taskId, X } = seedRejected("preserve");
    const row = taskRow(taskId);
    expect(row.status).toBe("rejected");
    expect(row.executionToken).toBe(X); // PRESERVED — the continuation token
    expect(row.lastFailureEventId).toBeNull();
    expect(row.lastReleaseEventId).toBeNull();
    expect(row.rejectedCount).toBe(1);
    expect(row.assignedAgentId).toBe(agentId); // still-assigned owner
  });

  it("owner start with X: rejected → in_progress, response carries a FRESH Y ≠ X, atomically", () => {
    const { taskId, X } = seedRejected("mint");
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    expect(started!.status).toBe("in_progress");
    const Y = started!.executionToken;
    expect(Y).toBeTruthy();
    expect(Y).not.toBe(X);
    expect(taskRow(taskId).executionToken).toBe(Y); // persisted, same write
    // The round-2 wire works under Y (continuation):
    const submitted = taskService.submitTask(taskId, agentId, "round-2 result", [], Y);
    expect(submitted.task).not.toBeNull();
    expect(submitted.task!.status).toBe("submitted");
  });

  it("a NON-owner agent cannot start the rejected task (owner-only continuation)", () => {
    const { taskId, X } = seedRejected("non-owner");
    const other = agentRepo.createAgent({
      name: "other-agent",
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    }).agent.id;
    expect(taskService.startTask(taskId, other, X)).toBeNull();
    expect(taskRow(taskId).status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// 2. Epoch fencing on the rejected row (existing guard, zero code change)
// ---------------------------------------------------------------------------

describe("rework continuation — epoch fencing", () => {
  it("a stale pre-claim token E0 (including presented after the reject) → typed 409, no writes", () => {
    const { taskId } = seedRejected("stale-e0");
    const before = taskRow(taskId);
    expect(() => taskService.startTask(taskId, agentId, "stale-epoch-0")).toThrow(
      ExecutionEpochMismatchError,
    );
    const after = taskRow(taskId);
    expect(after.status).toBe("rejected");
    expect(after.executionToken).toBe(before.executionToken);
    expect(after.version).toBe(before.version); // zero writes
  });

  it("typed-null token on a tokened rejected row → typed 409 (X must be presented)", () => {
    const { taskId } = seedRejected("null-token");
    expect(() => taskService.startTask(taskId, agentId, null)).toThrow(ExecutionEpochMismatchError);
    expect(taskRow(taskId).status).toBe("rejected");
  });

  it("legacy NULL-token rejected row: start mints Y, and NO session binding is inferred", () => {
    const { taskId } = seedRejected("legacy-null");
    // Force the genuine-legacy shape (pre-migration rejected row + NULL session).
    getDb().update(tasks).set({ executionToken: null }).where(eq(tasks.id, taskId)).run();
    const { sessionId } = seedDaemonAndSession(taskId, null, "legacy-daemon");
    const started = taskService.startTask(taskId, agentId, null);
    expect(started).not.toBeNull();
    const Y = started!.executionToken;
    expect(Y).toBeTruthy();
    expect(taskRow(taskId).executionToken).toBe(Y);
    // No NULL==NULL inference: the legacy session keeps NULL, stays active.
    const s = sessionRow(sessionId)!;
    expect(s.executionToken).toBeNull();
    expect(s.status).toBe("starting");
  });
});

// ---------------------------------------------------------------------------
// 3. Claimed start still preserves its token (regression pin)
// ---------------------------------------------------------------------------

describe("rework continuation — claimed start regression pin", () => {
  it("claimed → in_progress preserves the token byte-identically", () => {
    const task = seedTask("claimed-pin");
    const claim = taskStateMachine.claimTask(task.id, agentId);
    expect(claim.success).toBe(true);
    const X = (claim as { success: true; task: { executionToken: string } }).task.executionToken;
    const started = taskService.startTask(task.id, agentId, X);
    expect(started).not.toBeNull();
    expect(started!.executionToken).toBe(X);
    expect(taskRow(task.id).executionToken).toBe(X);
  });
});

// ---------------------------------------------------------------------------
// 4. Exact-X session rebind + known-stale terminalization (same act-tx)
// ---------------------------------------------------------------------------

describe("rework continuation — session rebind & stale disposition", () => {
  it("live X session (fresh heartbeat) rebinds to Y in the start tx; later death under Y fails the task under Y", () => {
    const { taskId, X } = seedRejected("rebind-live");
    const { daemonId, sessionId } = seedDaemonAndSession(taskId, X, "live-daemon");
    setHeartbeat(daemonId, new Date().toISOString()); // fresh — owner known alive
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    const Y = started!.executionToken!;
    const s = sessionRow(sessionId)!;
    expect(s.executionToken).toBe(Y); // rebound
    expect(s.status).toBe("starting"); // still active
    // Post-rework session death drives recovery under Y (fail lands):
    daemonRepo.updateSessionStatus(sessionId, "failed");
    const outcome = driveDaemonSessionOutcome(sessionId);
    expect(outcome).toBe("ok_failed");
    expect(taskRow(taskId).status).toBe("failed");
  });

  it("known-stale standalone X (heartbeat ≥ 10 min): terminalized `lost` in the start tx, keeps X, task proceeds under Y, drive no-ops", () => {
    const { taskId, X } = seedRejected("stale-owner");
    const { daemonId, sessionId } = seedDaemonAndSession(taskId, X, "stale-daemon");
    setHeartbeat(daemonId, new Date(Date.now() - 11 * 60_000).toISOString());
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    const Y = started!.executionToken!;
    const s = sessionRow(sessionId)!;
    expect(s.status).toBe("lost"); // terminalized INSIDE the start tx
    expect(s.executionToken).toBe(X); // terminal row keeps X — never Y-laundered
    expect(s.endedAt).not.toBeNull();
    // Task state is untouched by the X death (epoch mismatch by construction):
    const outcome = driveDaemonSessionOutcome(sessionId);
    expect(outcome).toBe("no_op_epoch_mismatch");
    expect(taskRow(taskId).status).toBe("in_progress");
    expect(taskRow(taskId).executionToken).toBe(Y);
  });

  it("embedded engine running spares a stale-heartbeat owner (rebind, not terminalize)", () => {
    const { taskId, X } = seedRejected("embedded-live");
    const { daemonId, sessionId } = seedDaemonAndSession(taskId, X, "embedded-daemon");
    setHeartbeat(daemonId, new Date(Date.now() - 30 * 60_000).toISOString()); // very stale
    setEngineLivenessProbe((id) => id === daemonId); // ...but the engine runs
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    const s = sessionRow(sessionId)!;
    expect(s.status).toBe("starting");
    expect(s.executionToken).toBe(started!.executionToken); // rebound
  });

  it("terminal session + manual owner start: no rebind, terminal keeps X, manual continuation works under Y", () => {
    const { taskId, X } = seedRejected("terminal-session");
    const { sessionId } = seedDaemonAndSession(taskId, X, "ended-daemon");
    daemonRepo.updateSessionStatus(sessionId, "released"); // terminal BEFORE start
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    const Y = started!.executionToken!;
    const s = sessionRow(sessionId)!;
    expect(s.status).toBe("released"); // untouched by the start
    expect(s.executionToken).toBe(X); // never rebound
    // Manual continuation under Y:
    const submitted = taskService.submitTask(taskId, agentId, "manual round-2", [], Y);
    expect(submitted.task).not.toBeNull();
  });

  it("historic-E0 session rows are excluded by token (only the exact-X session is touched)", () => {
    const { taskId, X } = seedRejected("e0-exclusion");
    const e0Session = seedDaemonAndSession(taskId, "historic-epoch-0-token", "e0-daemon");
    const xSession = seedDaemonAndSession(taskId, X, "x-daemon");
    const started = taskService.startTask(taskId, agentId, X);
    expect(started).not.toBeNull();
    const Y = started!.executionToken!;
    expect(sessionRow(e0Session.sessionId)!.executionToken).toBe("historic-epoch-0-token");
    expect(sessionRow(e0Session.sessionId)!.status).toBe("starting");
    expect(sessionRow(xSession.sessionId)!.executionToken).toBe(Y);
  });

  it.each([
    ["alive-first", 0, 1],
    ["stale-first", 1, 0],
  ] as const)(
    "duplicate X sessions (intentionally corrupt rows, invariant not DB-enforced): %s — only the ALIVE one rebinds to Y, the STALE one terminalizes keeping X, drive cannot fail Y",
    (_label, aliveSlot, staleSlot) => {
      const { taskId, X } = seedRejected("duplicate-x");
      // Two sessions BOTH carrying X (the one-session invariant is not
      // DB-enforced — defensively tolerated). One owner fresh, one stale.
      const daemons = [0, 1].map((i) => seedDaemonAndSession(taskId, X, `dup-daemon-${i}`));
      setHeartbeat(daemons[aliveSlot].daemonId, new Date().toISOString());
      setHeartbeat(daemons[staleSlot].daemonId, new Date(Date.now() - 11 * 60_000).toISOString());

      const started = taskService.startTask(taskId, agentId, X);
      expect(started).not.toBeNull();
      const Y = started!.executionToken!;

      const alive = sessionRow(daemons[aliveSlot].sessionId)!;
      const stale = sessionRow(daemons[staleSlot].sessionId)!;
      // The alive candidate rebinds — individually, by exact row id.
      expect(alive.status).toBe("starting");
      expect(alive.executionToken).toBe(Y);
      // The stale candidate terminalizes in the same start tx and KEEPS X —
      // never Y-laundered, never mutated by its sibling's disposition.
      expect(stale.status).toBe("lost");
      expect(stale.executionToken).toBe(X);

      // The stale row's post-commit drive cannot touch the rework epoch:
      expect(driveDaemonSessionOutcome(daemons[staleSlot].sessionId)).toBe("no_op_epoch_mismatch");
      expect(taskRow(taskId).status).toBe("in_progress");
      expect(taskRow(taskId).executionToken).toBe(Y);
      // And the alive row is untouched by the sibling's terminal write.
      expect(sessionRow(daemons[aliveSlot].sessionId)!.status).toBe("starting");
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Reviewer rows survive reject (round 2 decided by the same reviewers)
// ---------------------------------------------------------------------------

describe("rework continuation — reviewer-row carryover", () => {
  it("reject writes only task columns: rows stay pending; round 2 same-pending decisions; mixed approved row idempotent; completion only all-approved", () => {
    const task = seedTask("review-round2");
    const claim = taskStateMachine.claimTask(task.id, agentId);
    expect(claim.success).toBe(true);
    const X = (claim as { success: true; task: { executionToken: string } }).task.executionToken;
    expect(taskService.startTask(task.id, agentId, X)).not.toBeNull();
    const submitted = taskService.submitTask(task.id, agentId, "r1", [], X);
    expect(submitted.task).not.toBeNull();

    // Two human reviewer rows (round 1): reviewer A approves, reviewer B rejects.
    taskReviewerRepo.create(task.id, "human", "reviewer-a");
    taskReviewerRepo.create(task.id, "human", "reviewer-b");
    const partial = taskService.approveTask(task.id, "reviewer-a");
    expect(partial).not.toBeNull();
    expect(taskRow(task.id).status).toBe("submitted"); // B still pending
    const rejected = taskService.rejectTask(task.id, "reviewer-b", "rework it", "human");
    expect(rejected).not.toBeNull();

    // Rows preserved across the reject: A approved, B pending — no reset.
    const rows = taskReviewerRepo.getByTaskId(task.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { reviewerId: string }) => r.reviewerId === "reviewer-a")!.status).toBe(
      "approved",
    );
    expect(rows.find((r: { reviewerId: string }) => r.reviewerId === "reviewer-b")!.status).toBe(
      "pending",
    );

    // Round 2: rework start mints Y; resubmit; A's approved row is idempotent.
    const started = taskService.startTask(task.id, agentId, X);
    expect(started).not.toBeNull();
    const Y = started!.executionToken!;
    const resubmitted = taskService.submitTask(task.id, agentId, "r2", [], Y);
    expect(resubmitted.task).not.toBeNull();
    const stillPendingB = taskService.approveTask(task.id, "reviewer-a"); // idempotent
    expect(stillPendingB).not.toBeNull();
    expect(taskRow(task.id).status).toBe("submitted"); // B still holds the gate
    // B approves → all approved → task transitions approved → complete.
    const approved = taskService.approveTask(task.id, "reviewer-b");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
    const done = taskService.completeTask(task.id, agentId);
    expect(done.task).not.toBeNull();
    expect(done.task!.status).toBe("done");
  });
});
