/**
 * Creation Dispatch Adapters — T4B Phase 1 invariant tests.
 *
 * DORMANT: no production origin creates post-cutover Tasks until cutover.
 * These tests prove the load-bearing invariants the T4A dispatcher and the
 * eventual cutover will rely on. Each test is a discriminating probe: it FAILS
 * without the Phase 1 implementation and PASSES after.
 *
 * Contract invariants covered:
 *  1. Each adapter returns `accepted` on attempt/durable-ingress.
 *  2. A faulting underlying mechanism → `{attention, error}` (no silent
 *     claimability).
 *  3. `defaultCreationDispatchPlan` lists exactly the 6 required target kinds.
 *  4. After `registerCreationDispatchAdapters()`, `resolveDispatchAdapter`
 *     resolves all 6; before, none.
 *  5. Integration: `processEnvelopeDispatchWithClient` invokes registered
 *     adapters; all-accepted → observation advances.
 *  6. Re-processing an accepted target does NOT re-call the adapter.
 *
 * See the T4B ticket § "Phase 1 grounding" and "Contract invariants".
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock data — vi.mock factories are hoisted above const declarations,
// so shared mock values must be created via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockTask } = vi.hoisted(() => ({
  mockTask: {
    id: "task-adapter-test",
    missionId: "mission-1",
    title: "Test Task",
    status: "pending",
    priority: "medium",
    habitatId: "habitat-adapter-test",
  },
}));

// ---------------------------------------------------------------------------
// Mocks — all underlying mechanisms are mocked so tests are deterministic.
// The dispatch engine + registry are NOT mocked (they use the real in-memory
// DB for integration tests).
// ---------------------------------------------------------------------------

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn().mockReturnValue(mockTask),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn(), publishToClients: vi.fn() },
}));

vi.mock("../services/webhookDispatcher.js", () => ({
  dispatchWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/chatService.js", () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/automationEventService.js", () => ({
  ingestEvent: vi.fn().mockResolvedValue({
    eventType: "task.created",
    matched: 0,
    skipped: 0,
    errors: [],
  }),
}));

vi.mock("../plugins/pluginManager.js", () => ({
  runPostInterceptors: vi.fn(),
}));

vi.mock("../services/tasks/transition-emitter.js", () => ({
  notifyTransition: vi.fn(),
  emitTransition: vi.fn(),
  onTransition: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as taskRepo from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { dispatchWebhooks } from "../services/webhookDispatcher.js";
import { processEvent as chatProcessEvent } from "../services/chatService.js";
import { ingestEvent } from "../services/automationEventService.js";
import { runPostInterceptors } from "../plugins/pluginManager.js";
import { notifyTransition } from "../services/tasks/transition-emitter.js";

import { taskCreationEnvelopes, taskCreationDispatchTargets } from "../db/schema/index.js";
import {
  clientStreamAdapter,
  webhookAdapter,
  chatAdapter,
  automationAdapter,
  postInterceptorAdapter,
  transitionSubscriberAdapter,
  defaultCreationDispatchPlan,
  registerCreationDispatchAdapters,
  areCreationDispatchAdaptersRegistered,
  CREATION_TARGET_KINDS,
} from "../services/taskCreationDispatchAdapters.js";
import { resolveDispatchAdapter } from "../services/taskCreationDispatchRegistry.js";
import type { DispatchTargetAttemptOutcome } from "../services/taskCreationDispatchRegistry.js";

type EnvelopeRow = typeof taskCreationEnvelopes.$inferSelect;
type TargetRow = typeof taskCreationDispatchTargets.$inferSelect;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const testEnvelope: EnvelopeRow = {
  eventId: "evt-test-001",
  lifecycleAction: "created",
  taskId: "task-adapter-test",
  habitatId: "habitat-adapter-test",
  occurredAt: new Date().toISOString(),
  attemptId: "attempt-test",
  actorType: "human",
  actorId: "user-1",
  source: "test",
  causalContext: { root: { type: "test", id: "root-1" } },
  cloneSourceTaskId: null,
};

// Clone envelope — lifecycleAction "cloned" + cloneSourceTaskId set (mirrors
// the envelope a T3C-published clone produces). The new task is still
// `mockTask` (resolveTask returns it for `taskId`); `cloneSourceTaskId` is the
// SOURCE task the clone was copied from (matches `task-crud.ts` live shape).
const clonedEnvelope: EnvelopeRow = {
  eventId: "evt-clone-001",
  lifecycleAction: "cloned",
  taskId: "task-adapter-test",
  habitatId: "habitat-adapter-test",
  occurredAt: new Date().toISOString(),
  attemptId: "attempt-clone",
  actorType: "human",
  actorId: "user-1",
  source: "test",
  causalContext: { root: { type: "test", id: "root-1" } },
  cloneSourceTaskId: "task-source-001",
};

const testTarget: TargetRow = {
  id: "target-test-001",
  eventId: "evt-test-001",
  targetKind: "client_stream",
  targetKey: "habitat-adapter-test",
  state: "pending",
  attemptCount: 0,
  lastAttemptAt: null,
  lastError: null,
  acceptedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function expectAccepted(result: DispatchTargetAttemptOutcome): void {
  expect(result.outcome).toBe("accepted");
}

function expectAttention(result: DispatchTargetAttemptOutcome, substr?: string): void {
  expect(result.outcome).toBe("attention");
  if (result.outcome === "attention" && substr) {
    expect(result.error).toContain(substr);
  }
}

// ===========================================================================
// 1. defaultCreationDispatchPlan
// ===========================================================================

describe("defaultCreationDispatchPlan", () => {
  it("lists exactly the 6 required target kinds", () => {
    const plan = defaultCreationDispatchPlan(testEnvelope);
    expect(plan).toHaveLength(6);
    const kinds = plan.map((t) => t.targetKind).sort();
    const expected = [...CREATION_TARGET_KINDS].sort();
    expect(kinds).toEqual(expected);
  });

  it("uses habitatId as targetKey for every target", () => {
    const plan = defaultCreationDispatchPlan(testEnvelope);
    for (const target of plan) {
      expect(target.targetKey).toBe(testEnvelope.habitatId);
    }
  });
});

// ===========================================================================
// 2. registerCreationDispatchAdapters
// ===========================================================================

describe("registerCreationDispatchAdapters", () => {
  it("resolves all 6 kinds after registration", () => {
    registerCreationDispatchAdapters();

    for (const kind of CREATION_TARGET_KINDS) {
      const adapter = resolveDispatchAdapter(kind);
      expect(adapter, `expected adapter for "${kind}"`).toBeDefined();
      expect(adapter!.targetKind).toBe(kind);
    }
  });

  it("is idempotent — safe to call multiple times", () => {
    registerCreationDispatchAdapters();
    registerCreationDispatchAdapters();

    expect(areCreationDispatchAdaptersRegistered()).toBe(true);
    for (const kind of CREATION_TARGET_KINDS) {
      expect(resolveDispatchAdapter(kind)).toBeDefined();
    }
  });
});

// ===========================================================================
// 3. clientStreamAdapter — Phase 2: publishToClients + clone dual-signal +
// routing split (no domain fan-out from the client-stream path).
// ===========================================================================

describe("clientStreamAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  // ----- Created single-signal (Phase 1 invariant, now via publishToClients) -----

  it("returns accepted and emits task.created via publishToClients (created envelope)", () => {
    const result = clientStreamAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(sseBroadcaster.publishToClients).toHaveBeenCalledWith(testEnvelope.habitatId, {
      type: "task.created",
      data: mockTask,
    });
    // Exactly one SSE signal for a created envelope.
    expect(sseBroadcaster.publishToClients).toHaveBeenCalledTimes(1);
  });

  it("returns attention when task not found (no silent claimability)", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = clientStreamAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "not found");
    expect(sseBroadcaster.publishToClients).not.toHaveBeenCalled();
  });

  it("returns attention when publishToClients throws", () => {
    vi.mocked(sseBroadcaster.publishToClients).mockImplementationOnce(() => {
      throw new Error("SSE transport down");
    });
    const result = clientStreamAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "SSE transport down");
  });

  // ----- Clone dual-signal (Phase 2 invariant) -----

  it("emits task.cloned THEN task.created for a cloned envelope (order + count + shape)", () => {
    const result = clientStreamAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "client_stream",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);

    // Exactly TWO publishToClients calls — one cloned, one created.
    expect(sseBroadcaster.publishToClients).toHaveBeenCalledTimes(2);

    // Order: cloned THEN created (mirror task-crud.ts:115/120).
    const calls = vi.mocked(sseBroadcaster.publishToClients).mock.calls;
    expect(calls[0][1].type).toBe("task.cloned");
    expect(calls[1][1].type).toBe("task.created");

    // Shape: task.cloned carries { sourceTaskId, clonedTask }.
    expect(calls[0][0]).toBe(clonedEnvelope.habitatId);
    expect(calls[0][1]).toEqual({
      type: "task.cloned",
      data: { sourceTaskId: "task-source-001", clonedTask: mockTask },
    });

    // Shape: task.created carries the new task.
    expect(calls[1][0]).toBe(clonedEnvelope.habitatId);
    expect(calls[1][1]).toEqual({ type: "task.created", data: mockTask });

    // publish (the domain bus) is NEVER called by the client-stream adapter.
    expect(sseBroadcaster.publish).not.toHaveBeenCalled();
  });

  // ----- Routing split (the load-bearing Phase 2 invariant) -----

  it("routing split: client-stream adapter NEVER triggers domain fan-out (no webhook/chat/automation)", () => {
    // Created envelope — the single-signal case.
    clientStreamAdapter.attempt(testEnvelope, testTarget);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(chatProcessEvent).not.toHaveBeenCalled();
    expect(ingestEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // Cloned envelope — the dual-signal case. Even with TWO publishToClients
    // calls, none of the generic domain consumers fire (they have their own
    // dedicated adapters).
    clientStreamAdapter.attempt(clonedEnvelope, testTarget);
    expect(dispatchWebhooks).not.toHaveBeenCalled();
    expect(chatProcessEvent).not.toHaveBeenCalled();
    expect(ingestEvent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3b. Generic single-handoff (Phase 2 invariant) — cloned envelope fires each
// generic adapter EXACTLY ONCE (the canonical `created`), not twice.
// ===========================================================================

describe("generic adapters — clone single-handoff (one envelope → one call each)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("webhookAdapter fires exactly once for a cloned envelope (task.created shape)", () => {
    const result = webhookAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "webhook",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);
    expect(dispatchWebhooks).toHaveBeenCalledTimes(1);
    expect(dispatchWebhooks).toHaveBeenCalledWith(clonedEnvelope.habitatId, {
      type: "task.created",
      data: mockTask,
    });
  });

  it("chatAdapter fires exactly once for a cloned envelope (task.created shape)", () => {
    const result = chatAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "chat",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);
    expect(chatProcessEvent).toHaveBeenCalledTimes(1);
    expect(chatProcessEvent).toHaveBeenCalledWith(
      "task.created",
      clonedEnvelope.habitatId,
      expect.objectContaining({ id: mockTask.id }),
    );
  });

  it("automationAdapter fires exactly once for a cloned envelope (task.created shape)", () => {
    const result = automationAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "automation",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);
    expect(ingestEvent).toHaveBeenCalledTimes(1);
    // The cloned envelope forwards lifecycleAction "cloned" + causalContext.
    expect(ingestEvent).toHaveBeenCalledWith(
      clonedEnvelope.habitatId,
      expect.objectContaining({
        type: "task.created",
        data: expect.objectContaining({
          lifecycleAction: "cloned",
          causalContext: clonedEnvelope.causalContext,
          eventId: clonedEnvelope.eventId,
        }),
      }),
    );
  });

  it("postInterceptorAdapter fires exactly once for a cloned envelope", () => {
    const result = postInterceptorAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "post_interceptor",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);
    expect(runPostInterceptors).toHaveBeenCalledTimes(1);
  });

  it("transitionSubscriberAdapter fires exactly once for a cloned envelope (action 'created')", () => {
    const result = transitionSubscriberAdapter.attempt(clonedEnvelope, {
      ...testTarget,
      targetKind: "transition_subscriber",
      eventId: clonedEnvelope.eventId,
    });
    expectAccepted(result);
    expect(notifyTransition).toHaveBeenCalledTimes(1);
    expect(notifyTransition).toHaveBeenCalledWith(expect.objectContaining({ action: "created" }));
  });
});

// ===========================================================================
// 4. webhookAdapter
// ===========================================================================

describe("webhookAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns accepted and dispatches webhooks (fire-and-forget)", () => {
    const result = webhookAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(dispatchWebhooks).toHaveBeenCalledWith(testEnvelope.habitatId, {
      type: "task.created",
      data: mockTask,
    });
  });

  it("returns attention when task not found", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = webhookAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "not found");
    expect(dispatchWebhooks).not.toHaveBeenCalled();
  });

  it("returns attention when dispatchWebhooks throws synchronously", () => {
    vi.mocked(dispatchWebhooks).mockImplementationOnce(() => {
      throw new Error("subscription lookup failed");
    });
    const result = webhookAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "subscription lookup failed");
  });
});

// ===========================================================================
// 5. chatAdapter
// ===========================================================================

describe("chatAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns accepted and hands off to chatService.processEvent", () => {
    const result = chatAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(chatProcessEvent).toHaveBeenCalledWith(
      "task.created",
      testEnvelope.habitatId,
      expect.objectContaining({ id: mockTask.id }),
    );
  });

  it("returns attention when task not found", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = chatAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "not found");
    expect(chatProcessEvent).not.toHaveBeenCalled();
  });

  it("returns attention when chatProcessEvent throws synchronously", () => {
    vi.mocked(chatProcessEvent).mockImplementationOnce(() => {
      throw new Error("integration lookup failed");
    });
    const result = chatAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "integration lookup failed");
  });
});

// ===========================================================================
// 6. automationAdapter
// ===========================================================================

describe("automationAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns accepted and ingests event with envelope.eventId for receiver dedup", () => {
    const result = automationAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(ingestEvent).toHaveBeenCalledWith(
      testEnvelope.habitatId,
      expect.objectContaining({
        type: "task.created",
        data: expect.objectContaining({
          eventId: testEnvelope.eventId,
          taskId: testEnvelope.taskId,
        }),
      }),
    );
  });

  it("forwards lifecycleAction and causalContext (trusted-envelope signature)", () => {
    const result = automationAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(ingestEvent).toHaveBeenCalledWith(
      testEnvelope.habitatId,
      expect.objectContaining({
        type: "task.created",
        data: expect.objectContaining({
          lifecycleAction: testEnvelope.lifecycleAction,
          causalContext: testEnvelope.causalContext,
        }),
      }),
    );
  });

  it("returns accepted even when task is null (eventId + taskId still passed)", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = automationAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(ingestEvent).toHaveBeenCalled();
  });

  it("returns attention when ingestEvent throws synchronously", () => {
    vi.mocked(ingestEvent).mockImplementationOnce(() => {
      throw new Error("rule repo unavailable");
    });
    const result = automationAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "rule repo unavailable");
  });
});

// ===========================================================================
// 7. postInterceptorAdapter
// ===========================================================================

describe("postInterceptorAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns accepted and runs post-interceptors with taskCreated event", () => {
    const result = postInterceptorAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(runPostInterceptors).toHaveBeenCalledWith(
      testEnvelope.taskId,
      "taskCreated",
      testEnvelope.habitatId,
      expect.objectContaining({ task: mockTask }),
    );
  });

  it("returns attention when task not found", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = postInterceptorAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "not found");
    expect(runPostInterceptors).not.toHaveBeenCalled();
  });

  it("returns attention when runPostInterceptors throws", () => {
    vi.mocked(runPostInterceptors).mockImplementationOnce(() => {
      throw new Error("runtime unavailable");
    });
    const result = postInterceptorAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "runtime unavailable");
  });
});

// ===========================================================================
// 8. transitionSubscriberAdapter
// ===========================================================================

describe("transitionSubscriberAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns accepted and notifies transition subscribers with action 'created'", () => {
    const result = transitionSubscriberAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(notifyTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: testEnvelope.taskId,
        action: "created",
        habitatId: testEnvelope.habitatId,
      }),
    );
  });

  it("returns accepted even when task is null (task field is optional)", () => {
    vi.mocked(taskRepo.getTaskById).mockReturnValueOnce(null);
    const result = transitionSubscriberAdapter.attempt(testEnvelope, testTarget);
    expectAccepted(result);
    expect(notifyTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: testEnvelope.taskId }),
    );
  });

  it("returns attention when notifyTransition throws", () => {
    vi.mocked(notifyTransition).mockImplementationOnce(() => {
      throw new Error("hook registry corrupt");
    });
    const result = transitionSubscriberAdapter.attempt(testEnvelope, testTarget);
    expectAttention(result, "hook registry corrupt");
  });
});

// ===========================================================================
// 9. Integration — processEnvelopeDispatchWithClient with real adapters
// ===========================================================================

describe("Integration with processEnvelopeDispatchWithClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("all 6 creation adapters accepted via the dispatch engine → observation advances to created", async () => {
    // Use the REAL dispatch engine + REAL in-memory DB. The mechanism modules
    // are mocked, but the adapter → registry → engine → DB chain is real.
    const { closeDb, getDb, initTestDb } = await import("../db/index.js");
    const { taskCreationAttempts, taskCreationEnvelopes, taskCreationDispatchTargets } =
      await import("../db/schema/index.js");
    const { processEnvelopeDispatchWithClient } =
      await import("../services/taskCreationDispatchEngine.js");

    await initTestDb();
    try {
      const db = getDb();
      const attemptId = "attempt-integration-test";
      const eventId = "evt-integration-test";

      db.insert(taskCreationAttempts)
        .values({
          id: attemptId,
          source: "test",
          sourceScopeKind: "mission",
          sourceScopeId: "m-adapter-integration",
          attemptKey: `key-${attemptId}`,
          requestFingerprint: `fp-${attemptId}`,
          publicationKind: "create",
          actorType: "human",
          actorId: "user-1",
          state: "published_pending_observation",
        })
        .run();

      db.insert(taskCreationEnvelopes)
        .values({
          eventId,
          lifecycleAction: "created",
          taskId: "task-adapter-test",
          habitatId: "habitat-adapter-test",
          occurredAt: new Date().toISOString(),
          attemptId,
          actorType: "human",
          actorId: "user-1",
          source: "test",
        })
        .run();

      // Seed the 6 creation dispatch targets
      for (const kind of CREATION_TARGET_KINDS) {
        db.insert(taskCreationDispatchTargets)
          .values({
            id: `target-${kind}-${eventId}`,
            eventId,
            targetKind: kind,
            targetKey: "habitat-adapter-test",
            state: "pending",
          })
          .run();
      }

      // Adapters are registered (from the earlier registration test).
      // Ensure they're registered.
      registerCreationDispatchAdapters();

      const result = processEnvelopeDispatchWithClient(db, attemptId);

      expect(result.outcome).toBe("dispatched");
      if (result.outcome !== "dispatched") {
        await closeDb();
        return;
      }

      // All 6 targets should be transitioned to accepted.
      expect(result.targets).toHaveLength(6);
      for (const tr of result.targets) {
        expect(tr.outcome).toBe("transitioned");
        expect(tr.target.state).toBe("accepted");
      }

      // Observation advances (all accepted + no reservation → created).
      expect(result.observation.outcome).toBe("advanced");
    } finally {
      await closeDb();
    }
  });

  it("re-processing an accepted target does NOT re-call the adapter (call count stays 1)", async () => {
    const { closeDb, getDb, initTestDb } = await import("../db/index.js");
    const {
      taskCreationAttempts,
      taskCreationEnvelopes,
      taskCreationDispatchTargets,
      taskCreationAssignmentReservations,
    } = await import("../db/schema/index.js");
    const { processEnvelopeDispatchWithClient } =
      await import("../services/taskCreationDispatchEngine.js");

    await initTestDb();
    try {
      const db = getDb();
      const attemptId = "attempt-reprocess-test";
      const eventId = "evt-reprocess-test";

      db.insert(taskCreationAttempts)
        .values({
          id: attemptId,
          source: "test",
          sourceScopeKind: "mission",
          sourceScopeId: "m-reprocess",
          attemptKey: `key-${attemptId}`,
          requestFingerprint: `fp-${attemptId}`,
          publicationKind: "create",
          actorType: "human",
          actorId: "user-1",
          state: "published_pending_observation",
        })
        .run();

      db.insert(taskCreationEnvelopes)
        .values({
          eventId,
          lifecycleAction: "created",
          taskId: "task-adapter-test",
          habitatId: "habitat-adapter-test",
          occurredAt: new Date().toISOString(),
          attemptId,
          actorType: "human",
          actorId: "user-1",
          source: "test",
        })
        .run();

      // Seed a single client_stream target
      db.insert(taskCreationDispatchTargets)
        .values({
          id: `target-reprocess-${eventId}`,
          eventId,
          targetKind: "client_stream",
          targetKey: "habitat-adapter-test",
          state: "pending",
        })
        .run();

      // Active reservation keeps the attempt non-terminal (published_pending_assignment)
      // so the lease can be re-acquired on the second pass.
      db.insert(taskCreationAssignmentReservations)
        .values({
          id: `res-reprocess-${eventId}`,
          taskId: "task-adapter-test",
          attemptId,
          requestedAgentId: "agent-1",
          deadline: new Date(Date.now() + 60_000).toISOString(),
          state: "active",
        })
        .run();

      registerCreationDispatchAdapters();

      // First pass: adapter called, target accepted.
      const first = processEnvelopeDispatchWithClient(db, attemptId);
      expect(first.outcome).toBe("dispatched");
      const firstCallCount = vi.mocked(sseBroadcaster.publishToClients).mock.calls.length;

      // Second pass: target is already accepted → NOT re-attempted.
      const second = processEnvelopeDispatchWithClient(db, attemptId);
      expect(second.outcome).toBe("dispatched");
      if (second.outcome !== "dispatched") return;
      expect(second.targets).toHaveLength(0); // no outstanding targets
      expect(vi.mocked(sseBroadcaster.publishToClients).mock.calls.length).toBe(firstCallCount);
    } finally {
      await closeDb();
    }
  });
});
