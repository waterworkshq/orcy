/**
 * Task quality checklist-item containment — PRODUCTION DRIVER proofs
 * (better-sqlite3 file DB, repository boundary, FK enforcement asserted on).
 * Not production-driver HTTP evidence: these prove the aggregate
 * repository primitive's final-statement semantics — triple-scoped
 * UPDATE ... RETURNING, same-owned-checklist status recalculation on the
 * transaction client, late scoped-mismatch rollback, and real statement
 * faults — on the driver production serves, not only the sql.js test
 * driver. Results come from RETURNING rows only; no `.run().changes`
 * semantics anywhere. The SEAM below is in-transaction instrumentation
 * (same connection), not overlapping independent-connection concurrency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql, getTableName } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as qualityRepo from "../repositories/qualityGate.js";
import { taskQualityChecklists, taskQualityChecklistItems } from "../db/schema/index.js";
import { AppError } from "../errors.js";
import { RepositoryError } from "../errors/repository.js";

let dbFile: string;
let habitatId: string;
let colA: ReturnType<typeof seed>;
let colB: ReturnType<typeof seed>;
// GENUINE second instance checklist under colA's EXISTING Task (same
// reusable template) — asserted: equal persisted taskId, distinct ids.
let colASecond: string;

let columnOrder = 0;
function seed(title: string, opts?: { isRequired?: boolean }) {
  const template = qualityRepo.createTemplate({
    name: `tqcp-tpl-${title}`,
    category: "testing",
    isRequired: opts?.isRequired ?? true,
    items: [
      { title: `${title}::req-1`, required: true },
      { title: `${title}::req-2`, required: true },
      { title: `${title}::opt-1`, required: false },
    ],
  });
  const column = columnRepo.createColumn({
    habitatId,
    name: `tqcp-col-${title}`,
    order: ++columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `tqcp-mission-${title}`,
    createdBy: "tqcp-seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "tqcp-seed",
  });
  const checklist = qualityRepo.createTaskChecklist(task.id, template.id);
  return {
    template,
    task,
    checklist,
    items: qualityRepo.getChecklistItems(checklist.id),
  };
}
function reqItem(s: ReturnType<typeof seed>, n: 1 | 2) {
  const want = `${s.task.title}::req-${n}`;
  const tpl = qualityRepo.getTemplateItems(s.template.id).find((t) => t.title === want)!;
  return s.items.find((i) => i.itemId === tpl.id)!;
}
function itemRow(id: string) {
  return getDb()
    .select()
    .from(taskQualityChecklistItems)
    .where(eq(taskQualityChecklistItems.id, id))
    .get();
}
function checklistRow(id: string) {
  return getDb().select().from(taskQualityChecklists).where(eq(taskQualityChecklists.id, id)).get();
}
function snapshot(): unknown {
  return JSON.parse(
    JSON.stringify({
      items: getDb().select().from(taskQualityChecklistItems).all(),
      checklists: getDb().select().from(taskQualityChecklists).all(),
    }),
  );
}

/** Commissioned FK state: enforcement enabled AND functionally asserted. */
function enableFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
}
function assertFkOn(): void {
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{
    foreign_keys: number;
  }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
  expect(() =>
    getDb()
      .insert(taskQualityChecklistItems)
      .values({
        id: "tqcp-fk-probe",
        checklistId: "00000000-0000-4000-8000-0000000000f1",
        itemId: "00000000-0000-4000-8000-0000000000f2",
        isCompleted: false,
        completedBy: null,
        completedAt: null,
        evidenceUrl: null,
        notes: "",
      })
      .run(),
  ).toThrow(/FOREIGN KEY/i);
  getDb()
    .delete(taskQualityChecklistItems)
    .where(eq(taskQualityChecklistItems.id, "tqcp-fk-probe"))
    .run();
}

// ---- SEAM: proxy around the aggregate's tx client (real SQL, same tx) ------
let armed: { table: string; fire: () => void } | null = null;
function armSeam(table: string, fire: () => void): void {
  armed = { table, fire };
  const db = getDb();
  const orig = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementation(((cb: any, cfg: any) =>
    orig(
      (tx: any) =>
        cb(
          new Proxy(tx, {
            get(target, prop) {
              const value = Reflect.get(target, prop, target);
              if (prop !== "update" || typeof value !== "function") {
                return typeof value === "function" ? value.bind(target) : value;
              }
              return (...args: unknown[]) => {
                if (armed && getTableName(args[0] as never) === armed.table) {
                  const { fire: f } = armed;
                  armed = null;
                  f();
                }
                return value.apply(target, args);
              };
            },
          }),
        ),
      cfg,
    )) as never);
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tqcp-")), "orcy.db");
  await initDb(dbFile);
  enableFk();
  habitatId = habitatRepo.createHabitat({ name: "tqcp-habitat" }).id;
  colA = seed("tqcp-a");
  colB = seed("tqcp-b");
  colASecond = qualityRepo.createTaskChecklist(colA.task.id, colA.template.id).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  armed = null;
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe("PRODUCTION DRIVER — triple-scoped aggregate primitives", () => {
  it("asserts FK enforcement before fixtures", () => {
    assertFkOn();
  });

  it("matching triple: RETURNING row with camel/snake mapping, booleans and nullables; unchanged-value UPDATE also matches", () => {
    const item = reqItem(colA, 1);
    const updated = qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
      isCompleted: true,
      completedBy: "tqcp-meta",
      evidenceUrl: null,
      notes: "",
    });
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(item.id);
    expect(updated!.checklistId).toBe(colA.checklist.id);
    expect(updated!.itemId).toBe(item.itemId);
    expect(updated!.isCompleted).toBe(true);
    expect(updated!.completedBy).toBe("tqcp-meta");
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.evidenceUrl).toBeNull();
    expect(updated!.notes).toBe("");
    // Row mapping round-trips against a raw read.
    const raw = itemRow(item.id)!;
    expect(raw.isCompleted).toBe(true);
    expect(raw.completedBy).toBe("tqcp-meta");
    // Unchanged-value repeat still RETURNs the row (no .run().changes guess).
    const again = qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(again!.id).toBe(item.id);
  });

  it("same-Task second-checklist fixture is genuine (equal persisted taskId, distinct ids) and both same-Task broken pairs are null with zero mutations", () => {
    const first = qualityRepo.getTaskChecklistById(colA.checklist.id)!;
    const second = qualityRepo.getTaskChecklistById(colASecond)!;
    expect(colASecond).not.toBe(colA.checklist.id);
    expect(second.taskId).toBe(colA.task.id);
    expect(second.taskId).toBe(first.taskId);
    const secondItem = qualityRepo.getChecklistItems(colASecond)[0]!;
    const before = snapshot();
    expect(
      qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, secondItem.id, {
        isCompleted: true,
      }),
      "item of the SECOND checklist under the SAME Task",
    ).toBeNull();
    expect(
      qualityRepo.updateChecklistItem(colA.task.id, colASecond, reqItem(colA, 1).id, {
        isCompleted: true,
      }),
      "SECOND checklist of the same Task, first checklist's item",
    ).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it("mismatch/absent triple: null with zero mutations on the production driver", () => {
    const target = reqItem(colA, 1);
    const bItem = reqItem(colB, 1);
    const before = snapshot();
    const cases: Array<[string, string, string]> = [
      [colB.task.id, colA.checklist.id, target.id],
      [colA.task.id, colB.checklist.id, bItem.id],
      [colA.task.id, "00000000-0000-4000-8000-0000000000c5", target.id],
      [colA.task.id, colA.template.id, target.id],
      [colA.task.id, colA.checklist.id, target.itemId],
      [colA.task.id, colA.checklist.id, "00000000-0000-4000-8000-0000000000c6"],
      ["00000000-0000-4000-8000-0000000000c7", colA.checklist.id, target.id],
    ];
    for (const [taskId, checklistId, itemId] of cases) {
      expect(
        qualityRepo.updateChecklistItem(taskId, checklistId, itemId, {
          isCompleted: true,
          notes: "must-not-land",
        }),
      ).toBeNull();
    }
    expect(snapshot()).toEqual(before);
  });

  it("status derivation on tx: required filter, passed stamping/clearing, scoped public primitive", () => {
    const item = reqItem(colA, 1);
    qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(checklistRow(colA.checklist.id)!.status).toBe("in_progress");
    expect(checklistRow(colA.checklist.id)!.completedAt).toBeNull();

    // Optional item NOT required: completing both required is enough.
    const second = reqItem(colA, 2);
    qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, second.id, {
      isCompleted: true,
    });
    const passed = checklistRow(colA.checklist.id)!;
    expect(passed.status).toBe("passed");
    expect(passed.completedAt).not.toBeNull();
    // Checklist completedBy/notes/createdAt untouched by recalculation.
    expect(passed.completedBy).toBeNull();
    expect(passed.notes).toBe("");
    const createdBefore = passed.createdAt;

    // Uncompleting clears the stamp and drops back to in_progress.
    qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, second.id, {
      isCompleted: false,
    });
    const regressed = checklistRow(colA.checklist.id)!;
    expect(regressed.status).toBe("in_progress");
    expect(regressed.completedAt).toBeNull();
    expect(regressed.createdAt).toBe(createdBefore);

    // Public scoped primitive: wrong Task throws 404; right pair works.
    expect(() => qualityRepo.updateChecklistStatus(colB.task.id, colA.checklist.id)).toThrow(
      AppError,
    );
    expect(qualityRepo.updateChecklistStatus(colA.task.id, colA.checklist.id)).toBe("in_progress");
  });

  it("PARENT-BEFORE-ITEM: checklist moved to a foreign Task between the scoped lookup and the item UPDATE matches zero rows; the move survives, nothing recalculates", () => {
    const item = reqItem(colA, 1);
    const beforeItem = itemRow(item.id);
    const beforeParent = checklistRow(colA.checklist.id)!;
    const beforeForeign = checklistRow(colB.checklist.id)!;
    armSeam("task_quality_checklist_items", () => {
      getDb().run(
        sql`UPDATE task_quality_checklists SET task_id = ${colB.task.id} WHERE id = ${colA.checklist.id}`,
      );
    });
    const result = qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(result).toBeNull();
    expect(itemRow(item.id)).toEqual(beforeItem);
    expect(checklistRow(colA.checklist.id)).toEqual({ ...beforeParent, taskId: colB.task.id });
    expect(checklistRow(colA.checklist.id)!.status).toBe(beforeParent.status);
    expect(checklistRow(colA.checklist.id)!.completedAt).toBe(beforeParent.completedAt);
    expect(checklistRow(colB.checklist.id)).toEqual(beforeForeign);
  });

  it("late scoped status mismatch (checklist moved in-tx after item UPDATE) rolls the item back", () => {
    const item = reqItem(colA, 1);
    const before = snapshot();
    armSeam("task_quality_checklists", () => {
      getDb().run(
        sql`UPDATE task_quality_checklists SET task_id = ${colB.task.id} WHERE id = ${colA.checklist.id}`,
      );
    });
    let thrown: unknown;
    try {
      qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
        isCompleted: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("item-table statement fault wraps as RepositoryError and preserves both tables", () => {
    const item = reqItem(colA, 1);
    const before = snapshot();
    getDb().run(
      sql`CREATE TRIGGER tqcp_abort BEFORE UPDATE ON task_quality_checklist_items BEGIN SELECT RAISE(ABORT, 'tqcp item fault'); END`,
    );
    expect(() =>
      qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toThrow(RepositoryError);
    expect(snapshot()).toEqual(before);
    getDb().run(sql`DROP TRIGGER tqcp_abort`);
  });

  it("status-table statement fault AFTER a matched item UPDATE rolls the item back too", () => {
    const item = reqItem(colA, 1);
    const before = snapshot();
    getDb().run(
      sql`CREATE TRIGGER tqcp_abort BEFORE UPDATE ON task_quality_checklists BEGIN SELECT RAISE(ABORT, 'tqcp status fault'); END`,
    );
    expect(() =>
      qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toThrow(RepositoryError);
    expect(snapshot()).toEqual(before);
    getDb().run(sql`DROP TRIGGER tqcp_abort`);

    // Replay after dropping the trigger succeeds (same request, real driver).
    const ok = qualityRepo.updateChecklistItem(colA.task.id, colA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(ok!.isCompleted).toBe(true);
    expect(checklistRow(colA.checklist.id)!.status).toBe("in_progress");
  });
});
