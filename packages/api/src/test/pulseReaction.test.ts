import { describe, it, expect, vi, beforeEach } from "vitest";

let _selectAllResult: Array<Record<string, unknown>> = [];
let _insertRun = vi.fn();
let _deleteRun = vi.fn();
let _insertShouldThrow = false;

function createMockDb() {
  const doInsert = () => {
    const chain = {
      values: () => chain,
      run: () => {
        if (_insertShouldThrow) {
          const err = new Error("UNIQUE constraint failed: pulseReactions") as Error & {
            code: string;
            name: string;
          };
          err.name = "SqliteError";
          err.code = "SQLITE_CONSTRAINT_UNIQUE";
          throw err;
        }
        _insertRun();
      },
    };
    return chain;
  };

  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      groupBy: () => chain,
      all: () => _selectAllResult,
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
  pulseReactions: {
    id: "id",
    pulseId: "pulse_id",
    reactorType: "reactor_type",
    reactorId: "reactor_id",
    reaction: "reaction",
    createdAt: "created_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: "eq" })),
    and: vi.fn((..._conditions: unknown[]) => ({ _type: "and" })),
    count: vi.fn(() => ({ _type: "count" })),
  };
});

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-reaction-uuid"),
}));

import {
  toggleReaction,
  getReactionCounts,
  getReactionsByPulse,
} from "../repositories/pulseReaction.js";

describe("pulseReaction repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _selectAllResult = [];
    _insertRun = vi.fn();
    _deleteRun = vi.fn();
    _insertShouldThrow = false;
  });

  describe("toggleReaction", () => {
    it("adds reaction when none exist", () => {
      _selectAllResult = [];

      const result = toggleReaction({
        pulseId: "pulse-1",
        reactorType: "human",
        reactorId: "user-1",
        reaction: "seen",
      });

      expect(result.added).toBe(true);
      expect(_insertRun).toHaveBeenCalled();
      expect(_deleteRun).not.toHaveBeenCalled();
    });

    it("removes reaction when it already exists (toggle off)", () => {
      _selectAllResult = [{ id: "r1", pulseId: "pulse-1" }];

      const result = toggleReaction({
        pulseId: "pulse-1",
        reactorType: "human",
        reactorId: "user-1",
        reaction: "seen",
      });

      expect(result.added).toBe(false);
      expect(_deleteRun).toHaveBeenCalled();
      expect(_insertRun).not.toHaveBeenCalled();
    });

    it("handles race condition — returns false when insert throws", () => {
      _selectAllResult = [];
      _insertShouldThrow = true;

      const result = toggleReaction({
        pulseId: "pulse-1",
        reactorType: "human",
        reactorId: "user-1",
        reaction: "ack",
      });

      expect(result.added).toBe(false);
      expect(_deleteRun).toHaveBeenCalled();
    });

    it("toggles for agent reactor type", () => {
      _selectAllResult = [];

      const result = toggleReaction({
        pulseId: "pulse-1",
        reactorType: "agent",
        reactorId: "agent-1",
        reaction: "question",
      });

      expect(result.added).toBe(true);
    });
  });

  describe("getReactionCounts", () => {
    it("returns zero counts when no reactions", () => {
      _selectAllResult = [];

      const result = getReactionCounts("pulse-1");

      expect(result).toEqual({ seen: 0, ack: 0, question: 0 });
    });

    it("returns counts for each reaction type", () => {
      _selectAllResult = [
        { reaction: "seen", total: 3 },
        { reaction: "ack", total: 1 },
      ];

      const result = getReactionCounts("pulse-1");

      expect(result.seen).toBe(3);
      expect(result.ack).toBe(1);
      expect(result.question).toBe(0);
    });

    it("returns all counts when all types present", () => {
      _selectAllResult = [
        { reaction: "seen", total: 5 },
        { reaction: "ack", total: 2 },
        { reaction: "question", total: 1 },
      ];

      const result = getReactionCounts("pulse-1");

      expect(result).toEqual({ seen: 5, ack: 2, question: 1 });
    });
  });

  describe("getReactionsByPulse", () => {
    it("returns reactions for a pulse", () => {
      _selectAllResult = [
        {
          id: "r1",
          pulseId: "pulse-1",
          reactorType: "human",
          reactorId: "user-1",
          reaction: "seen",
          createdAt: "2025-01-01",
        },
      ];

      const result = getReactionsByPulse("pulse-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("r1");
      expect(result[0].pulseId).toBe("pulse-1");
      expect(result[0].reactorType).toBe("human");
      expect(result[0].reaction).toBe("seen");
    });

    it("returns empty array when no reactions", () => {
      _selectAllResult = [];

      const result = getReactionsByPulse("pulse-1");

      expect(result).toEqual([]);
    });
  });
});
