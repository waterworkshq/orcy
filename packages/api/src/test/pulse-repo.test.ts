import { describe, it, expect, vi, beforeEach } from "vitest";

let _insertValues: Record<string, unknown> = {};
let _insertReturnAll: Array<Record<string, unknown>> = [];
let _selectAllResult: Array<Record<string, unknown>> = [];
let _selectAllQueue: Array<Array<Record<string, unknown>>> = [];
let _selectGetResult: Record<string, unknown> | undefined = undefined;
let _selectSingleResult: Record<string, unknown> | undefined = undefined;
let _selectCountResult = 0;
let _updateRun = vi.fn();
let _deleteRun = vi.fn();
let _insertRun = vi.fn();

type DbChain = Record<string, unknown>;

function createMockDb() {
  const doInsert = () => {
    const chain: DbChain = {
      values: (vals: Record<string, unknown>) => {
        _insertValues = { ...vals };
        _insertRun(vals);
        return chain;
      },
      returning: () => chain,
      onConflictDoUpdate: () => chain,
      run: () => {},
      all: () => _insertReturnAll,
    };
    return chain;
  };
  const doSelect = () => {
    const chain: DbChain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      groupBy: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      all: () => (_selectAllQueue.length ? _selectAllQueue.shift()! : _selectAllResult),
      get: () => _selectGetResult,
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

vi.mock("../db/index.js", () => ({ getDb: () => createMockDb() }));
vi.mock("../db/schema/index.js", () => ({
  pulses: {
    id: "id",
    missionId: "mission_id",
    habitatId: "habitat_id",
    scope: "scope",
    fromType: "from_type",
    fromId: "from_id",
    toType: "to_type",
    toId: "to_id",
    signalType: "signal_type",
    subject: "subject",
    body: "body",
    taskId: "task_id",
    replyToId: "reply_to_id",
    linkedTaskId: "linked_task_id",
    metadata: "metadata",
    createdAt: "created_at",
    pinned: "pinned",
    isAuto: "is_auto",
  },
  pulseCursors: {
    scopeKey: "scope_key",
    readerType: "reader_type",
    readerId: "reader_id",
    scope: "scope",
    lastCheckedAt: "last_checked_at",
  },
}));

const sqlMocks = vi.hoisted(() => {
  const join = vi.fn((_items: unknown[], _sep: unknown) => ({ _type: "sqlJoin" }));
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({
    _type: "sqlTemplate",
  }));
  (fn as any).join = join;
  return { sql: fn };
});

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    or: vi.fn((..._c) => ({ _type: "or" })),
    gt: vi.fn((_c, _v) => ({ _type: "gt" })),
    count: vi.fn(() => ({ _type: "count" })),
    desc: vi.fn((_c) => ({ _type: "desc" })),
    inArray: vi.fn((_c, _v) => ({ _type: "inArray" })),
    sql: sqlMocks.sql,
  };
});

vi.mock("uuid", () => ({ v4: vi.fn(() => "pulse-uuid") }));

import {
  createPulse,
  getPulseById,
  getPulsesByMission,
  getPulsesByHabitat,
  getPulseCountsByMission,
  deletePulse,
  getHighlightPulses,
  getLatestSummaryPulse,
  getNewPulseCount,
  getReplies,
  updateLinkedTask,
  getCursor,
  updateCursor,
  getPulseDigest,
  getHabitatPulseDigest,
} from "../repositories/pulse.js";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    mission_id: "m1",
    habitat_id: "h1",
    scope: "mission",
    from_type: "agent",
    from_id: "a1",
    to_type: "agent",
    to_id: "a2",
    signal_type: "blocker",
    subject: "Test",
    body: "Body",
    task_id: "t1",
    reply_to_id: null,
    linked_task_id: null,
    metadata: "{}",
    created_at: "2025-01-01T00:00:00Z",
    pinned: 0,
    is_auto: 0,
    ...overrides,
  };
}

describe("pulse repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _insertValues = {};
    _insertReturnAll = [];
    _selectAllResult = [];
    _selectAllQueue = [];
    _selectGetResult = undefined;
    _selectSingleResult = undefined;
    _selectCountResult = 0;
    _updateRun = vi.fn();
    _deleteRun = vi.fn();
    _insertRun = vi.fn();
  });

  describe("createPulse", () => {
    const validMissionInput = {
      scope: "mission" as const,
      missionId: "m1",
      habitatId: "h1",
      signalType: "blocker" as const,
      subject: "S",
      fromType: "agent" as const,
      fromId: "a1",
    };

    it("creates mission-scoped pulse", () => {
      _insertReturnAll = [makeRow()];
      const r = createPulse(validMissionInput);
      expect(r.id).toBe("p1");
      expect(r.signalType).toBe("blocker");
      expect(r.missionId).toBe("m1");
      expect(_insertRun).toHaveBeenCalled();
    });

    it("creates mission-scoped pulse with v0.20 experience signalType", () => {
      _insertReturnAll = [
        makeRow({ signal_type: "experience", metadata: '{"implicit":true,"experience":"stuck"}' }),
      ];
      const r = createPulse({
        ...validMissionInput,
        signalType: "experience",
        metadata: { implicit: true, experience: "stuck" },
      });
      expect(r.signalType).toBe("experience");
      expect(_insertValues).toEqual(expect.objectContaining({ signalType: "experience" }));
    });

    it("throws when mission scope missing missionId", () => {
      expect(() =>
        createPulse({
          scope: "mission",
          signalType: "blocker",
          subject: "X",
          fromType: "agent",
          fromId: "a1",
        } as any),
      ).toThrow("missionId is required");
    });

    it("throws when habitat scope has missionId", () => {
      expect(() =>
        createPulse({
          scope: "habitat",
          habitatId: "h1",
          missionId: "m1",
          signalType: "blocker",
          subject: "X",
          fromType: "agent",
          fromId: "a1",
        } as any),
      ).toThrow("missionId must not be provided for habitat-scoped signals");
    });

    it("throws when habitat scope missing habitatId", () => {
      expect(() =>
        createPulse({
          scope: "habitat",
          signalType: "blocker",
          subject: "X",
          fromType: "agent",
          fromId: "a1",
        } as any),
      ).toThrow("habitatId is required");
    });

    it("falls back to getPulseById when returning() is empty", () => {
      _insertReturnAll = [];
      _selectAllResult = [makeRow({ id: "pulse-uuid" })];
      const r = createPulse(validMissionInput);
      expect(r.id).toBe("pulse-uuid");
    });

    it("validates defaults are applied", () => {
      _insertReturnAll = [makeRow({ pinned: 0, is_auto: 0, body: "" })];
      const r = createPulse(validMissionInput);
      expect(r.body).toBe("");
      expect(r.createdAt).toBeDefined();
    });
  });

  describe("getPulseById", () => {
    it("returns pulse when found", () => {
      _selectAllResult = [makeRow()];
      expect(getPulseById("p1")?.id).toBe("p1");
    });
    it("returns null when not found", () => {
      _selectAllResult = [];
      expect(getPulseById("x")).toBeNull();
    });
  });

  describe("getPulsesByMission", () => {
    it("filters by signalType", () => {
      _selectAllResult = [makeRow({ signal_type: "question" })];
      _selectGetResult = { total: 1 };
      const r = getPulsesByMission("m1", { signalType: "question" });
      expect(r.pulses[0].signalType).toBe("question");
    });
    it("returns experience-signal pulses (v0.20 widening)", () => {
      _selectAllResult = [makeRow({ signal_type: "experience" })];
      _selectGetResult = { total: 1 };
      const r = getPulsesByMission("m1", { signalType: "experience" });
      expect(r.pulses[0].signalType).toBe("experience");
    });
    it("returns empty when no pulses", () => {
      _selectAllResult = [];
      _selectGetResult = { total: 0 };
      const r = getPulsesByMission("m1");
      expect(r.pulses).toEqual([]);
      expect(r.total).toBe(0);
    });
  });

  describe("getPulsesByHabitat", () => {
    it("returns habitat pulses", () => {
      _selectAllQueue = [[{ total: 1 }], [makeRow({ scope: "habitat" })]];
      const r = getPulsesByHabitat("h1");
      expect(r.pulses).toHaveLength(1);
      expect(r.total).toBe(1);
    });
  });

  describe("getPulseCountsByMission", () => {
    it("returns zeroed counts when empty", () => {
      _selectAllResult = [];
      const r = getPulseCountsByMission("m1");
      expect(r.finding).toBe(0);
      expect(r.blocker).toBe(0);
      expect(r.question).toBe(0);
      expect(r.experience).toBe(0);
    });
    it("returns correct counts", () => {
      _selectAllResult = [
        { signalType: "blocker", total: 3 },
        { signalType: "question", total: 1 },
        { signalType: "experience", total: 2 },
      ];
      const r = getPulseCountsByMission("m1");
      expect(r.blocker).toBe(3);
      expect(r.question).toBe(1);
      expect(r.experience).toBe(2);
      expect(r.finding).toBe(0);
    });
  });

  describe("deletePulse", () => {
    it("deletes existing pulse and returns true", () => {
      _selectAllResult = [makeRow()];
      expect(deletePulse("p1")).toBe(true);
      expect(_deleteRun).toHaveBeenCalled();
    });
    it("returns false when pulse not found", () => {
      _selectAllResult = [];
      expect(deletePulse("x")).toBe(false);
    });
  });

  describe("getHighlightPulses", () => {
    it("returns top directive/blocker pulses", () => {
      _selectAllResult = [makeRow({ signal_type: "blocker" })];
      const r = getHighlightPulses("m1");
      expect(r).toHaveLength(1);
      expect(r[0].signalType).toBe("blocker");
    });
    it("includes targeted pulses with reader info", () => {
      _selectAllResult = [makeRow({ signal_type: "directive" })];
      const r = getHighlightPulses("m1", "human", "u1");
      expect(r).toHaveLength(1);
    });
    it("returns empty when no highlights", () => {
      _selectAllResult = [];
      expect(getHighlightPulses("m1")).toEqual([]);
    });
  });

  describe("getLatestSummaryPulse", () => {
    it("returns latest non-auto pulse", () => {
      _selectAllResult = [makeRow()];
      expect(getLatestSummaryPulse("m1")?.id).toBe("p1");
    });
    it("returns null when no non-auto pulses", () => {
      _selectAllResult = [];
      expect(getLatestSummaryPulse("m1")).toBeNull();
    });
  });

  describe("getNewPulseCount", () => {
    it("returns count since timestamp", () => {
      _selectAllResult = [{ total: 5 }];
      expect(getNewPulseCount("m1", "2025-01-01T00:00:00Z")).toBe(5);
    });
  });

  describe("getReplies", () => {
    it("returns replies ordered by newest", () => {
      _selectAllResult = [makeRow({ id: "p2", reply_to_id: "p1" })];
      expect(getReplies("p1")).toHaveLength(1);
      expect(getReplies("p1")[0].id).toBe("p2");
    });
  });

  describe("updateLinkedTask", () => {
    it("updates linked task on pulse", () => {
      updateLinkedTask("p1", "t1");
      expect(_updateRun).toHaveBeenCalled();
    });
  });

  describe("getCursor", () => {
    it("returns lastCheckedAt when cursor exists", () => {
      _selectAllResult = [{ lastCheckedAt: "2025-01-01T00:00:00Z" }];
      expect(getCursor("m1", "human", "u1")).toBe("2025-01-01T00:00:00Z");
    });
    it("returns null when no cursor", () => {
      _selectGetResult = undefined;
      expect(getCursor("m1", "human", "u1")).toBeNull();
    });
  });

  describe("updateCursor", () => {
    it("upserts cursor", () => {
      updateCursor("m1", "human", "u1", "mission");
      expect(_insertRun).toHaveBeenCalled();
    });
  });

  describe("getPulseDigest", () => {
    it("builds digest with zero new signals", () => {
      _selectAllQueue = [[], [{ total: 0 }], [], [], []];
      const digest = getPulseDigest("m1", "human", "u1");
      expect(digest.newSinceLastCheck).toBe(0);
      expect(digest.highlights).toEqual([]);
      expect(digest.summary).toBe("No signals yet.");
      expect(_insertRun).toHaveBeenCalled(); // updateCursor
    });

    it("builds digest with signals present", () => {
      _selectAllQueue = [
        [],
        [{ total: 3 }],
        [{ signalType: "blocker", total: 3 }],
        [makeRow({ signal_type: "blocker", id: "highlight-pulse" })],
        [makeRow({ signal_type: "context", subject: "Summary item" })],
      ];
      const digest = getPulseDigest("m1", "human", "u1");
      expect(digest.newSinceLastCheck).toBe(3);
      expect(digest.counts.blocker).toBe(3);
      expect(digest.highlights[0].id).toBe("highlight-pulse");
      expect(digest.summary).toBe("Summary item. 3 more signals.");
    });
  });
});
