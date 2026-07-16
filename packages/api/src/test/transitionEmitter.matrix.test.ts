/**
 * Regression guard for the canonical single-owner SSE reset scheme.
 *
 * The activity-feed (events-infinite) reset is owned by exactly one SSE event
 * per task transition. On the backend, that ownership is asserted by
 * requiring that every transition which writes a `events` row also emits at
 * least one SSE event whose type is reset-owning for `eventsInfinite` per
 * `packages/ui/src/sse/registry.ts` — i.e. the handlers that route through
 * `projectTaskServer`/`taskServerHandler` and ultimately call
 * `resetEventsInfiniteForHabitat`.
 *
 * A transition that writes a habitat event row but emits neither
 * `task.updated` (when present) nor a sole-emission reset-owner
 * (`task.created` / `task.retry_scheduled`) would silently miss the reset;
 * this test fails when that happens.
 *
 * Additive-safety: `KNOWN_TASK_ACTIONS` mirrors the `TaskAction` union in
 * `transition-emitter.ts`. The `AssertNever<...>` constraint below proves the
 * mirror stays in sync; extending the union without updating this list
 * breaks the build at this file, forcing the test to be reviewed in lockstep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getTasksByDependency: vi.fn().mockReturnValue([]),
  areAllDependenciesMet: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

vi.mock("../services/watcherService.js", () => ({
  notifyWatchers: vi.fn(),
}));

vi.mock("../services/retryService.js", () => ({
  shouldRetry: vi.fn().mockReturnValue(false),
  scheduleRetry: vi.fn(),
  escalateToHuman: vi.fn(),
  getEffectivePolicy: vi.fn().mockReturnValue(null),
}));

vi.mock("../services/featureService.js", () => ({
  recalculateMissionStatus: vi.fn(),
}));

vi.mock("../services/pulseService.js", () => ({
  emitAutoSignal: vi.fn(),
}));

import * as eventRepo from "../repositories/event.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import {
  emitTransition,
  type TaskAction,
  type TransitionContext,
} from "../services/tasks/transition-emitter.js";
import type { Task } from "../models/index.js";

/**
 * SSE event types that call `resetEventsInfiniteForHabitat` on the UI side
 * (handlers using `projectTaskServer` / `taskServerHandler`). Mirrors the
 * canonical ownership documented in `packages/ui/src/sse/registry.ts`.
 * `task.moved` is reset-owning in the UI registry but is never emitted by
 * `transition-emitter`, so it is excluded here — the test only enumerates
 * types the transition-emitter can actually publish.
 */
const RESET_OWNING_SSE_TYPES = new Set<string>([
  "task.updated",
  "task.created",
  "task.deleted",
  "task.retry_scheduled",
]);

/**
 * Mirror of the `TaskAction` union in `transition-emitter.ts`. Keep in sync
 * with that union: see the `AssertNever` type alias below.
 */
const KNOWN_TASK_ACTIONS = [
  "claimed",
  "started",
  "submitted",
  "approved",
  "rejected",
  "completed",
  "released",
  "failed",
  "created",
  "updated",
  "deleted",
  "delegated",
  "claimed_delegated",
  "retry_scheduled",
  "retry_executed",
  "escalated",
] as const satisfies readonly TaskAction[];

// If a new TaskAction is added to `transition-emitter.ts` and this list is
// not updated in lockstep, the following resolves to a non-`never` union
// and TypeScript fails the build at this exact line. The associated
// iteration below is then also stale until the new action is covered.
type AssertNever<T extends never> = T;
type ExhaustiveCheck = AssertNever<
  Exclude<TaskAction, (typeof KNOWN_TASK_ACTIONS)[number]>
>;
// Runtime reference so the alias stays part of the type-check graph even
// if the project enables `noUnusedLocals`/`verbatimModuleSyntax` strictness.
const keepExhaustiveCheckAliased: ExhaustiveCheck = undefined as never;
void keepExhaustiveCheckAliased;

function makeTask(): Task {
  return {
    id: "task-1",
    title: "Sample task",
    description: null,
    status: "pending",
    priority: "medium",
    order: 0,
    columnId: "col-1",
    missionId: "mission-1",
    assignedAgentId: null,
    delegatedToAgentId: null,
    estimatedMinutes: null,
    actualMinutes: 0,
    result: null,
    labels: [],
    requiredDomain: null,
    requiredCapabilities: [],
    rejectionReason: null,
    retryCount: 0,
    nextRetryAt: null,
    isArchived: false,
    version: 1,
    createdBy: "user-1",
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
    claimedAt: null,
    completedAt: null,
  } as unknown as Task;
}

function publishedSseTypes(): string[] {
  const publishMock = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
  return publishMock.mock.calls.map((c) => (c[1] as { type: string }).type);
}

function createEventCallCount(): number {
  const createEventMock = eventRepo.createEvent as ReturnType<typeof vi.fn>;
  return createEventMock.mock.calls.length;
}

describe("TransitionEmitter: row-writing transitions emit a reset-owning SSE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const action of KNOWN_TASK_ACTIONS) {
    it(`action "${action}" satisfies the matrix contract`, () => {
      emitTransition("task-1", action, "hab-1", {
        actorType: "agent",
        actorId: "agent-1",
        newStatus: "in_progress",
        task: makeTask(),
      } satisfies TransitionContext);

      const types = new Set(publishedSseTypes());
      const writesEventRow = createEventCallCount() > 0;

      if (!writesEventRow) {
        // Non-row-writing transitions (only `deleted` per ACTION_EFFECTS) are
        // not in the reset-coverage matrix contract — assertions below would
        // be tautological. Defer to the existing emitter test for delete-side
        // guarantees (sole-emission of `task.deleted`).
        return;
      }

      const emitsResetOwner = [...RESET_OWNING_SSE_TYPES].some((t) => types.has(t));
      expect(
        emitsResetOwner,
        `row-writing transition "${action}" must emit ≥1 reset-owning SSE ` +
          `(got [${[...types].join(", ")}]; expected at least one of ` +
          `[${[...RESET_OWNING_SSE_TYPES].join(", ")}])`,
      ).toBe(true);
    });
  }
});

describe("TransitionEmitter: matrix sanity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only `deleted` is non-row-writing across the full transition surface", () => {
    const nonRowWriting: TaskAction[] = [];

    for (const action of KNOWN_TASK_ACTIONS) {
      emitTransition("task-1", action, "hab-1", {
        actorType: "agent",
        actorId: "agent-1",
        newStatus: "in_progress",
        task: makeTask(),
      } satisfies TransitionContext);

      if (createEventCallCount() === 0) {
        nonRowWriting.push(action);
      }
      vi.clearAllMocks();
    }

    expect(nonRowWriting).toEqual(["deleted"]);
  });
});
