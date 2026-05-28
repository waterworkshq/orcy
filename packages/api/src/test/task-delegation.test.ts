import { beforeEach, describe, expect, it, vi } from "vitest";

const taskRepoMocks = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  getHabitatIdForTask: vi.fn(),
  claimDelegatedTask: vi.fn(),
}));

const agentRepoMocks = vi.hoisted(() => ({
  getAgentById: vi.fn(),
}));

const eventRepoMocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
}));

const ssePublishMock = vi.hoisted(() => vi.fn());
const watcherMocks = vi.hoisted(() => ({ notifyWatchers: vi.fn() }));
const missionServiceMocks = vi.hoisted(() => ({ recalculateMissionStatus: vi.fn() }));

vi.mock("../repositories/task.js", () => taskRepoMocks);
vi.mock("../repositories/agent.js", () => agentRepoMocks);
vi.mock("../repositories/event.js", () => eventRepoMocks);
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: ssePublishMock } }));
vi.mock("../services/watcherService.js", () => watcherMocks);
vi.mock("../services/featureService.js", () => missionServiceMocks);

import { claimDelegatedTask, delegateTask } from "../services/tasks/task-delegation.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    missionId: "mission-1",
    title: "Task",
    status: "claimed",
    assignedAgentId: "agent-from",
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    artifacts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-to",
    name: "Target Agent",
    domain: "backend",
    capabilities: ["typescript"],
    ...overrides,
  };
}

describe("task delegation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRepoMocks.getTaskById.mockReturnValue(makeTask());
    taskRepoMocks.updateTask.mockReturnValue({
      success: true,
      task: makeTask({ delegatedToAgentId: "agent-to" }),
    });
    taskRepoMocks.getHabitatIdForTask.mockReturnValue("habitat-1");
    taskRepoMocks.claimDelegatedTask.mockReturnValue({
      success: true,
      task: makeTask({ assignedAgentId: "agent-to" }),
    });
    agentRepoMocks.getAgentById.mockReturnValue(makeAgent());
  });

  describe("delegateTask", () => {
    it("rejects delegation when the requester is not the assigned owner", () => {
      taskRepoMocks.getTaskById.mockReturnValue(makeTask({ assignedAgentId: "other-agent" }));

      const result = delegateTask("task-1", "agent-from", "agent-to");

      expect(result).toEqual({
        success: false,
        reason: "not_owner",
        message: "Only the assigned agent can delegate this task",
      });
      expect(taskRepoMocks.updateTask).not.toHaveBeenCalled();
      expect(eventRepoMocks.createEvent).not.toHaveBeenCalled();
    });

    it("rejects target agents that lack required capabilities", () => {
      taskRepoMocks.getTaskById.mockReturnValue(
        makeTask({ requiredCapabilities: ["typescript", "docker"] }),
      );
      agentRepoMocks.getAgentById.mockReturnValue(makeAgent({ capabilities: ["TypeScript"] }));

      const result = delegateTask("task-1", "agent-from", "agent-to");

      expect(result).toEqual({
        success: false,
        reason: "capability_mismatch",
        message: "Target agent lacks required capabilities: docker",
      });
      expect(taskRepoMocks.updateTask).not.toHaveBeenCalled();
    });

    it("allows fullstack agents to receive domain-specific delegated work and emits events", () => {
      taskRepoMocks.getTaskById.mockReturnValue(
        makeTask({ requiredDomain: "backend", status: "in_progress" }),
      );
      agentRepoMocks.getAgentById.mockReturnValue(makeAgent({ domain: "fullstack" }));

      const result = delegateTask("task-1", "agent-from", "agent-to", "handoff");

      expect(result.success).toBe(true);
      expect(taskRepoMocks.updateTask).toHaveBeenCalledWith("task-1", {
        delegatedToAgentId: "agent-to",
      });
      expect(eventRepoMocks.createEvent).toHaveBeenCalledWith({
        taskId: "task-1",
        actorType: "agent",
        actorId: "agent-from",
        action: "delegated",
        metadata: { toAgentId: "agent-to", reason: "handoff" },
      });
      expect(ssePublishMock).toHaveBeenCalledWith("habitat-1", {
        type: "task.delegated",
        data: { taskId: "task-1", fromAgentId: "agent-from", toAgentId: "agent-to" },
      });
      expect(ssePublishMock).toHaveBeenCalledWith("habitat-1", {
        type: "task.updated",
        data: makeTask({ delegatedToAgentId: "agent-to" }),
      });
    });
  });

  describe("claimDelegatedTask", () => {
    it("validates the claiming agent when capabilities are required", () => {
      taskRepoMocks.getTaskById.mockReturnValue(makeTask({ requiredCapabilities: ["python"] }));
      agentRepoMocks.getAgentById.mockReturnValue(makeAgent({ capabilities: ["typescript"] }));

      const result = claimDelegatedTask("task-1", "agent-to");

      expect(result).toEqual({
        success: false,
        reason: "capability_mismatch",
        message: "Agent lacks required capabilities: python",
      });
      expect(taskRepoMocks.claimDelegatedTask).not.toHaveBeenCalled();
    });

    it("records a delegated claim and notifies watchers after repository success", () => {
      const claimedTask = makeTask({ assignedAgentId: "agent-to", status: "claimed" });
      taskRepoMocks.claimDelegatedTask.mockReturnValue({ success: true, task: claimedTask });

      const result = claimDelegatedTask("task-1", "agent-to");

      expect(result).toEqual({ success: true, task: claimedTask });
      expect(eventRepoMocks.createEvent).toHaveBeenCalledWith({
        taskId: "task-1",
        actorType: "agent",
        actorId: "agent-to",
        action: "claimed",
        toStatus: "claimed",
        metadata: { delegatedClaim: true },
      });
      expect(ssePublishMock).toHaveBeenCalledWith("habitat-1", {
        type: "task.claimed",
        data: { taskId: "task-1", agentId: "agent-to" },
      });
      expect(watcherMocks.notifyWatchers).toHaveBeenCalledWith(
        "task-1",
        "habitat-1",
        "task.claimed",
      );
      expect(missionServiceMocks.recalculateMissionStatus).toHaveBeenCalledWith("mission-1");
    });
  });
});
