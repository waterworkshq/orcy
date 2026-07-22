/**
 * T11 — default creation dispatch plan (CRITICAL fix).
 *
 * Proves the keystone wiring: a Task published through the kernel WITHOUT a
 * caller-supplied `dispatchPlan` gets the standard 6-target creation plan, each
 * target starts `pending`, the registered adapters advance them to `accepted`,
 * and the observation checkpoint opens (attempt → `created`). Before this fix
 * the default was `[]` → zero targets → vacuously-accepted observation → the
 * Task advanced to `created` WITHOUT invoking any of the 6 dispatch consumers.
 *
 * This is the load-bearing test the cold review demanded: a real flag-on
 * origin → envelope → six pending targets → registered adapters → terminal
 * attempt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskCreationAttempts, taskCreationDispatchTargets } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { prepareTaskPublication } from "../services/taskPublicationPreparation.js";
import { governTaskPublication } from "../services/taskPublicationGovernance.js";
import { publishTaskWithClient } from "../services/taskPublicationCoordinator.js";
import {
  registerCreationDispatchAdapters,
  areCreationDispatchAdaptersRegistered,
  CREATION_TARGET_KINDS,
} from "../services/taskCreationDispatchAdapters.js";
import { processEnvelopeDispatchWithClient } from "../services/taskCreationDispatchEngine.js";
import type { AuditActorRef, AuditSource } from "@orcy/shared";

// --- Hoisted spies for the fan-out mechanisms the adapters wrap. ---
// `vi.hoisted` lifts these above the `vi.mock` calls so the factories close
// over initialized spies. webhook/chat/automation are fire-and-forget `.catch`
// chains in the adapters, so they MUST return a Promise.
const mocks = vi.hoisted(() => ({
  publishToClients: vi.fn(),
  dispatchWebhooks: vi.fn(() => Promise.resolve()),
  chatProcessEvent: vi.fn(() => Promise.resolve()),
  ingestEvent: vi.fn(() => Promise.resolve()),
  notifyTransition: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn(), publishToClients: mocks.publishToClients },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/webhookDispatcher.js", () => ({
  dispatchWebhooks: mocks.dispatchWebhooks,
}));
vi.mock("../services/chatService.js", () => ({
  processEvent: mocks.chatProcessEvent,
}));
vi.mock("../services/automationEventService.js", () => ({
  ingestEvent: mocks.ingestEvent,
}));
vi.mock("../services/tasks/transition-emitter.js", () => ({
  notifyTransition: mocks.notifyTransition,
}));

// --- Shared fixtures ---
let habitatId: string;
let missionId: string;

const ACTOR: AuditActorRef = { type: "human", id: "user-1" };
const AUDIT_SOURCE: AuditSource = "rest_api";
const CAUSAL_CONTEXT = { root: { type: "request" as const, id: "req-1" } };

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  for (const m of Object.values(mocks)) m.mockClear();
  const habitat = habitatRepo.createHabitat({ name: "Dispatch Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  missionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "dispatch-mission",
    createdBy: "user-1",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
});

/** Seeds a `task_creation_attempts` row at `pending` for the ledger FK. */
function seedAttempt(id: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: missionId,
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      habitatId,
      state: "pending",
    })
    .run();
}

// ===========================================================================
// 0. Unregistered-adapter guard (MUST run before any registration — the
//    registry is a module-level singleton with no reset).
// ===========================================================================

describe("T11 default creation dispatch plan — unregistered adapters stall (no silent claimability)", () => {
  it("does NOT open the observation gate when adapters are unregistered (targets stall at attention)", async () => {
    // Adapters deliberately NOT registered — simulates flag-off / boot-before-
    // registration. The engine surfaces `adapter_not_registered` per target as
    // `attention`, so all-accepted is false and the Task stays UNAVAILABLE.
    // This is the no-silent-claimability guard.

    const prepared = prepareTaskPublication({
      habitatId,
      targetMissionId: missionId,
      title: "Unregistered Task",
      actor: ACTOR,
      auditSource: AUDIT_SOURCE,
      causalContext: CAUSAL_CONTEXT,
      initialEventAction: "created",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-unregistered");
    governTaskPublication({
      attemptId: "attempt-unregistered",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-unregistered",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });
    if (outcome?.outcome !== "published") throw new Error("publish failed");
    const eventId = outcome.publication.envelope.eventId;

    const result = await processEnvelopeDispatchWithClient(getDb(), "attempt-unregistered");

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") throw new Error("expected dispatched");
    // Observation NOT satisfiable — at least one target is non-accepted.
    expect(result.observation.outcome).toBe("not_satisfiable");

    const targets = getDb()
      .select()
      .from(taskCreationDispatchTargets)
      .where(eq(taskCreationDispatchTargets.eventId, eventId))
      .all();
    expect(targets).toHaveLength(6);
    // Every target stalled at `attention` (adapter_not_registered).
    expect(targets.every((t) => t.state === "attention")).toBe(true);

    // Attempt stays at observation — NOT claimable.
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, "attempt-unregistered"))
      .all()[0];
    expect(attempt.state).toBe("published_pending_observation");

    // FAILURE MODE (pre-fix): with zero targets the observation was vacuously
    // satisfied and the attempt advanced to `created` despite NO adapter ever
    // running — silent claimability with zero fan-out.
  });
});

// ===========================================================================
// 1. Default plan shape — 6 targets, pending, routing on habitatId.
// ===========================================================================

describe("T11 default creation dispatch plan — envelope shape", () => {
  it("publishes with exactly the 6 kernel-fixed targets when no dispatchPlan is supplied", () => {
    registerCreationDispatchAdapters();
    expect(areCreationDispatchAdaptersRegistered()).toBe(true);

    const prepared = prepareTaskPublication({
      habitatId,
      targetMissionId: missionId,
      title: "Default Plan Task",
      actor: ACTOR,
      auditSource: AUDIT_SOURCE,
      causalContext: CAUSAL_CONTEXT,
      initialEventAction: "created",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-shape");
    governTaskPublication({
      attemptId: "attempt-shape",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-shape",
        proposal: prepared.proposal,
        guard: prepared.guard,
        // NOTE: no dispatchPlan supplied — exercises the default.
      });
    });

    expect(outcome?.outcome).toBe("published");
    if (outcome?.outcome !== "published") return;

    // FAILURE MODE (pre-fix): dispatchTargets was [] because the default was
    // `input.dispatchPlan ?? []` and no caller supplied a plan.
    expect(outcome.publication.dispatchTargets).toHaveLength(6);

    const kinds = outcome.publication.dispatchTargets.map((t) => t.targetKind).sort();
    expect(kinds).toEqual([...CREATION_TARGET_KINDS].sort());

    for (const target of outcome.publication.dispatchTargets) {
      expect(target.targetKey).toBe(habitatId);
      expect(target.state).toBe("pending");
    }

    // Checkpoint stopped at observation (dispatch processing is T4A, not T3C).
    expect(outcome.publication.checkpoint.attempt.state).toBe("published_pending_observation");
  });

  it("still honors a caller-supplied dispatchPlan override (does not force the default)", () => {
    registerCreationDispatchAdapters();

    const prepared = prepareTaskPublication({
      habitatId,
      targetMissionId: missionId,
      title: "Override Plan Task",
      actor: ACTOR,
      auditSource: AUDIT_SOURCE,
      causalContext: CAUSAL_CONTEXT,
      initialEventAction: "created",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-override");
    governTaskPublication({
      attemptId: "attempt-override",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-override",
        proposal: prepared.proposal,
        guard: prepared.guard,
        dispatchPlan: [{ targetKind: "custom", targetKey: "custom-key" }],
      });
    });

    expect(outcome?.outcome).toBe("published");
    if (outcome?.outcome !== "published") return;
    expect(outcome.publication.dispatchTargets).toHaveLength(1);
    expect(outcome.publication.dispatchTargets[0].targetKind).toBe("custom");
  });
});

// ===========================================================================
// 2. THE LOAD-BEARING TEST — origin → envelope → 6 pending → adapters →
//    accepted → observation opens → attempt terminalizes to `created`.
// ===========================================================================

describe("T11 default creation dispatch plan — full dispatch lifecycle", () => {
  it("advances 6 targets to accepted via the registered adapters and opens the observation gate to created", async () => {
    registerCreationDispatchAdapters();

    const prepared = prepareTaskPublication({
      habitatId,
      targetMissionId: missionId,
      title: "Lifecycle Task",
      actor: ACTOR,
      auditSource: AUDIT_SOURCE,
      causalContext: CAUSAL_CONTEXT,
      initialEventAction: "created",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-lifecycle");
    governTaskPublication({
      attemptId: "attempt-lifecycle",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-lifecycle",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });
    if (outcome?.outcome !== "published") throw new Error("publish failed");
    const eventId = outcome.publication.envelope.eventId;
    const taskId = outcome.publication.task.id;

    // --- Pre-dispatch: all 6 targets pending. ---
    const pendingTargets = getDb()
      .select()
      .from(taskCreationDispatchTargets)
      .where(eq(taskCreationDispatchTargets.eventId, eventId))
      .all();
    expect(pendingTargets).toHaveLength(6);
    expect(pendingTargets.every((t) => t.state === "pending")).toBe(true);

    // --- Run the dispatch worker (mirrors the T4A processing loop). ---
    const result = await processEnvelopeDispatchWithClient(getDb(), "attempt-lifecycle");

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") throw new Error("expected dispatched");

    // 3. All 6 targets now accepted.
    const acceptedTargets = getDb()
      .select()
      .from(taskCreationDispatchTargets)
      .where(eq(taskCreationDispatchTargets.eventId, eventId))
      .all();
    expect(acceptedTargets).toHaveLength(6);
    expect(acceptedTargets.every((t) => t.state === "accepted")).toBe(true);

    // 4. Observation checkpoint advanced → attempt terminalized.
    expect(result.observation.outcome).toBe("advanced");
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, "attempt-lifecycle"))
      .all()[0];
    // No reservation requested → direct terminal to `created`.
    expect(attempt.state).toBe("created");

    // 5. Each registered adapter's underlying mechanism was actually invoked.
    //    client-stream:
    expect(mocks.publishToClients).toHaveBeenCalledWith(
      habitatId,
      expect.objectContaining({
        type: "task.created",
        data: expect.objectContaining({ id: taskId }),
      }),
    );
    // webhook:
    expect(mocks.dispatchWebhooks).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchWebhooks).toHaveBeenCalledWith(
      habitatId,
      expect.objectContaining({ type: "task.created" }),
    );
    // chat:
    expect(mocks.chatProcessEvent).toHaveBeenCalledTimes(1);
    expect(mocks.chatProcessEvent).toHaveBeenCalledWith(
      "task.created",
      habitatId,
      expect.any(Object),
    );
    // automation:
    expect(mocks.ingestEvent).toHaveBeenCalledTimes(1);
    expect(mocks.ingestEvent).toHaveBeenCalledWith(
      habitatId,
      expect.objectContaining({ type: "task.created" }),
    );
    // transition-subscriber:
    expect(mocks.notifyTransition).toHaveBeenCalledWith(
      expect.objectContaining({ taskId, action: "created", habitatId }),
    );
    // post-interceptor: verified implicitly by the post_interceptor target
    // reaching `accepted` — runPostInterceptors with zero enrolled plugins is
    // a clean no-op that the adapter reports as accepted. If it had thrown,
    // the target would be `attention` and the observation gate would NOT open.
  });
});
