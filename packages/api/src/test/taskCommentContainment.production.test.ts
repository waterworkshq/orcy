/**
 * Task comment containment — PRODUCTION DRIVER proofs (better-sqlite3 file
 * DB, repository boundary, FK enforcement on). Not production-driver HTTP
 * evidence: these prove the repository primitives' final-statement
 * semantics — required pair+typed-author UPDATE/DELETE RETURNING, the
 * conditional reply INSERT, the recursive-UNION cascade fence, trigger
 * faults, and the deeper-than-SQLITE_MAX_TRIGGER_DEPTH native FK recursion
 * fault (wrapped, statement rollback) — on the driver production serves,
 * not only the sql.js test driver. No `.run().changes` semantics anywhere:
 * results come from RETURNING rows only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as commentRepo from "../repositories/comment.js";
import { taskComments, taskCommentMentions } from "../db/schema/index.js";
import * as commentMentionRepo from "../repositories/commentMention.js";
import { RepositoryError } from "../errors/repository.js";

let dbFile: string;
let habitatId: string;
let taskIdA: string;
let taskIdB: string;
const AUTHOR = { authorType: "agent" as const, authorId: "tcp-author" };

let columnOrder = 0;
function makeTask(title: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "tcp-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tcp-seed" }).id;
}

function seed(taskId: string, content: string, parentId: string | null = null): string {
  return commentRepo.createComment({
    taskId,
    content,
    parentId,
    authorType: AUTHOR.authorType,
    authorId: AUTHOR.authorId,
  }).id;
}

function row(commentId: string) {
  return getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).get();
}

function rowsFor(taskId: string) {
  return getDb().select().from(taskComments).where(eq(taskComments.taskId, taskId)).all();
}

/** Cross-Task parent links are legal under the simple self-FK (parent exists) with enforcement ON. */
function rawCrossTaskChild(parentId: string, taskId: string): string {
  const id = `tcp-cross-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .insert(taskComments)
    .values({
      id,
      taskId,
      parentId,
      authorType: "agent",
      authorId: AUTHOR.authorId,
      content: "foreign",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

/**
 * Commissioned FK-integrity proof state on the production driver: enforcement
 * explicitly enabled and asserted (PRAGMA + functional missing-Task INSERT)
 * BEFORE legal cross-Task/cycle/deep fixtures are created.
 */
function enableFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
}

/** READ-ONLY enforcement assertion: if a statement or fixture left FK off, this fails instead of masking it. */
function assertFkOn(): void {
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
  expect(() =>
    getDb()
      .insert(taskComments)
      .values({
        id: `tcp-fk-probe-${Math.random().toString(36).slice(2, 8)}`,
        taskId: "00000000-0000-4000-8000-0000000000ff",
        parentId: null,
        authorType: "agent",
        authorId: "tcp-fk-probe",
        content: "fk enforcement check",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run(),
  ).toThrow(/FOREIGN KEY/i);
}

/** Seeds a nonempty mention row on a comment (the durable mention projection). */
function seedMention(commentId: string, name: string): string {
  return commentMentionRepo.createMentions([
    {
      commentId,
      mentionedType: "human",
      mentionedId: `mention-user-${name}`,
      mentionText: `@${name}`,
    },
  ])[0]!.id;
}

/** Closure-wide full snapshot: comment rows (content+timestamps) plus every mention row. */
function closureSnapshot(ids: string[]) {
  return JSON.parse(
    JSON.stringify({
      comments: ids.map((id) => row(id)),
      mentions: getDb().select().from(taskCommentMentions).all(),
    }),
  );
}

function mentionsFor(commentId: string) {
  return getDb()
    .select()
    .from(taskCommentMentions)
    .where(eq(taskCommentMentions.commentId, commentId))
    .all();
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tcp-")), "orcy.db");
  await initDb(dbFile);
  habitatId = habitatRepo.createHabitat({ name: "tcp-habitat" }).id;
  taskIdA = makeTask("tcp-a");
  taskIdB = makeTask("tcp-b");
});

afterEach(() => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe("PRODUCTION DRIVER — required pair + typed author primitives", () => {
  it("createReplyComment: matched conditional INSERT returns the reply row; missing/wrong-Task parent returns null with no row", () => {
    const parent = seed(taskIdA, "parent");
    const reply = commentRepo.createReplyComment({
      taskId: taskIdA,
      parentId: parent,
      authorType: AUTHOR.authorType,
      authorId: AUTHOR.authorId,
      content: "reply",
    });
    expect(reply).not.toBeNull();
    expect(reply!.taskId).toBe(taskIdA);
    expect(reply!.parentId).toBe(parent);
    expect(reply!.content).toBe("reply");
    expect((reply as any).mentions).toEqual([]);

    // Wrong-Task parent (raw-created under B): zero rows.
    const bParent = seed(taskIdB, "b-parent");
    expect(
      commentRepo.createReplyComment({
        taskId: taskIdA,
        parentId: bParent,
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "cross",
      }),
    ).toBeNull();
    expect(rowsFor(taskIdA)).toHaveLength(2);

    expect(
      commentRepo.createReplyComment({
        taskId: taskIdA,
        parentId: "00000000-0000-4000-8000-0000000000c9",
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "orphan",
      }),
    ).toBeNull();
    expect(rowsFor(taskIdA)).toHaveLength(2);
  }, 30_000);

  it("updateComment: exact pair+typed author matches with NONEMPTY mention projection; unchanged-content control still succeeds; wrong Task/author/absent all match zero and leave the row+mentions untouched", () => {
    const comment = seed(taskIdA, "original");
    const mentionId = seedMention(comment, "update-mention");
    const matched = commentRepo.updateComment(
      taskIdA,
      comment,
      AUTHOR.authorType,
      AUTHOR.authorId,
      "driven",
    );
    expect(matched).not.toBeNull();
    expect(matched!.content).toBe("driven");
    expect(matched!.taskId).toBe(taskIdA);
    expect((matched as any).mentions.map((m: any) => m.id)).toEqual([mentionId]);
    expect((matched as any).mentions[0].mentionText).toBe("@update-mention");

    // Unchanged-content control: the same values remain a matched success.
    const again = commentRepo.updateComment(
      taskIdA,
      comment,
      AUTHOR.authorType,
      AUTHOR.authorId,
      "driven",
    );
    expect(again).not.toBeNull();
    expect((again as any).mentions).toHaveLength(1);

    expect(
      commentRepo.updateComment(taskIdB, comment, AUTHOR.authorType, AUTHOR.authorId, "x"),
    ).toBeNull();
    expect(
      commentRepo.updateComment(taskIdA, comment, AUTHOR.authorType, "other-author", "x"),
    ).toBeNull();
    expect(commentRepo.updateComment(taskIdA, comment, "human", AUTHOR.authorId, "x")).toBeNull();
    expect(
      commentRepo.updateComment(
        taskIdA,
        "00000000-0000-4000-8000-0000000000c1",
        AUTHOR.authorType,
        AUTHOR.authorId,
        "x",
      ),
    ).toBeNull();
    // None of the mismatched attempts touched the row or its mention rows.
    expect(row(comment)!.content).toBe("driven");
    expect(mentionsFor(comment).map((m) => m.id)).toEqual([mentionId]);
  }, 30_000);

  it("deleteComment: wrong Task/author/absent all false; exact pair true; repeat false", () => {
    const comment = seed(taskIdA, "to-delete");

    expect(commentRepo.deleteComment(taskIdB, comment, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
    expect(commentRepo.deleteComment(taskIdA, comment, AUTHOR.authorType, "other")).toBe(false);
    expect(commentRepo.deleteComment(taskIdA, comment, "human", AUTHOR.authorId)).toBe(false);
    expect(row(comment)).toBeDefined();

    expect(commentRepo.deleteComment(taskIdA, comment, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      true,
    );
    expect(row(comment)).toBeUndefined();
    expect(commentRepo.deleteComment(taskIdA, comment, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
  }, 30_000);

  it("UPDATE/DELETE/INSERT abort triggers propagate as wrapped RepositoryError with the row preserved — never false success or zero-match", () => {
    const comment = seed(taskIdA, "fault-target");
    const parent = seed(taskIdA, "fault-parent");
    const db = getDb();

    db.run(
      sql`CREATE TRIGGER tcp_update_fault BEFORE UPDATE ON task_comments BEGIN SELECT RAISE(ABORT, 'prod update failure'); END`,
    );
    expect(() =>
      commentRepo.updateComment(taskIdA, comment, AUTHOR.authorType, AUTHOR.authorId, "x"),
    ).toThrow(RepositoryError);
    db.run(sql`DROP TRIGGER tcp_update_fault`);

    db.run(
      sql`CREATE TRIGGER tcp_delete_fault BEFORE DELETE ON task_comments BEGIN SELECT RAISE(ABORT, 'prod delete failure'); END`,
    );
    expect(() =>
      commentRepo.deleteComment(taskIdA, comment, AUTHOR.authorType, AUTHOR.authorId),
    ).toThrow(RepositoryError);
    expect(row(comment)).toBeDefined();
    db.run(sql`DROP TRIGGER tcp_delete_fault`);

    db.run(
      sql`CREATE TRIGGER tcp_insert_fault BEFORE INSERT ON task_comments BEGIN SELECT RAISE(ABORT, 'prod insert failure'); END`,
    );
    expect(() =>
      commentRepo.createReplyComment({
        taskId: taskIdA,
        parentId: parent,
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "reply",
      }),
    ).toThrow(RepositoryError);
    expect(rowsFor(taskIdA)).toHaveLength(2);
    db.run(sql`DROP TRIGGER tcp_insert_fault`);

    // Replay without the triggers succeeds.
    expect(
      commentRepo.createReplyComment({
        taskId: taskIdA,
        parentId: parent,
        authorType: AUTHOR.authorType,
        authorId: AUTHOR.authorId,
        content: "reply",
      }),
    ).not.toBeNull();
  }, 30_000);
});

describe("PRODUCTION DRIVER — cascade fence and recursion characterization", () => {
  it("raw cross-Task immediate child and deep foreign chain: DELETE matches zero with every row preserved (FK asserted ON); positive mixed-author same-Task tree still cascades INCLUDING mention rows", () => {
    enableFk();
    assertFkOn();
    const root = seed(taskIdA, "fence-root");
    const sameTaskChild = seed(taskIdA, "fence-child", root);
    seedMention(root, "fence-root-m");
    seedMention(sameTaskChild, "fence-child-m");
    const foreignChild = rawCrossTaskChild(sameTaskChild, taskIdB);
    const foreignGrandchild = rawCrossTaskChild(foreignChild, taskIdB);
    const closure = [root, sameTaskChild, foreignChild, foreignGrandchild];
    const fullBefore = JSON.parse(
      JSON.stringify({
        comments: closure.map((id) => row(id)),
        mentions: getDb().select().from(taskCommentMentions).all(),
      }),
    );

    expect(commentRepo.deleteComment(taskIdA, root, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
    // FULL nonempty snapshot equality over the entire rejected closure:
    // comment rows (content + timestamps) and every mention row.
    expect(
      JSON.parse(
        JSON.stringify({
          comments: closure.map((id) => row(id)),
          mentions: getDb().select().from(taskCommentMentions).all(),
        }),
      ),
    ).toEqual(fullBefore);
    expect(rowsFor(taskIdA)).toHaveLength(2);

    // Positive: same-Task mixed-author tree cascades on root deletion,
    // removing reply comment rows AND their mention rows.
    const root2 = seed(taskIdA, "fence-root-2");
    const reply = commentRepo.createComment({
      taskId: taskIdA,
      content: "other-author-reply",
      parentId: root2,
      authorType: "human",
      authorId: "human-author",
    }).id;
    const cascadeMention = seedMention(reply, "cascade-mention");
    // Pass-through recorder on the live db.all: observes the REAL raw
    // result of the deleting statement without replacing any SQL. The
    // RETURNING set must be the SELECTED ROOT ID ONLY — cascaded
    // descendants are FK work, never RETURNING rows.
    const db = getDb();
    const origAll = db.all.bind(db);
    const rawResults: unknown[] = [];
    db.all = ((...args: unknown[]) => {
      const result = (origAll as (...a: unknown[]) => unknown)(...args);
      rawResults.push(result);
      return result;
    }) as typeof db.all;
    let matched: boolean | undefined;
    try {
      matched = commentRepo.deleteComment(taskIdA, root2, AUTHOR.authorType, AUTHOR.authorId);
    } finally {
      db.all = origAll;
    }
    expect(matched).toBe(true);
    expect(rawResults).toHaveLength(1);
    expect(rawResults[0]).toEqual([{ id: root2 }]);
    expect(rowsFor(taskIdA)).toHaveLength(2); // root + child from the rejected tree only
    expect(row(reply)).toBeUndefined();
    expect(mentionsFor(reply)).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(taskCommentMentions)
        .where(eq(taskCommentMentions.id, cascadeMention))
        .all(),
    ).toHaveLength(0);
    assertFkOn();
  }, 30_000);

  it("cross-Task parent cycle: UNION closure terminates and rejects; same-Task cycle deletes through", () => {
    enableFk();
    assertFkOn();
    const ca = seed(taskIdA, "cycle-a");
    const cb = seed(taskIdB, "cycle-b");
    const db = getDb();
    db.update(taskComments).set({ parentId: cb }).where(eq(taskComments.id, ca)).run();
    db.update(taskComments).set({ parentId: ca }).where(eq(taskComments.id, cb)).run();
    assertFkOn();

    expect(commentRepo.deleteComment(taskIdA, ca, AUTHOR.authorType, AUTHOR.authorId)).toBe(false);
    expect(row(ca)).toBeDefined();
    expect(row(cb)).toBeDefined();

    const s1 = seed(taskIdA, "same-cycle-1");
    const s2 = seed(taskIdA, "same-cycle-2");
    db.update(taskComments).set({ parentId: s2 }).where(eq(taskComments.id, s1)).run();
    db.update(taskComments).set({ parentId: s1 }).where(eq(taskComments.id, s2)).run();
    assertFkOn();

    seedMention(s1, "cycle-m");
    expect(commentRepo.deleteComment(taskIdA, s1, AUTHOR.authorType, AUTHOR.authorId)).toBe(true);
    expect(row(s1)).toBeUndefined();
    expect(row(s2)).toBeUndefined();
    expect(mentionsFor(s1)).toHaveLength(0);
    assertFkOn();
  }, 30_000);

  it("ONE-ROW self-cycle (parentId === own id) with a foreign-Task descendant: closure terminates, rejects, FULL comment/mention/timestamp snapshots preserved", () => {
    enableFk();
    assertFkOn();
    const selfRow = seed(taskIdA, "tcp-selfrow-comment");
    seedMention(selfRow, "selfrow-m");
    // parentId === the same row's own ID: legal under the simple self-FK
    // (the parent row exists — itself) with enforcement ON.
    getDb().update(taskComments).set({ parentId: selfRow }).where(eq(taskComments.id, selfRow)).run();
    assertFkOn();
    const foreign = rawCrossTaskChild(selfRow, taskIdB);
    const before = closureSnapshot([selfRow, foreign]);

    expect(commentRepo.deleteComment(taskIdA, selfRow, AUTHOR.authorType, AUTHOR.authorId)).toBe(false);
    expect(closureSnapshot([selfRow, foreign])).toEqual(before);
    assertFkOn();
  }, 30_000);

  it("SELF-CYCLE plus foreign-Task descendant: closure sees both, terminates, rejects with FULL snapshot preservation", () => {
    enableFk();
    assertFkOn();
    const s1 = seed(taskIdA, "selfcycle-foreign-1");
    const s2 = seed(taskIdA, "selfcycle-foreign-2");
    seedMention(s1, "selfcycle-m");
    getDb().update(taskComments).set({ parentId: s2 }).where(eq(taskComments.id, s1)).run();
    getDb().update(taskComments).set({ parentId: s1 }).where(eq(taskComments.id, s2)).run();
    const foreign = rawCrossTaskChild(s2, taskIdB);
    const fullBefore = JSON.parse(
      JSON.stringify({
        comments: [row(s1), row(s2), row(foreign)],
        mentions: getDb().select().from(taskCommentMentions).all(),
      }),
    );

    expect(commentRepo.deleteComment(taskIdA, s1, AUTHOR.authorType, AUTHOR.authorId)).toBe(false);
    expect(
      JSON.parse(
        JSON.stringify({
          comments: [row(s1), row(s2), row(foreign)],
          mentions: getDb().select().from(taskCommentMentions).all(),
        }),
      ),
    ).toEqual(fullBefore);
    assertFkOn();
  }, 30_000);

  it("1100-deep chain (FK ON throughout): native FK trigger-recursion fault is wrapped (RepositoryError) with full statement rollback — every deep row preserved", () => {
    enableFk();
    assertFkOn();
    const db = getDb();
    let prev: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const id = `tcp-deep-${i}-${Math.random().toString(36).slice(2, 8)}`;
      db.insert(taskComments)
        .values({
          id,
          taskId: taskIdA,
          parentId: prev,
          authorType: AUTHOR.authorType,
          authorId: AUTHOR.authorId,
          content: "deep",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
      ids.push(id);
      prev = id;
    }
    assertFkOn();
    const deepBefore = JSON.parse(
      JSON.stringify(
        db
          .select()
          .from(taskComments)
          .where(sql`${taskComments.id} LIKE 'tcp-deep-%'`)
          .all(),
      ),
    );

    expect(() =>
      commentRepo.deleteComment(taskIdA, ids[0]!, AUTHOR.authorType, AUTHOR.authorId),
    ).toThrow(RepositoryError);
    // Full-rollback proof: every deep row byte-identical (content and
    // timestamps included), not merely counted.
    expect(
      JSON.parse(
        JSON.stringify(
          db
            .select()
            .from(taskComments)
            .where(sql`${taskComments.id} LIKE 'tcp-deep-%'`)
            .all(),
        ),
      ),
    ).toEqual(deepBefore);
    assertFkOn();
  }, 60_000);

  it("foreign leaf beyond the native cascade depth: predicate-time fence rejects BEFORE deletion, so the native recursion fault never fires and every row survives", () => {
    enableFk();
    assertFkOn();
    const root = seed(taskIdA, "deepleaf-root");
    let prev = root;
    for (let i = 0; i < 1050; i++) {
      const id = `tcp-deepleaf-${i}-${Math.random().toString(36).slice(2, 8)}`;
      getDb()
        .insert(taskComments)
        .values({
          id,
          taskId: taskIdA,
          parentId: prev,
          authorType: AUTHOR.authorType,
          authorId: AUTHOR.authorId,
          content: "deep",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
      prev = id;
    }
    const foreignLeaf = rawCrossTaskChild(prev, taskIdB);

    expect(commentRepo.deleteComment(taskIdA, root, AUTHOR.authorType, AUTHOR.authorId)).toBe(
      false,
    );
    expect(row(root)).toBeDefined();
    expect(row(foreignLeaf)).toBeDefined();
    expect(
      getDb()
        .select({ id: taskComments.id })
        .from(taskComments)
        .where(sql`${taskComments.id} LIKE 'tcp-deepleaf-%'`)
        .all(),
    ).toHaveLength(1050);
    assertFkOn();
  }, 60_000);
});
