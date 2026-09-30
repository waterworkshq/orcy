import { describe, it, expect, vi, beforeEach } from "vitest";

let _insertRun = vi.fn();
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _countResult = 0;
let _updateReturningResult: Array<Record<string, unknown>> = [];
let _rawAllResult: Array<Record<string, unknown>> = [];

function createMockDb() {
  const doInsert = () => {
    const chain = {
      values: (vals: Record<string, unknown>) => {
        _insertRun(vals);
        return chain;
      },
      run: () => {},
    };
    return chain;
  };
  const doSelect = (columnsArg?: Record<string, unknown>) => {
    const isCount = columnsArg && "count" in columnsArg;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      all: () => _selectAllResult,
      get: () => (isCount ? { count: _countResult } : _selectGetResult),
    };
    return chain;
  };
  const doUpdate = () => {
    const chain: Record<string, unknown> = {
      set: () => chain,
      where: () => chain,
      run: () => {
        _updateRun();
      },
      returning: () => chain,
      all: () => _updateReturningResult,
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
    select: (arg?: Record<string, unknown>) => doSelect(arg),
    update: () => doUpdate(),
    delete: () => doDelete(),
    all: () => _rawAllResult,
  };
}

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return { ...actual, getDb: () => createMockDb() };
});

vi.mock("../db/schema/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/schema/index.js")>();
  return { ...actual };
});

const mentionMock = vi.hoisted(() => ({ getMentionsByCommentIds: vi.fn(() => []) }));
vi.mock("../repositories/commentMention.js", () => mentionMock);

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    desc: vi.fn((_c) => ({ _type: "desc" })),
    count: vi.fn(() => ({ _type: "count" })),
  };
});

vi.mock("uuid", () => ({ v4: vi.fn(() => "mock-comment-uuid") }));

import {
  createComment,
  createReplyComment,
  getCommentsByTaskId,
  getCommentById,
  updateComment,
  deleteComment,
  isCommentAuthor,
} from "../repositories/comment.js";

describe("comment repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertRun = vi.fn();
    _updateRun = vi.fn();
    _deleteRun = vi.fn();
    _selectAllResult = [];
    _selectGetResult = undefined;
    _countResult = 0;
    _updateReturningResult = [];
    _rawAllResult = [];
    (mentionMock.getMentionsByCommentIds as any).mockReturnValue([]);
  });

  describe("createComment", () => {
    it("creates comment and returns it", () => {
      _selectGetResult = {
        id: "mock-comment-uuid",
        taskId: "task-1",
        parentId: null,
        authorType: "human",
        authorId: "u1",
        content: "Hi",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };
      const result = createComment({
        taskId: "task-1",
        authorType: "human",
        authorId: "u1",
        content: "Hi",
      });
      expect(result.id).toBe("mock-comment-uuid");
      expect(result.taskId).toBe("task-1");
      expect(_insertRun).toHaveBeenCalled();
    });

    it("creates comment with parentId", () => {
      _selectGetResult = {
        id: "mock-comment-uuid",
        taskId: "task-1",
        parentId: "parent-1",
        authorType: "agent",
        authorId: "a1",
        content: "Reply",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };
      const result = createComment({
        taskId: "task-1",
        authorType: "agent",
        authorId: "a1",
        content: "Reply",
        parentId: "parent-1",
      });
      expect(result.parentId).toBe("parent-1");
    });
  });

  describe("getCommentById", () => {
    it("returns comment when found", () => {
      _selectGetResult = {
        id: "c1",
        taskId: "task-1",
        parentId: null,
        authorType: "human",
        authorId: "u1",
        content: "X",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };
      expect(getCommentById("c1")).not.toBeNull();
      expect(getCommentById("c1")!.id).toBe("c1");
    });
    it("returns null when not found", () => {
      _selectGetResult = undefined;
      expect(getCommentById("missing")).toBeNull();
    });
  });

  describe("getCommentsByTaskId", () => {
    it("returns comments with count", () => {
      _selectAllResult = [
        {
          id: "c1",
          taskId: "task-1",
          parentId: null,
          authorType: "human",
          authorId: "u1",
          content: "C1",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ];
      _countResult = 1;
      const result = getCommentsByTaskId("task-1");
      expect(result.comments).toHaveLength(1);
      expect(result.total).toBe(1);
    });
    it("returns zero when no comments", () => {
      _selectAllResult = [];
      _countResult = 0;
      const result = getCommentsByTaskId("empty");
      expect(result.comments).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("createReplyComment", () => {
    it("returns the matched reply row from the conditional INSERT", () => {
      _rawAllResult = [
        {
          id: "mock-comment-uuid",
          taskId: "task-1",
          parentId: "parent-1",
          authorType: "agent",
          authorId: "a1",
          content: "Reply",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ];
      const result = createReplyComment({
        taskId: "task-1",
        parentId: "parent-1",
        authorType: "agent",
        authorId: "a1",
        content: "Reply",
      });
      expect(result!.id).toBe("mock-comment-uuid");
      expect(result!.parentId).toBe("parent-1");
      expect((result as any).mentions).toEqual([]);
    });

    it("returns null on a zero-row conditional INSERT (parent missing or wrong task)", () => {
      _rawAllResult = [];
      expect(
        createReplyComment({
          taskId: "task-1",
          parentId: "gone",
          authorType: "agent",
          authorId: "a1",
          content: "Reply",
        }),
      ).toBeNull();
      // No unrestricted ID refetch fallback: the row lookup stays untouched.
      expect(_selectGetResult).toBeUndefined();
    });
  });

  describe("updateComment", () => {
    it("updates content through the required pair+typed-author predicate and returns the matched row", () => {
      _updateReturningResult = [
        {
          id: "c1",
          taskId: "task-1",
          parentId: null,
          authorType: "human",
          authorId: "u1",
          content: "Updated",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];
      const result = updateComment("task-1", "c1", "human", "u1", "Updated");
      expect(result!.content).toBe("Updated");
      expect((result as any).mentions).toEqual([]);
    });

    it("returns null on a zero-match (wrong task, author or absent comment)", () => {
      _updateReturningResult = [];
      expect(updateComment("task-1", "c1", "human", "u1", "Updated")).toBeNull();
    });
  });

  describe("deleteComment", () => {
    it("returns true when the fenced root DELETE matched", () => {
      _rawAllResult = [{ id: "c1" }];
      expect(deleteComment("task-1", "c1", "human", "u1")).toBe(true);
    });

    it("returns false on a zero-match (closure, pair or author mismatch)", () => {
      _rawAllResult = [];
      expect(deleteComment("task-1", "c1", "human", "u1")).toBe(false);
    });
  });

  describe("isCommentAuthor", () => {
    it("true on match", () => {
      _selectGetResult = { authorType: "human", authorId: "u1" };
      expect(isCommentAuthor("c1", "human", "u1")).toBe(true);
    });
    it("false on type mismatch", () => {
      _selectGetResult = { authorType: "agent", authorId: "a1" };
      expect(isCommentAuthor("c1", "human", "a1")).toBe(false);
    });
    it("false on id mismatch", () => {
      _selectGetResult = { authorType: "human", authorId: "u1" };
      expect(isCommentAuthor("c1", "human", "u2")).toBe(false);
    });
    it("false when not found", () => {
      _selectGetResult = undefined;
      expect(isCommentAuthor("c1", "human", "u1")).toBe(false);
    });
  });
});
