/**
 * Task quality checklist-item containment — sql.js REAL-DB proofs at the
 * repository/service boundary (the API test driver), plus the two
 * commissioned SEAM instrumentations and real SQLite statement-fault
 * triggers.
 *
 * Scope of claims (author evidence):
 *  - `updateChecklistItem(taskId, checklistId, itemId, input)` binds the
 *    exact instance item → instance checklist → URL Task at BOTH the scoped
 *    lookup and the final UPDATE ... RETURNING predicate inside one
 *    immediate transaction, and recalculates only the same owned checklist's
 *    status on that tx; a zero-match returns null with no effects.
 *  - A late scoped status-write mismatch throws a generic 404 inside the
 *    transaction, rolling the item UPDATE back with it.
 *
 * SEAM disclosure: the postlookup-reparent and late-mismatch fixtures fire
 * real SQL through a Proxy around the aggregate's tx client, INSIDE the same
 * transaction. That is same-transaction instrumentation, not overlapping
 * HTTP concurrency from independent connections — no such claim is made
 * here. No repository/service/DB module is mocked; the spy wraps only the
 * `transaction` entry point and every delegated statement is the real
 * implementation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and, sql, getTableName, inArray } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as qualityRepo from "../repositories/qualityGate.js";
import * as qualityService from "../services/qualityGateService.js";
import { taskQualityChecklists, taskQualityChecklistItems } from "../db/schema/index.js";
import { AppError } from "../errors.js";
import { RepositoryError } from "../errors/repository.js";

let habitatId: string;
let seeded: {
  taskA: ReturnType<typeof seedQualityTask>;
  taskB: ReturnType<typeof seedQualityTask>;
  secondChecklistA: ReturnType<typeof seedQualityTask>["checklist"];
};

let columnOrder = 0;
function seedQualityTask(taskTitle: string, opts?: { isRequired?: boolean; itemCount?: number }) {
  const template = qualityRepo.createTemplate({
    name: `tqc-tpl-${taskTitle}`,
    category: "testing",
    isRequired: opts?.isRequired ?? true,
    items: [
      { title: `${taskTitle}::req-1`, required: true },
      { title: `${taskTitle}::req-2`, required: true },
      { title: `${taskTitle}::opt-1`, required: false },
    ],
  });
  const column = columnRepo.createColumn({
    habitatId,
    name: `tqc-col-${taskTitle}`,
    order: ++columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `tqc-mission-${taskTitle}`,
    createdBy: "tqc-seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: taskTitle,
    createdBy: "tqc-seed",
  });
  const checklist = qualityRepo.createTaskChecklist(task.id, template.id);
  return {
    template,
    task,
    checklist,
    items: qualityRepo.getChecklistItems(checklist.id),
  };
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
function fullSnapshot(): unknown {
  return JSON.parse(
    JSON.stringify({
      items: getDb().select().from(taskQualityChecklistItems).all(),
      checklists: getDb().select().from(taskQualityChecklists).all(),
    }),
  );
}
function reqItem(s: ReturnType<typeof seedQualityTask>, n: 1 | 2) {
  return s.items.find((i) => i.itemId === templateItemId(s, `::req-${n}`))!;
}
function templateItemId(s: ReturnType<typeof seedQualityTask>, suffix: string) {
  const title = `${s.task.title}${suffix}`;
  return qualityRepo.getTemplateItems(s.template.id).find((t) => t.title === title)!.id;
}

/** Read-only FK assertion: fails if any fixture left enforcement off. */
function assertFkOn(): void {
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{
    foreign_keys: number;
  }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
}

// ---- SEAM: proxy around the aggregate's tx client --------------------------
// Fires a callback (executing REAL SQL on the same connection, joining the
// open transaction) at the first `.update(<table>)` builder call, i.e. after
// the scoped lookup SELECT has run and immediately before that statement's
// SQL is built. The delegated call is always the real implementation.
type Interpose = () => void;
let armed: { table: string; fire: Interpose } | null = null;

function armSeam(table: string, fire: Interpose): void {
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

beforeEach(() => {
  return initTestDb().then(() => {
    // Commissioned FK-integrity state: enforcement explicitly enabled (and
    // asserted below) BEFORE fixtures are created on the sql.js test driver.
    getDb().run(sql`PRAGMA foreign_keys = ON`);
    habitatId = habitatRepo.createHabitat({ name: "tqc-habitat" }).id;
    const taskA = seedQualityTask("tqc-a");
    seeded = {
      taskA,
      taskB: seedQualityTask("tqc-b"),
      // GENUINE second instance checklist under the EXISTING Task A (same
      // reusable template) — asserted below: equal persisted taskId, distinct
      // checklist ids, nonempty item rows.
      secondChecklistA: qualityRepo.createTaskChecklist(taskA.task.id, taskA.template.id),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  armed = null;
  closeDb();
});

describe("quality item containment — sql.js repository/service proofs", () => {
  it("enforces foreign keys before fixtures (read-only assertion)", () => {
    assertFkOn();
  });

  it("same-Task second-checklist fixture is genuine: equal persisted taskId, distinct checklist ids, nonempty items", () => {
    const { taskA, secondChecklistA } = seeded;
    const first = qualityRepo.getTaskChecklistById(taskA.checklist.id)!;
    const second = qualityRepo.getTaskChecklistById(secondChecklistA.id)!;
    expect(secondChecklistA.id).not.toBe(taskA.checklist.id);
    expect(first.taskId).toBe(taskA.task.id);
    expect(second.taskId).toBe(taskA.task.id);
    expect(second.taskId).toBe(first.taskId);
    expect(qualityRepo.getChecklistItems(secondChecklistA.id).length).toBeGreaterThan(0);
  });

  it("exact triple updates the item, returns the RETURNING row, and recalculates only the owned checklist", () => {
    const { taskA } = seeded;
    const first = reqItem(taskA, 1);

    const updated = qualityService.updateChecklistItem(
      taskA.task.id,
      taskA.checklist.id,
      first.id,
      { isCompleted: true, completedBy: "tqc-meta", evidenceUrl: "https://ci.test/1", notes: "n1" },
    );

    // Exact persisted projection from UPDATE RETURNING (template-item itemId).
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(first.id);
    expect(updated!.checklistId).toBe(taskA.checklist.id);
    expect(updated!.itemId).toBe(first.itemId);
    expect(updated!.isCompleted).toBe(true);
    expect(updated!.completedBy).toBe("tqc-meta");
    expect(updated!.completedAt).not.toBeNull();
    expect(updated!.evidenceUrl).toBe("https://ci.test/1");
    expect(updated!.notes).toBe("n1");

    // Partial completion → in_progress, no completedAt stamp yet.
    const row = checklistRow(taskA.checklist.id);
    expect(row!.status).toBe("in_progress");
    expect(row!.completedAt).toBeNull();

    // Second required item completes the checklist → passed + stamp.
    const second = reqItem(taskA, 2);
    qualityService.updateChecklistItem(taskA.task.id, taskA.checklist.id, second.id, {
      isCompleted: true,
    });
    const passed = checklistRow(taskA.checklist.id);
    expect(passed!.status).toBe("passed");
    expect(passed!.completedAt).not.toBeNull();
    const opt = taskA.items.find((i) => i.itemId === templateItemId(taskA, "::opt-1"))!;
    // Optional template item left incomplete does NOT block passed/validate
    // for the FIRST checklist — but the genuine second checklist under the
    // SAME Task (same REQUIRED template, still incomplete) legitimately
    // blocks task-level validation until its required items complete too.
    expect(qualityService.validateQualityGates(taskA.task.id).passed).toBe(false);
    for (const i of qualityRepo.getChecklistItems(seeded.secondChecklistA.id)) {
      const tplItem = qualityRepo
        .getTemplateItems(taskA.template.id)
        .find((t) => t.id === i.itemId)!;
      if (tplItem.required) {
        qualityService.updateChecklistItem(taskA.task.id, seeded.secondChecklistA.id, i.id, {
          isCompleted: true,
        });
      }
    }
    expect(qualityService.validateQualityGates(taskA.task.id).passed).toBe(true);
    qualityService.updateChecklistItem(taskA.task.id, taskA.checklist.id, opt.id, {
      isCompleted: true,
    });
    expect(qualityService.validateQualityGates(taskA.task.id).passed).toBe(true);

    // Unrelated checklist under B untouched.
    expect(checklistRow(seeded.taskB.checklist.id)!.status).toBe("pending");
  });

  it("every broken containment relation returns null with zero mutations and no foreign recalculation", () => {
    const { taskA, taskB } = seeded;
    const target = reqItem(taskA, 1);
    const bItem = reqItem(taskB, 1);

    // Distinguishable nonempty status/stamps on EVERY checklist involved
    // (both same-Task checklists and the foreign one) so any wrongful
    // recalculation is detectable.
    getDb()
      .update(taskQualityChecklists)
      .set({ status: "in_progress", completedAt: "2000-01-01T00:00:00.000Z" })
      .where(
        inArray(taskQualityChecklists.id, [
          taskA.checklist.id,
          seeded.secondChecklistA.id,
          taskB.checklist.id,
        ]),
      )
      .run();

    const cases: Array<[string, string, string, string]> = [
      ["wrong Task, correct child pair", taskB.task.id, taskA.checklist.id, target.id],
      ["right Task, checklist of another Task", taskA.task.id, taskB.checklist.id, bItem.id],
      [
        "right Task+checklist, item of the SECOND checklist under the SAME Task",
        taskA.task.id,
        taskA.checklist.id,
        qualityRepo.getChecklistItems(seeded.secondChecklistA.id)[0]!.id,
      ],
      [
        "right Task, SECOND checklist of the same Task, first checklist's item",
        taskA.task.id,
        seeded.secondChecklistA.id,
        target.id,
      ],
      [
        "nonexistent checklist, known item",
        taskA.task.id,
        "00000000-0000-4000-8000-0000000000c1",
        target.id,
      ],
      ["template id used as checklist id", taskA.task.id, taskA.template.id, target.id],
      ["template-item id used as item id", taskA.task.id, taskA.checklist.id, target.itemId],
      ["absent item", taskA.task.id, taskA.checklist.id, "00000000-0000-4000-8000-0000000000c2"],
      [
        "absent Task, otherwise exact triple",
        "00000000-0000-4000-8000-0000000000c3",
        taskA.checklist.id,
        target.id,
      ],
    ];

    const before = fullSnapshot();
    for (const [label, taskId, checklistId, itemId] of cases) {
      expect(
        qualityService.updateChecklistItem(taskId, checklistId, itemId, {
          isCompleted: true,
          notes: `must-not-land-${label}`,
        }),
        label,
      ).toBeNull();
    }
    expect(fullSnapshot()).toEqual(before);
  });

  it("mapper semantics: true/false stamps, null clears, empty strings, omission preserves, unknown keys ignored, unchanged values succeed", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    const put = (input: Record<string, unknown>) =>
      qualityService.updateChecklistItem(
        taskA.task.id,
        taskA.checklist.id,
        item.id,
        input as never,
      );

    // true without completedBy stores null metadata and fresh stamp.
    put({ isCompleted: true });
    let row = itemRow(item.id)!;
    expect(row.isCompleted).toBe(true);
    expect(row.completedBy).toBeNull();
    const stampOne = row.completedAt;
    expect(stampOne).not.toBeNull();

    // Explicit null completedBy while completing stays null.
    put({ isCompleted: true, completedBy: null });
    expect(itemRow(item.id)!.completedBy).toBeNull();

    // completedBy string sticks; evidence/notes set.
    put({
      isCompleted: true,
      completedBy: "tqc-author",
      evidenceUrl: "https://e.test/a",
      notes: "note",
    });
    row = itemRow(item.id)!;
    expect(row.completedBy).toBe("tqc-author");
    expect(row.evidenceUrl).toBe("https://e.test/a");
    expect(row.notes).toBe("note");

    // Null evidence clears the nullable column; empty string is verbatim.
    put({ evidenceUrl: null });
    expect(itemRow(item.id)!.evidenceUrl).toBeNull();
    put({ evidenceUrl: "" });
    expect(itemRow(item.id)!.evidenceUrl).toBe("");
    put({ notes: "" });
    expect(itemRow(item.id)!.notes).toBe("");

    // completedBy/evidence WITHOUT isCompleted leaves completion metadata alone.
    const stamped = itemRow(item.id)!;
    put({ completedBy: "tqc-other", evidenceUrl: "https://e.test/b" });
    const after = itemRow(item.id)!;
    expect(after.isCompleted).toBe(true);
    expect(after.completedBy).toBe(stamped.completedBy);
    expect(after.completedAt).toBe(stamped.completedAt);
    expect(after.evidenceUrl).toBe("https://e.test/b");

    // Unknown keys are inert at the service boundary (route strips them).
    put({ isCompleted: true, rogueField: "x" } as never);
    expect(itemRow(item.id)!.isCompleted).toBe(true);

    // Unchanged-value update still succeeds.
    expect(put({ isCompleted: true })!.id).toBe(item.id);

    // false clears completion metadata.
    put({ isCompleted: false });
    row = itemRow(item.id)!;
    expect(row.isCompleted).toBe(false);
    expect(row.completedBy).toBeNull();
    expect(row.completedAt).toBeNull();
  });

  it("status derivation: optional template counts all items; null-template instance considers ALL instance items (no per-item lookup); zero qualifying items is pending", () => {
    // Optional template: the optional-only item drives in_progress.
    const opt = seedQualityTask("tqc-opttpl", { isRequired: false });
    const optItem = opt.items.find((i) => i.itemId === templateItemId(opt, "::opt-1"))!;
    qualityRepo.updateChecklistItem(opt.task.id, opt.checklist.id, optItem.id, {
      isCompleted: true,
    });
    expect(checklistRow(opt.checklist.id)!.status).toBe("in_progress");
    for (const i of qualityRepo.getChecklistItems(opt.checklist.id)) {
      qualityRepo.updateChecklistItem(opt.task.id, opt.checklist.id, i.id, { isCompleted: true });
    }
    expect(checklistRow(opt.checklist.id)!.status).toBe("passed");

    // Null-template-INSTANCE branch (raw template_id cleared, FK-valid): the
    // repository sees no template and directly considers ALL instance items —
    // NO per-item template lookup and NO required-default run in this branch
    // (the report's separate `required ?? true` projection is not what this
    // status derivation executes). No template-item row is removed (normal
    // template deletion cascades the completion rows); no dangling-FK fixture.
    const nullTemplate = seedQualityTask("tqc-nulltemplate");
    getDb()
      .update(taskQualityChecklists)
      .set({ templateId: null })
      .where(eq(taskQualityChecklists.id, nullTemplate.checklist.id))
      .run();
    const first = reqItem(nullTemplate, 1);
    qualityRepo.updateChecklistItem(nullTemplate.task.id, nullTemplate.checklist.id, first.id, {
      isCompleted: true,
    });
    expect(checklistRow(nullTemplate.checklist.id)!.status).toBe("in_progress");
    for (const i of qualityRepo.getChecklistItems(nullTemplate.checklist.id)) {
      qualityRepo.updateChecklistItem(nullTemplate.task.id, nullTemplate.checklist.id, i.id, {
        isCompleted: true,
      });
    }
    expect(checklistRow(nullTemplate.checklist.id)!.status).toBe("passed");

    // Zero qualifying items stays pending (no synthetic recalc elsewhere).
    const empty = seedQualityTask("tqc-empty");
    getDb()
      .delete(taskQualityChecklistItems)
      .where(eq(taskQualityChecklistItems.checklistId, empty.checklist.id))
      .run();
    expect(qualityRepo.updateChecklistStatus(empty.task.id, empty.checklist.id)).toBe("pending");
  });

  it("public updateChecklistStatus is Task-scoped: wrong pair throws a generic 404, never synthetic pending", () => {
    const { taskA, taskB } = seeded;
    expect(() => qualityRepo.updateChecklistStatus(taskB.task.id, taskA.checklist.id)).toThrow(
      AppError,
    );
    try {
      qualityRepo.updateChecklistStatus(taskB.task.id, taskA.checklist.id);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(404);
    }
    expect(() =>
      qualityRepo.updateChecklistStatus(taskA.task.id, "00000000-0000-4000-8000-0000000000c4"),
    ).toThrow(AppError);
    // The correctly owned pair still works.
    expect(qualityRepo.updateChecklistStatus(taskA.task.id, taskA.checklist.id)).toBe("pending");
  });
});

describe("SEAM — postlookup mutation defeats the final SQL predicate (in-transaction instrumentation)", () => {
  it("item reparented to another checklist (same Task) between scoped lookup and UPDATE matches zero rows", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    const before = fullSnapshot();

    armSeam("task_quality_checklist_items", () => {
      getDb().run(
        sql`UPDATE task_quality_checklist_items SET checklist_id = ${seeded.secondChecklistA.id} WHERE id = ${item.id}`,
      );
    });

    const result = qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(result).toBeNull();

    // No recalculation happened anywhere; only the competing writer's own
    // reparent persists (tx committed the callback's return-null path).
    const after = JSON.parse(JSON.stringify(fullSnapshot()));
    expect(after.items.find((i: any) => i.id === item.id).checklistId).toBe(
      seeded.secondChecklistA.id,
    );
    expect(after.items.find((i: any) => i.id === item.id).isCompleted).toBe(false);
    for (const cl of after.checklists as any[]) {
      expect(cl.status).toBe("pending");
      expect(cl.completedAt).toBeNull();
    }
    void before;
  });

  it("PARENT-BEFORE-ITEM: checklist moved to a FOREIGN Task between the scoped lookup and the item UPDATE matches zero rows; the seam's move survives and nothing recalculates", () => {
    const { taskA, taskB } = seeded;
    const item = reqItem(taskA, 1);
    const beforeItem = itemRow(item.id);
    const beforeParent = checklistRow(taskA.checklist.id)!;
    const beforeForeign = checklistRow(taskB.checklist.id)!;

    armSeam("task_quality_checklist_items", () => {
      getDb().run(
        sql`UPDATE task_quality_checklists SET task_id = ${taskB.task.id} WHERE id = ${taskA.checklist.id}`,
      );
    });

    const result = qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
      isCompleted: true,
    });
    // The final item predicate (EXISTS on checklist.id AND checklist.task_id)
    // zero-matches AFTER the positive lookup: no write, no effects.
    expect(result).toBeNull();
    expect(itemRow(item.id)).toEqual(beforeItem);
    // The competing writer's reparent persists (null-return commits the tx);
    // this is NOT a status-late throw/rollback faking an item fence.
    expect(checklistRow(taskA.checklist.id)).toEqual({ ...beforeParent, taskId: taskB.task.id });
    // No checklist — moved or foreign — was recalculated.
    expect(checklistRow(taskA.checklist.id)!.status).toBe(beforeParent.status);
    expect(checklistRow(taskA.checklist.id)!.completedAt).toBe(beforeParent.completedAt);
    expect(checklistRow(taskB.checklist.id)).toEqual(beforeForeign);
  });

  it("item reparented into a FOREIGN Task's checklist matches zero rows; the foreign owner row is preserved", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    armSeam("task_quality_checklist_items", () => {
      getDb().run(
        sql`UPDATE task_quality_checklist_items SET checklist_id = ${seeded.taskB.checklist.id} WHERE id = ${item.id}`,
      );
    });
    expect(
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toBeNull();
    expect(itemRow(item.id)!.checklistId).toBe(seeded.taskB.checklist.id);
    expect(itemRow(item.id)!.isCompleted).toBe(false);
    expect(checklistRow(seeded.taskB.checklist.id)!.status).toBe("pending");
  });

  it("item REMOVED between scoped lookup and UPDATE matches zero rows with no effects", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    armSeam("task_quality_checklist_items", () => {
      getDb().run(sql`DELETE FROM task_quality_checklist_items WHERE id = ${item.id}`);
    });
    expect(
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toBeNull();
    expect(itemRow(item.id)).toBeUndefined();
    expect(checklistRow(taskA.checklist.id)!.status).toBe("pending");
  });

  it("checklist moved to another Task after the item UPDATE forces the scoped status write to throw and rolls the item back", () => {
    const { taskA, taskB } = seeded;
    const item = reqItem(taskA, 1);
    const snapshot = fullSnapshot();

    armSeam("task_quality_checklists", () => {
      getDb().run(
        sql`UPDATE task_quality_checklists SET task_id = ${taskB.task.id} WHERE id = ${taskA.checklist.id}`,
      );
    });

    let thrown: unknown;
    try {
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      });
    } catch (err) {
      thrown = err;
    }
    // Generic 404 from INSIDE the transaction; item + parent both rolled back
    // to the pretransaction snapshot (the seam's own move rolls back too).
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(404);
    expect(fullSnapshot()).toEqual(snapshot);
  });

  it("checklist DELETED after the item UPDATE forces rollback of the committed-in-tx item change", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    const snapshot = fullSnapshot();
    armSeam("task_quality_checklists", () => {
      getDb().run(sql`DELETE FROM task_quality_checklists WHERE id = ${taskA.checklist.id}`);
    });
    expect(() =>
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toThrow(AppError);
    expect(fullSnapshot()).toEqual(snapshot);
  });
});

describe("real statement faults — sql.js BEFORE UPDATE abort triggers", () => {
  const drop = () => getDb().run(sql`DROP TRIGGER IF EXISTS tqc_abort`);
  afterEach(drop);

  it("item-table fault after a matched lookup wraps as RepositoryError and changes nothing", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    const snapshot = fullSnapshot();
    getDb().run(
      sql`CREATE TRIGGER tqc_abort BEFORE UPDATE ON task_quality_checklist_items BEGIN SELECT RAISE(ABORT, 'tqc item fault'); END`,
    );
    expect(() =>
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toThrow(RepositoryError);
    expect(fullSnapshot()).toEqual(snapshot);
  });

  it("status-table fault AFTER the item UPDATE matched rolls the item change back too", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    const snapshot = fullSnapshot();
    getDb().run(
      sql`CREATE TRIGGER tqc_abort BEFORE UPDATE ON task_quality_checklists BEGIN SELECT RAISE(ABORT, 'tqc status fault'); END`,
    );
    expect(() =>
      qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
        isCompleted: true,
      }),
    ).toThrow(RepositoryError);
    expect(fullSnapshot()).toEqual(snapshot);
  });

  it("dropping the trigger lets the identical request succeed", () => {
    const { taskA } = seeded;
    const item = reqItem(taskA, 1);
    drop();
    const ok = qualityRepo.updateChecklistItem(taskA.task.id, taskA.checklist.id, item.id, {
      isCompleted: true,
    });
    expect(ok!.isCompleted).toBe(true);
    expect(checklistRow(taskA.checklist.id)!.status).toBe("in_progress");
  });
});
