/**
 * T10A Milestone 3 — Manifest Domain Handlers (validate / prepare / resolveReferences).
 *
 * Tests the PURE three-phase pipeline for each of the 8 portable domains.
 * Covers:
 *
 *   - validate: shape, reference-shape, forbidden-field absence (C4)
 *   - prepare: PURITY (no DB writes; spy on getDb), IDEMPOTENCY
 *   - resolveReferences: sourceId → serverId rewrite; unresolved accumulate
 *   - dependencies: cycle detection (acyclic passes; self-loop rejects;
 *     multi-node cycle rejects with the cycle named in the error)
 *
 * Out of scope: `apply` (T10B), the orchestrator (M4), the v3 zod schema
 * (M4), the import-attempt reservation (M4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the `getDb` import BEFORE the handlers load. The handlers must NOT
// call getDb, but we want a hard guarantee — a spy that throws if touched.
vi.mock("../db/db.js", () => ({
  getDb: vi.fn(() => {
    throw new Error("PURE HANDLER VIOLATION: getDb() called from a domain handler");
  }),
}));

import {
  habitatSettingsHandler,
} from "../services/importManifest/domainHandlers/habitatSettings.js";
import {
  columnsHandler,
} from "../services/importManifest/domainHandlers/columns.js";
import {
  missionsHandler,
} from "../services/importManifest/domainHandlers/missions.js";
import {
  tasksHandler,
} from "../services/importManifest/domainHandlers/tasks.js";
import {
  subtasksHandler,
} from "../services/importManifest/domainHandlers/subtasks.js";
import {
  dependenciesHandler,
} from "../services/importManifest/domainHandlers/dependencies.js";
import {
  commentsHandler,
} from "../services/importManifest/domainHandlers/comments.js";
import {
  templatesHandler,
} from "../services/importManifest/domainHandlers/templates.js";
import type { DomainEnvelope, DomainDisposition } from "../services/importManifest/types.js";
import type {
  ManifestContext,
  CrossDomainState,
} from "../services/importManifest/domainHandler.js";
import { createIdentityMap } from "../services/importManifest/domainHandler.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal but realistic per the M1 portable shapes.
// ---------------------------------------------------------------------------

function envelope<T>(data: T): DomainEnvelope<T> {
  return { disposition: "replace" as DomainDisposition, data };
}

function baseCtx(overrides: Partial<ManifestContext> = {}): ManifestContext {
  return {
    habitatId: null,
    mode: "new",
    identityPolicy: "remap",
    existingHabitatSnapshot: null,
    actor: { type: "human", id: "user-1" },
    auditSource: "rest_api",
    ...overrides,
  };
}

function ctxWithEnvelopes(
  crossDomainState: CrossDomainState,
  overrides: Partial<ManifestContext> = {},
): ManifestContext {
  return baseCtx({ ...overrides, crossDomainState });
}

// ---------------------------------------------------------------------------
// habitatSettings
// ---------------------------------------------------------------------------

describe("habitatSettings handler", () => {
  const goodSettings = {
    sourceId: "habitat-1",
    name: "Test Habitat",
    description: "A test",
    settings: { theme: "dark" },
  };

  it("validates a well-formed habitatSettings envelope", () => {
    const idMap = createIdentityMap();
    const result = habitatSettingsHandler.validate(envelope(goodSettings), baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated.sourceId).toBe("habitat-1");
      expect(result.validated.name).toBe("Test Habitat");
    }
  });

  it("accumulates ALL shape errors (never first-error)", () => {
    const idMap = createIdentityMap();
    const result = habitatSettingsHandler.validate(
      envelope({ sourceId: 0, name: "", description: 42, settings: null }),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // At least one error per missing field.
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
      const kinds = result.errors.map((e) => e.kind);
      expect(kinds).toContain("invalid_source_id");
      expect(kinds).toContain("invalid_name");
      expect(kinds).toContain("invalid_description");
      expect(kinds).toContain("invalid_settings");
    }
  });

  it("rejects C4 forbidden fields (defensive — adapter should have stripped)", () => {
    const idMap = createIdentityMap();
    const result = habitatSettingsHandler.validate(
      envelope({ ...goodSettings, version: 2, exportedAt: "now" }),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("forbidden_field_present");
    }
  });

  it("prepare is PURE (does not touch getDb) and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { sourceId: "habitat-1", name: "x", description: "", settings: {} };
    const p1 = habitatSettingsHandler.prepare(validated, baseCtx(), idMap);
    const p2 = habitatSettingsHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.habitatServerId).toBe(p2.habitatServerId);
    expect(idMap.sourceToServer.size).toBe(1);
  });

  it("resolveReferences is a structural no-op (root domain)", () => {
    const idMap = createIdentityMap();
    const prepared = habitatSettingsHandler.prepare(
      { sourceId: "h1", name: "x", description: "", settings: {} },
      baseCtx(),
      idMap,
    );
    const result = habitatSettingsHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// columns
// ---------------------------------------------------------------------------

describe("columns handler", () => {
  const goodCol = {
    sourceId: "col-a",
    name: "Todo",
    order: 0,
    color: null,
    wipLimit: null,
    nextColumnName: null,
    isTerminal: false,
  };

  it("validates a single column", () => {
    const idMap = createIdentityMap();
    const result = columnsHandler.validate(envelope([goodCol]), baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated.columns).toHaveLength(1);
      expect(result.validated.columns[0].name).toBe("Todo");
    }
  });

  it("rejects duplicate column names", () => {
    const idMap = createIdentityMap();
    const result = columnsHandler.validate(
      envelope([
        goodCol,
        { ...goodCol, sourceId: "col-b", order: 1 },
      ]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("duplicate_column_name");
    }
  });

  it("rejects unresolvable nextColumnName", () => {
    const idMap = createIdentityMap();
    const result = columnsHandler.validate(
      envelope([{ ...goodCol, nextColumnName: "Ghost" }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolvable_next_column_name");
    }
  });

  it("rejects nextColumnName chain cycle (a → b → a)", () => {
    const idMap = createIdentityMap();
    const result = columnsHandler.validate(
      envelope([
        { ...goodCol, sourceId: "col-a", name: "A", nextColumnName: "B" },
        { ...goodCol, sourceId: "col-b", name: "B", order: 1, nextColumnName: "A" },
      ]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => e.kind === "next_column_chain_cycle");
      expect(cycleErr).toBeDefined();
      // Cycle path names both columns + loops back.
      expect(cycleErr!.cyclePath).toBeDefined();
      expect(cycleErr!.cyclePath!.length).toBe(3);
    }
  });

  it("detects a 3-node chain cycle (a → b → c → a)", () => {
    const idMap = createIdentityMap();
    const result = columnsHandler.validate(
      envelope([
        { ...goodCol, sourceId: "col-a", name: "A", nextColumnName: "B" },
        { ...goodCol, sourceId: "col-b", name: "B", order: 1, nextColumnName: "C" },
        {
          ...goodCol,
          sourceId: "col-c",
          name: "C",
          order: 2,
          nextColumnName: "A",
          isTerminal: true,
        },
      ]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => e.kind === "next_column_chain_cycle");
      expect(cycleErr).toBeDefined();
      expect(cycleErr!.cyclePath!.length).toBe(4); // A,B,C,A
    }
  });

  it("prepare is PURE and IDEMPOTENT — same sourceId reuses server id", () => {
    const idMap = createIdentityMap();
    const validated = { columns: [{ ...goodCol }] };
    const p1 = columnsHandler.prepare(validated, baseCtx(), idMap);
    const p2 = columnsHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.columns[0].columnServerId).toBe(p2.columns[0].columnServerId);
  });

  it("resolveReferences rewrites nextColumnName → nextColumnServerId", () => {
    const idMap = createIdentityMap();
    const validated = {
      columns: [
        { ...goodCol, sourceId: "col-a", name: "A", nextColumnName: "B" },
        { ...goodCol, sourceId: "col-b", name: "B", order: 1, nextColumnName: null },
      ],
    };
    const prepared = columnsHandler.prepare(validated, baseCtx(), idMap);
    const result = columnsHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // First column's nextColumnServerId == second column's columnServerId
      expect(result.resolved.columns[0].nextColumnServerId).toBe(
        result.resolved.columns[1].columnServerId,
      );
      expect(result.resolved.columns[1].nextColumnServerId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// missions
// ---------------------------------------------------------------------------

describe("missions handler", () => {
  const goodMission = {
    sourceId: "m1",
    title: "M1",
    description: "d",
    acceptanceCriteria: "ac",
    priority: "high" as const,
    labels: [],
    columnName: "Todo",
    dependsOnSourceIds: [],
    blocksSourceIds: [],
    dueAt: null,
  };

  const colsEnvelope = envelope([{
    sourceId: "col-todo",
    name: "Todo",
    order: 0,
    color: null,
    wipLimit: null,
    nextColumnName: null,
    isTerminal: false,
  }]);

  it("validates a well-formed mission with columnName resolved via columnsEnvelope", () => {
    const idMap = createIdentityMap();
    const result = missionsHandler.validate(
      envelope([goodMission]),
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unknown columnName", () => {
    const idMap = createIdentityMap();
    const result = missionsHandler.validate(
      envelope([{ ...goodMission, columnName: "GhostCol" }]),
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolvable_column_name");
    }
  });

  it("rejects unknown dependsOnSourceId", () => {
    const idMap = createIdentityMap();
    const result = missionsHandler.validate(
      envelope([{ ...goodMission, dependsOnSourceIds: ["ghost-mission"] }]),
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolved_depends_on_source_id");
    }
  });

  it("rejects unknown blocksSourceId", () => {
    const idMap = createIdentityMap();
    const result = missionsHandler.validate(
      envelope([{ ...goodMission, blocksSourceIds: ["ghost-mission"] }]),
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolved_blocks_source_id");
    }
  });

  it("rejects invalid priority", () => {
    const idMap = createIdentityMap();
    const result = missionsHandler.validate(
      envelope([{ ...goodMission, priority: "urgent" as never }]),
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_priority");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { missions: [goodMission] };
    const p1 = missionsHandler.prepare(validated, baseCtx(), idMap);
    const p2 = missionsHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.missions[0].missionServerId).toBe(p2.missions[0].missionServerId);
  });

  it("resolveReferences rewrites columnName and dependsOn/blocks", () => {
    // Two missions: m1 and m2; m2 depends on m1.
    const idMap = createIdentityMap();
    // Prepare the columns domain first so its sourceId is in the idMap.
    columnsHandler.prepare(
      { columns: [colsEnvelope.data[0]] },
      baseCtx(),
      idMap,
    );
    const validated = {
      missions: [
        goodMission,
        { ...goodMission, sourceId: "m2", title: "M2", dependsOnSourceIds: ["m1"], blocksSourceIds: [] },
      ],
    };
    const prepared = missionsHandler.prepare(validated, baseCtx(), idMap);
    const result = missionsHandler.resolveReferences(
      prepared,
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.missions[0].columnServerId).toBe(
        idMap.sourceToServer.get("col-todo"),
      );
      expect(result.resolved.missions[0].dependsOnServerIds).toEqual([]);
      expect(result.resolved.missions[1].dependsOnServerIds).toEqual([
        result.resolved.missions[0].missionServerId,
      ]);
    }
  });

  it("resolveReferences accumulates unresolved references", () => {
    const idMap = createIdentityMap();
    const validated = { missions: [{ ...goodMission, dependsOnSourceIds: ["ghost"] }] };
    const prepared = missionsHandler.prepare(validated, baseCtx(), idMap);
    const result = missionsHandler.resolveReferences(
      prepared,
      ctxWithEnvelopes({ columnsEnvelope: colsEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolved_depends_on_source_id");
    }
  });
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

describe("tasks handler", () => {
  const goodTask = {
    sourceId: "t1",
    missionSourceId: "m1",
    title: "T1",
    description: "d",
    priority: "high" as const,
    requiredDomain: null,
    requiredCapabilities: [],
  };

  it("validates a well-formed task", () => {
    const idMap = createIdentityMap();
    const result = tasksHandler.validate(envelope([goodTask]), baseCtx(), idMap);
    expect(result.ok).toBe(true);
  });

  it("rejects empty missionSourceId shape", () => {
    const idMap = createIdentityMap();
    const result = tasksHandler.validate(
      envelope([{ ...goodTask, missionSourceId: "" }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_mission_source_id");
    }
  });

  it("rejects C4 execution-state forbidden fields (defensive)", () => {
    const idMap = createIdentityMap();
    const result = tasksHandler.validate(
      envelope([{
        ...goodTask,
        status: "in_progress",
        result: "x",
        artifacts: [],
        assignedAgentId: "a1",
        rejectedCount: 1,
        rejectionReason: "x",
        retryCount: 1,
        createdAt: "now",
      }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("forbidden_field_present");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { tasks: [goodTask] };
    const p1 = tasksHandler.prepare(validated, baseCtx(), idMap);
    const p2 = tasksHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.tasks[0].taskServerId).toBe(p2.tasks[0].taskServerId);
  });

  it("resolveReferences rewrites missionSourceId → missionServerId", () => {
    const idMap = createIdentityMap();
    // Pre-populate idMap with a mission server id.
    idMap.sourceToServer.set("m1", "mission-server-1");
    const validated = { tasks: [goodTask] };
    const prepared = tasksHandler.prepare(validated, baseCtx(), idMap);
    expect(prepared.tasks[0].taskServerId).toBeTruthy();
    // prepared[0].missionServerId should NOT yet be resolved — prepare uses the validated shape.
    expect(prepared.tasks[0].missionServerId).toBeNull();
    const result = tasksHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.tasks[0].missionServerId).toBe("mission-server-1");
    }
  });

  it("resolveReferences accumulates unresolved mission references", () => {
    const idMap = createIdentityMap();
    const validated = { tasks: [goodTask] };
    const prepared = tasksHandler.prepare(validated, baseCtx(), idMap);
    const result = tasksHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("unresolved_mission_source_id");
    }
  });
});

// ---------------------------------------------------------------------------
// subtasks
// ---------------------------------------------------------------------------

describe("subtasks handler", () => {
  const goodSub = {
    sourceId: "s1",
    taskSourceId: "t1",
    title: "S1",
    order: 0,
    completed: false,
    assigneeId: null,
  };

  it("validates a well-formed subtask", () => {
    const idMap = createIdentityMap();
    const result = subtasksHandler.validate(envelope([goodSub]), baseCtx(), idMap);
    expect(result.ok).toBe(true);
  });

  it("rejects non-integer order", () => {
    const idMap = createIdentityMap();
    const result = subtasksHandler.validate(
      envelope([{ ...goodSub, order: -1 }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_order");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { subtasks: [goodSub] };
    const p1 = subtasksHandler.prepare(validated, baseCtx(), idMap);
    const p2 = subtasksHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.subtasks[0].subtaskServerId).toBe(p2.subtasks[0].subtaskServerId);
  });

  it("resolveReferences rewrites taskSourceId → taskServerId", () => {
    const idMap = createIdentityMap();
    idMap.sourceToServer.set("t1", "task-server-1");
    const validated = { subtasks: [goodSub] };
    const prepared = subtasksHandler.prepare(validated, baseCtx(), idMap);
    const result = subtasksHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.subtasks[0].taskServerId).toBe("task-server-1");
    }
  });
});

// ---------------------------------------------------------------------------
// dependencies (graph-heavy)
// ---------------------------------------------------------------------------

describe("dependencies handler", () => {
  const goodEdge = {
    sourceId: "e1",
    taskSourceId: "t1",
    dependsOnTaskSourceId: "t2",
    kind: "blocks" as const,
  };

  const tasksEnvelope = envelope([{
    sourceId: "t1",
    missionSourceId: "m1",
    title: "T1",
    description: "",
    priority: "high" as const,
    requiredDomain: null,
    requiredCapabilities: [],
  }, {
    sourceId: "t2",
    missionSourceId: "m1",
    title: "T2",
    description: "",
    priority: "high" as const,
    requiredDomain: null,
    requiredCapabilities: [],
  }, {
    sourceId: "t3",
    missionSourceId: "m1",
    title: "T3",
    description: "",
    priority: "high" as const,
    requiredDomain: null,
    requiredCapabilities: [],
  }]);

  it("validates an acyclic task graph", () => {
    const idMap = createIdentityMap();
    const result = dependenciesHandler.validate(
      envelope([goodEdge]),
      ctxWithEnvelopes({ tasksEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects self-loop (task depends on itself)", () => {
    const idMap = createIdentityMap();
    const result = dependenciesHandler.validate(
      envelope([{ ...goodEdge, taskSourceId: "t1", dependsOnTaskSourceId: "t1" }]),
      ctxWithEnvelopes({ tasksEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const selfLoop = result.errors.find((e) => e.kind === "self_loop");
      expect(selfLoop).toBeDefined();
      expect(selfLoop!.cyclePath).toBeDefined();
    }
  });

  it("rejects 2-node task graph cycle (t1 → t2 → t1)", () => {
    const idMap = createIdentityMap();
    const result = dependenciesHandler.validate(
      envelope([
        { sourceId: "e1", taskSourceId: "t1", dependsOnTaskSourceId: "t2", kind: "blocks" as const },
        { sourceId: "e2", taskSourceId: "t2", dependsOnTaskSourceId: "t1", kind: "blocks" as const },
      ]),
      ctxWithEnvelopes({ tasksEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => e.kind === "cycle_detected");
      expect(cycleErr).toBeDefined();
      // Cycle path names both tasks + loops back.
      expect(cycleErr!.cyclePath!.length).toBe(3);
      // Cycle labels include the task prefix.
      expect(cycleErr!.cyclePath!.every((seg) => seg.startsWith("task["))).toBe(true);
    }
  });

  it("rejects 3-node task graph cycle (t1 → t2 → t3 → t1) and names the cycle", () => {
    const idMap = createIdentityMap();
    const result = dependenciesHandler.validate(
      envelope([
        { sourceId: "e1", taskSourceId: "t1", dependsOnTaskSourceId: "t2", kind: "blocks" as const },
        { sourceId: "e2", taskSourceId: "t2", dependsOnTaskSourceId: "t3", kind: "blocks" as const },
        { sourceId: "e3", taskSourceId: "t3", dependsOnTaskSourceId: "t1", kind: "blocks" as const },
      ]),
      ctxWithEnvelopes({ tasksEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErr = result.errors.find((e) => e.kind === "cycle_detected");
      expect(cycleErr).toBeDefined();
      // Cycle path names t1,t2,t3,t1.
      expect(cycleErr!.cyclePath!.length).toBe(4);
    }
  });

  it("rejects mission-level dependsOn cycle (reads missionsEnvelope)", () => {
    const idMap = createIdentityMap();
    const missionsEnv = envelope([{
      sourceId: "m1",
      title: "M1",
      description: "",
      acceptanceCriteria: "",
      priority: "high" as const,
      labels: [],
      columnName: "Todo",
      dependsOnSourceIds: ["m2"],
      blocksSourceIds: [],
      dueAt: null,
    }, {
      sourceId: "m2",
      title: "M2",
      description: "",
      acceptanceCriteria: "",
      priority: "high" as const,
      labels: [],
      columnName: "Todo",
      dependsOnSourceIds: ["m1"],
      blocksSourceIds: [],
      dueAt: null,
    }]);
    const result = dependenciesHandler.validate(
      envelope([]),
      ctxWithEnvelopes({ tasksEnvelope, missionsEnvelope: missionsEnv }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cycleErr = result.errors.find(
        (e) => e.kind === "cycle_detected",
      );
      expect(cycleErr).toBeDefined();
      expect(cycleErr!.cyclePath!.every((seg) => seg.startsWith("mission["))).toBe(true);
    }
  });

  it("rejects invalid kind", () => {
    const idMap = createIdentityMap();
    const result = dependenciesHandler.validate(
      envelope([{ ...goodEdge, kind: "contradicts" as never }]),
      ctxWithEnvelopes({ tasksEnvelope }),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_kind");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { edges: [goodEdge] };
    const p1 = dependenciesHandler.prepare(validated, baseCtx(), idMap);
    const p2 = dependenciesHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.edges[0].edgeServerId).toBe(p2.edges[0].edgeServerId);
  });

  it("resolveReferences rewrites task edges", () => {
    const idMap = createIdentityMap();
    idMap.sourceToServer.set("t1", "task-1");
    idMap.sourceToServer.set("t2", "task-2");
    const validated = { edges: [goodEdge] };
    const prepared = dependenciesHandler.prepare(validated, baseCtx(), idMap);
    const result = dependenciesHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.edges[0].taskServerId).toBe("task-1");
      expect(result.resolved.edges[0].dependsOnTaskServerId).toBe("task-2");
    }
  });
});

// ---------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------

describe("comments handler", () => {
  const goodComment = {
    sourceId: "c1",
    taskSourceId: "t1",
    parentCommentSourceId: null,
    content: "Hello",
    author: { resolvedActorId: null, importedAttribution: "bob@example.com" },
    authorType: "human" as const,
    authoredAt: "2026-07-19T12:00:00.000Z",
  };

  it("validates a well-formed comment", () => {
    const idMap = createIdentityMap();
    const result = commentsHandler.validate(envelope([goodComment]), baseCtx(), idMap);
    expect(result.ok).toBe(true);
  });

  it("rejects invalid authorType", () => {
    const idMap = createIdentityMap();
    const result = commentsHandler.validate(
      envelope([{ ...goodComment, authorType: "bot" as never }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_author_type");
    }
  });

  it("rejects empty importedAttribution", () => {
    const idMap = createIdentityMap();
    const result = commentsHandler.validate(
      envelope([
        {
          ...goodComment,
          author: { resolvedActorId: null, importedAttribution: "" },
        },
      ]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("invalid_imported_attribution");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { comments: [goodComment] };
    const p1 = commentsHandler.prepare(validated, baseCtx(), idMap);
    const p2 = commentsHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.comments[0].commentServerId).toBe(p2.comments[0].commentServerId);
  });

  it("resolveReferences rewrites taskSourceId + parentCommentSourceId", () => {
    const idMap = createIdentityMap();
    idMap.sourceToServer.set("t1", "task-1");
    idMap.sourceToServer.set("c1", "comment-1");
    const validated = {
      comments: [
        goodComment,
        {
          ...goodComment,
          sourceId: "c2",
          parentCommentSourceId: "c1",
        },
      ],
    };
    const prepared = commentsHandler.prepare(validated, baseCtx(), idMap);
    const result = commentsHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.comments[0].taskServerId).toBe("task-1");
      expect(result.resolved.comments[0].parentCommentServerId).toBeNull();
      expect(result.resolved.comments[1].parentCommentServerId).toBe("comment-1");
    }
  });
});

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

describe("templates handler", () => {
  const goodTemplate = {
    sourceId: "tmpl-1",
    name: "Standard",
    description: "Standard template",
    content: {
      columns: [],
      labels: [],
      missions: [],
    },
    isDefault: false,
  };

  it("validates a well-formed template", () => {
    const idMap = createIdentityMap();
    const result = templatesHandler.validate(envelope([goodTemplate]), baseCtx(), idMap);
    expect(result.ok).toBe(true);
  });

  it("rejects multiple default templates", () => {
    const idMap = createIdentityMap();
    const result = templatesHandler.validate(
      envelope([
        { ...goodTemplate, isDefault: true },
        { ...goodTemplate, sourceId: "tmpl-2", name: "Other", isDefault: true },
      ]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("multiple_default_templates");
    }
  });

  it("rejects forbidden C4 fields", () => {
    const idMap = createIdentityMap();
    const result = templatesHandler.validate(
      envelope([{ ...goodTemplate, usageCount: 5, habitatId: "h-1" }]),
      baseCtx(),
      idMap,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.kind)).toContain("forbidden_field_present");
    }
  });

  it("prepare is PURE and IDEMPOTENT", () => {
    const idMap = createIdentityMap();
    const validated = { templates: [goodTemplate] };
    const p1 = templatesHandler.prepare(validated, baseCtx(), idMap);
    const p2 = templatesHandler.prepare(validated, baseCtx(), idMap);
    expect(p1.templates[0].templateServerId).toBe(p2.templates[0].templateServerId);
  });

  it("resolveReferences is a structural no-op (template content is template-scoped)", () => {
    const idMap = createIdentityMap();
    const validated = { templates: [goodTemplate] };
    const prepared = templatesHandler.prepare(validated, baseCtx(), idMap);
    const result = templatesHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toEqual(prepared);
    }
  });
});

// ---------------------------------------------------------------------------
// PURITY enforcement (cross-cutting)
// ---------------------------------------------------------------------------

describe("handler purity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("NONE of the handlers touch getDb() during validate / prepare / resolveReferences", async () => {
    const idMap = createIdentityMap();
    const colsEnv = envelope([{
      sourceId: "col-a",
      name: "Todo",
      order: 0,
      color: null,
      wipLimit: null,
      nextColumnName: null,
      isTerminal: false,
    }]);
    const tasksEnv = envelope([{
      sourceId: "t1",
      missionSourceId: "m1",
      title: "T1",
      description: "",
      priority: "high" as const,
      requiredDomain: null,
      requiredCapabilities: [],
    }]);

    const ctx = ctxWithEnvelopes({ columnsEnvelope: colsEnv, tasksEnvelope: tasksEnv });

    // Run validate + prepare + resolveReferences for every handler.
    habitatSettingsHandler.validate(
      envelope({ sourceId: "h", name: "x", description: "", settings: {} }),
      ctx,
      idMap,
    );
    habitatSettingsHandler.prepare(
      { sourceId: "h", name: "x", description: "", settings: {} },
      ctx,
      idMap,
    );
    habitatSettingsHandler.resolveReferences(
      habitatSettingsHandler.prepare(
        { sourceId: "h", name: "x", description: "", settings: {} },
        ctx,
        idMap,
      ),
      ctx,
      idMap,
    );

    const colsV = columnsHandler.validate(envelope([colsEnv.data[0]]), ctx, idMap);
    if (colsV.ok) {
      const p = columnsHandler.prepare(colsV.validated, ctx, idMap);
      columnsHandler.resolveReferences(p, ctx, idMap);
    }

    const missionsV = missionsHandler.validate(
      envelope([{
        sourceId: "m1",
        title: "M1",
        description: "",
        acceptanceCriteria: "",
        priority: "high" as const,
        labels: [],
        columnName: "Todo",
        dependsOnSourceIds: [],
        blocksSourceIds: [],
        dueAt: null,
      }]),
      ctx,
      idMap,
    );
    if (missionsV.ok) {
      const p = missionsHandler.prepare(missionsV.validated, ctx, idMap);
      missionsHandler.resolveReferences(p, ctx, idMap);
    }

    const tasksV = tasksHandler.validate(
      envelope([{
        sourceId: "t1",
        missionSourceId: "m1",
        title: "T1",
        description: "",
        priority: "high" as const,
        requiredDomain: null,
        requiredCapabilities: [],
      }]),
      ctx,
      idMap,
    );
    if (tasksV.ok) {
      const p = tasksHandler.prepare(tasksV.validated, ctx, idMap);
      tasksHandler.resolveReferences(p, ctx, idMap);
    }

    const subsV = subtasksHandler.validate(
      envelope([{
        sourceId: "s1",
        taskSourceId: "t1",
        title: "S",
        order: 0,
        completed: false,
        assigneeId: null,
      }]),
      ctx,
      idMap,
    );
    if (subsV.ok) {
      const p = subtasksHandler.prepare(subsV.validated, ctx, idMap);
      subtasksHandler.resolveReferences(p, ctx, idMap);
    }

    const depsV = dependenciesHandler.validate(envelope([]), ctx, idMap);
    if (depsV.ok) {
      const p = dependenciesHandler.prepare(depsV.validated, ctx, idMap);
      dependenciesHandler.resolveReferences(p, ctx, idMap);
    }

    const cmtV = commentsHandler.validate(
      envelope([{
        sourceId: "c1",
        taskSourceId: "t1",
        parentCommentSourceId: null,
        content: "x",
        author: { resolvedActorId: null, importedAttribution: "x" },
        authorType: "human" as const,
        authoredAt: "2026-07-19T12:00:00.000Z",
      }]),
      ctx,
      idMap,
    );
    if (cmtV.ok) {
      const p = commentsHandler.prepare(cmtV.validated, ctx, idMap);
      commentsHandler.resolveReferences(p, ctx, idMap);
    }

    const tmplsV = templatesHandler.validate(
      envelope([{
        sourceId: "tmpl-1",
        name: "x",
        description: "",
        content: { columns: [], labels: [], missions: [] },
        isDefault: false,
      }]),
      ctx,
      idMap,
    );
    if (tmplsV.ok) {
      const p = templatesHandler.prepare(tmplsV.validated, ctx, idMap);
      templatesHandler.resolveReferences(p, ctx, idMap);
    }

    // If any handler touched getDb, the mock would have thrown "PURE HANDLER VIOLATION".
    // Reaching this point is the assertion.
    expect(true).toBe(true);
  });
});
