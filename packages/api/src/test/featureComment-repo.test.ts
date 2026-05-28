import { describe, it, expect, vi, beforeEach } from "vitest";

let _insertRun = vi.fn();
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _countResult = 0;

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
    select: (arg?: Record<string, unknown>) => doSelect(arg),
    update: () => doUpdate(),
    delete: () => doDelete(),
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

const mentionMock = vi.hoisted(() => ({
  getMentionsByCommentIds: vi.fn(() => []),
}));

vi.mock("./featureCommentMention.js", () => mentionMock);

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
    desc: vi.fn((_col: unknown) => ({ _type: "desc" })),
    count: vi.fn(() => ({ _type: "count" })),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-comment-uuid"),
}));

import {
  createComment,
  getCommentsByMissionId,
  getCommentById,
  updateComment,
  deleteComment,
  isCommentAuthor,
} from "../repositories/featureComment.js";

describe("featureComment repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertRun = vi.fn();
    _updateRun = vi.fn();
    _deleteRun = vi.fn();
    _selectAllResult = [];
    _selectGetResult = undefined;
    _countResult = 0;
    (mentionMock.getMentionsByCommentIds as any).mockReturnValue([]);
  });

  describe("createComment", () => {
    it("creates comment and returns it", () => {
      _selectGetResult = {
        id: "mock-comment-uuid",
        missionId: "mission-1",
        parentId: null,
        authorType: "human",
        authorId: "user-1",
        content: "Hello",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = createComment({
        missionId: "mission-1",
        authorType: "human",
        authorId: "user-1",
        content: "Hello",
      });

      expect(result.id).toBe("mock-comment-uuid");
      expect(result.content).toBe("Hello");
      expect(_insertRun).toHaveBeenCalled();
    });

    it("creates comment with parentId", () => {
      _selectGetResult = {
        id: "mock-comment-uuid",
        missionId: "mission-1",
        parentId: "parent-1",
        authorType: "agent",
        authorId: "agent-1",
        content: "Reply",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = createComment({
        missionId: "mission-1",
        authorType: "agent",
        authorId: "agent-1",
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
        missionId: "mission-1",
        parentId: null,
        authorType: "human",
        authorId: "u1",
        content: "Test",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-01",
      };

      const result = getCommentById("c1");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("c1");
    });

    it("returns null when not found", () => {
      _selectGetResult = undefined;

      const result = getCommentById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getCommentsByMissionId", () => {
    it("returns comments with total count", () => {
      _selectAllResult = [
        {
          id: "c1",
          missionId: "mission-1",
          parentId: null,
          authorType: "human",
          authorId: "u1",
          content: "C1",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ];
      _countResult = 1;

      const result = getCommentsByMissionId("mission-1");

      expect(result.comments).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("returns zero count when no comments", () => {
      _selectAllResult = [];
      _countResult = 0;

      const result = getCommentsByMissionId("empty-mission");

      expect(result.comments).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("updateComment", () => {
    it("updates comment content", () => {
      _selectGetResult = {
        id: "c1",
        missionId: "mission-1",
        parentId: null,
        authorType: "human",
        authorId: "u1",
        content: "Updated",
        createdAt: "2025-01-01",
        updatedAt: "2025-01-02",
      };

      const result = updateComment("c1", "Updated");

      expect(result).not.toBeNull();
      expect(result!.content).toBe("Updated");
      expect(_updateRun).toHaveBeenCalled();
    });
  });

  describe("deleteComment", () => {
    it("deletes and returns true", () => {
      const result = deleteComment("c1");
      expect(result).toBe(true);
      expect(_deleteRun).toHaveBeenCalled();
    });
  });

  describe("isCommentAuthor", () => {
    it("returns true when author matches", () => {
      _selectGetResult = { authorType: "human", authorId: "user-1" };
      expect(isCommentAuthor("c1", "human", "user-1")).toBe(true);
    });

    it("returns false when type mismatches", () => {
      _selectGetResult = { authorType: "agent", authorId: "agent-1" };
      expect(isCommentAuthor("c1", "human", "agent-1")).toBe(false);
    });

    it("returns false when id mismatches", () => {
      _selectGetResult = { authorType: "human", authorId: "user-1" };
      expect(isCommentAuthor("c1", "human", "user-2")).toBe(false);
    });

    it("returns false when comment not found", () => {
      _selectGetResult = undefined;
      expect(isCommentAuthor("c1", "human", "user-1")).toBe(false);
    });
  });
});
