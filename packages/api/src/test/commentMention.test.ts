import { describe, it, expect, vi, beforeEach } from "vitest";

let _mentionsStore: Record<string, Array<Record<string, unknown>>> = {};
let _insertRun = vi.fn();
let _selectAll = vi.fn();

function createMockDb() {
  const doInsert = () => {
    let _vals: Record<string, unknown> = {};
    const chain = {
      values: (vals: Record<string, unknown>) => {
        _vals = vals;
        return chain;
      },
      onConflictDoNothing: () => chain,
      run: () => {
        const key = String(_vals.commentId ?? "");
        if (!_mentionsStore[key]) _mentionsStore[key] = [];
        _mentionsStore[key].push({ ..._vals });
        _insertRun(_vals);
      },
    };
    return chain;
  };

  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      all: () => _selectAll(),
    };
    return chain;
  };

  return { insert: () => doInsert(), select: () => doSelect() };
}

vi.mock("../db/index.js", () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock("../db/schema/index.js", () => ({
  taskCommentMentions: {
    id: "id",
    commentId: "comment_id",
    mentionedType: "mentioned_type",
    mentionedId: "mentioned_id",
    mentionText: "mention_text",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    inArray: vi.fn((_col: unknown, _vals: unknown[]) => ({ _type: "inArray" })),
    asc: vi.fn((_col: unknown) => ({ _type: "asc" })),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid"),
}));

import { createMentions, getMentionsByCommentIds } from "../repositories/commentMention.js";

describe("commentMention repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mentionsStore = {};
    _selectAll = vi.fn(() => []);
    _insertRun = vi.fn();
  });

  describe("createMentions", () => {
    it("creates mentions and returns them with id and createdAt", () => {
      const input = [
        {
          commentId: "comment-1",
          mentionedType: "agent" as const,
          mentionedId: "agent-1",
          mentionText: "@helper",
        },
      ];

      const result = createMentions(input);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("mock-uuid");
      expect(result[0].commentId).toBe("comment-1");
      expect(result[0].mentionedType).toBe("agent");
      expect(result[0].mentionedId).toBe("agent-1");
      expect(result[0].mentionText).toBe("@helper");
      expect(result[0].createdAt).toBeDefined();
      expect(typeof result[0].createdAt).toBe("string");
      expect(_insertRun).toHaveBeenCalledTimes(1);
    });

    it("creates multiple mentions", () => {
      const input = [
        {
          commentId: "comment-1",
          mentionedType: "agent" as const,
          mentionedId: "agent-1",
          mentionText: "@helper",
        },
        {
          commentId: "comment-1",
          mentionedType: "human" as const,
          mentionedId: "user-2",
          mentionText: "@vikas",
        },
      ];

      const result = createMentions(input);

      expect(result).toHaveLength(2);
      expect(result[0].mentionedType).toBe("agent");
      expect(result[1].mentionedType).toBe("human");
      expect(result[1].mentionedId).toBe("user-2");
      expect(_insertRun).toHaveBeenCalledTimes(2);
    });

    it("returns empty array for empty input", () => {
      const result = createMentions([]);
      expect(result).toEqual([]);
      expect(_insertRun).not.toHaveBeenCalled();
    });

    it("handles multiple mentions across different comments", () => {
      const input = [
        {
          commentId: "comment-a",
          mentionedType: "human" as const,
          mentionedId: "u1",
          mentionText: "@a",
        },
        {
          commentId: "comment-b",
          mentionedType: "agent" as const,
          mentionedId: "a1",
          mentionText: "@b",
        },
      ];

      const result = createMentions(input);

      expect(result).toHaveLength(2);
      expect(Object.keys(_mentionsStore)).toHaveLength(2);
    });
  });

  describe("getMentionsByCommentIds", () => {
    it("returns mentions for given comment ids", () => {
      const mockMention = {
        id: "m1",
        commentId: "c1",
        mentionedType: "human",
        mentionedId: "u1",
        mentionText: "@user",
        createdAt: "2025-01-01",
      };

      _selectAll = vi.fn(() => [mockMention]);

      const result = getMentionsByCommentIds(["c1"]);

      expect(result).toHaveLength(1);
      expect(result[0].commentId).toBe("c1");
      expect(result[0].mentionedType).toBe("human");
    });

    it("returns empty array when no comment ids provided", () => {
      const result = getMentionsByCommentIds([]);
      expect(result).toEqual([]);
    });

    it("returns empty array when no mentions found", () => {
      _selectAll = vi.fn(() => []);
      const result = getMentionsByCommentIds(["nonexistent"]);
      expect(result).toEqual([]);
    });

    it("returns multiple mentions across comments", () => {
      _selectAll = vi.fn(() => [
        {
          id: "m1",
          commentId: "c1",
          mentionedType: "human",
          mentionedId: "u1",
          mentionText: "@a",
          createdAt: "2025-01-01",
        },
        {
          id: "m2",
          commentId: "c2",
          mentionedType: "agent",
          mentionedId: "a1",
          mentionText: "@b",
          createdAt: "2025-01-01",
        },
      ]);

      const result = getMentionsByCommentIds(["c1", "c2"]);
      expect(result).toHaveLength(2);
    });
  });
});
