/**
 * Smoke test for the transaction-aware task-publication primitives (T1 Phase 2).
 *
 * These primitives are DORMANT (no production callers). This test proves the
 * load-bearing invariants that the later publication coordinator will rely on:
 *
 *  1. Each primitive inserts on the PASSED client and the row is read-back-able
 *     through the SAME transaction (it does not escape to getDb()).
 *  2. ROLLBACK atomicity — a Task + its initial event inserted inside one
 *     `db.transaction` that then throws leaves NEITHER row committed. This is
 *     the atomicity that `taskCrud.createTask` (a bare getDb() insert) cannot
 *     guarantee.
 *  3. Mission-recalculation marker COALESCING — a second pending marker for the
 *     same mission does not throw and does not create a duplicate row.
 *  4. Attempt terminal completion IDEMPOTENCY — re-calling completeAttempt does
 *     not overwrite the prior completion timestamp or throw.
 *
 * Rigorous failure-injection + full invariants are Phase 3 (claude harness).
 * See the T1 ticket § "Phase 2 grounding".
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  taskCreationAttempts,
  taskEvents,
  tasks,
  missionRecalculationMarkers,
  taskCreationDispatchTargets,
  taskCreationEnvelopes,
} from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import {
  createTaskWithClient,
  createTaskEventWithClient,
  createSubtaskWithClient,
  addTaskDependencyWithClient,
  markMissionForRecalculationWithClient,
  createCommittedTaskEnvelopeWithClient,
  createAssignmentReservationWithClient,
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type TaskPublicationDbClient,
} from "../repositories/taskPublication.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Publication Primitive Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => closeDb());

/** Seeds a mission row (tasks FK to missions). */
function seedMission(title = "publication-mission"): string {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  }).id;
}

/** Seeds a `task_creation_attempts` row (envelopes/reservations/checkpoints FK to it). */
function seedAttempt(db: TaskPublicationDbClient, suffix = "1"): string {
  const id = `attempt-${suffix}`;
  db.insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-test",
      attemptKey: `key-${suffix}`,
      requestFingerprint: `fp-${suffix}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      state: "pending",
    })
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// 1. createTaskWithClient — insert + readback + order allocation via passed tx
// ---------------------------------------------------------------------------

describe("createTaskWithClient", () => {
  it("inserts a pending task on the passed client and reads it back through the same tx", () => {
    const db = getDb();
    const missionId = seedMission();
    const taskId: string[] = [];

    db.transaction((tx) => {
      const task = createTaskWithClient(tx, {
        missionId,
        title: "tx-aware-task",
        createdBy: "user-1",
      });
      taskId.push(task.id);

      expect(task.status).toBe("pending");
      expect(task.title).toBe("tx-aware-task");
      // creationIntegrity left at default 0 (Legacy Partial History).
      expect(task.creationIntegrity).toBe(0);

      // Read back through the SAME tx — proves the row is visible inside the tx.
      const readBack = tx.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(readBack).toHaveLength(1);
      expect(readBack[0].title).toBe("tx-aware-task");
    });

    // Committed: visible through a fresh getDb() read.
    const committed = getDb().select().from(tasks).where(eq(tasks.id, taskId[0])).all();
    expect(committed).toHaveLength(1);
  });

  it("allocates order via the passed client (max+1, tx-visible)", () => {
    const db = getDb();
    const missionId = seedMission();
    const orders: number[] = [];

    db.transaction((tx) => {
      const t1 = createTaskWithClient(tx, { missionId, title: "t1", createdBy: "u" });
      const t2 = createTaskWithClient(tx, { missionId, title: "t2", createdBy: "u" });
      orders.push(t1.order, t2.order);
    });

    // Second task's order must be first's + 1, allocated through the passed tx.
    expect(orders[1]).toBe(orders[0] + 1);
  });
});

// ---------------------------------------------------------------------------
// 2. createTaskEventWithClient
// ---------------------------------------------------------------------------

describe("createTaskEventWithClient", () => {
  it("inserts the initial created event on the passed client", () => {
    const db = getDb();
    const missionId = seedMission();
    const eventId: string[] = [];

    db.transaction((tx) => {
      const task = createTaskWithClient(tx, { missionId, title: "event-task", createdBy: "u" });
      const event = createTaskEventWithClient(tx, {
        taskId: task.id,
        actorType: "human",
        actorId: "user-1",
        action: "created",
      });
      eventId.push(event.id);

      expect(event.action).toBe("created");
      expect(event.taskId).toBe(task.id);

      // Visible through the same tx.
      const readBack = tx.select().from(taskEvents).where(eq(taskEvents.id, event.id)).all();
      expect(readBack).toHaveLength(1);
    });

    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.id, eventId[0])).all(),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. ROLLBACK atomicity — Task + initial event roll back together
// ---------------------------------------------------------------------------

describe("transaction rollback atomicity", () => {
  it("rolls back Task AND its initial event when the tx throws (no partial commit)", () => {
    const db = getDb();
    const missionId = seedMission();
    let capturedTaskId: string | undefined;

    const before = db.select().from(tasks).all().length;
    const beforeEvents = db.select().from(taskEvents).all().length;

    expect(() =>
      db.transaction((tx) => {
        const task = createTaskWithClient(tx, {
          missionId,
          title: "rollback-task",
          createdBy: "u",
        });
        capturedTaskId = task.id;
        createTaskEventWithClient(tx, {
          taskId: task.id,
          actorType: "human",
          actorId: "user-1",
          action: "created",
        });
        // Simulate a downstream failure mid-publication.
        throw new Error("downstream failure");
      }),
    ).toThrow("downstream failure");

    // NEITHER row committed — the atomicity taskCrud.createTask cannot guarantee.
    const after = getDb().select().from(tasks).all().length;
    const afterEvents = getDb().select().from(taskEvents).all().length;
    expect(after).toBe(before);
    expect(afterEvents).toBe(beforeEvents);
    expect(capturedTaskId).toBeDefined();
    expect(getDb().select().from(tasks).where(eq(tasks.id, capturedTaskId!)).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. createSubtaskWithClient + addTaskDependencyWithClient
// ---------------------------------------------------------------------------

describe("createSubtaskWithClient", () => {
  it("inserts a subtask on the passed client", () => {
    const db = getDb();
    const missionId = seedMission();
    let subtaskId = "";

    db.transaction((tx) => {
      const task = createTaskWithClient(tx, { missionId, title: "subtask-parent", createdBy: "u" });
      const sub = createSubtaskWithClient(tx, { taskId: task.id, title: "child", order: 0 });
      subtaskId = sub.id;
      expect(sub.title).toBe("child");
      expect(sub.completed).toBe(false);
    });

    expect(subtaskId).toBeTruthy();
  });
});

describe("addTaskDependencyWithClient", () => {
  it("inserts a dependency edge on the passed client", () => {
    const db = getDb();
    const missionId = seedMission();

    db.transaction((tx) => {
      const a = createTaskWithClient(tx, { missionId, title: "dep-a", createdBy: "u" });
      const b = createTaskWithClient(tx, { missionId, title: "dep-b", createdBy: "u" });
      const edge = addTaskDependencyWithClient(tx, { taskId: b.id, dependsOnId: a.id });
      expect(edge.taskId).toBe(b.id);
      expect(edge.dependsOnId).toBe(a.id);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. markMissionForRecalculationWithClient — coalescing
// ---------------------------------------------------------------------------

describe("markMissionForRecalculationWithClient", () => {
  it("coalesces: a second pending marker for the same mission does not throw or duplicate", () => {
    const db = getDb();
    const missionId = seedMission();

    db.transaction((tx) => {
      markMissionForRecalculationWithClient(tx, missionId, "first");
    });
    db.transaction((tx) => {
      // Second pending marker — must NOT throw and must NOT insert a duplicate.
      expect(() => markMissionForRecalculationWithClient(tx, missionId, "second")).not.toThrow();
    });

    const pending = getDb()
      .select()
      .from(missionRecalculationMarkers)
      .where(
        sql`${missionRecalculationMarkers.missionId} = ${missionId} AND ${missionRecalculationMarkers.state} = 'pending'`,
      )
      .all();
    expect(pending).toHaveLength(1);
    // The first marker survives (coalesce keeps the original).
    expect(pending[0].reason).toBe("first");
  });

  it("allows a new pending marker after the prior one is done", () => {
    const db = getDb();
    const missionId = seedMission();

    db.transaction((tx) => markMissionForRecalculationWithClient(tx, missionId, "cycle-1"));
    // Mark the first as done (simulating the projection worker consuming it).
    db.update(missionRecalculationMarkers)
      .set({ state: "done" })
      .where(eq(missionRecalculationMarkers.missionId, missionId))
      .run();

    db.transaction((tx) => markMissionForRecalculationWithClient(tx, missionId, "cycle-2"));
    const pending = getDb()
      .select()
      .from(missionRecalculationMarkers)
      .where(
        sql`${missionRecalculationMarkers.missionId} = ${missionId} AND ${missionRecalculationMarkers.state} = 'pending'`,
      )
      .all();
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe("cycle-2");
  });
});

// ---------------------------------------------------------------------------
// 6. createCommittedTaskEnvelopeWithClient — envelope + dispatch targets
// ---------------------------------------------------------------------------

describe("createCommittedTaskEnvelopeWithClient", () => {
  it("inserts the envelope and all dispatch targets atomically on the passed client", () => {
    const db = getDb();
    const missionId = seedMission();
    const attemptId = seedAttempt(getDb());
    const result: { eventId: string; targetCount: number }[] = [];
    const now = new Date().toISOString();

    db.transaction((tx) => {
      const task = createTaskWithClient(tx, { missionId, title: "envelope-task", createdBy: "u" });
      const { envelope, dispatchTargets } = createCommittedTaskEnvelopeWithClient(
        tx,
        {
          eventId: "evt-1",
          lifecycleAction: "created",
          taskId: task.id,
          habitatId,
          occurredAt: now,
          attemptId,
          actorType: "human",
          actorId: "user-1",
          source: "test",
        },
        [
          { targetKind: "mission_projection", targetKey: missionId },
          { targetKind: "assignment", targetKey: "agent-1" },
        ],
      );
      result.push({ eventId: envelope.eventId, targetCount: dispatchTargets.length });

      // Read back through the same tx.
      const envRows = tx
        .select()
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.eventId, "evt-1"))
        .all();
      expect(envRows).toHaveLength(1);
      expect(envRows[0].lifecycleAction).toBe("created");

      const targetRows = tx
        .select()
        .from(taskCreationDispatchTargets)
        .where(eq(taskCreationDispatchTargets.eventId, "evt-1"))
        .all();
      expect(targetRows).toHaveLength(2);
      expect(targetRows.every((t) => t.state === "pending")).toBe(true);
    });

    expect(result[0].eventId).toBe("evt-1");
    expect(result[0].targetCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. createAssignmentReservationWithClient
// ---------------------------------------------------------------------------

describe("createAssignmentReservationWithClient", () => {
  it("inserts an active reservation on the passed client", () => {
    const db = getDb();
    const missionId = seedMission();
    const attemptId = seedAttempt(getDb());
    const now = new Date().toISOString();

    db.transaction((tx) => {
      const task = createTaskWithClient(tx, { missionId, title: "reserved-task", createdBy: "u" });
      const res = createAssignmentReservationWithClient(tx, {
        taskId: task.id,
        attemptId,
        requestedAgentId: "agent-1",
        deadline: now,
      });
      expect(res.state).toBe("active");
      expect(res.taskId).toBe(task.id);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. checkpointAttemptWithClient
// ---------------------------------------------------------------------------

describe("checkpointAttemptWithClient", () => {
  it("advances state to published_pending_observation and sets published_at", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);

    const row = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(row.state).toBe("published_pending_observation");
    expect(row.publishedAt).not.toBeNull();
  });

  it("throws notFound when the attempt does not exist", () => {
    expect(() =>
      checkpointAttemptWithClient(getDb(), "no-such-attempt", {
        stage: "published_pending_observation",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. completeAttemptWithClient — idempotent re-call
// ---------------------------------------------------------------------------

describe("completeAttemptWithClient", () => {
  it("sets terminal fields + final state on first call", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);

    const row = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created",
      finalState: "created",
      terminalResult: { outcome: "created", taskId: "t-1" },
    });
    expect(row.state).toBe("created");
    expect(row.terminalOutcome).toBe("created");
    expect(row.completedAt).not.toBeNull();
    expect(row.terminalResult?.outcome).toBe("created");
  });

  it("is idempotent on re-call — does not overwrite the prior completion", () => {
    const db = getDb();
    const attemptId = seedAttempt(db);

    const first = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created",
      finalState: "created",
      terminalResult: { outcome: "created", taskId: "t-1" },
    });
    const firstCompletedAt = first.completedAt;

    // Re-call with a DIFFERENT terminal result — the prior completion is authoritative.
    const second = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created_unassigned",
      finalState: "created_unassigned",
      terminalResult: { outcome: "created_unassigned", taskId: "t-2" },
    });

    expect(second.completedAt).toBe(firstCompletedAt);
    expect(second.terminalOutcome).toBe("created");
    expect(second.state).toBe("created");
    expect(second.terminalResult?.outcome).toBe("created");
  });

  it("throws notFound when the attempt does not exist", () => {
    expect(() =>
      completeAttemptWithClient(getDb(), "no-such-attempt", {
        terminalOutcome: "vetoed",
        finalState: "vetoed",
      }),
    ).toThrow();
  });
});
