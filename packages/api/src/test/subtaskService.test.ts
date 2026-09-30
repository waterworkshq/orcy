import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/subtask.js", () => ({
  getSubtasksByTaskId: vi.fn(),
  getSubtaskById: vi.fn(),
  createSubtask: vi.fn(),
  updateSubtask: vi.fn(),
  deleteSubtask: vi.fn(),
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

import {
  getSubtasks,
  createSubtask,
  updateSubtask,
  deleteSubtask,
} from "../services/subtaskService.js";
import * as subtaskRepo from "../repositories/subtask.js";
import * as taskRepo from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

function makeSubtask(overrides: Record<string, unknown> = {}) {
  return {
    id: "subtask-1",
    taskId: "task-1",
    title: "Test subtask",
    completed: false,
    order: 0,
    assigneeId: null,
    createdAt: "2025-01-01",
    updatedAt: "2025-01-01",
    ...overrides,
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test task",
    status: "pending",
    ...overrides,
  };
}

describe("subtaskService", () => {
  beforeEach(() => {
    // Reset implementations AND results between cases, not only call
    // histories — a stale return from one case must never satisfy the
    // truthful-success assertions of the next.
    vi.resetAllMocks();
  });

  describe("getSubtasks", () => {
    it("returns subtasks with total and completed count", () => {
      vi.mocked(subtaskRepo.getSubtasksByTaskId).mockReturnValue([
        makeSubtask({ id: "s1", title: "Sub 1", completed: true }),
        makeSubtask({ id: "s2", title: "Sub 2", completed: false }),
        makeSubtask({ id: "s3", title: "Sub 3", completed: true }),
      ]);

      const result = getSubtasks("task-1");

      expect(result.total).toBe(3);
      expect(result.completedCount).toBe(2);
      expect(result.subtasks).toHaveLength(3);
      expect(result.subtasks[0].id).toBe("s1");
    });

    it("returns zero counts for empty subtask list", () => {
      vi.mocked(subtaskRepo.getSubtasksByTaskId).mockReturnValue([]);

      const result = getSubtasks("task-1");

      expect(result.total).toBe(0);
      expect(result.completedCount).toBe(0);
      expect(result.subtasks).toEqual([]);
    });
  });

  describe("createSubtask", () => {
    it("creates subtask when parent task exists", () => {
      vi.mocked(taskRepo.getTaskById).mockReturnValue(makeTask() as any);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("habitat-1");
      vi.mocked(subtaskRepo.createSubtask).mockReturnValue(makeSubtask({ id: "new-sub" }) as any);

      const result = createSubtask("task-1", { title: "New subtask" });

      expect(result).not.toBeNull();
      expect(result!.id).toBe("new-sub");
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "subtask.created" }),
      );
    });

    it("returns null when parent task does not exist", () => {
      vi.mocked(taskRepo.getTaskById).mockReturnValue(null);

      const result = createSubtask("missing-task", { title: "New subtask" });

      expect(result).toBeNull();
      expect(subtaskRepo.createSubtask).not.toHaveBeenCalled();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("does not broadcast when habitatId not found", () => {
      vi.mocked(taskRepo.getTaskById).mockReturnValue(makeTask() as any);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue(null);
      vi.mocked(subtaskRepo.createSubtask).mockReturnValue(makeSubtask() as any);

      const result = createSubtask("task-1", { title: "New subtask" });

      expect(result).not.toBeNull();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });

  describe("updateSubtask", () => {
    it("updates subtask when it exists under the required parent", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.updateSubtask).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1", title: "Updated", completed: true }) as any,
      );
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("habitat-1");

      const result = updateSubtask("task-1", "sub-1", { title: "Updated", completed: true });

      expect(result).not.toBeNull();
      expect(result!.title).toBe("Updated");
      expect(subtaskRepo.updateSubtask).toHaveBeenCalledWith("task-1", "sub-1", {
        title: "Updated",
        completed: true,
      });
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "subtask.updated" }),
      );
    });

    it("returns null and never writes when the child belongs to a different task", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-2" }) as any,
      );

      const result = updateSubtask("task-1", "sub-1", { title: "Nope" });

      expect(result).toBeNull();
      expect(subtaskRepo.updateSubtask).not.toHaveBeenCalled();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("returns null when subtask does not exist", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(null);

      const result = updateSubtask("task-1", "missing-sub", { title: "Nope" });

      expect(result).toBeNull();
      expect(subtaskRepo.updateSubtask).not.toHaveBeenCalled();
    });

    it("returns null when the final statement matches no row (zero match, no SSE)", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.updateSubtask).mockReturnValue(null);

      const result = updateSubtask("task-1", "sub-1", { title: "Updated" });

      expect(result).toBeNull();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("does not broadcast when habitat ancestry is not found", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.updateSubtask).mockReturnValue(makeSubtask() as any);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue(null);

      const result = updateSubtask("task-1", "sub-1", { title: "Updated" });

      expect(result).not.toBeNull();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });

  describe("deleteSubtask", () => {
    it("deletes the exact parent/child pair and broadcasts", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.deleteSubtask).mockReturnValue(true);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("habitat-1");

      const result = deleteSubtask("task-1", "sub-1");

      expect(result).toBe(true);
      expect(subtaskRepo.deleteSubtask).toHaveBeenCalledWith("task-1", "sub-1");
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "habitat-1",
        expect.objectContaining({ type: "subtask.deleted" }),
      );
    });

    it("returns false and never writes when the child belongs to a different task", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-2" }) as any,
      );

      const result = deleteSubtask("task-1", "sub-1");

      expect(result).toBe(false);
      expect(subtaskRepo.deleteSubtask).not.toHaveBeenCalled();
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("returns false when subtask does not exist", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(null);

      const result = deleteSubtask("task-1", "missing-sub");

      expect(result).toBe(false);
      expect(subtaskRepo.deleteSubtask).not.toHaveBeenCalled();
    });

    it("returns false when the final statement matches no row (no delete-side SSE)", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.deleteSubtask).mockReturnValue(false);

      const result = deleteSubtask("task-1", "sub-1");

      expect(result).toBe(false);
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });

    it("still deletes when habitat ancestry is not found", () => {
      vi.mocked(subtaskRepo.getSubtaskById).mockReturnValue(
        makeSubtask({ id: "sub-1", taskId: "task-1" }) as any,
      );
      vi.mocked(subtaskRepo.deleteSubtask).mockReturnValue(true);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue(null);

      const result = deleteSubtask("task-1", "sub-1");

      expect(result).toBe(true);
      expect(subtaskRepo.deleteSubtask).toHaveBeenCalledWith("task-1", "sub-1");
      expect(sseBroadcaster.publish).not.toHaveBeenCalled();
    });
  });
});
