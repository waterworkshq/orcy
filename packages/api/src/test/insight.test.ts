import { describe, it, expect, vi, beforeEach } from "vitest";

let _insertRun = vi.fn();
let _updateRun = vi.fn();
let _selectAllResult: Array<Record<string, unknown>> = [];
let _getSelectResult: Record<string, unknown> | undefined = undefined;
let _selectGetResult: Record<string, unknown> | undefined = undefined;

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
    const isCount = columnsArg && "total" in columnsArg;
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      all: () => (isCount ? [{ total: _selectAllResult.length }] : _selectAllResult),
      get: () => _getSelectResult,
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
  return {
    insert: () => doInsert(),
    select: (arg?: Record<string, unknown>) => doSelect(arg),
    update: () => doUpdate(),
  };
}

const sqlMocks = vi.hoisted(() => {
  const join = vi.fn((_items: unknown[], _sep: unknown) => ({ _type: "sqlJoin" }));
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    _type: "sqlTemplate",
  }));
  (fn as any).join = join;
  return { sql: fn };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    count: vi.fn(() => ({ _type: "count" })),
    desc: vi.fn((_c) => ({ _type: "desc" })),
    sql: sqlMocks.sql,
  };
});

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return { ...actual, getDb: () => createMockDb() };
});

vi.mock("../db/schema/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/schema/index.js")>();
  return { ...actual };
});

vi.mock("uuid", () => ({ v4: vi.fn(() => "insight-uuid") }));

import {
  createInsight,
  getInsightById,
  getInsightsByHabitat,
  deactivateInsight,
  getRelevantInsights,
} from "../repositories/insight.js";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "insight-1",
    habitat_id: "habitat-1",
    source_pulse_id: null,
    source_mission: null,
    signal_type: "blocker",
    subject: "Test",
    body: "Body",
    relevance_tags: JSON.stringify(["tag1"]),
    promoted_by: "user-1",
    promoted_at: "2025-01-01",
    is_active: 1,
    created_at: "2025-01-01",
    ...overrides,
  };
}

describe("insight repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertRun = vi.fn();
    _updateRun = vi.fn();
    _selectAllResult = [];
    _getSelectResult = undefined;
    _selectGetResult = undefined;
  });

  describe("createInsight", () => {
    it("creates insight with defaults", () => {
      _selectAllResult = [makeRow({ id: "insight-uuid" })];
      const result = createInsight({
        habitatId: "habitat-1",
        signalType: "blocker",
        subject: "Test",
        promotedBy: "user-1",
      });
      expect(result.id).toBe("insight-uuid");
      expect(result.signalType).toBe("blocker");
      expect(result.isActive).toBeTruthy();
      expect(_insertRun).toHaveBeenCalled();
    });

    it("creates insight with optional fields", () => {
      _selectAllResult = [
        makeRow({
          id: "insight-uuid",
          source_pulse_id: "pulse-1",
          source_mission: "m1",
          body: "Custom body",
          relevance_tags: ["a", "b"],
        }),
      ];
      const result = createInsight({
        habitatId: "h1",
        signalType: "question",
        subject: "Q",
        body: "Custom body",
        sourcePulseId: "pulse-1",
        sourceMission: "m1",
        relevanceTags: ["a", "b"],
        promotedBy: "u1",
      });
      expect(result.body).toBe("Custom body");
      expect(result.relevanceTags).toEqual(["a", "b"]);
      expect(result.sourcePulseId).toBe("pulse-1");
    });
  });

  describe("getInsightById", () => {
    it("returns insight when found", () => {
      _selectAllResult = [makeRow()];
      const result = getInsightById("insight-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("insight-1");
    });
    it("returns null when not found", () => {
      _selectAllResult = [];
      expect(getInsightById("missing")).toBeNull();
    });
  });

  describe("getInsightsByHabitat", () => {
    it("returns insights with total", () => {
      _selectAllResult = [makeRow()];
      const result = getInsightsByHabitat("habitat-1");
      expect(result.insights).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("filters by signalType", () => {
      _selectAllResult = [makeRow({ signal_type: "question" })];
      const result = getInsightsByHabitat("habitat-1", { signalType: "question" });
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].signalType).toBe("question");
    });

    it("filters by isActive", () => {
      _selectAllResult = [];
      const result = getInsightsByHabitat("habitat-1", { isActive: false });
      expect(result.insights).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("deactivateInsight", () => {
    it("deactivates and returns true", () => {
      _selectAllResult = [makeRow()];
      expect(deactivateInsight("insight-1")).toBe(true);
      expect(_updateRun).toHaveBeenCalled();
    });
    it("returns false when insight not found", () => {
      _selectAllResult = [];
      expect(deactivateInsight("missing")).toBe(false);
      expect(_updateRun).not.toHaveBeenCalled();
    });
  });

  describe("getRelevantInsights", () => {
    it("returns empty when no tags", () => {
      expect(getRelevantInsights("h1", [])).toEqual([]);
    });
    it("returns matching insights", () => {
      _selectAllResult = [makeRow()];
      const result = getRelevantInsights("h1", ["tag1"]);
      expect(result).toHaveLength(1);
      expect(result[0].signalType).toBe("blocker");
    });
    it("returns empty when no matches", () => {
      _selectAllResult = [];
      const result = getRelevantInsights("h1", ["unknown"]);
      expect(result).toEqual([]);
    });
  });
});
