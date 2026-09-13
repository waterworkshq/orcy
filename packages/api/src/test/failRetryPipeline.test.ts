import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * failTask → retry wiring (T2 receipt-driven rework).
 *
 * The restored slice moved the failed action's retry/escalation OFF the
 * transition emitter and INTO the `retry_ladder` effect receipt: the
 * emitter's non-required pass never triggers retry for receipt-owned events,
 * and the deliverer composes ETA + guarded task write + follow-up event +
 * ack in ONE transaction. These tests pin the new wiring at the unit seam
 * the emitter split exposes.
 */
import { emitTransition, emitTransitionNonRequired } from "../services/tasks/transition-emitter.js";
import * as retryService from "../services/retryService.js";
import { makeTask } from "./factories/task.js";

vi.mock("../services/tasks/transitionBudget.js", () => ({
  guardTransitionTop: vi.fn(() => ({ outcome: "allow", count: 0, ceiling: 12 })),
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getHabitatIdForTask: vi.fn(() => "habitat-1"),
  failTask: vi.fn(),
  getTasksByDependency: vi.fn(() => []),
  claimTask: vi.fn(),
}));

vi.mock("../repositories/mission.js", () => ({ getMissionById: vi.fn() }));
vi.mock("../repositories/agent.js", () => ({ getAgentById: vi.fn() }));
vi.mock("../repositories/event.js", () => ({ createEvent: vi.fn(), getEventById: vi.fn() }));
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: vi.fn() } }));
vi.mock("../services/watcherService.js", () => ({ notifyWatchers: vi.fn() }));
vi.mock("../services/retryService.js", () => ({
  shouldRetry: vi.fn(),
  scheduleRetry: vi.fn(),
  getEffectivePolicy: vi.fn(),
  escalateToHuman: vi.fn(),
  calculateBackoff: vi.fn(() => 60),
}));
vi.mock("../services/missionService.js", () => ({ recalculateMissionStatus: vi.fn() }));
vi.mock("../plugins/pluginManager.js", () => ({
  getDetectorEntry: vi.fn(() => null),
  registerDetectorHooks: vi.fn(),
  loadQuarantinesFromDb: vi.fn(),
  resetPlugins: vi.fn(),
}));
vi.mock("../services/pulseService.js", () => ({
  emitAutoSignal: vi.fn(),
  onPulseCreated: vi.fn(() => () => {}),
  broadcastPulse: vi.fn(),
  createPulseBatchAtomic: vi.fn(() => []),
}));

describe("failTask → retry wiring (receipt era)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the non-required emitter pass NEVER triggers the retry block", () => {
    const failedTask = makeTask({ status: "failed" as never });
    emitTransitionNonRequired("task-1", "failed", "habitat-1", {
      existingEventId: "ev-1",
      actorType: "agent",
      actorId: "agent-1",
      task: failedTask as never,
    });
    expect(retryService.shouldRetry).not.toHaveBeenCalled();
    expect(retryService.scheduleRetry).not.toHaveBeenCalled();
    expect(retryService.escalateToHuman).not.toHaveBeenCalled();
  });

  it("the FULL emitter (unopted actions, e.g. rejected) still triggers retry", () => {
    const rejectedTask = makeTask({ status: "rejected" as never });
    vi.mocked(retryService.shouldRetry).mockReturnValue(true);
    emitTransition("task-1", "rejected", "habitat-1", {
      actorType: "human",
      actorId: "rev-1",
      task: rejectedTask as never,
    });
    expect(retryService.shouldRetry).toHaveBeenCalled();
    expect(retryService.scheduleRetry).toHaveBeenCalled();
  });

  it("the full emitter without a retry policy and without escalation arms nothing", () => {
    const rejectedTask = makeTask({ status: "rejected" as never });
    vi.mocked(retryService.shouldRetry).mockReturnValue(false);
    vi.mocked(retryService.getEffectivePolicy).mockReturnValue(null);
    emitTransition("task-1", "rejected", "habitat-1", {
      actorType: "human",
      actorId: "rev-1",
      task: rejectedTask as never,
    });
    expect(retryService.scheduleRetry).not.toHaveBeenCalled();
    expect(retryService.escalateToHuman).not.toHaveBeenCalled();
  });
});
