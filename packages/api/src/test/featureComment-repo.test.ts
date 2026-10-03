import { describe, it, expect, vi, beforeEach } from "vitest";

let _insertRun = vi.fn();
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _rawAllResult: Array<Record<string, unknown>> = [];
let _rawAllCalls = 0;
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
      returning: () => chain,
      all: () => {
        _updateRun();
        return _selectAllResult;
      },
      run: () => {
        _updateRun();
      },
    };
    return chain;
  };
  const doDelete = () => {
    const chain = {
      where: () => chain,
      returning: () => chain,
      all: () => {
        _deleteRun();
        return _rawAllResult;
      },
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
    // Raw-SQL seam (conditional reply INSERT, cascade-fenced DELETE): the
    // matched rows this statement returned.
    all: () => {
      _rawAllCalls += 1;
      return _rawAllResult;
    },
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
    and: vi.fn((...conds: unknown[]) => ({ _type: "and", conds })),
    desc: vi.fn((_col: unknown) => ({ _type: "desc" })),
    count: vi.fn(() => ({ _type: "count" })),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-comment-uuid"),
}));

import {
  createComment,
  createReplyComment,
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
    _rawAllResult = [];
    _rawAllCalls = 0;
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

  describe("createReplyComment", () => {
    it("returns the row the conditional INSERT matched", () => {
      _rawAllResult = [
        {
          id: "mock-comment-uuid",
          missionId: "mission-1",
          parentId: "parent-1",
          authorType: "agent",
          authorId: "agent-1",
          content: "Reply",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-01",
        },
      ];

      const result = createReplyComment({
        missionId: "mission-1",
        parentId: "parent-1",
        authorType: "agent",
        authorId: "agent-1",
        content: "Reply",
      });

      expect(result!.id).toBe("mock-comment-uuid");
      expect(result!.parentId).toBe("parent-1");
    });

    it("returns null when the conditional INSERT matched no row", () => {
      _rawAllResult = [];
      expect(
        createReplyComment({
          missionId: "mission-1",
          parentId: "missing-parent",
          authorType: "human",
          authorId: "u1",
          content: "Reply",
        }),
      ).toBeNull();
    });
  });

  describe("updateComment", () => {
    it("returns the row the UPDATE matched", () => {
      _selectAllResult = [
        {
          id: "c1",
          missionId: "mission-1",
          parentId: null,
          authorType: "human",
          authorId: "u1",
          content: "Updated",
          createdAt: "2025-01-01",
          updatedAt: "2025-01-02",
        },
      ];

      const result = updateComment("mission-1", "c1", "human", "u1", "Updated");

      expect(result).not.toBeNull();
      expect(result!.content).toBe("Updated");
      expect(_updateRun).toHaveBeenCalled();
    });

    it("returns null when the UPDATE matched no row", () => {
      _selectAllResult = [];
      expect(updateComment("mission-1", "c1", "human", "u1", "Updated")).toBeNull();
    });
  });

  describe("deleteComment", () => {
    it("returns true when the DELETE returned the root row", () => {
      _rawAllResult = [{ id: "c1" }];
      expect(deleteComment("mission-1", "c1", "human", "u1")).toBe(true);
      // The fence lives in the final raw statement, so the raw seam — not the
      // drizzle DELETE builder — is what executed.
      expect(_rawAllCalls).toBe(1);
    });

    it("returns false when the DELETE matched no row", () => {
      _rawAllResult = [];
      expect(deleteComment("mission-1", "c1", "human", "u1")).toBe(false);
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
