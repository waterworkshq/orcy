import { describe, it, expect, vi, beforeEach } from "vitest";

let _watchersStore: Array<{ taskId: string; userId: string; createdAt: string }> = [];
let _selectResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _deleteRun = vi.fn();
let _insertRun = vi.fn();

function createMockDb() {
  const doInsert = () => {
    const chain = {
      values: (vals: Record<string, unknown>) => {
        _insertRun(vals);
        return chain;
      },
      onConflictDoNothing: () => chain,
      run: () => {},
    };
    return chain;
  };

  const doSelect = (columns?: Record<string, unknown>) => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      all: () => _selectResult,
      get: () => _selectGetResult,
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

  return { insert: () => doInsert(), select: () => doSelect(), delete: () => doDelete() };
}

vi.mock("../db/index.js", () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/schema/index.js", () => ({
  taskWatchers: {
    taskId: "task_id",
    userId: "user_id",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
    and: vi.fn((..._conditions: unknown[]) => ({ _type: "and" })),
    asc: vi.fn((_col: unknown) => ({ _type: "asc" })),
    desc: vi.fn((_col: unknown) => ({ _type: "desc" })),
  };
});

import {
  addWatcher,
  removeWatcher,
  isWatching,
  getWatchersForTask,
  getWatcherUserIdsForTask,
  getWatchedTasksForUser,
  removeWatchersForTask,
} from "../repositories/watcher.js";

describe("watcher repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _watchersStore = [];
    _selectResult = [];
    _selectGetResult = undefined;
    _deleteRun = vi.fn();
    _insertRun = vi.fn();
  });

  describe("addWatcher", () => {
    it("adds a watcher and returns the watcher object", () => {
      const result = addWatcher("task-1", "user-1");

      expect(result.taskId).toBe("task-1");
      expect(result.userId).toBe("user-1");
      expect(result.createdAt).toBeDefined();
      expect(_insertRun).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeWatcher", () => {
    it("removes existing watcher and returns true", () => {
      _selectGetResult = { taskId: "task-1", userId: "user-1", createdAt: "2025-01-01" };

      const result = removeWatcher("task-1", "user-1");

      expect(result).toBe(true);
      expect(_deleteRun).toHaveBeenCalled();
    });

    it("returns false when watcher does not exist", () => {
      _selectGetResult = undefined;

      const result = removeWatcher("task-1", "user-1");

      expect(result).toBe(false);
      expect(_deleteRun).not.toHaveBeenCalled();
    });
  });

  describe("isWatching", () => {
    it("returns true when user is watching", () => {
      _selectGetResult = { taskId: "task-1", userId: "user-1", createdAt: "2025-01-01" };

      const result = isWatching("task-1", "user-1");

      expect(result).toBe(true);
    });

    it("returns false when user is not watching", () => {
      _selectGetResult = undefined;

      const result = isWatching("task-1", "user-1");

      expect(result).toBe(false);
    });
  });

  describe("getWatchersForTask", () => {
    it("returns watchers for a task ordered by createdAt", () => {
      _selectResult = [
        { taskId: "task-1", userId: "user-1", createdAt: "2025-01-01" },
        { taskId: "task-1", userId: "user-2", createdAt: "2025-01-02" },
      ];

      const result = getWatchersForTask("task-1");

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe("user-1");
      expect(result[1].userId).toBe("user-2");
    });

    it("returns empty array when no watchers", () => {
      _selectResult = [];

      const result = getWatchersForTask("task-1");

      expect(result).toEqual([]);
    });
  });

  describe("getWatcherUserIdsForTask", () => {
    it("returns user IDs for task watchers", () => {
      _selectResult = [{ userId: "user-1" }, { userId: "user-2" }];

      const result = getWatcherUserIdsForTask("task-1");

      expect(result).toEqual(["user-1", "user-2"]);
    });

    it("returns empty array when no watchers", () => {
      _selectResult = [];

      const result = getWatcherUserIdsForTask("task-1");

      expect(result).toEqual([]);
    });
  });

  describe("getWatchedTasksForUser", () => {
    it("returns tasks watched by user ordered by createdAt desc", () => {
      _selectResult = [
        { taskId: "task-2", userId: "user-1", createdAt: "2025-02-01" },
        { taskId: "task-1", userId: "user-1", createdAt: "2025-01-01" },
      ];

      const result = getWatchedTasksForUser("user-1");

      expect(result).toHaveLength(2);
      expect(result[0].taskId).toBe("task-2");
    });

    it("returns empty array when user watches nothing", () => {
      _selectResult = [];

      const result = getWatchedTasksForUser("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("removeWatchersForTask", () => {
    it("removes all watchers for a task", () => {
      removeWatchersForTask("task-1");

      expect(_deleteRun).toHaveBeenCalled();
    });

    it("does not throw when no watchers exist", () => {
      expect(() => removeWatchersForTask("nonexistent")).not.toThrow();
    });
  });
});
