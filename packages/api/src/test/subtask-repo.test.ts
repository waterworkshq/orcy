import { describe, it, expect, vi, beforeEach } from "vitest";

let _subtasksStore: Record<string, Record<string, unknown>> = {};
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
// Statement-returned row arrays, modeled INDEPENDENTLY from _selectGetResult:
// the required-parent UPDATE/DELETE RETURNING result is the only success
// signal, so zero-match is an explicitly empty array here.
let updateReturning: Array<Record<string, unknown>> = [];
let deleteReturning: Array<Record<string, unknown>> = [];
let lastSet: Record<string, unknown> | undefined = undefined;
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
      set: (vals: Record<string, unknown>) => {
        lastSet = vals;
        return chain;
      },
      where: () => chain,
      returning: () => ({
        all: () => updateReturning,
      }),
    };
    return chain;
  };

  const doDelete = () => {
    const chain = {
      where: () => chain,
      returning: () => ({
        all: () => deleteReturning,
      }),
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
    and: vi.fn((..._conds: unknown[]) => ({ _type: "and" })),
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
    updateReturning = [];
    deleteReturning = [];
    lastSet = undefined;
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
    it("updates title under the required parent and returns the matched RETURNING row", () => {
      updateReturning = [
        {
          id: "s1",
          taskId: "task-1",
          title: "Updated Title",
          completed: false,
          order: 0,
          assigneeId: null,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      const result = updateSubtask("task-1", "s1", { title: "Updated Title" });

      expect(result).not.toBeNull();
      expect(result!.title).toBe("Updated Title");
      expect(lastSet).toMatchObject({ title: "Updated Title", updatedAt: expect.any(String) });
    });

    it("updates completed status", () => {
      updateReturning = [
        {
          id: "s1",
          taskId: "task-1",
          title: "Check",
          completed: true,
          order: 0,
          assigneeId: null,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      const result = updateSubtask("task-1", "s1", { completed: true });

      expect(result!.completed).toBe(true);
      expect(lastSet).toMatchObject({ completed: true });
    });

    it("updates assignee", () => {
      updateReturning = [
        {
          id: "s1",
          taskId: "task-1",
          title: "Check",
          completed: false,
          order: 0,
          assigneeId: "agent-2",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      const result = updateSubtask("task-1", "s1", { assigneeId: "agent-2" });

      expect(result!.assigneeId).toBe("agent-2");
      expect(lastSet).toMatchObject({ assigneeId: "agent-2" });
    });

    it("updates order", () => {
      updateReturning = [
        {
          id: "s1",
          taskId: "task-1",
          title: "Check",
          completed: false,
          order: 10,
          assigneeId: null,
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      const result = updateSubtask("task-1", "s1", { order: 10 });

      expect(result!.order).toBe(10);
      expect(lastSet).toMatchObject({ order: 10 });
    });

    it("maps only supplied fields — absent fields are never written", () => {
      updateReturning = [
        {
          id: "s1",
          taskId: "task-1",
          title: "Untouched",
          completed: true,
          order: 3,
          assigneeId: "agent-9",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      updateSubtask("task-1", "s1", { completed: false });

      expect(lastSet).toEqual({ completed: false, updatedAt: expect.any(String) });
    });

    it("returns null when the required-parent statement matches no row (no post-write refetch)", () => {
      // Zero-match (absent child or child under another parent) is an empty
      // RETURNING — the obsolete post-UPDATE refetch characterization is gone.
      updateReturning = [];

      const result = updateSubtask("task-1", "s1", { title: "Gone" });

      expect(result).toBeNull();
    });
  });

  describe("deleteSubtask", () => {
    it("deletes the exact parent/child pair and returns true from the returned ID", () => {
      deleteReturning = [{ id: "s1" }];

      const result = deleteSubtask("task-1", "s1");

      expect(result).toBe(true);
    });

    it("returns false when the required-parent statement returns no ID (zero match)", () => {
      deleteReturning = [];

      const result = deleteSubtask("task-1", "s1");

      expect(result).toBe(false);
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
