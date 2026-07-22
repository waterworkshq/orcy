/**
 * Failure-injection + invariant tests for the task-publication primitives
 * (T1 Phase 3).
 *
 * Builds on the Phase-2 smoke test (`taskPublicationPrimitives.test.ts`) by
 * exercising the load-bearing T1 guardrails with REAL write-boundary failure
 * injection (not a `throw` inside the tx callback). Uses a real-DB-backed
 * `FailingDbClient` wrapper around the drizzle tx — see
 * `./helpers/failingDbClient.ts`.
 *
 * Each invariant test below states the SPECIFIC failure mode that would
 * break its assertion (proving it is not tautological).
 *
 * Out of scope: the primitives themselves (read-only — we test them).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  taskCreationAttempts,
  taskCreationAssignmentReservations,
  taskCreationDispatchTargets,
  taskCreationEnvelopes,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  missionRecalculationMarkers,
  scheduledOccurrences,
  tasks,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { RepositoryError } from "../errors/repository.js";
import {
  createTaskWithClient,
  createTaskEventWithClient,
  createSubtaskWithClient,
  addTaskDependencyWithClient,
  createCommittedTaskEnvelopeWithClient,
  createAssignmentReservationWithClient,
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type TaskPublicationDbClient,
} from "../repositories/taskPublication.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "FailureInjection Habitat" });
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

// ---------------------------------------------------------------------------
// Seeders (match Phase-2 smoke test conventions)
// ---------------------------------------------------------------------------

/** Seeds a mission row. */
function seedMission(title = "publication-mission"): string {
  return missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "user-1",
  }).id;
}

/** Casts the wrapper to the union type accepted by `*WithClient` primitives. */
function asPubClient(w: FailingDbClient): TaskPublicationDbClient {
  return w as unknown as TaskPublicationDbClient;
}

/** Seeds a `task_creation_attempts` row via raw insert. */
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
// 1. Wrapper sanity — proves the harness itself behaves as advertised.
// ---------------------------------------------------------------------------

describe("FailingDbClient wrapper", () => {
  it("counts a single INSERT...VALUES().RUN() as one write", () => {
    const w = new FailingDbClient(getDb(), { failAtWriteN: null });

    w.insert(taskCreationAttempts)
      .values({
        id: "attempt-sanity-1",
        source: "test",
        sourceScopeKind: "mission",
        sourceScopeId: "m-test",
        attemptKey: "k-sanity-1",
        requestFingerprint: "fp-sanity-1",
        publicationKind: "create",
        actorType: "human",
        actorId: "u",
        state: "pending",
      })
      .run();

    expect(w.writeCount).toBe(1);
    expect(w.writes[0]).toMatchObject({ index: 1, kind: "insert" });
    // Sanity: the row actually committed via the wrapper (real DB write).
    const rows = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, "attempt-sanity-1"))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("counts INSERT...VALUES().RETURNING().ALL() as one write", () => {
    const missionId = seedMission("sanity-mission");
    const w = new FailingDbClient(getDb(), { failAtWriteN: null });
    const rows = w
      .insert(tasks)
      .values({
        id: "task-sanity-1",
        missionId,
        title: "sanity",
        createdBy: "u",
      })
      .returning()
      .all() as Array<{ id: string }>;
    expect(w.writeCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("task-sanity-1");
  });

  it("counts UPDATE...SET().WHERE().RUN() as one write", () => {
    const w = new FailingDbClient(getDb(), { failAtWriteN: null });
    const attemptId = seedAttempt(getDb(), "sanity-2");

    w.update(taskCreationAttempts)
      .set({ state: "published_pending_observation" })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    expect(w.writeCount).toBe(1);
    expect(w.writes[0].kind).toBe("update");
  });

  it("throws on the Nth write boundary", () => {
    // failAtWriteN: 1 — the FIRST write boundary throws the injected error.
    // We then verify writeCount was incremented (1) before the throw fired,
    // and that no further writes can sneak through after the throw.
    const w = new FailingDbClient(getDb(), { failAtWriteN: 1 });
    expect(() => {
      w.insert(taskCreationAttempts)
        .values({} as never)
        .run();
    }).toThrow(/Injected failure at write #1/);
    expect(w.writeCount).toBe(1);
    expect(w.writes[0].kind).toBe("insert");
    // The throw happened BEFORE target.run() was called — no SQL was issued.
    // Verify by re-running with the same wrapper (now failAtWriteN=null) and
    // seeing the same attempt id cannot conflict because we never inserted.
    w.setFailAt(null);
    expect(() => {
      w.insert(taskCreationAttempts)
        .values({} as never)
        .run();
    }).toThrow(/NOT NULL constraint/); // proves the SQL ran this time (id missing)
  });

  it("counts SELECT chains via readCount", () => {
    const w = new FailingDbClient(getDb(), { failAtWriteN: null });
    w.select().from(tasks).all();
    w.select().from(tasks).get();
    w.select({ maxOrder: tasks.order }).from(tasks).get();
    expect(w.readCount).toBe(3);
    expect(w.writeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Task + initial-event atomic rollback under failure injection.
// ---------------------------------------------------------------------------

describe("Task + initial-event atomic rollback (failure-injected)", () => {
  it("rolls back BOTH the task and its initial event when the event INSERT fails on the wrapper", () => {
    const db = getDb();
    const missionId = seedMission("rollback-mission");
    const beforeTasks = db.select().from(tasks).all().length;
    const beforeEvents = db.select().from(taskEvents).all().length;

    let capturedTaskId: string | undefined;
    let thrown: unknown;
    try {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: 2,
        });
        // Write #1 — INSERT tasks (createTaskWithClient does SELECT(max) first
        // — a read through the wrapper — then INSERT).
        const task = createTaskWithClient(asPubClient(w), {
          missionId,
          title: "rollback-task",
          createdBy: "u",
        });
        capturedTaskId = task.id;
        // Write #2 — INSERT task_events. The wrapper throws here. The primitive's
        // catch wraps it in repositoryCreateError, which propagates out of the tx
        // callback and triggers the rollback.
        createTaskEventWithClient(asPubClient(w), {
          taskId: task.id,
          actorType: "human",
          actorId: "user-1",
          action: "created",
        });
      });
    } catch (err) {
      thrown = err;
    }

    // The throw must be a repositoryCreateError on taskEvent (primitive wraps the
    // injected failure) — not the bare injected error.
    expect(thrown).toBeInstanceOf(RepositoryError);
    expect((thrown as { entity?: string }).entity).toBe("taskEvent");

    // NEITHER row committed.
    const afterTasks = getDb().select().from(tasks).all().length;
    const afterEvents = getDb().select().from(taskEvents).all().length;
    expect(afterTasks).toBe(beforeTasks);
    expect(afterEvents).toBe(beforeEvents);
    expect(capturedTaskId).toBeDefined();
    expect(getDb().select().from(tasks).where(eq(tasks.id, capturedTaskId!)).all()).toHaveLength(0);

    // **Failure mode that breaks this assertion**: if `createTaskEventWithClient`
    // (or `createTaskWithClient`) wrote via `getDb()` instead of the passed
    // client, the row would commit despite the tx throw → row counts would
    // increase and the per-id SELECT would return 1.
  });
});

// ---------------------------------------------------------------------------
// 3. Clone nested-structure rollback — Task + subtask + dependency + event.
// ---------------------------------------------------------------------------

describe("Clone nested-structure atomic rollback (failure-injected)", () => {
  it("rolls back the whole clone aggregate (task + subtask + dependency + event) when a later write fails", () => {
    const db = getDb();
    const missionId = seedMission("clone-mission");
    // Source task to clone FROM.
    const sourceTask = taskCrud.createTask({
      missionId,
      title: "source-task",
      createdBy: "u",
    });

    const before = {
      tasks: db.select().from(tasks).all().length,
      subtasks: db.select().from(taskSubtasks).all().length,
      deps: db.select().from(taskDependencies).all().length,
      events: db.select().from(taskEvents).all().length,
    };

    let clonedTaskId: string | undefined;
    try {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: 4, // fail at the 4th write (the cloned event INSERT)
        });
        // Write #1 — INSERT tasks (clone)
        const cloned = createTaskWithClient(asPubClient(w), {
          missionId,
          title: "cloned-task",
          createdBy: "u",
        });
        clonedTaskId = cloned.id;
        // Write #2 — INSERT task_subtasks
        createSubtaskWithClient(asPubClient(w), {
          taskId: cloned.id,
          title: "child-subtask",
          order: 0,
        });
        // Write #3 — INSERT task_dependencies
        addTaskDependencyWithClient(asPubClient(w), {
          taskId: cloned.id,
          dependsOnId: sourceTask.id,
        });
        // Write #4 — INSERT task_events (cloned) — wrapper throws, tx rolls back.
        createTaskEventWithClient(asPubClient(w), {
          taskId: cloned.id,
          actorType: "human",
          actorId: "user-1",
          action: "cloned",
        });
      });
    } catch {
      // expected
    }

    // The whole aggregate must be gone — no half-cloned task.
    const after = {
      tasks: getDb().select().from(tasks).all().length,
      subtasks: getDb().select().from(taskSubtasks).all().length,
      deps: getDb().select().from(taskDependencies).all().length,
      events: getDb().select().from(taskEvents).all().length,
    };
    expect(after).toEqual(before);
    expect(clonedTaskId).toBeDefined();
    // No cloned-task row, no subtask, no dep edge, no event.
    expect(getDb().select().from(tasks).where(eq(tasks.id, clonedTaskId!)).all()).toHaveLength(0);
    expect(
      getDb().select().from(taskSubtasks).where(eq(taskSubtasks.taskId, clonedTaskId!)).all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, clonedTaskId!))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, clonedTaskId!)).all(),
    ).toHaveLength(0);

    // **Failure mode that breaks this assertion**: if any of the four primitives
    // leaked to `getDb()`, OR if the primitives did not share a single tx,
    // rows would survive for the writes before the failure.
  });
});

// ---------------------------------------------------------------------------
// 4. Envelope partial rollback — caller-tx atomicity on dispatch-target failure.
// ---------------------------------------------------------------------------

describe("Envelope + dispatch-targets atomic rollback (failure-injected)", () => {
  it("rolls back the envelope when a later dispatch-target INSERT fails", () => {
    const db = getDb();
    const missionId = seedMission("envelope-mission");
    const attemptId = seedAttempt(db, "envelope-1");
    const eventId = "evt-rollback";

    const beforeEnvelopes = db.select().from(taskCreationEnvelopes).all().length;
    const beforeTargets = db.select().from(taskCreationDispatchTargets).all().length;
    const now = new Date().toISOString();

    let thrown: unknown;
    try {
      db.transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: 3, // fail at the 3rd write (second dispatch-target INSERT)
        });
        // Write #1 — INSERT task_creation_envelopes (no .returning(), uses .run()).
        // Write #2 — INSERT task_creation_dispatch_targets[0] (succeeds).
        // Write #3 — INSERT task_creation_dispatch_targets[1] (FAILS — wrapper throws).
        createCommittedTaskEnvelopeWithClient(
          asPubClient(w),
          {
            eventId,
            lifecycleAction: "created",
            taskId: "t-rollback",
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
            { targetKind: "external_dispatch", targetKey: "pulse-1" },
          ],
        );
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RepositoryError);

    // BOTH envelope AND all dispatch targets must be absent.
    const afterEnvelopes = getDb().select().from(taskCreationEnvelopes).all().length;
    const afterTargets = getDb().select().from(taskCreationDispatchTargets).all().length;
    expect(afterEnvelopes).toBe(beforeEnvelopes);
    expect(afterTargets).toBe(beforeTargets);
    expect(
      getDb()
        .select()
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.eventId, eventId))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(taskCreationDispatchTargets)
        .where(eq(taskCreationDispatchTargets.eventId, eventId))
        .all(),
    ).toHaveLength(0);

    // **Failure mode that breaks this assertion**: if
    // `createCommittedTaskEnvelopeWithClient` wrote the envelope via
    // `getDb()` (outside the caller's tx), OR did not share the caller's tx,
    // the envelope row would survive despite the dispatch-target failure.
  });
});

// ---------------------------------------------------------------------------
// 5. Attempt non-cascade on habitat replace (HEADLINE T1 GUARDRAIL).
// ---------------------------------------------------------------------------

describe("Attempt / envelope / dispatch / reservation survive habitat replace", () => {
  it("deletes the task via FK cascade but PRESERVES the cross-chain publication records", () => {
    const db = getDb();
    const missionId = seedMission("non-cascade-mission");
    // Create the task via the legacy path (no tx, no envelope) — this is what
    // a pre-cutover Task looks like.
    const task = taskCrud.createTask({
      missionId,
      title: "non-cascade-task",
      createdBy: "u",
    });
    const attemptId = seedAttempt(db, "non-cascade-1");
    const eventId = "evt-non-cascade";
    const reservationId = "res-non-cascade";
    const targetId = "target-non-cascade";
    const now = new Date().toISOString();

    // Seed the cross-chain publication records. Note: `task_id` is plain text
    // (no FK) on envelope, dispatch-target (via envelope), and reservation.
    // `committed_task_id` is plain text (no FK) on attempt. If the schema had
    // accidentally added FKs with cascade, this seed would still work, but the
    // DELETE below would also delete these rows — making the test fail.
    db.insert(taskCreationEnvelopes)
      .values({
        eventId,
        lifecycleAction: "created",
        taskId: task.id,
        habitatId,
        occurredAt: now,
        attemptId,
        actorType: "human",
        actorId: "user-1",
        source: "test",
      })
      .run();
    db.insert(taskCreationDispatchTargets)
      .values({
        id: targetId,
        eventId,
        targetKind: "mission_projection",
        targetKey: missionId,
        state: "pending",
      })
      .run();
    db.insert(taskCreationAssignmentReservations)
      .values({
        id: reservationId,
        taskId: task.id,
        attemptId,
        deadline: now,
        state: "active",
      })
      .run();
    // Stamp attempt's committedTaskId (plain text — no FK) to also exercise that
    // cross-reference surviving.
    db.update(taskCreationAttempts)
      .set({ committedTaskId: task.id, committedMissionId: missionId })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // m5 strengthening: seed BOTH a scheduled_occurrences row AND a
    // mission_recalculation_markers row BEFORE the habitat delete. The prior
    // test seeded the marker AFTER the delete (and never seeded an occurrence),
    // so it proved no-FK-insert works but NOT that pre-existing cross-chain
    // rows survive a habitat replace. These two tables are forward-compatible
    // Story-3 / projection storage with plain-text cross-chain IDs (no FK) —
    // the test now proves pre-existing rows are not swept by the cascade.
    db.insert(scheduledOccurrences)
      .values({
        id: "occ-non-cascade",
        scheduledTaskId: "sched-non-cascade",
        scheduledFor: now,
        ordinal: 1,
        state: "reserved",
        attemptId,
        createdMissionId: missionId,
      })
      .run();
    db.insert(missionRecalculationMarkers)
      .values({ id: "mkr-non-cascade", missionId, reason: "non-cascade-test", state: "pending" })
      .run();

    // Replace the habitat — delete it. The cascade goes Habitat → Mission → Task.
    habitatRepo.deleteHabitat(habitatId);

    // Task row is GONE (cascaded via missions FK).
    expect(getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()).toHaveLength(0);

    // BUT the cross-chain publication records SURVIVE. Their cross-chain ID
    // columns are plain text with NO FK by design — see
    // `db/schema/taskPublication.ts` "Non-cascade design" header comment.
    expect(getDb().select().from(taskCreationAttempts).all()).toHaveLength(1);
    expect(getDb().select().from(taskCreationAttempts).all()[0].committedTaskId).toBe(task.id);
    expect(getDb().select().from(taskCreationAttempts).all()[0].committedMissionId).toBe(missionId);
    expect(
      getDb()
        .select()
        .from(taskCreationEnvelopes)
        .where(eq(taskCreationEnvelopes.eventId, eventId))
        .all(),
    ).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(taskCreationDispatchTargets)
        .where(eq(taskCreationDispatchTargets.id, targetId))
        .all(),
    ).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(taskCreationAssignmentReservations)
        .where(eq(taskCreationAssignmentReservations.id, reservationId))
        .all(),
    ).toHaveLength(1);

    // The pre-existing scheduled occurrence AND mission-recalculation marker
    // ALSO survive — both reference the habitat's mission/task via plain-text
    // columns with no FK, so the habitat-replace cascade cannot reach them.
    expect(
      getDb()
        .select()
        .from(scheduledOccurrences)
        .where(eq(scheduledOccurrences.id, "occ-non-cascade"))
        .all(),
    ).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(scheduledOccurrences)
        .where(eq(scheduledOccurrences.id, "occ-non-cascade"))
        .all()[0].createdMissionId,
    ).toBe(missionId);
    expect(
      getDb()
        .select()
        .from(missionRecalculationMarkers)
        .where(eq(missionRecalculationMarkers.id, "mkr-non-cascade"))
        .all(),
    ).toHaveLength(1);

    // **Failure mode that breaks this assertion**: if the schema accidentally
    // added a cascade-FK on `envelopes.task_id`, `dispatch_targets` (via
    // envelopes), `reservations.task_id`, `attempts.committed_task_id` /
    // `.committed_mission_id`, `scheduled_occurrences.created_mission_id` /
    // `.attempt_id`, or `mission_recalc_markers.mission_id`, the habitat delete
    // would cascade through and delete these rows. The test proves the
    // "non-cascade by design" invariant actually holds at the SQL level for
    // pre-existing rows — not just that a post-delete insert succeeds.
  });
});

// ---------------------------------------------------------------------------
// 6. Old Tasks remain claimable & behaviorally unchanged (Legacy Partial History).
// ---------------------------------------------------------------------------

describe("Legacy Partial History: creationIntegrity=0 tasks remain claimable", () => {
  it("a taskCrud.createTask-produced task has creationIntegrity=0 and claimTask still claims it", () => {
    const db = getDb();
    const missionId = seedMission("legacy-claim-mission");
    // Seed an agent so the claim's assigned_agent_id FK doesn't fail.
    const { agent } = agentRepo.createAgent({
      name: "legacy-claim-agent",
      type: "claude-code",
      domain: "backend",
    });

    // Create via the LEGACY raw inserter — this is what every pre-cutover Task
    // in production looks like.
    const task = taskCrud.createTask({
      missionId,
      title: "legacy-claimable-task",
      createdBy: "u",
    });

    // Read the DB row directly so we observe the actual schema value. The
    // shared `Task` model does not yet carry `creationIntegrity` — it's a new
    // additive column added in T1 — so we MUST verify against the schema row.
    const reloaded = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    // Sanity: the integrity column defaults to 0 (Legacy Partial History).
    expect(reloaded.creationIntegrity).toBe(0);
    expect(reloaded.status).toBe("pending");

    // claimTask must succeed — the new integrity column does NOT gate legacy
    // claiming. This is the headline Legacy Partial History guardrail.
    const claim = taskStateMachine.claimTask(task.id, agent.id);
    expect(claim.success).toBe(true);
    if (claim.success) {
      expect(claim.task.id).toBe(task.id);
      expect(claim.task.status).toBe("claimed");
      expect(claim.task.assignedAgentId).toBe(agent.id);
    }

    // The claimed row still carries creationIntegrity=0 — legacy claiming did
    // not stamp the column either (claim path is unchanged from pre-T1).
    const claimed = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(claimed.creationIntegrity).toBe(0);
    expect(claimed.status).toBe("claimed");

    // **Failure mode that breaks this assertion**: if `taskCrud.createTask` were
    // modified to stamp creationIntegrity > 0, OR if `claimTask` started
    // checking creationIntegrity and rejected 0, the claim would fail (or
    // succeed with a different status). The test asserts both invariants
    // together — the legacy path is unchanged AND the legacy claim path
    // ignores the integrity column.
  });
});

// ---------------------------------------------------------------------------
// 7. completeAttemptWithClient terminal-replay no-side-effects.
// ---------------------------------------------------------------------------

describe("completeAttemptWithClient terminal-replay no-side-effects", () => {
  it("a re-call with DIFFERENT terminal values performs ZERO writes on the wrapper", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "replay-1");
    // `created` is a legal terminal ONLY from `published_pending_assignment`.
    db.update(taskCreationAttempts)
      .set({ state: "published_pending_assignment" })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // First completion — real DB, captures the row + completedAt.
    const first = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created",
      finalState: "created",
      terminalResult: { outcome: "created", taskId: "t-original" },
    });
    expect(first.outcome).toBe("completed");
    if (first.outcome !== "completed") return;
    expect(first.attempt.state).toBe("created");
    const firstCompletedAt = first.attempt.completedAt;
    expect(firstCompletedAt).not.toBeNull();

    // Second call: re-use a wrapper to assert NO writes happen at this layer.
    // The primitive reads current (through wrapper) then, because completedAt
    // !== null, returns the authoritative row WITHOUT calling UPDATE.
    const w = new FailingDbClient(db, { failAtWriteN: null });
    const second = completeAttemptWithClient(asPubClient(w), attemptId, {
      // DIFFERENT values — would corrupt state if the idempotency guard were missing.
      terminalOutcome: "created_unassigned",
      finalState: "created_unassigned",
      terminalResult: { outcome: "created_unassigned", taskId: "t-DIFFERENT" },
    });

    // CRITICAL invariant: zero writes on the wrapper.
    expect(w.writeCount).toBe(0);
    expect(w.writes).toHaveLength(0);
    // The primitive DID read the attempt (replay fast-path read).
    expect(w.readCount).toBeGreaterThanOrEqual(1);
    // The returned row is the original — terminal fields untouched.
    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    expect(second.attempt.completedAt).toBe(firstCompletedAt);
    expect(second.attempt.terminalOutcome).toBe("created");
    expect(second.attempt.state).toBe("created");
    expect(second.attempt.terminalResult?.taskId).toBe("t-original");

    // **Failure mode that breaks this assertion**: if the idempotency guard
    // (`if (existing.completedAt !== null) return existing`) were missing, the
    // second call would do an UPDATE (writeCount=1) and overwrite terminal
    // fields — writeCount=1 and taskId would be "t-DIFFERENT".
  });
});

// ---------------------------------------------------------------------------
// 8. checkpointAttemptWithClient re-entrancy.
// ---------------------------------------------------------------------------

describe("checkpointAttemptWithClient re-entrancy", () => {
  it("advances state observation → assignment; backward observation is rejected (no-op) with stable publishedAt", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "reentrant-1");

    // First checkpoint: pending → published_pending_observation (legal forward).
    const first = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(first.outcome).toBe("transitioned");
    expect(first.attempt.state).toBe("published_pending_observation");
    expect(first.attempt.publishedAt).not.toBeNull();
    const firstPublishedAt = first.attempt.publishedAt;

    // Second checkpoint: published_pending_observation → published_pending_assignment
    // (legal forward). Must NOT throw — checkpoint is a forward transition, not a
    // one-shot. COALESCE preserves the FIRST publishedAt.
    const second = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_assignment",
    });
    expect(second.outcome).toBe("transitioned");
    expect(second.attempt.state).toBe("published_pending_assignment");
    expect(second.attempt.id).toBe(attemptId);
    // publishedAt is COALESCE-preserved (unchanged across the second transition).
    expect(second.attempt.publishedAt).toBe(firstPublishedAt);

    // Third call: BACKWARD transition (assignment → observation) is now REJECTED
    // (the M4 fix made this visible — the permissive primitive used to bless it).
    const third = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(third.outcome).toBe("rejected_transition");
    if (third.outcome !== "rejected_transition") return;
    expect(third.fromState).toBe("published_pending_assignment");
    expect(third.toStage).toBe("published_pending_observation");
    // The row is returned read-only (unchanged) — no backward corruption.
    expect(third.attempt.state).toBe("published_pending_assignment");
    // publishedAt is stable — the rejection did not re-stamp it.
    expect(third.attempt.publishedAt).toBe(firstPublishedAt);

    // **Failure mode that breaks this assertion**: if the permissive primitive
    // (M4 defect) were still in place, the third call would silently move state
    // back to published_pending_observation (backward) and re-stamp publishedAt,
    // so third.outcome would not be "rejected_transition" and publishedAt would
    // differ from firstPublishedAt. If COALESCE were missing, second.attempt
    // .publishedAt would differ from firstPublishedAt.
  });
});

// ---------------------------------------------------------------------------
// 8b. checkpointAttemptWithClient transition matrix (M4 fix — forward-only,
//     same-state no-op, backward/terminal rejected, COALESCE publishedAt,
//     compare-and-set under concurrent state change).
// ---------------------------------------------------------------------------

/**
 * Seeds a `task_creation_attempts` row at an arbitrary state (the default
 * `seedAttempt` always inserts `pending`; the matrix tests need non-pending
 * starting states to exercise same-state / backward / terminal paths).
 */
function seedAttemptAtState(
  db: TaskPublicationDbClient,
  id: string,
  state: string,
  extra?: Partial<{ publishedAt: string; completedAt: string; state: string }>,
): string {
  db.insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-matrix",
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      state: state as typeof taskCreationAttempts.$inferSelect.state,
      publishedAt: extra?.publishedAt ?? null,
      completedAt: extra?.completedAt ?? null,
    })
    .run();
  return id;
}

/**
 * Tx-injection shim for the compare-and-set race test. Wraps a real drizzle
 * client and, on the FIRST `.update(...).run()` boundary, runs
 * `competingMutation` against the INNER client BEFORE delegating the update —
 * simulating a concurrent writer that mutates state in the window between the
 * primitive's in-tx read and its conditional UPDATE. Reads / inserts / deletes
 * pass through unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raceInjectingClient(
  inner: TaskPublicationDbClient,
  competingMutation: (db: TaskPublicationDbClient) => void,
): TaskPublicationDbClient {
  let injected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapUpdateBuilder = (builder: any): any =>
    new Proxy(builder, {
      get: (target, prop, receiver) => {
        if (prop === "run") {
          return () => {
            if (!injected) {
              injected = true;
              competingMutation(inner);
            }
            return (target as { run: () => unknown }).run();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => wrapUpdateBuilder(value.apply(target, args));
        }
        return value;
      },
    });
  return new Proxy(inner as object, {
    get: (target, prop, receiver) => {
      if (prop === "update") {
        return (table: unknown) => {
          const builder = (target as { update: (t: unknown) => unknown }).update(table);
          return wrapUpdateBuilder(builder);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as unknown as TaskPublicationDbClient;
}

describe("checkpointAttemptWithClient transition matrix (M4 fix)", () => {
  it("forward pending → observation SUCCEEDS and sets publishedAt the FIRST time", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "fwd-pending");

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(result.outcome).toBe("transitioned");
    expect(result.attempt.state).toBe("published_pending_observation");
    expect(result.attempt.publishedAt).not.toBeNull();

    // **Failure mode**: if the matrix rejected pending→observation (e.g. the
    // legal-forward check were inverted), outcome would be "rejected_transition"
    // and publishedAt would be null.
  });

  it("forward observation → assignment SUCCEEDS and COALESCE-preserves publishedAt", () => {
    const db = getDb();
    const stamped = "2025-01-01T00:00:00.000Z";
    const attemptId = seedAttemptAtState(db, "fwd-obs", "published_pending_observation", {
      publishedAt: stamped,
    });

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_assignment",
    });
    expect(result.outcome).toBe("transitioned");
    expect(result.attempt.state).toBe("published_pending_assignment");
    // COALESCE: the FIRST publishedAt is preserved, NOT overwritten with now().
    expect(result.attempt.publishedAt).toBe(stamped);

    // **Failure mode**: if COALESCE were missing, publishedAt would be a fresh
    // `now()` ISO stamp, not equal to `stamped`.
  });

  it("same-state observation → observation is NO-OP with publishedAt UNCHANGED", () => {
    const db = getDb();
    const stamped = "2025-02-02T00:00:00.000Z";
    const attemptId = seedAttemptAtState(db, "same-obs", "published_pending_observation", {
      publishedAt: stamped,
    });

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(result.outcome).toBe("no_op");
    expect(result.attempt.state).toBe("published_pending_observation");
    // Same-state never re-stamps publishedAt.
    expect(result.attempt.publishedAt).toBe(stamped);

    // **Failure mode**: if same-state did not short-circuit (the M4 defect:
    // unconditional UPDATE), publishedAt would be overwritten with now() and
    // outcome would be "transitioned".
  });

  it("backward assignment → observation is REJECTED with stable state + publishedAt", () => {
    const db = getDb();
    const stamped = "2025-03-03T00:00:00.000Z";
    const attemptId = seedAttemptAtState(db, "back-assign", "published_pending_assignment", {
      publishedAt: stamped,
    });

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(result.outcome).toBe("rejected_transition");
    if (result.outcome !== "rejected_transition") return;
    expect(result.fromState).toBe("published_pending_assignment");
    expect(result.toStage).toBe("published_pending_observation");
    // The row is returned read-only — no backward corruption.
    expect(result.attempt.state).toBe("published_pending_assignment");
    expect(result.attempt.publishedAt).toBe(stamped);

    // **Failure mode**: if backward transitions were not rejected (the M4
    // defect), state would move to published_pending_observation and outcome
    // would be "transitioned".
  });

  it("forward-skip pending → assignment is REJECTED (must pass observation first)", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "skip-assign");

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_assignment",
    });
    expect(result.outcome).toBe("rejected_transition");
    if (result.outcome !== "rejected_transition") return;
    expect(result.fromState).toBe("pending");
    expect(result.toStage).toBe("published_pending_assignment");
    expect(result.attempt.state).toBe("pending");

    // **Failure mode**: if the matrix only checked "target is a published state"
    // without the from→to pairing, pending→assignment would wrongly fire,
    // skipping the observation gate.
  });

  it("terminal-locked: a `created` attempt rejects any checkpoint transition", () => {
    const db = getDb();
    const stamped = "2025-04-04T00:00:00.000Z";
    const attemptId = seedAttemptAtState(db, "term-created", "created", {
      publishedAt: stamped,
      completedAt: stamped,
    });

    const toObservation = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(toObservation.outcome).toBe("rejected_transition");
    expect(toObservation.attempt.state).toBe("created");
    expect(toObservation.attempt.completedAt).toBe(stamped);

    const toAssignment = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_assignment",
    });
    expect(toAssignment.outcome).toBe("rejected_transition");
    expect(toAssignment.attempt.state).toBe("created");

    // **Failure mode**: if the terminal-lock (completedAt / terminal-state
    // check) were missing, a `created` attempt could be dragged back into
    // published_pending_* — violating the guardrail "terminal replay cannot
    // transition back to active work."
  });

  it("terminal-locked: a `rejected_validation` attempt (no completedAt) rejects any checkpoint", () => {
    const db = getDb();
    // rejected_validation reachable directly from pending WITHOUT completeAttempt,
    // so completedAt is null — the state-set terminal check is what locks it.
    const attemptId = seedAttemptAtState(db, "term-rejected", "rejected_validation");

    const result = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(result.outcome).toBe("rejected_transition");
    expect(result.attempt.state).toBe("rejected_validation");
    expect(result.attempt.completedAt).toBeNull();

    // **Failure mode**: if the terminal-lock only checked `completedAt !== null`
    // (ignoring the terminal STATE set), this rejected_validation attempt (null
    // completedAt) would slip through and re-enter active publication.
  });

  it("compare-and-set: a concurrent state change between read and UPDATE no-ops without corruption", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "race-1");
    // Advance to observation so the legal-forward path under test is
    // observation → assignment.
    checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });

    // Racer: between the primitive's in-tx read (state=observation) and its
    // conditional UPDATE, a concurrent worker ADVANCES the attempt via the
    // legal checkpoint observation→assignment. (Pre-R1 the racer terminalized
    // observation→created; R1's legal terminal matrix now rejects that as a
    // forward-skip past the assignment gate, so the meaningful concurrent
    // mutation is a legal checkpoint advance — same CAS-race shape.)
    const racer = raceInjectingClient(db, (inner) => {
      checkpointAttemptWithClient(inner, attemptId, {
        stage: "published_pending_assignment",
      });
    });

    const result = checkpointAttemptWithClient(racer, attemptId, {
      stage: "published_pending_assignment",
    });

    // The conditional UPDATE's WHERE (state = observation) did NOT match (the
    // racer moved state to assignment), so the result is no_op — NOT a
    // transition. R5 classifies by the affected-row count (0), not the re-read
    // state, so even though the re-read sees the target the outcome is no_op.
    expect(result.outcome).toBe("no_op");
    // The row reflects the concurrent winner, untouched by our UPDATE.
    expect(result.attempt.state).toBe("published_pending_assignment");
    expect(result.attempt.completedAt).toBeNull();

    // **Failure mode**: if the UPDATE were unconditional (the M4 defect — no
    // `AND state = fromState` in the WHERE), our UPDATE would have OVERWRITTEN
    // the racer's `published_pending_assignment` row (re-stamping publishedAt
    // and losing the winner's transition), and outcome would be "transitioned".
    // R5's affected-row classification additionally catches the case where the
    // re-read happens to show the target despite a zero-row UPDATE.
  });
});

// ---------------------------------------------------------------------------
// 8c. completeAttemptWithClient + transition terminal-lock interaction.
// ---------------------------------------------------------------------------

describe("completeAttemptWithClient + checkpoint terminal-lock", () => {
  it("completeAttempt is idempotent on re-call, THEN a checkpoint transition is rejected", () => {
    const db = getDb();
    const attemptId = seedAttempt(db, "term-lock-1");
    // `created` is a legal terminal ONLY from `published_pending_assignment`.
    db.update(taskCreationAttempts)
      .set({ state: "published_pending_assignment" })
      .where(eq(taskCreationAttempts.id, attemptId))
      .run();

    // First completion → terminal `created`.
    const first = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created",
      finalState: "created",
      terminalResult: { outcome: "created", taskId: "t-first" },
    });
    expect(first.outcome).toBe("completed");
    if (first.outcome !== "completed") return;
    expect(first.attempt.state).toBe("created");
    expect(first.attempt.completedAt).not.toBeNull();
    const firstCompletedAt = first.attempt.completedAt;

    // Idempotent re-call: prior completion is authoritative, no overwrite.
    const second = completeAttemptWithClient(db, attemptId, {
      terminalOutcome: "created_unassigned",
      finalState: "created_unassigned",
      terminalResult: { outcome: "created_unassigned", taskId: "t-DIFFERENT" },
    });
    expect(second.outcome).toBe("no_op");
    if (second.outcome !== "no_op") return;
    expect(second.attempt.completedAt).toBe(firstCompletedAt);
    expect(second.attempt.state).toBe("created");
    expect(second.attempt.terminalResult?.taskId).toBe("t-first");

    // Terminal-lock: once completedAt is set, the transition API refuses to
    // reopen — terminalization is a one-way door.
    const transition = checkpointAttemptWithClient(db, attemptId, {
      stage: "published_pending_observation",
    });
    expect(transition.outcome).toBe("rejected_transition");
    expect(transition.attempt.state).toBe("created");
    expect(transition.attempt.completedAt).toBe(firstCompletedAt);

    // **Failure mode**: if the checkpoint did not treat completedAt !== null as
    // terminal-locked, the transition would fire onto an already-completed
    // attempt, reopening terminal work (violating the one-way door) and outcome
    // would be "transitioned".
  });
});

// ---------------------------------------------------------------------------
// 9. createTaskWithClient order allocation observed on the passed client.
// ---------------------------------------------------------------------------

describe("createTaskWithClient order allocation on the passed client", () => {
  it("SELECT(max) and INSERT both flow through the wrapper — writeCount=2, readCount>=2, orders 0 then 1", () => {
    const db = getDb();
    const missionId = seedMission("order-mission");

    const orders: number[] = [];
    db.transaction((tx) => {
      const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
        failAtWriteN: null,
      });
      // createTaskWithClient on a fresh mission: SELECT(max)→INSERT.
      const t1 = createTaskWithClient(asPubClient(w), {
        missionId,
        title: "order-t1",
        createdBy: "u",
      });
      orders.push(t1.order);
      const t2 = createTaskWithClient(asPubClient(w), {
        missionId,
        title: "order-t2",
        createdBy: "u",
      });
      orders.push(t2.order);

      // Both SELECTs (max order allocation) went through the wrapper.
      expect(w.readCount).toBeGreaterThanOrEqual(2);
      // Both INSERTs went through the wrapper.
      expect(w.writeCount).toBe(2);
      // Order rows must reference the two INSERTs (distinct).
      expect(w.writes.every((r) => r.kind === "insert")).toBe(true);
    });

    // Sequential allocation: t1.order = 0, t2.order = 1.
    expect(orders).toEqual([0, 1]);

    // **Failure mode that breaks this assertion**: if `createTaskWithClient`
    // leaked to `getDb()` for either the SELECT(max) or the INSERT, those
    // calls would NOT increment the wrapper's counters — writeCount and/or
    // readCount would be lower. Or if the SELECT happened on `getDb()` and the
    // INSERT happened on the wrapper, the orders might still match (the DB
    // is shared) but readCount would be 0 — proving the SELECT escaped the tx.
  });
});
