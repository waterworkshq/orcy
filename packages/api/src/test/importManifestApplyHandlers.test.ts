/**
 * T10B Milestone 1 — per-domain `apply` handlers.
 *
 * Tests each of the 8 M3 handlers' new `apply` function. Each apply runs
 * inside a caller-owned transaction; the tests prove:
 *
 *   - Happy path: prepare + resolveReferences + apply commits the correct
 *     rows on the passed client; the returned `AppliedDomain`'s
 *     `committedServerIds` matches the inserted rows.
 *   - Atomicity: a throw inside `apply` rolls the WHOLE tx back. No rows
 *     survive the abort. The tx client never throws for partial state.
 *
 * Out of scope: the orchestrator (M2), the `mode:"replacement"` in-place
 * logic (M2), the existing M3 validate/prepare/resolveReferences tests
 * (see importManifestDomainHandlers.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  columns as columnsTable,
  habitats,
  missionComments,
  missionDependencies,
  missions,
  missionTemplates,
  taskDependencies,
  taskSubtasks,
  tasks,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";

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
import type {
  DomainEnvelope,
  HabitatSettingsPortable,
  ColumnPortable,
  MissionPortable,
  TaskPortable,
  SubtaskPortable,
  DependencyPortable,
  CommentPortable,
  TemplatePortable,
  DomainDisposition,
} from "../services/importManifest/types.js";
import type { ManifestContext, CrossDomainState } from "../services/importManifest/domainHandler.js";
import { createIdentityMap } from "../services/importManifest/domainHandler.js";

// ---------------------------------------------------------------------------
// Shared helpers
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

function ctxWithEnvelopes(crossDomainState: CrossDomainState): ManifestContext {
  return baseCtx({ crossDomainState });
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  // Clean slate — domains write rows that depend on habitat_id being absent.
  db.delete(taskSubtasks).run();
  db.delete(taskDependencies).run();
  db.delete(missionComments).run();
  db.delete(missionDependencies).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(missionTemplates).run();
  db.delete(habitats).run();
});

// Helper: seed a habitat row whose id matches the apply target. Required
// because columns.habitatId, missions.habitatId, mission_templates.habitatId,
// and tasks.missionId are FKs.
function seedHabitat(id: string): void {
  getDb()
    .insert(habitats)
    .values({
      id,
      name: `habitat-for-${id}`,
      description: "",
    })
    .run();
}

// Helper: seed a column row whose id may be referenced by a mission.
function seedColumn(id: string, habitatId: string): void {
  getDb()
    .insert(columnsTable)
    .values({
      id,
      habitatId,
      name: `col-for-${id}`,
      order: 0,
      autoAdvance: false,
      requiresClaim: true,
      nextColumnId: null,
      isTerminal: false,
    })
    .run();
}

// Helper: seed a minimal mission row (FK habitatId + columnId).
function seedMission(id: string, habitatId: string, columnId: string): void {
  getDb()
    .insert(missions)
    .values({
      id,
      habitatId,
      columnId,
      title: "Parent Mission",
      description: "",
      acceptanceCriteria: "",
      priority: "medium",
      labels: [],
      status: "not_started",
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      createdBy: "import",
    })
    .run();
}

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Habitat-settings
// ---------------------------------------------------------------------------

describe("applyHabitatSettings", () => {
  const good: HabitatSettingsPortable = {
    sourceId: "habitat-1",
    name: "Imported Habitat",
    description: "an imported habitat",
    settings: { theme: "dark" },
  };

  it("inserts one habitat row for mode:'new' and returns the prepared server id", () => {
    const idMap = createIdentityMap();
    const v = habitatSettingsHandler.validate(envelope(good), baseCtx(), idMap);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const prepared = habitatSettingsHandler.prepare(v.validated, baseCtx(), idMap);
    const resolved = habitatSettingsHandler.resolveReferences(prepared, baseCtx(), idMap);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const db = getDb();
    const result = db.transaction((tx) => {
      return habitatSettingsHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId: prepared.habitatServerId,
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    // Note: habitatSettings.apply also writes a habitats row; the prepared
    // habitatServerId is the new row's id. No pre-seed needed (this is the
    // FIRST apply in the aggregate). Verify the row written by apply.

    expect(result.domain).toBe("habitatSettings");
    expect(result.mode).toBe("new");
    expect(result.inserted).toBe(1);
    expect(result.committedServerIds).toEqual([prepared.habitatServerId]);

    // Verify the row is actually in the DB.
    const db2 = getDb();
    const rows = db2.select().from(habitats).where(eq(habitats.id, prepared.habitatServerId)).all();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Imported Habitat");
  });

  it("rolls back when a downstream throw aborts the apply", () => {
    const idMap = createIdentityMap();
    const v = habitatSettingsHandler.validate(envelope(good), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = habitatSettingsHandler.prepare(v.validated, baseCtx(), idMap);

    expect(() => {
      const db = getDb();
      db.transaction((tx) => {
        habitatSettingsHandler.apply(tx as never, prepared, {
          mode: "new",
          targetHabitatId: prepared.habitatServerId,
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        // Simulate a downstream failure AFTER the habitat insert.
        throw new Error("downstream handler failure — must roll back");
      });
    }).toThrow(/downstream handler failure/);

    const db2 = getDb();
    const rows = db2.select().from(habitats).all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe("applyColumns", () => {
  const columns: ColumnPortable[] = [
    { sourceId: "c-1", name: "Backlog", order: 0, color: null, wipLimit: null, nextColumnName: null, isTerminal: false },
    { sourceId: "c-2", name: "In Progress", order: 1, color: "#abc", wipLimit: 3, nextColumnName: "Backlog", isTerminal: false },
    { sourceId: "c-3", name: "Done", order: 2, color: null, wipLimit: null, nextColumnName: null, isTerminal: true },
  ];

  it("inserts all columns and resolves nextColumnServerId via the prepared array", () => {
    const idMap = createIdentityMap();
    const v = columnsHandler.validate(envelope(columns), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = columnsHandler.prepare(v.validated, baseCtx(), idMap);
    const resolved = columnsHandler.resolveReferences(prepared, baseCtx(), idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    const targetHabitatId = "target-habitat-cols";
    seedHabitat(targetHabitatId);

    let result;
    const db = getDb();
    db.transaction((tx) => {
      result = columnsHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId,
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(3);
    expect(result!.committedServerIds).toEqual([
      prepared.columns[0].columnServerId,
      prepared.columns[1].columnServerId,
      prepared.columns[2].columnServerId,
    ]);

    const db2 = getDb();
    const rows = db2
      .select()
      .from(columnsTable)
      .where(eq(columnsTable.habitatId, targetHabitatId))
      .all();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.name).toSorted()).toEqual(["Backlog", "Done", "In Progress"]);
  });

  it("rolls back when a downstream throw aborts the apply mid-loop", () => {
    const idMap = createIdentityMap();
    const v = columnsHandler.validate(envelope(columns), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = columnsHandler.prepare(v.validated, baseCtx(), idMap);
    const targetHabitatId = "target-habitat-cols-rollback";
    seedHabitat(targetHabitatId);

    expect(() => {
      const db = getDb();
      db.transaction((tx) => {
        columnsHandler.apply(tx as never, prepared, {
          mode: "new",
          targetHabitatId,
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("rollback trigger");
      });
    }).toThrow(/rollback trigger/);

    const db2 = getDb();
    const rows = db2.select().from(columnsTable).where(eq(columnsTable.habitatId, targetHabitatId)).all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

describe("applyMissions", () => {
  it("inserts missions + their dependsOn mission_dependencies edges", () => {
    const idMap = createIdentityMap();
    // Real columns must exist in the DB (FK missions.column_id → columns.id).
    // Run the columns apply first inside the same tx so missions' FK
    // resolves against the just-inserted column row.
    const columnsData: ColumnPortable[] = [
      { sourceId: "col-1", name: "Backlog", order: 0, color: null, wipLimit: null, nextColumnName: null, isTerminal: false },
    ];
    const cV = columnsHandler.validate(envelope(columnsData), baseCtx(), idMap);
    if (!cV.ok) throw new Error("columns validate failed");
    const cPrepared = columnsHandler.prepare(cV.validated, baseCtx(), idMap);
    const cResolved = columnsHandler.resolveReferences(cPrepared, baseCtx(), idMap);
    if (!cResolved.ok) throw new Error("columns resolve failed");

    const missionsData: MissionPortable[] = [
      {
        sourceId: "m-1",
        title: "Mission 1",
        description: "first",
        acceptanceCriteria: "",
        priority: "high",
        labels: [],
        columnName: "Backlog",
        dependsOnSourceIds: [],
        blocksSourceIds: [],
        dueAt: null,
      },
      {
        sourceId: "m-2",
        title: "Mission 2",
        description: "depends on 1",
        acceptanceCriteria: "",
        priority: "medium",
        labels: [],
        columnName: "Backlog",
        dependsOnSourceIds: ["m-1"],
        blocksSourceIds: [],
        dueAt: null,
      },
    ];

    const ctx = ctxWithEnvelopes({
      columnsEnvelope: envelope(columnsData),
    });
    const v = missionsHandler.validate(envelope(missionsData), ctx, idMap);
    if (!v.ok) throw new Error("missions validate failed");
    const prepared = missionsHandler.prepare(v.validated, ctx, idMap);
    const resolved = missionsHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    const targetHabitatId = "target-habitat-missions";
    seedHabitat(targetHabitatId);
    const columnServerId = cPrepared.columns[0].columnServerId;

    let result;
    const db = getDb();
    db.transaction((tx) => {
      // Compose columns THEN missions in the SAME tx (mission FK resolves
      // against the just-inserted column row).
      columnsHandler.apply(tx as never, cResolved.resolved, {
        mode: "new",
        targetHabitatId,
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
      result = missionsHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId,
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(2);
    expect(result!.committedServerIds).toEqual([
      prepared.missions[0].missionServerId,
      prepared.missions[1].missionServerId,
    ]);

    const db2 = getDb();
    const missionRows = db2
      .select()
      .from(missions)
      .where(eq(missions.habitatId, targetHabitatId))
      .all();
    expect(missionRows.length).toBe(2);
    for (const mr of missionRows) {
      expect(mr.columnId).toBe(columnServerId);
    }
    const edgeRows = db2.select().from(missionDependencies).all();
    expect(edgeRows.length).toBe(1);
    expect(edgeRows[0].missionId).toBe(prepared.missions[1].missionServerId);
    expect(edgeRows[0].dependsOnId).toBe(prepared.missions[0].missionServerId);
  });

  it("rolls back mission + mission_dependencies inserts when apply aborts", () => {
    const idMap = createIdentityMap();
    const columnsData: ColumnPortable[] = [
      { sourceId: "col-1", name: "Backlog", order: 0, color: null, wipLimit: null, nextColumnName: null, isTerminal: false },
    ];
    const cV = columnsHandler.validate(envelope(columnsData), baseCtx(), idMap);
    if (!cV.ok) throw new Error("columns validate failed");
    const cPrepared = columnsHandler.prepare(cV.validated, baseCtx(), idMap);
    const cResolved = columnsHandler.resolveReferences(cPrepared, baseCtx(), idMap);
    if (!cResolved.ok) throw new Error("columns resolve failed");

    const missionsData: MissionPortable[] = [
      {
        sourceId: "m-1",
        title: "Mission 1",
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        labels: [],
        columnName: "Backlog",
        dependsOnSourceIds: [],
        blocksSourceIds: [],
        dueAt: null,
      },
    ];
    const ctx = ctxWithEnvelopes({ columnsEnvelope: envelope(columnsData) });
    const v = missionsHandler.validate(envelope(missionsData), ctx, idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = missionsHandler.prepare(v.validated, ctx, idMap);
    const resolved = missionsHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    expect(() => {
      const seedId = "target-missions-rb";
      seedHabitat(seedId);
      const db = getDb();
      db.transaction((tx) => {
        columnsHandler.apply(tx as never, cResolved.resolved, {
          mode: "new",
          targetHabitatId: seedId,
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        missionsHandler.apply(tx as never, resolved.resolved, {
          mode: "new",
          targetHabitatId: "target-missions-rb",
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("trigger missions rollback");
      });
    }).toThrow();

    const db2 = getDb();
    const missionRows = db2.select().from(missions).all();
    const edgeRows = db2.select().from(missionDependencies).all();
    const columnRows = db2.select().from(columnsTable).all();
    expect(columnRows.length).toBe(0);
    expect(missionRows.length).toBe(0);
    expect(edgeRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tasks (STUB)
// ---------------------------------------------------------------------------

describe("applyTasks (STUB)", () => {
  it("throws unconditionally — must compose via publishTaskWithClient, not via DomainHandler.apply", () => {
    const idMap = createIdentityMap();
    const data: TaskPortable[] = [
      {
        sourceId: "t-1",
        missionSourceId: "m-1",
        title: "Task 1",
        description: "",
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
      },
    ];
    const v = tasksHandler.validate(envelope(data), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = tasksHandler.prepare(v.validated, baseCtx(), idMap);

    expect(() => {
      tasksHandler.apply(getDb() as never, prepared, {
        mode: "new",
        targetHabitatId: "any",
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    }).toThrow(/publishTaskWithClient/);
  });
});

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

describe("applySubtasks", () => {
  it("inserts subtasks via createSubtaskWithClient", () => {
    const idMap = createIdentityMap();
    // Real task row needed (task_subtasks.task_id FK → tasks.id).
    // tasks.missionId → missions.id → habitats.id chain — seed all three.
    const taskSourceId = "task-1";
    const taskServerId = "synthesized-task-server-id-1";
    const habitatId = "hab-for-subtasks-1";
    const missionId = "synthesized-mission-server-id-1";
    seedHabitat(habitatId);
    seedColumn("synthesized-column-1", habitatId);
    seedMission(missionId, habitatId, "synthesized-column-1");
    getDb()
      .insert(tasks)
      .values({
        id: taskServerId,
        missionId,
        title: "Parent Task",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 0,
      })
      .run();

    const data: SubtaskPortable[] = [
      { sourceId: "st-1", taskSourceId, title: "Sub A", order: 0, completed: false, assigneeId: null },
      { sourceId: "st-2", taskSourceId, title: "Sub B", order: 1, completed: true, assigneeId: null },
    ];
    const v = subtasksHandler.validate(envelope(data), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = subtasksHandler.prepare(v.validated, baseCtx(), idMap);
    idMap.sourceToServer.set(taskSourceId, taskServerId);
    const resolved = subtasksHandler.resolveReferences(prepared, baseCtx(), idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    let result;
    const db = getDb();
    db.transaction((tx) => {
      result = subtasksHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId: "any",
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(2);
    expect(result!.committedServerIds.length).toBe(2);

    const db2 = getDb();
    const rows = db2
      .select()
      .from(taskSubtasks)
      .where(eq(taskSubtasks.taskId, taskServerId))
      .all();
    expect(rows.length).toBe(2);
  });

  it("rolls back subtasks when a downstream throw aborts the apply", () => {
    const idMap = createIdentityMap();
    const taskSourceId = "task-rb";
    const taskServerId = "synthesized-task-server-id-rb";
    const habitatId = "hab-for-subtasks-rb";
    const missionId = "synthesized-mission-server-id-rb";
    seedHabitat(habitatId);
    seedColumn("synthesized-column-rb", habitatId);
    seedMission(missionId, habitatId, "synthesized-column-rb");
    getDb()
      .insert(tasks)
      .values({
        id: taskServerId,
        missionId,
        title: "Parent",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 0,
      })
      .run();

    const data: SubtaskPortable[] = [
      { sourceId: "st-1", taskSourceId, title: "Sub", order: 0, completed: false, assigneeId: null },
    ];
    const v = subtasksHandler.validate(envelope(data), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = subtasksHandler.prepare(v.validated, baseCtx(), idMap);
    idMap.sourceToServer.set(taskSourceId, taskServerId);
    const resolved = subtasksHandler.resolveReferences(prepared, baseCtx(), idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    expect(() => {
      const db = getDb();
      db.transaction((tx) => {
        subtasksHandler.apply(tx as never, resolved.resolved, {
          mode: "new",
          targetHabitatId: "any",
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("subtasks rollback");
      });
    }).toThrow();

    const db2 = getDb();
    const rows = db2.select().from(taskSubtasks).all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

describe("applyDependencies", () => {
  it("inserts task-level dependency edges via addTaskDependencyWithClient", () => {
    const idMap = createIdentityMap();
    // Real task rows needed (task_dependencies FKs).
    const habitatId = "hab-for-deps-1";
    seedHabitat(habitatId);
    seedColumn("col-for-deps-1", habitatId);
    seedMission("mission-for-deps-1", habitatId, "col-for-deps-1");
    getDb()
      .insert(tasks)
      .values({
        id: "server-A",
        missionId: "mission-for-deps-1",
        title: "A",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 0,
      })
      .run();
    getDb()
      .insert(tasks)
      .values({
        id: "server-B",
        missionId: "mission-for-deps-1",
        title: "B",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 1,
      })
      .run();
    idMap.sourceToServer.set("t-A", "server-A");
    idMap.sourceToServer.set("t-B", "server-B");
    // The tasks envelope must declare each task sourceId so the validator's
    // cross-domain reference check passes.
    const tasksData: TaskPortable[] = [
      { sourceId: "t-A", missionSourceId: "m-1", title: "A", description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [] },
      { sourceId: "t-B", missionSourceId: "m-1", title: "B", description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [] },
    ];

    const data: DependencyPortable[] = [
      { sourceId: "edge-1", taskSourceId: "t-A", dependsOnTaskSourceId: "t-B", kind: "blocks" },
    ];
    const ctx: ManifestContext = baseCtx({
      crossDomainState: { tasksEnvelope: envelope(tasksData) },
    });
    const v = dependenciesHandler.validate(envelope(data), ctx, idMap);
    if (!v.ok) throw new Error("validate failed: " + JSON.stringify(v.errors));
    const prepared = dependenciesHandler.prepare(v.validated, ctx, idMap);
    const resolved = dependenciesHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed: " + JSON.stringify(resolved.errors));

    let result;
    const db = getDb();
    db.transaction((tx) => {
      result = dependenciesHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId: "any",
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(1);
    expect(result!.committedServerIds.length).toBe(1);

    const db2 = getDb();
    const rows = db2.select().from(taskDependencies).all();
    expect(rows.length).toBe(1);
    expect(rows[0].taskId).toBe("server-A");
    expect(rows[0].dependsOnId).toBe("server-B");
  });

  it("rolls back task dependency edges when a downstream throw aborts the apply", () => {
    const idMap = createIdentityMap();
    const habitatId = "hab-for-deps-rb";
    seedHabitat(habitatId);
    seedColumn("col-for-deps-rb", habitatId);
    seedMission("mission-for-deps-rb", habitatId, "col-for-deps-rb");
    getDb()
      .insert(tasks)
      .values({
        id: "server-X",
        missionId: "mission-for-deps-rb",
        title: "X",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 0,
      })
      .run();
    getDb()
      .insert(tasks)
      .values({
        id: "server-Y",
        missionId: "mission-for-deps-rb",
        title: "Y",
        description: "",
        labels: [],
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
        status: "pending",
        createdBy: "import",
        order: 1,
      })
      .run();
    idMap.sourceToServer.set("t-X", "server-X");
    idMap.sourceToServer.set("t-Y", "server-Y");
    const tasksData: TaskPortable[] = [
      { sourceId: "t-X", missionSourceId: "m-1", title: "X", description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [] },
      { sourceId: "t-Y", missionSourceId: "m-1", title: "Y", description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [] },
    ];
    const data: DependencyPortable[] = [
      { sourceId: "edge-1", taskSourceId: "t-X", dependsOnTaskSourceId: "t-Y", kind: "blocks" },
    ];
    const ctx: ManifestContext = baseCtx({
      crossDomainState: { tasksEnvelope: envelope(tasksData) },
    });
    const v = dependenciesHandler.validate(envelope(data), ctx, idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = dependenciesHandler.prepare(v.validated, ctx, idMap);
    const resolved = dependenciesHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    expect(() => {
      const db = getDb();
      db.transaction((tx) => {
        dependenciesHandler.apply(tx as never, resolved.resolved, {
          mode: "new",
          targetHabitatId: "any",
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("dependencies rollback");
      });
    }).toThrow();

    const db2 = getDb();
    const rows = db2.select().from(taskDependencies).all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

describe("applyComments", () => {
  it("inserts mission-scoped comments bridged from task-scoped portable via cross-domain lookup", () => {
    const idMap = createIdentityMap();
    // Pre-populate idMap as if columns/missions/tasks.prepare had run.
    idMap.sourceToServer.set("col-1", "server-col");
    idMap.sourceToServer.set("m-1", "server-mission");
    idMap.sourceToServer.set("t-1", "server-task");
    idMap.sourceToServer.set("c-1", "server-comment");

    // FK: mission_comments.missionId → missions.id → habitats.id.
    const habitatId = "hab-for-comments-1";
    seedHabitat(habitatId);
    seedColumn("col-for-comments-1", habitatId);
    seedMission("server-mission", habitatId, "col-for-comments-1");

    const data: CommentPortable[] = [
      {
        sourceId: "c-1",
        taskSourceId: "t-1",
        parentCommentSourceId: null,
        content: "First comment.",
        author: { resolvedActorId: null, importedAttribution: "alice@example.com" },
        authorType: "human",
        authoredAt: "2025-01-01T00:00:00Z",
      },
    ];

    const tasksData: TaskPortable[] = [
      {
        sourceId: "t-1",
        missionSourceId: "m-1",
        title: "Task",
        description: "",
        priority: "medium",
        requiredDomain: null,
        requiredCapabilities: [],
      },
    ];
    const ctx: ManifestContext = baseCtx({
      crossDomainState: { tasksEnvelope: envelope(tasksData) },
    });
    const v = commentsHandler.validate(envelope(data), ctx, idMap);
    if (!v.ok) throw new Error("validate failed: " + JSON.stringify(v.errors));
    const prepared = commentsHandler.prepare(v.validated, ctx, idMap);
    const resolved = commentsHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed: " + JSON.stringify(resolved.errors));

    let result;
    const db = getDb();
    db.transaction((tx) => {
      result = commentsHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId: "any",
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(1);
    expect(result!.committedServerIds).toEqual(["server-comment"]);

    const db2 = getDb();
    const rows = db2.select().from(missionComments).all();
    expect(rows.length).toBe(1);
    expect(rows[0].missionId).toBe("server-mission");
    expect(rows[0].authorId).toBe("imported:alice@example.com");
  });

  it("rolls back comment inserts when a downstream throw aborts the apply", () => {
    const idMap = createIdentityMap();
    // FK chain: mission_comments.missionId → missions.id → habitats.id
    const habitatIdRb = "hab-for-comments-rb";
    seedHabitat(habitatIdRb);
    seedColumn("col-for-comments-rb", habitatIdRb);
    seedMission("server-mission", habitatIdRb, "col-for-comments-rb");
    idMap.sourceToServer.set("m-1", "server-mission");
    idMap.sourceToServer.set("t-1", "server-task");
    idMap.sourceToServer.set("c-1", "server-comment");
    const data: CommentPortable[] = [
      {
        sourceId: "c-1",
        taskSourceId: "t-1",
        parentCommentSourceId: null,
        content: "X",
        author: { resolvedActorId: null, importedAttribution: "bob" },
        authorType: "human",
        authoredAt: "2025-01-01T00:00:00Z",
      },
    ];
    const tasksData: TaskPortable[] = [
      { sourceId: "t-1", missionSourceId: "m-1", title: "T", description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [] },
    ];
    const ctx: ManifestContext = baseCtx({
      crossDomainState: { tasksEnvelope: envelope(tasksData) },
    });
    const v = commentsHandler.validate(envelope(data), ctx, idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = commentsHandler.prepare(v.validated, ctx, idMap);
    const resolved = commentsHandler.resolveReferences(prepared, ctx, idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    expect(() => {
      // habitat + mission seeded earlier in the test.
      const db = getDb();
      db.transaction((tx) => {
        commentsHandler.apply(tx as never, resolved.resolved, {
          mode: "new",
          targetHabitatId: "any",
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("comments rollback");
      });
    }).toThrow();

    const db2 = getDb();
    const rows = db2.select().from(missionComments).all();
    expect(rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe("applyTemplates", () => {
  it("inserts templates with name + descriptionPattern + best-effort labels from content", () => {
    const idMap = createIdentityMap();
    const data: TemplatePortable[] = [
      {
        sourceId: "tpl-1",
        name: "Default Triage",
        description: "A standard triage template.",
        content: { columns: [], labels: ["triage", "incident"], missions: [] },
        isDefault: true,
      },
    ];
    const v = templatesHandler.validate(envelope(data), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = templatesHandler.prepare(v.validated, baseCtx(), idMap);
    const resolved = templatesHandler.resolveReferences(prepared, baseCtx(), idMap);
    if (!resolved.ok) throw new Error("resolve failed");

    const targetHabitatId = "target-habitat-templates";
    seedHabitat(targetHabitatId);
    let result;
    const db = getDb();
    db.transaction((tx) => {
      result = templatesHandler.apply(tx as never, resolved.resolved, {
        mode: "new",
        targetHabitatId,
        identityMap: idMap,
        existingHabitatSnapshot: null,
        preserveDomainTargets: new Map(),
      });
    });

    expect(result!.inserted).toBe(1);
    expect(result!.committedServerIds).toEqual([prepared.templates[0].templateServerId]);

    const db2 = getDb();
    const rows = db2
      .select()
      .from(missionTemplates)
      .where(eq(missionTemplates.habitatId, targetHabitatId))
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Default Triage");
    expect(rows[0].descriptionPattern).toBe("A standard triage template.");
    expect(rows[0].titlePattern).toBe("Default Triage");
    expect(rows[0].isDefault).toBe(true);
    expect(rows[0].labels).toEqual(["triage", "incident"]);
  });

  it("rolls back template inserts when a downstream throw aborts the apply", () => {
    const idMap = createIdentityMap();
    seedHabitat("target-tpl-rb");
    const data: TemplatePortable[] = [
      {
        sourceId: "tpl-1",
        name: "X",
        description: "x",
        content: { columns: [], labels: [], missions: [] },
        isDefault: true,
      },
    ];
    const v = templatesHandler.validate(envelope(data), baseCtx(), idMap);
    if (!v.ok) throw new Error("validate failed");
    const prepared = templatesHandler.prepare(v.validated, baseCtx(), idMap);

    expect(() => {
      const db = getDb();
      db.transaction((tx) => {
        templatesHandler.apply(tx as never, prepared, {
          mode: "new",
          targetHabitatId: "target-tpl-rb",
          identityMap: idMap,
          existingHabitatSnapshot: null,
          preserveDomainTargets: new Map(),
        });
        throw new Error("templates rollback");
      });
    }).toThrow();

    const db2 = getDb();
    const rows = db2.select().from(missionTemplates).all();
    expect(rows.length).toBe(0);
  });
});
