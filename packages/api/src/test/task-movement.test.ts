import { beforeEach, describe, expect, it, vi } from "vitest";

const taskRepoMocks = vi.hoisted(() => ({
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));

const eventRepoMocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
}));

const ssePublishMock = vi.hoisted(() => vi.fn());

vi.mock("../repositories/task.js", () => taskRepoMocks);
vi.mock("../repositories/event.js", () => eventRepoMocks);
vi.mock("../sse/broadcaster.js", () => ({ sseBroadcaster: { publish: ssePublishMock } }));

import { moveTask, reorderTask } from "../services/tasks/task-movement.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Task",
    status: "claimed",
    missionId: "mission-1",
    artifacts: [],
    ...overrides,
  };
}

describe("task movement service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRepoMocks.getTaskById.mockReturnValue(makeTask());
    taskRepoMocks.updateTask.mockReturnValue({
      success: true,
      task: makeTask({ status: "in_progress" }),
    });
    taskRepoMocks.getHabitatIdForTask.mockReturnValue("habitat-1");
  });

  describe("moveTask", () => {
    it("returns null when the task does not exist", () => {
      taskRepoMocks.getTaskById.mockReturnValue(null);

      expect(moveTask("missing", "column-1", "user-1", "human", "in_progress")).toBeNull();
      expect(taskRepoMocks.updateTask).not.toHaveBeenCalled();
    });

    it("returns the current task without side effects when no status change is requested", () => {
      const current = makeTask({ status: "claimed" });
      taskRepoMocks.getTaskById.mockReturnValue(current);

      expect(moveTask("task-1", "column-1", "user-1", "human")).toBe(current);
      expect(taskRepoMocks.updateTask).not.toHaveBeenCalled();
      expect(eventRepoMocks.createEvent).not.toHaveBeenCalled();
      expect(ssePublishMock).not.toHaveBeenCalled();
    });

    it("returns null without emitting side effects when the status update fails", () => {
      taskRepoMocks.updateTask.mockReturnValue({ success: false, reason: "conflict" });

      expect(moveTask("task-1", "column-1", "agent-1", "agent", "in_progress")).toBeNull();
      expect(eventRepoMocks.createEvent).not.toHaveBeenCalled();
      expect(ssePublishMock).not.toHaveBeenCalled();
    });

    it("updates status, records the transition, and broadcasts the updated task", () => {
      const updated = makeTask({ status: "submitted" });
      taskRepoMocks.updateTask.mockReturnValue({ success: true, task: updated });

      const result = moveTask("task-1", "column-1", "agent-1", "agent", "submitted");

      expect(result).toBe(updated);
      expect(taskRepoMocks.updateTask).toHaveBeenCalledWith("task-1", { status: "submitted" });
      expect(eventRepoMocks.createEvent).toHaveBeenCalledWith({
        taskId: "task-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "updated",
        metadata: { changedFields: ["status"], fromStatus: "claimed", toStatus: "submitted" },
      });
      expect(ssePublishMock).toHaveBeenCalledWith("habitat-1", {
        type: "task.updated",
        data: updated,
      });
    });
  });

  describe("reorderTask", () => {
    it("currently returns the requested task without changing order", () => {
      const current = makeTask({ id: "task-2" });
      taskRepoMocks.getTaskById.mockReturnValue(current);

      expect(reorderTask("task-2", "column-1", "after-1", null)).toBe(current);
      expect(taskRepoMocks.updateTask).not.toHaveBeenCalled();
    });
  });
});
