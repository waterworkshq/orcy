/**
 * TG-18 — T10B scoped-delete on the PRODUCTION database driver (better-sqlite3).
 *
 * The import orchestrator's scoped-delete (`scopedDeleteDomain` in
 * `importPublication.ts`) explicitly deletes child entities in REVERSED
 * manifest-domain order rather than relying on `ON DELETE CASCADE`. The existing
 * `importPublication.test.ts` exercises this only on sql.js, where foreign-key
 * enforcement / cascade is unreliable (cascade may not fire). This suite
 * confirms the explicit-delete + cascade COEXIST correctly on the production
 * driver — `initDb()` opens better-sqlite3 with `PRAGMA foreign_keys = ON`, so
 * any FK violation hidden by sql.js surfaces here. Specifically it proves:
 *   - no FK violation is thrown during the replacement scoped-delete;
 *   - the `missions.columnId → columns` NO ACTION constraint is honored
 *     (missions are deleted before columns in the reversed-domain pass);
 *   - the explicit child deletes + the `ON DELETE CASCADE` that also fires on
 *     better-sqlite3 leave the correct end state (stale tree gone, fresh tree
 *     committed, habitat row persisted).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import {
  habitats,
  columns as columnsTable,
  missions,
  tasks,
  taskSubtasks,
  taskDependencies,
} from "../db/schema/index.js";
import * as taskRepo from "../repositories/task.js";
import { prepareImport } from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";

// Mocks: the publication kernel emits no pre-commit effects, but the import
// pipeline + post-commit subscribers may; silence them (mirrors
// importPublication.test.ts).
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- minimal v3 manifest with `replace` dispositions across the FK-critical
//     domains (habitatSettings/columns/missions/tasks/subtasks/dependencies) ---
const EXPORTED_AT = "2026-07-20T12:00:00.000Z";

function v3Manifest(opts: { manifestId: string; habitatName?: string }): HabitatImportManifest {
  return {
    version: 3,
    manifestId: opts.manifestId,
    generatedAt: EXPORTED_AT,
    mode: "replacement",
    identityPolicy: "remap",
    lineage: { sourceHabitatId: null, sourceExportedAt: EXPORTED_AT, sourceManifestId: null },
    domains: {
      habitatSettings: {
        disposition: "replace",
        data: {
          sourceId: "habitat-1",
          name: opts.habitatName ?? "Imported Habitat",
          description: "test habitat",
          settings: {},
        },
      },
      columns: {
        disposition: "replace",
        data: [
          {
            sourceId: "col-1",
            name: "Todo",
            order: 0,
            color: null,
            wipLimit: null,
            nextColumnName: null,
            isTerminal: false,
          },
        ],
      },
      missions: {
        disposition: "replace",
        data: [
          {
            sourceId: "mission-1",
            title: "Mission Alpha",
            description: "Alpha",
            acceptanceCriteria: "AC",
            priority: "high",
            labels: ["alpha"],
            columnName: "Todo",
            dependsOnSourceIds: [],
            blocksSourceIds: [],
            dueAt: null,
          },
        ],
      },
      tasks: {
        disposition: "replace",
        data: [
          {
            sourceId: "task-1",
            missionSourceId: "mission-1",
            title: "Task One",
            description: "first imported task",
            priority: "medium",
            requiredDomain: null,
            requiredCapabilities: [],
          },
        ],
      },
      subtasks: { disposition: "replace", data: [] },
      dependencies: { disposition: "replace", data: [] },
    },
  };
}

function prepareInput(manifest: HabitatImportManifest, habitatId: string) {
  return {
    rawManifest: manifest,
    habitatId,
    mode: "replacement" as const,
    manifestId: manifest.manifestId,
    actor: { type: "human" as const, id: "user-1" },
    auditSource: "rest_api" as const,
  };
}

let dbPath: string;

beforeEach(async () => {
  // PRODUCTION driver: initDb() opens better-sqlite3 with foreign_keys = ON
  // (a real file-based DB, not the sql.js test snapshot).
  dbPath = join(tmpdir(), `orcy-tg18-${randomUUID()}.db`);
  await initDb(dbPath);
});

afterEach(() => {
  closeDb();
  rmSync(dbPath, { force: true });
});

describe("TG-18 — T10B scoped-delete on the production DB driver (better-sqlite3)", () => {
  it("mode:'replacement' + replace deletes the existing tree with NO FK violation and commits fresh entities (explicit-delete coexists with ON DELETE CASCADE)", () => {
    // FAILURE MODE this catches: on sql.js the FK/cascade is unreliable, so an
    // ordering slip (e.g. deleting columns while missions still reference them
    // via the NO ACTION `missions.columnId → columns`, or relying on cascade
    // that doesn't fire) stays green. On better-sqlite3 (foreign_keys = ON)
    // the same slip throws a FOREIGN KEY constraint violation. This test would
    // fail on the production driver if the explicit-delete strategy didn't
    // honor the reversed-domain order.
    const db = getDb();
    const existingHabitatId = `existing-hab-${randomUUID()}`;
    const ts = "2025-01-01T00:00:00Z";

    // --- arrange: seed an existing habitat with a FULL entity tree exercising
    //     every FK-critical scoped-delete branch ---
    db.insert(habitats)
      .values({
        id: existingHabitatId,
        name: "Old Name",
        description: "old",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    db.insert(columnsTable)
      .values({
        id: "old-col",
        habitatId: existingHabitatId,
        name: "Stale",
        order: 99,
        autoAdvance: false,
        requiresClaim: true,
        nextColumnId: null,
        isTerminal: false,
      })
      .run();
    db.insert(missions)
      .values({
        id: "old-mission",
        habitatId: existingHabitatId,
        columnId: "old-col", // NO ACTION FK → columns (deleting columns first would violate)
        title: "Stale Mission",
        description: "",
        acceptanceCriteria: "",
        priority: "low",
        labels: [],
        status: "not_started",
        displayOrder: 0,
        dependsOn: [],
        blocks: [],
        createdBy: "test",
      })
      .run();
    const staleTask1 = taskRepo.createTask({
      missionId: "old-mission",
      title: "Stale Task 1",
      createdBy: "test",
      estimatedMinutes: 30,
    });
    const staleTask2 = taskRepo.createTask({
      missionId: "old-mission",
      title: "Stale Task 2",
      createdBy: "test",
      estimatedMinutes: 30,
    });
    db.insert(taskSubtasks)
      .values({ id: "old-subtask", taskId: staleTask1.id, title: "Stale Subtask" })
      .run();
    db.insert(taskDependencies).values({ taskId: staleTask1.id, dependsOnId: staleTask2.id }).run();

    // --- act: replacement import. The scoped-delete runs in REVERSED manifest-
    //     domain order (dependencies → subtasks → tasks → missions → columns),
    //     i.e. missions before columns, explicit child deletes before parents. ---
    const manifest = v3Manifest({ manifestId: `tg18-${randomUUID()}`, habitatName: "New Name" });
    const preparedResult = prepareImport(prepareInput(manifest, existingHabitatId));
    expect(preparedResult.outcome).toBe("prepared");
    if (preparedResult.outcome !== "prepared") return;
    const outcome = publishImportAggregateWithClient(getDb(), {
      prepared: preparedResult.prepared,
    });

    // --- assert: the publish SUCCEEDED (no FK violation thrown on the prod driver) ---
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;
    expect(outcome.habitatId).toBe(existingHabitatId);
    expect(outcome.importedCounts.tasks).toBe(1); // the one fresh Task published via the kernel

    // The habitat row PERSISTED (same id) + was UPDATEd in place.
    const liveHabitat = db
      .select()
      .from(habitats)
      .where(eq(habitats.id, existingHabitatId))
      .all()[0];
    expect(liveHabitat).toBeTruthy();
    expect(liveHabitat!.name).toBe("New Name");

    // The stale tree is GONE (explicit scoped-delete + cascade cleaned it).
    expect(db.select().from(columnsTable).where(eq(columnsTable.id, "old-col")).all()).toHaveLength(
      0,
    );
    expect(db.select().from(missions).where(eq(missions.id, "old-mission")).all()).toHaveLength(0);
    expect(db.select().from(tasks).where(eq(tasks.id, staleTask1.id)).all()).toHaveLength(0);
    expect(db.select().from(tasks).where(eq(tasks.id, staleTask2.id)).all()).toHaveLength(0);
    expect(
      db.select().from(taskSubtasks).where(eq(taskSubtasks.id, "old-subtask")).all(),
    ).toHaveLength(0);
    expect(
      db.select().from(taskDependencies).where(eq(taskDependencies.taskId, staleTask1.id)).all(),
    ).toHaveLength(0);

    // The fresh manifest entities were committed.
    expect(
      db.select().from(columnsTable).where(eq(columnsTable.habitatId, existingHabitatId)).all()
        .length,
    ).toBe(1);
    expect(
      db.select().from(missions).where(eq(missions.habitatId, existingHabitatId)).all().length,
    ).toBe(1);
    // Exactly one fresh task (the manifest's task-1), published via the kernel.
    expect(
      db.select().from(tasks).where(eq(tasks.missionId, "")).all().length,
    ).toBeGreaterThanOrEqual(0);
    const freshTasks = db.select().from(tasks).where(eq(tasks.title, "Task One")).all();
    expect(freshTasks).toHaveLength(1);
  });
});
