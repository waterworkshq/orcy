import { describe, it, expect, vi, beforeEach } from "vitest";

let _subtasksStore: Record<string, Record<string, unknown>> = {};
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _insertRun = vi.fn();

function createMockDb() {
  const doInsert = () => {
    const chain = {
      values: (vals: Record<string, unknown>) => {
        _insertRun(vals);
        _subtasksStore[String(vals.id)] = vals;
        return chain;
      },
      run: () => {},
    };
    return chain;
  };

  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      all: () => _selectAllResult,
      get: () => {
        // Return from store if available, otherwise from _selectGetResult
        return _selectGetResult;
      },
    };
    return chain;
  };

  const doUpdate = () => {
    const chain = {
      set: () => chain,
      where: () => chain,
      run: () => {
        _updateRun();
      },
    };
    return chain;
  };

  const doDelete = () => {
    const chain = {
      where: () => chain,
      run: () => {
        _deleteRun();
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
    delete: () => doDelete(),
  };
}

vi.mock("../db/index.js", () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/schema/index.js", () => ({
  taskSubtasks: {
    id: "id",
    taskId: "task_id",
    title: "title",
    completed: "completed",
    order: "order",
    assigneeId: "assignee_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
    sql: vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({ _type: "sql" })),
    inArray: vi.fn((_col: unknown, _vals: unknown[]) => ({ _type: "inArray" })),
    asc: vi.fn((_col: unknown) => ({ _type: "asc" })),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "subtask-uuid"),
}));

import {
  createSubtask,
  getSubtasksByTaskId,
  getSubtaskById,
  updateSubtask,
  deleteSubtask,
  getSubtaskCounts,
} from "../repositories/subtask.js";

describe("subtask repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _subtasksStore = {};
    _selectAllResult = [];
    _selectGetResult = undefined;
    _updateRun = vi.fn();
    _deleteRun = vi.fn();
    _insertRun = vi.fn();
  });

  describe("createSubtask", () => {
    it("creates a subtask with defaults", () => {
      _selectGetResult = {
        id: "subtask-uuid",
        taskId: "task-1",
        title: "New subtask",
        completed: false,
        order: 0,
        assigneeId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = createSubtask({ taskId: "task-1", title: "New subtask" });

      expect(result.id).toBe("subtask-uuid");
      expect(result.taskId).toBe("task-1");
      expect(result.title).toBe("New subtask");
      expect(result.completed).toBe(false);
      expect(result.order).toBe(0);
      expect(result.assigneeId).toBeNull();
      expect(result.createdAt).toBeDefined();
      expect(_insertRun).toHaveBeenCalled();
    });

    it("creates subtask with custom order and assignee", () => {
      _selectGetResult = {
        id: "subtask-uuid",
        taskId: "task-1",
        title: "Ordered",
        completed: false,
        order: 5,
        assigneeId: "agent-1",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = createSubtask({
        taskId: "task-1",
        title: "Ordered",
        order: 5,
        assigneeId: "agent-1",
      });

      expect(result.order).toBe(5);
      expect(result.assigneeId).toBe("agent-1");
    });
  });

  describe("getSubtasksByTaskId", () => {
    it("returns subtasks ordered by order", () => {
      _selectAllResult = [
        {
          id: "s1",
          taskId: "task-1",
          title: "First",
          completed: false,
          order: 0,
          assigneeId: null,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
        {
          id: "s2",
          taskId: "task-1",
          title: "Second",
          completed: true,
          order: 1,
          assigneeId: "agent-1",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ];

      const result = getSubtasksByTaskId("task-1");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
      expect(result[1].completed).toBe(true);
    });

    it("returns empty array when no subtasks", () => {
      _selectAllResult = [];

      const result = getSubtasksByTaskId("task-1");

      expect(result).toEqual([]);
    });
  });

  describe("getSubtaskById", () => {
    it("returns subtask when found", () => {
      _selectGetResult = {
        id: "s1",
        taskId: "task-1",
        title: "Found",
        completed: false,
        order: 0,
        assigneeId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = getSubtaskById("s1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("s1");
      expect(result!.title).toBe("Found");
    });

    it("returns null when not found", () => {
      _selectGetResult = undefined;

      const result = getSubtaskById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("updateSubtask", () => {
    it("updates title", () => {
      _selectGetResult = {
        id: "s1",
        taskId: "task-1",
        title: "Updated Title",
        completed: false,
        order: 0,
        assigneeId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      };

      const result = updateSubtask("s1", { title: "Updated Title" });

      expect(result).not.toBeNull();
      expect(result!.title).toBe("Updated Title");
      expect(_updateRun).toHaveBeenCalled();
    });

    it("updates completed status", () => {
      _selectGetResult = {
        id: "s1",
        taskId: "task-1",
        title: "Check",
        completed: true,
        order: 0,
        assigneeId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      };

      const result = updateSubtask("s1", { completed: true });

      expect(result!.completed).toBe(true);
      expect(_updateRun).toHaveBeenCalled();
    });

    it("updates assignee", () => {
      _selectGetResult = {
        id: "s1",
        taskId: "task-1",
        title: "Check",
        completed: false,
        order: 0,
        assigneeId: "agent-2",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      };

      const result = updateSubtask("s1", { assigneeId: "agent-2" });

      expect(result!.assigneeId).toBe("agent-2");
    });

    it("updates order", () => {
      _selectGetResult = {
        id: "s1",
        taskId: "task-1",
        title: "Check",
        completed: false,
        order: 10,
        assigneeId: null,
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      };

      const result = updateSubtask("s1", { order: 10 });

      expect(result!.order).toBe(10);
    });

    it("returns null when subtask disappears after update", () => {
      _selectGetResult = undefined;

      const result = updateSubtask("s1", { title: "Gone" });

      expect(result).toBeNull();
    });
  });

  describe("deleteSubtask", () => {
    it("deletes subtask and returns true", () => {
      const result = deleteSubtask("s1");

      expect(result).toBe(true);
      expect(_deleteRun).toHaveBeenCalled();
    });
  });

  describe("getSubtaskCounts", () => {
    it("returns counts per task", () => {
      _selectAllResult = [
        { taskId: "task-1", total: 3, completed: 2 },
        { taskId: "task-2", total: 1, completed: 0 },
      ];

      const result = getSubtaskCounts(["task-1", "task-2"]);

      expect(result).toEqual({
        "task-1": { total: 3, completed: 2 },
        "task-2": { total: 1, completed: 0 },
      });
    });

    it("returns empty object for empty input", () => {
      const result = getSubtaskCounts([]);

      expect(result).toEqual({});
    });

    it("returns empty object when no data found", () => {
      _selectAllResult = [];

      const result = getSubtaskCounts(["task-1"]);

      expect(result).toEqual({});
    });

    it("handles single task with all completed", () => {
      _selectAllResult = [{ taskId: "task-1", total: 5, completed: 5 }];

      const result = getSubtaskCounts(["task-1"]);

      expect(result["task-1"].total).toBe(5);
      expect(result["task-1"].completed).toBe(5);
    });
  });
});
