/**
 * T10C M2 — `exportHabitatManifest` (native v3 Habitat Exporter).
 *
 * Coverage:
 *   - Round-trip test (load-bearing): seed a full habitat → export →
 *     prepareImport → publishImportAggregateWithClient into a new habitat →
 *     verify the new habitat's portable domains match the original.
 *   - Per-domain emission tests (one per domain) — emitted shape matches the
 *     corresponding `*Portable` type.
 *   - Not-found test — `exportHabitatManifest("nonexistent")` → null.
 *   - Mode + identityPolicy override test — passes options through.
 *   - Lineage test — `sourceHabitatId` matches input; `sourceManifestId`
 *     is null on first export.
 *   - Manifest ID determinism — same `habitatId` + same `exportedAt` →
 *     same `manifestId`.
 *
 * The exporter is exercised read-only; the round-trip path through
 * `prepareImport` + `publishImportAggregateWithClient` requires
 * `ORCY_CREATION_PUBLICATION_ENABLED=true` (forced ON for these tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { eq, sql } from "drizzle-orm";

import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  columns as columnsTable,
  habitats,
  importAttempts,
  missionComments,
  missions as missionsTable,
  missionTemplates,
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskDependencies,
  taskEvents,
  tasks as tasksTable,
  taskSubtasks,
} from "../db/schema/index.js";

import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as subtaskRepo from "../repositories/subtask.js";
import * as commentRepo from "../repositories/comment.js";
import * as templateRepo from "../repositories/template.js";
import * as dependencyRepo from "../repositories/dependency.js";

import { createHabitat } from "../services/habitatService.js";
import {
  exportHabitatManifest,
  type ExportHabitatManifestOptions,
} from "../services/habitatManifestExporter.js";
import {
  prepareImport,
  type PrepareImportInput,
} from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";

// ---------------------------------------------------------------------------
// Setup — cutover flag handling per the established pattern.
// ---------------------------------------------------------------------------

const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let originalFlag: string | undefined;

beforeEach(async () => {
  await initTestDb();
  originalFlag = process.env[CUTOVER_FLAG];
  process.env[CUTOVER_FLAG] = "true";
});

afterEach(() => {
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  closeDb();
});

// ---------------------------------------------------------------------------
// Fixture — seed a full habitat with all 8 portable domains populated.
// ---------------------------------------------------------------------------

interface SeededHabitat {
  habitatId: string;
  columnIds: { todo: string; inProgress: string; done: string };
  missionIds: { alpha: string; beta: string };
  taskIds: { alphaTask1: string; alphaTask2: string; betaTask1: string };
  subtaskIds: { alphaTask1Sub1: string };
  commentIds: { alphaTask1Comment1: string };
  templateIds: { default: string };
}

/**
 * Seeds a source habitat with columns, missions, tasks, subtasks, a task
 * dependency edge, comments, and a default template. Returns the ids so tests
 * can assert specific references survived the round-trip.
 */
function seedFullHabitat(name = "Source Habitat"): SeededHabitat {
  const { habitat, columns } = createHabitat({ name, defaultColumns: true });
  const habitatId = habitat.id;

  // Default columns are seeded in order: index 0 (Todo), 1 (InProgress),
  // 2 (Review), 3 (Done) — verify the column shape matches the default
  // flow before indexing.
  const byName = new Map(columns.map((c) => [c.name, c]));
  const todo = byName.get("Todo") ?? columns[0];
  const inProgress = byName.get("In Progress") ?? columns[1];
  const done = byName.get("Done") ?? columns.at(-1)!;

  // Two missions: alpha (Todo) + beta (In Progress). Beta depends on alpha.
  const alpha = missionRepo.createMission({
    habitatId,
    columnId: todo.id,
    title: "Mission Alpha",
    description: "Alpha description",
    acceptanceCriteria: "Alpha AC",
    priority: "high",
    labels: ["alpha", "frontend"],
    createdBy: "tester",
    dueAt: "2026-12-31T00:00:00.000Z",
  });
  const beta = missionRepo.createMission({
    habitatId,
    columnId: inProgress.id,
    title: "Mission Beta",
    description: "Beta description",
    acceptanceCriteria: "Beta AC",
    priority: "medium",
    labels: ["beta"],
    dependsOn: [alpha.id],
    createdBy: "tester",
  });

  // Two tasks on alpha, one on beta.
  const alphaTask1 = taskRepo.createTask({
    missionId: alpha.id,
    title: "Alpha Task 1",
    description: "First alpha task",
    priority: "high",
    requiredDomain: "code_review",
    requiredCapabilities: ["review"],
    createdBy: "tester",
  });
  const alphaTask2 = taskRepo.createTask({
    missionId: alpha.id,
    title: "Alpha Task 2",
    description: "Second alpha task",
    priority: "low",
    requiredDomain: null,
    requiredCapabilities: [],
    createdBy: "tester",
  });
  const betaTask1 = taskRepo.createTask({
    missionId: beta.id,
    title: "Beta Task 1",
    description: "First beta task",
    priority: "medium",
    createdBy: "tester",
  });

  // Subtask on alphaTask1.
  const alphaTask1Sub1 = subtaskRepo.createSubtask({
    taskId: alphaTask1.id,
    title: "Subtask A",
    order: 0,
  });

  // Task dependency: alphaTask2 depends on alphaTask1.
  dependencyRepo.addTaskDependency(alphaTask2.id, alphaTask1.id);

  // Comment on alphaTask1.
  const alphaTask1Comment1 = commentRepo.createComment({
    taskId: alphaTask1.id,
    authorType: "human",
    authorId: "user-1",
    content: "First comment",
  });

  // Default template.
  const defaultTemplate = templateRepo.createTemplate({
    habitatId,
    name: "Default Template",
    titlePattern: "Templated Mission",
    descriptionPattern: "Template description",
    priority: "medium",
    labels: ["template"],
    requiredDomain: null,
    requiredCapabilities: [],
    isDefault: true,
    createdBy: "tester",
  });

  return {
    habitatId,
    columnIds: { todo: todo.id, inProgress: inProgress.id, done: done.id },
    missionIds: { alpha: alpha.id, beta: beta.id },
    taskIds: { alphaTask1: alphaTask1.id, alphaTask2: alphaTask2.id, betaTask1: betaTask1.id },
    subtaskIds: { alphaTask1Sub1: alphaTask1Sub1.id },
    commentIds: { alphaTask1Comment1: alphaTask1Comment1.id },
    templateIds: { default: defaultTemplate.id },
  };
}

/**
 * Wipes publication-related tables between tests. Defensive — the per-test
 * `initTestDb` snapshot already resets, but import-related rows survive via
 * the WAL (mirrors `importPublication.test.ts`).
 */
function wipeTables(): void {
  const db = getDb();
  db.delete(taskSubtasks).run();
  db.delete(taskDependencies).run();
  db.delete(missionComments).run();
  db.delete(taskEvents).run();
  db.delete(tasksTable).run();
  db.delete(missionsTable).run();
  db.delete(columnsTable).run();
  db.delete(missionTemplates).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(importAttempts).run();
  db.delete(habitats).run();
}

function prepareInput(
  manifest: HabitatImportManifest,
  overrides?: Partial<PrepareImportInput>,
): PrepareImportInput {
  return {
    rawManifest: manifest,
    habitatId: overrides?.habitatId ?? null,
    mode: overrides?.mode ?? manifest.mode,
    manifestId: overrides?.manifestId ?? manifest.manifestId,
    actor: overrides?.actor ?? { type: "human", id: "user-1" },
    auditSource: overrides?.auditSource ?? "rest_api",
  };
}

// ---------------------------------------------------------------------------
// 1. Round-trip — the load-bearing test.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — round-trip through prepareImport + publishImportAggregateWithClient", () => {
  // T10B-FK-FIX-2 (execution-run drift M3.5): force FK ON for this round-trip.
  // The orchestrator's domain apply was split into pre-task + post-task passes
  // so subtasks/dependencies INSERT after their task_id FK targets exist. With
  // that fix in place, the round-trip MUST pass deterministically with FK ON
  // (mirroring production's better-sqlite3 always-ON enforcement). If this
  // flakes, the orchestrator fix is incomplete — investigate which handler
  // still forward-references tasks. Precedent: productionMigrationChain.test.ts:83.
  beforeEach(() => {
    wipeTables();
    getDb().run(sql`PRAGMA foreign_keys = ON`);
  });

  it("reproduces the source habitat's portable domains in a new habitat (mode:'new', remap)", () => {
    // --- arrange (seed source) ---
    const seeded = seedFullHabitat("Round-trip Source");

    // --- act (export source) ---
    const manifest = exportHabitatManifest(seeded.habitatId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // --- act (prepare + publish into a new habitat) ---
    const preparedResult = prepareImport(prepareInput(manifest));
    expect(preparedResult.outcome).toBe("prepared");
    if (preparedResult.outcome !== "prepared") return;
    const outcome = publishImportAggregateWithClient(getDb(), {
      prepared: preparedResult.prepared,
    });

    // --- assert publication committed ---
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;
    const newHabitatId = outcome.habitatId;

    // --- assert per-domain counts + key fields survived ---
    const newHabitat = habitatRepo.getHabitatById(newHabitatId);
    expect(newHabitat).not.toBeNull();
    expect(newHabitat!.name).toBe("Round-trip Source");
    expect(newHabitat!.description).toBe("");

    // Columns: 4 default columns survive (Todo / In Progress / Review / Done).
    const newColumnsResult = habitatRepo.getHabitatWithColumnsAndTasks(newHabitatId);
    expect(newColumnsResult).not.toBeNull();
    const newColumns = newColumnsResult!.columns;
    expect(newColumns).toHaveLength(4);
    expect(newColumns.map((c) => c.name).sort()).toEqual(
      ["Done", "In Progress", "Review", "Todo"].sort(),
    );
    const newTodo = newColumns.find((c) => c.name === "Todo")!;
    const newDone = newColumns.find((c) => c.name === "Done")!;
    expect(newDone.isTerminal).toBe(true);

    // Missions: 2 missions survive (alpha + beta). Their titles + labels +
    // priority + column resolution survive. Mission-to-mission dependency
    // survives (beta depends on alpha — re-keyed through the new server ids).
    const { missions: newMissions } = missionRepo.getMissionsByHabitatId(newHabitatId);
    expect(newMissions).toHaveLength(2);
    const newAlpha = newMissions.find((m) => m.title === "Mission Alpha")!;
    const newBeta = newMissions.find((m) => m.title === "Mission Beta")!;
    expect(newAlpha).toBeDefined();
    expect(newBeta).toBeDefined();
    expect(newAlpha.description).toBe("Alpha description");
    expect(newAlpha.acceptanceCriteria).toBe("Alpha AC");
    expect(newAlpha.priority).toBe("high");
    expect(newAlpha.labels).toEqual(["alpha", "frontend"]);
    expect(newAlpha.dueAt).toBe("2026-12-31T00:00:00.000Z");
    expect(newAlpha.columnId).toBe(newTodo.id);
    // Beta's mission-level dependency on alpha survives via the
    // `mission_dependencies` join table (the v3 import path writes edges
    // there, NOT the denormalized `missions.depends_on` JSON column —
    // architectural choice, see missions.apply + importRebuildability test).
    const betaDeps = dependencyRepo.getMissionDependencies(newBeta.id);
    expect(betaDeps.dependsOn.map((d) => d.missionId)).toContain(newAlpha.id);

    // Tasks: 3 tasks survive (2 under alpha, 1 under beta). Their portable
    // fields survive; execution state resets to pending/default per C4.
    const newAlphaTasks = taskRepo.getTasksByMissionId(newAlpha.id);
    const newBetaTasks = taskRepo.getTasksByMissionId(newBeta.id);
    expect(newAlphaTasks).toHaveLength(2);
    expect(newBetaTasks).toHaveLength(1);
    const newAlphaTask1 = newAlphaTasks.find((t) => t.title === "Alpha Task 1")!;
    const newAlphaTask2 = newAlphaTasks.find((t) => t.title === "Alpha Task 2")!;
    expect(newAlphaTask1.description).toBe("First alpha task");
    expect(newAlphaTask1.priority).toBe("high");
    expect(newAlphaTask1.requiredDomain).toBe("code_review");
    expect(newAlphaTask1.requiredCapabilities).toEqual(["review"]);
    // C4 absorption: execution state resets.
    expect(newAlphaTask1.status).toBe("pending");
    expect(newAlphaTask1.result).toBeNull();

    // Subtasks: 1 subtask survives under alphaTask1.
    const newSubtasks = subtaskRepo.getSubtasksByTaskId(newAlphaTask1.id);
    expect(newSubtasks).toHaveLength(1);
    expect(newSubtasks[0].title).toBe("Subtask A");
    expect(newSubtasks[0].order).toBe(0);

    // Task dependencies: alphaTask2 → alphaTask1 survives (re-keyed).
    const newDep = dependencyRepo.getTaskDependencies(newAlphaTask2.id);
    expect(newDep.dependsOn).toHaveLength(1);
    expect(newDep.dependsOn[0].taskId).toBe(newAlphaTask1.id);

    // Comments: 1 comment survives. The v3 import path writes task-scoped
    // portable comments into the mission-scoped `missionComments` table
    // (bridged via the task's parent mission — see comments.apply).
    const db = getDb();
    const newMissionComments = db
      .select()
      .from(missionComments)
      .where(eq(missionComments.missionId, newAlpha.id))
      .all();
    expect(newMissionComments).toHaveLength(1);
    expect(newMissionComments[0].content).toBe("First comment");
    expect(newMissionComments[0].authorType).toBe("human");
    expect(newMissionComments[0].authorId).toBe("user-1");

    // Templates: 1 default template survives.
    const newTemplates = templateRepo
      .getTemplatesByHabitatId(newHabitatId)
      .filter((t) => t.habitatId === newHabitatId);
    expect(newTemplates).toHaveLength(1);
    expect(newTemplates[0].name).toBe("Default Template");
    expect(newTemplates[0].isDefault).toBe(true);
    expect(newTemplates[0].labels).toEqual(["template"]);
  });
});

// ---------------------------------------------------------------------------
// 1b. Reverse-dependency round-trip — the T10C cold-review Finding 1/4 guard.
//
// The existing round-trip fixture (alpha high-priority + beta medium-priority
// depending on alpha) only passes pre-fix because `priorityOrderExpr` sorts
// high (1) before medium (2) — the dependent (beta) appears AFTER its target
// (alpha) in the manifest. This test seeds the UNFAVORABLE case: a critical-
// priority mission (sorts FIRST) that depends on a low-priority mission
// (sorts LAST). Before the two-pass fix in `applyMissions`, the edge INSERT
// for the critical mission would fire before the low-priority target row
// exists → `FOREIGN KEY constraint failed`. After the fix (pass 1: all rows,
// pass 2: all edges), it succeeds regardless of emission order.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — reverse-dependency round-trip (cold-review Finding 1/4)", () => {
  // Force FK ON — mirrors the main round-trip's pragma discipline. The test
  // MUST pass deterministically under better-sqlite3's always-ON enforcement.
  beforeEach(() => {
    wipeTables();
    getDb().run(sql`PRAGMA foreign_keys = ON`);
  });

  it("a forward-FK mission dependency (dependent sorts before target) round-trips with FK ON", () => {
    // --- arrange (seed source with a reverse-dependency pair) ---
    const { habitat, columns } = createHabitat({
      name: "Reverse-Dep Source",
      defaultColumns: true,
    });
    const habitatId = habitat.id;
    const todo = columns.find((c) => c.name === "Todo")!;

    // delta: low priority — the dependency TARGET. Created FIRST (so the
    // `dependsOn` FK target row exists for gamma) but assigned
    // displayOrder: 1 so it sorts LATER in the export.
    const delta = missionRepo.createMission({
      habitatId,
      columnId: todo.id,
      title: "Mission Delta",
      description: "Low-priority target",
      acceptanceCriteria: "Delta AC",
      priority: "low",
      labels: ["delta"],
      displayOrder: 1,
      createdBy: "tester",
    });
    // gamma: critical priority — the DEPENDENT. Created SECOND but assigned
    // displayOrder: 0 so it sorts FIRST in `getMissionsByHabitatId`
    // (displayOrder is the primary sort key, before priorityOrder). gamma's
    // `dependsOn` edge points to delta which appears LATER in the export —
    // the forward-FK case the two-pass `applyMissions` fix addresses.
    const gamma = missionRepo.createMission({
      habitatId,
      columnId: todo.id,
      title: "Mission Gamma",
      description: "Critical-priority dependent",
      acceptanceCriteria: "Gamma AC",
      priority: "critical",
      labels: ["gamma"],
      displayOrder: 0,
      dependsOn: [delta.id],
      createdBy: "tester",
    });

    // --- act (export source) ---
    const manifest = exportHabitatManifest(habitatId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // --- assert the manifest emission order is the UNFAVORABLE case ---
    // gamma (critical) MUST appear before delta (low) in the missions array.
    // This proves the fixture exercises the forward-FK bug class.
    const ms = manifest.domains.missions!.data;
    const gammaIdx = ms.findIndex((m) => m.sourceId === gamma.id);
    const deltaIdx = ms.findIndex((m) => m.sourceId === delta.id);
    expect(gammaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(gammaIdx).toBeLessThan(deltaIdx);
    // gamma's dependsOnSourceIds point to delta (which appears LATER).
    expect(ms[gammaIdx].dependsOnSourceIds).toEqual([delta.id]);

    // --- act (prepare + publish into a new habitat with FK ON) ---
    const preparedResult = prepareImport(prepareInput(manifest));
    expect(preparedResult.outcome).toBe("prepared");
    if (preparedResult.outcome !== "prepared") return;
    const outcome = publishImportAggregateWithClient(getDb(), {
      prepared: preparedResult.prepared,
    });

    // --- assert publication committed (the forward-FK did NOT fire) ---
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;
    const newHabitatId = outcome.habitatId;

    // Both missions survive + the gamma → delta edge survives (re-keyed).
    const { missions: newMissions } = missionRepo.getMissionsByHabitatId(newHabitatId);
    expect(newMissions).toHaveLength(2);
    const newGamma = newMissions.find((m) => m.title === "Mission Gamma")!;
    const newDelta = newMissions.find((m) => m.title === "Mission Delta")!;
    expect(newGamma).toBeDefined();
    expect(newDelta).toBeDefined();
    const gammaDeps = dependencyRepo.getMissionDependencies(newGamma.id);
    expect(gammaDeps.dependsOn.map((d) => d.missionId)).toContain(newDelta.id);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-domain emission — the manifest's portable shape matches each
//    *Portable type's fields exactly.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — per-domain emission shape", () => {
  let seeded: SeededHabitat;
  let manifest: HabitatImportManifest;

  beforeEach(() => {
    wipeTables();
    seeded = seedFullHabitat("Emission Source");
    const m = exportHabitatManifest(seeded.habitatId);
    expect(m).not.toBeNull();
    manifest = m!;
  });

  it("emits the v3 envelope (version, manifestId, generatedAt, mode, identityPolicy, lineage, domains)", () => {
    expect(manifest.version).toBe(3);
    expect(manifest.manifestId).toMatch(/^export:[^:]+:.+$/);
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/);
    expect(manifest.mode).toBe("new");
    expect(manifest.identityPolicy).toBe("remap");
    expect(manifest.lineage.sourceHabitatId).toBe(seeded.habitatId);
    expect(Object.keys(manifest.domains)).toEqual(
      expect.arrayContaining([
        "habitatSettings",
        "columns",
        "missions",
        "tasks",
        "subtasks",
        "dependencies",
        "comments",
        "templates",
      ]),
    );
  });

  it("habitatSettings envelope matches HabitatSettingsPortable", () => {
    const env = manifest.domains.habitatSettings!;
    expect(env.disposition).toBe("replace");
    expect(env.data.sourceId).toBe(seeded.habitatId);
    expect(env.data.name).toBe("Emission Source");
    expect(typeof env.data.description).toBe("string");
    // Settings is a plain JSON object (carries the public settings shape).
    expect(env.data.settings).not.toBeNull();
    expect(typeof env.data.settings).toBe("object");
    expect(Array.isArray(env.data.settings)).toBe(false);
  });

  it("columns envelope matches ColumnPortable[] (drops autoAdvance/requiresClaim; color:null drift)", () => {
    const cols = manifest.domains.columns!.data;
    expect(cols.length).toBe(4);
    const todo = cols.find((c) => c.name === "Todo")!;
    expect(todo.sourceId).toBe(seeded.columnIds.todo);
    expect(todo.order).toBe(0);
    // Drift: schema has no color column — emitted as null.
    expect(todo.color).toBeNull();
    expect(todo.wipLimit).toBeNull();
    expect(todo.isTerminal).toBe(false);
    // Drift: autoAdvance/requiresClaim are NOT emitted (ColumnPortable has
    // no slots for them).
    expect("autoAdvance" in todo).toBe(false);
    expect("requiresClaim" in todo).toBe(false);
    // Object carries exactly the ColumnPortable field set.
    expect(Object.keys(todo).sort()).toEqual(
      ["sourceId", "name", "order", "color", "wipLimit", "nextColumnName", "isTerminal"].sort(),
    );
  });

  it("missions envelope matches MissionPortable[] (UUID sourceIds + dependsOn as UUIDs)", () => {
    const ms = manifest.domains.missions!.data;
    expect(ms).toHaveLength(2);
    const alpha = ms.find((m) => m.title === "Mission Alpha")!;
    const beta = ms.find((m) => m.title === "Mission Beta")!;
    expect(alpha.sourceId).toBe(seeded.missionIds.alpha);
    expect(beta.sourceId).toBe(seeded.missionIds.beta);
    expect(alpha.columnName).toBe("Todo");
    expect(beta.columnName).toBe("In Progress");
    expect(alpha.priority).toBe("high");
    expect(alpha.labels).toEqual(["alpha", "frontend"]);
    expect(alpha.dueAt).toBe("2026-12-31T00:00:00.000Z");
    // dependsOnSourceIds carry UUIDs directly (no title-keyed resolution).
    expect(beta.dependsOnSourceIds).toEqual([seeded.missionIds.alpha]);
    expect(alpha.dependsOnSourceIds).toEqual([]);
    expect(alpha.blocksSourceIds).toEqual([]);
  });

  it("tasks envelope matches TaskPortable[] (NO execution state)", () => {
    const ts = manifest.domains.tasks!.data;
    expect(ts).toHaveLength(3);
    const alphaTask1 = ts.find((t) => t.title === "Alpha Task 1")!;
    expect(alphaTask1.sourceId).toBe(seeded.taskIds.alphaTask1);
    expect(alphaTask1.missionSourceId).toBe(seeded.missionIds.alpha);
    expect(alphaTask1.priority).toBe("high");
    expect(alphaTask1.requiredDomain).toBe("code_review");
    expect(alphaTask1.requiredCapabilities).toEqual(["review"]);
    // C4 absorption: TaskPortable has no slot for execution state.
    expect("status" in alphaTask1).toBe(false);
    expect("result" in alphaTask1).toBe(false);
    expect("artifacts" in alphaTask1).toBe(false);
    expect("createdBy" in alphaTask1).toBe(false);
    expect(Object.keys(alphaTask1).sort()).toEqual(
      [
        "sourceId",
        "missionSourceId",
        "title",
        "description",
        "priority",
        "requiredDomain",
        "requiredCapabilities",
      ].sort(),
    );
  });

  it("subtasks envelope matches SubtaskPortable[]", () => {
    const ss = manifest.domains.subtasks!.data;
    expect(ss).toHaveLength(1);
    const sub = ss[0];
    expect(sub.sourceId).toBe(seeded.subtaskIds.alphaTask1Sub1);
    expect(sub.taskSourceId).toBe(seeded.taskIds.alphaTask1);
    expect(sub.title).toBe("Subtask A");
    expect(sub.order).toBe(0);
    expect(sub.completed).toBe(false);
    expect(sub.assigneeId).toBeNull();
  });

  it("dependencies envelope matches DependencyPortable[] (kind defaults to blocks; sourceId synthesized)", () => {
    const ds = manifest.domains.dependencies!.data;
    expect(ds).toHaveLength(1);
    const dep = ds[0];
    // sourceId is synthesized deterministically from the composite key.
    expect(dep.sourceId).toBe(`dep:${seeded.taskIds.alphaTask2}:${seeded.taskIds.alphaTask1}`);
    expect(dep.taskSourceId).toBe(seeded.taskIds.alphaTask2);
    expect(dep.dependsOnTaskSourceId).toBe(seeded.taskIds.alphaTask1);
    // Drift: task_dependencies has no kind column — defaults to "blocks".
    expect(dep.kind).toBe("blocks");
    expect(Object.keys(dep).sort()).toEqual(
      ["sourceId", "taskSourceId", "dependsOnTaskSourceId", "kind"].sort(),
    );
  });

  it("comments envelope matches CommentPortable[] (native v3: resolvedActorId + importedAttribution)", () => {
    const cs = manifest.domains.comments!.data;
    expect(cs).toHaveLength(1);
    const c = cs[0];
    expect(c.sourceId).toBe(seeded.commentIds.alphaTask1Comment1);
    expect(c.taskSourceId).toBe(seeded.taskIds.alphaTask1);
    expect(c.parentCommentSourceId).toBeNull();
    expect(c.content).toBe("First comment");
    // Native v3: authorId flows into both fields (resolvedActorId is the
    // resolution key; importedAttribution is the non-empty documentary
    // fallback the validator requires).
    expect(c.author.resolvedActorId).toBe("user-1");
    expect(c.author.importedAttribution).toBe("user-1");
    expect(c.authorType).toBe("human");
    expect(typeof c.authoredAt).toBe("string");
    expect(c.authoredAt.length).toBeGreaterThan(0);
  });

  it("templates envelope matches TemplatePortable[] (single-mission synthesis)", () => {
    const ts = manifest.domains.templates!.data;
    expect(ts).toHaveLength(1);
    const t = ts[0];
    expect(t.sourceId).toBe(seeded.templateIds.default);
    expect(t.name).toBe("Default Template");
    expect(typeof t.description).toBe("string");
    expect(t.isDefault).toBe(true);
    // content.missions is the synthesized single mission carrying the
    // template's pattern fields.
    expect(t.content.missions).toHaveLength(1);
    const synth = t.content.missions[0];
    expect(synth.title).toBe("Templated Mission");
    expect(synth.priority).toBe("medium");
    expect(synth.labels).toEqual(["template"]);
    expect(synth.dependsOnSourceIds).toEqual([]);
    // content.columns is empty (v2 templates carry no column graph).
    expect(t.content.columns).toEqual([]);
    expect(t.content.labels).toEqual(["template"]);
    // Omit<MissionPortable, "sourceId" | "columnName"> — synthesized mission
    // has no sourceId and no columnName.
    expect("sourceId" in synth).toBe(false);
    expect("columnName" in synth).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Not-found.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — not-found", () => {
  it("returns null when the habitat does not exist", () => {
    expect(exportHabitatManifest("nonexistent-habitat-id")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Mode + identityPolicy override.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — mode + identityPolicy override", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("defaults to mode:'new' + identityPolicy:'remap' when no options are passed", () => {
    const seeded = seedFullHabitat("Defaults Source");
    const manifest = exportHabitatManifest(seeded.habitatId)!;
    expect(manifest.mode).toBe("new");
    expect(manifest.identityPolicy).toBe("remap");
  });

  it.each<[string, ExportHabitatManifestOptions, "new" | "replacement", "remap" | "restore"]>([
    ["new + remap", { mode: "new", identityPolicy: "remap" }, "new", "remap"],
    [
      "replacement + restore",
      { mode: "replacement", identityPolicy: "restore" },
      "replacement",
      "restore",
    ],
    ["replacement only", { mode: "replacement" }, "replacement", "remap"],
    ["restore only", { identityPolicy: "restore" }, "new", "restore"],
  ])("passes options through (%s)", (_label, opts, expectedMode, expectedPolicy) => {
    const seeded = seedFullHabitat("Override Source");
    const manifest = exportHabitatManifest(seeded.habitatId, opts)!;
    expect(manifest.mode).toBe(expectedMode);
    expect(manifest.identityPolicy).toBe(expectedPolicy);
  });
});

// ---------------------------------------------------------------------------
// 5. Lineage.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — lineage", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("carries sourceHabitatId = the input habitat's id + null sourceManifestId (first export)", () => {
    const seeded = seedFullHabitat("Lineage Source");
    const manifest = exportHabitatManifest(seeded.habitatId)!;
    expect(manifest.lineage.sourceHabitatId).toBe(seeded.habitatId);
    expect(manifest.lineage.sourceManifestId).toBeNull();
    expect(manifest.lineage.sourceExportedAt).toBe(manifest.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// 6. Manifest ID determinism.
// ---------------------------------------------------------------------------

describe("exportHabitatManifest — manifest ID determinism", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("produces manifestId of the form `export:<habitatId>:<exportedAt>`", () => {
    const seeded = seedFullHabitat("Determinism Source");
    const manifest = exportHabitatManifest(seeded.habitatId)!;
    expect(manifest.manifestId).toBe(`export:${seeded.habitatId}:${manifest.generatedAt}`);
  });

  it("produces the same manifestId when re-exported at the same instant", () => {
    const seeded = seedFullHabitat("Re-export Source");
    const fixedTime = new Date("2026-07-21T12:00:00.000Z");

    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);
    try {
      const m1 = exportHabitatManifest(seeded.habitatId)!;
      const m2 = exportHabitatManifest(seeded.habitatId)!;
      expect(m1.manifestId).toBe(m2.manifestId);
      expect(m1.generatedAt).toBe("2026-07-21T12:00:00.000Z");
      expect(m1.manifestId).toBe(`export:${seeded.habitatId}:2026-07-21T12:00:00.000Z`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("produces different manifestIds for different habitat ids (at the same instant)", () => {
    const seededA = seedFullHabitat("Habitat A");
    const seededB = seedFullHabitat("Habitat B");
    const mA = exportHabitatManifest(seededA.habitatId)!;
    const mB = exportHabitatManifest(seededB.habitatId)!;
    expect(mA.manifestId).not.toBe(mB.manifestId);
    expect(mA.manifestId).toContain(seededA.habitatId);
    expect(mB.manifestId).toContain(seededB.habitatId);
  });
});
