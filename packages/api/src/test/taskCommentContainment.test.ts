/**
 * Task comment containment — final-predicate proofs labeled by boundary
 * (comment-containment-contract + independent-review amendment).
 *
 *  1. SEAM (service boundary, real sql.js DB): the guarded behaviors live
 *     BETWEEN the service's synchronous pre-read and the repository
 *     mutation — no real-wire request can interleave them in
 *     single-threaded synchronous code. The repository module is wrapped
 *     (everything else — service logic, error mapping, the actual SQL — is
 *     the real code): the wrapper fires a one-shot out-of-band DB change at
 *     exactly that seam, then delegates to the REAL implementation against
 *     the LIVE database. A service mock returning null would be
 *     insufficient proof; the final SQL statement actually runs and must
 *     match zero. An ID-only write (or a precheck-only fix) would match the
 *     reparented/re-authored row and FAIL these tests.
 *
 *  2. WIRE (real TCP into the real application, DB live): temporary SQLite
 *     BEFORE UPDATE/DELETE/INSERT triggers abort the mutation statement
 *     itself AFTER authentication, Task admission and prechecks passed —
 *     the outcome is 500 REPOSITORY_ERROR with the row preserved and zero
 *     operation SSE, never a flattened 404 or false success. The database
 *     stays live so DB-backed agent-key authentication succeeds. A
 *     wrong-Task request under the installed trigger stays 404 and never
 *     reaches the aborting statement (pinned by the wrapper's call
 *     counter). Dropping the trigger turns the byte-identical request into
 *     success. True BEFORE INSERT aborts (reply creation) stay 500, never
 *     parent-400.
 *
 *  3. CASCADE FENCE + RECURSION CHARACTERIZATION (live sql.js DB): the
 *     recursive-UNION closure terminates cross-Task parent cycles, rejects
 *     deletion when ANY descendant (including one injected after the
 *     service pre-read, defeating an unlocked closure precheck) belongs to
 *     another Task, preserves every row on rejection, and still lets a
 *     legitimate mixed-author same-Task thread cascade. A deeper-than-
 *     SQLITE_MAX_TRIGGER_DEPTH chain surfaces SQLite's native "too many
 *     levels of trigger recursion" fault — the wrapped 500 path with full
 *     statement rollback (all deep rows preserved), never a false success
 *     or a silent depth cap.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import net from "node:net";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as commentRepo from "../repositories/comment.js";
import * as commentMentionRepo from "../repositories/commentMention.js";
import { taskComments, taskCommentMentions } from "../db/schema/index.js";
import * as agentRepo from "../repositories/agent.js";

import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import {
  editComment as serviceEdit,
  removeComment as serviceRemove,
  addComment as serviceAdd,
} from "../services/commentService.js";
import { RepositoryError } from "../errors/repository.js";
import { AppError } from "../errors.js";
import { onCommentCreated } from "../services/commentService.js";

const seam = vi.hoisted(() => ({
  mutationCalls: 0,
  interpose: null as null | (() => void),
}));

vi.mock("../repositories/comment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/comment.js")>();
  const counted = <T extends unknown[]>(impl: (...args: T) => unknown) => {
    return (...args: T) => {
      seam.mutationCalls += 1;
      if (seam.interpose) {
        const fire = seam.interpose;
        seam.interpose = null;
        fire();
      }
      return impl(...args);
    };
  };
  return {
    ...actual,
    updateComment: counted(actual.updateComment),
    deleteComment: counted(actual.deleteComment),
    createReplyComment: counted(actual.createReplyComment),
  };
});

const containmentHookCalls: string[] = [];
const unsubscribeContainmentHook = onCommentCreated((comment) => {
  containmentHookCalls.push(comment.id);
});

const publishSpy = vi.spyOn(sseBroadcaster, "publish");
function sseCount(type: string, taskId: string): number {
  return publishSpy.mock.calls.filter(
    ([, event]: any) => event?.type === type && event?.data?.taskId === taskId,
  ).length;
}
function sseTotal(): number {
  return publishSpy.mock.calls.length;
}

let app: HttpRuntimeHandle;
let baseUrl: string;
let agentKey: string;
let agentId: string;
let habitatId: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let columnOrder = 0;
function makeTask(h: string, title: string): string {
  const column = columnRepo.createColumn({
    habitatId: h,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: h,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "tcc-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tcc-seed" }).id;
}

function seedComment(
  taskId: string,
  content: string,
  parentId: string | null = null,
  authorType: "human" | "agent" | "remote_human" | "remote_orcy" = "agent",
  authorId: string | null = null,
): string {
  return commentRepo.createComment({
    taskId,
    content,
    parentId,
    authorType,
    authorId: authorId ?? agentId,
  }).id;
}

function row(commentId: string) {
  return getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).get();
}

function rawInsert(id: string, taskId: string, parentId: string | null) {
  getDb()
    .insert(taskComments)
    .values({
      id,
      taskId,
      parentId,
      authorType: "agent",
      authorId: agentId,
      content: `raw-${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

/**
 * Commissioned FK-integrity proof state: enforcement explicitly ON (PRAGMA
 * plus a functional missing-Task INSERT that must throw) BEFORE any legal
 * cross-Task/cycle/deep fixture is created — cross-Task parent links, cycles
 * and deep chains are legal under the simple self-FK (the parent row exists),
 * so NO FK-off is used for them. Only the corrupt-ancestry fixtures disable
 * enforcement, in try/finally.
 */
function enableFk(): void {
  // Explicitly enable first: the sql.js connection's PRAGMA state after
  // initTestDb is not assumed (a cold snapshot export can leave it OFF).
  getDb().run(sql`PRAGMA foreign_keys = ON`);
}

/** READ-ONLY enforcement assertion: if a statement or fixture left FK off, this fails instead of masking it. */
function assertFkOn(): void {
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
  expect(() =>
    rawInsert(
      `fk-probe-${Math.random().toString(36).slice(2, 8)}`,
      "00000000-0000-4000-8000-0000000000ff",
      null,
    ),
  ).toThrow(/FOREIGN KEY/i);
}

/** Raw cross-Task descendant: legal under the simple self-FK (parent exists) with enforcement ON. */
function rawCrossTaskChild(parentId: string, taskId: string): string {
  const id = `cross-${parentId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  rawInsert(id, taskId, parentId);
  return id;
}

function setParent(commentId: string, parentId: string | null) {
  getDb().update(taskComments).set({ parentId }).where(eq(taskComments.id, commentId)).run();
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

/** Full nonempty snapshot: comment content/timestamps plus its mention rows. */
function fullSnapshot(commentId: string) {
  return JSON.parse(
    JSON.stringify({
      comment: getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).all(),
      mentions: getDb()
        .select()
        .from(taskCommentMentions)
        .where(eq(taskCommentMentions.commentId, commentId))
        .all(),
    }),
  );
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

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  habitatId = habitatRepo.createHabitat({ name: "tcc-habitat" }).id;
  const created = agentRepo.createAgent({
    name: "tcc-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;
}, 120_000);

afterEach(() => {
  seam.interpose = null;
});

afterAll(async () => {
  unsubscribeContainmentHook();
  publishSpy.mockRestore();
  await app.close();
  closeDb();
});

describe("SEAM — post-lookup mutation defeats the final SQL predicate (service boundary, live DB)", () => {
  it("UPDATE: comment reparented A→B between pre-read and write matches zero — 404, B row intact, no SSE", () => {
    const a = makeTask(habitatId, "tcc-seam-upd-a");
    const b = makeTask(habitatId, "tcc-seam-upd-b");
    const comment = seedComment(a, "tcc-seam-upd");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().update(taskComments).set({ taskId: b }).where(eq(taskComments.id, comment)).run();
    };

    expect(() => serviceEdit(a, comment, "agent", agentId, "hijacked")).toThrow(
      "Comment not found",
    );
    // The B row is intact and untouched: an ID-only SQL write (or a
    // precheck-only fix) would have rewritten content here and failed.
    const after = row(comment)!;
    expect(after.taskId).toBe(b);
    expect(after.content).toBe("tcc-seam-upd");
    expect(sseTotal()).toBe(sseBefore);
  });

  it("UPDATE: author changed between pre-read and write matches zero — 404, new-owner row survives", () => {
    const a = makeTask(habitatId, "tcc-seam-auth-a");
    const comment = seedComment(a, "tcc-seam-auth");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb()
        .update(taskComments)
        .set({ authorId: "someone-else" })
        .where(eq(taskComments.id, comment))
        .run();
    };

    expect(() => serviceEdit(a, comment, "agent", agentId, "hijacked")).toThrow(
      "Comment not found",
    );
    expect(row(comment)!.authorId).toBe("someone-else");
    expect(sseTotal()).toBe(sseBefore);
  });

  it("UPDATE: comment deleted between pre-read and write matches zero — 404, no SSE", () => {
    const a = makeTask(habitatId, "tcc-seam-upddis-a");
    const comment = seedComment(a, "tcc-seam-upddis");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().delete(taskComments).where(eq(taskComments.id, comment)).run();
    };

    expect(() => serviceEdit(a, comment, "agent", agentId, "hijacked")).toThrow(
      "Comment not found",
    );
    expect(row(comment)).toBeUndefined();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("DELETE: comment reparented A→B between pre-read and write matches zero — 404, B row preserved, no SSE", () => {
    const a = makeTask(habitatId, "tcc-seam-del-a");
    const b = makeTask(habitatId, "tcc-seam-del-b");
    const comment = seedComment(a, "tcc-seam-del");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().update(taskComments).set({ taskId: b }).where(eq(taskComments.id, comment)).run();
    };

    expect(() => serviceRemove(a, comment, "agent", agentId)).toThrow("Comment not found");
    expect(row(comment)!.taskId).toBe(b);
    expect(sseTotal()).toBe(sseBefore);
  });

  it("DELETE: comment deleted between pre-read and write matches zero — 404, no SSE", () => {
    const a = makeTask(habitatId, "tcc-seam-deldis-a");
    const comment = seedComment(a, "tcc-seam-deldis");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().delete(taskComments).where(eq(taskComments.id, comment)).run();
    };

    expect(() => serviceRemove(a, comment, "agent", agentId)).toThrow("Comment not found");
    expect(row(comment)).toBeUndefined();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("UPDATE: author TYPE flipped between pre-read and write matches zero — 404, row preserved", () => {
    const a = makeTask(habitatId, "tcc-seam-authtype-a");
    const comment = seedComment(a, "tcc-seam-authtype");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb()
        .update(taskComments)
        .set({ authorType: "human" })
        .where(eq(taskComments.id, comment))
        .run();
    };

    expect(() => serviceEdit(a, comment, "agent", agentId, "x")).toThrow("Comment not found");
    expect(row(comment)!.authorType).toBe("human");
    expect(sseTotal()).toBe(sseBefore);
  });

  it("DELETE: author ID changed between pre-read and write matches zero — 404, row preserved", () => {
    const a = makeTask(habitatId, "tcc-seam-delid-a");
    const comment = seedComment(a, "tcc-seam-delid");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb()
        .update(taskComments)
        .set({ authorId: "new-owner" })
        .where(eq(taskComments.id, comment))
        .run();
    };

    expect(() => serviceRemove(a, comment, "agent", agentId)).toThrow("Comment not found");
    expect(row(comment)!.authorId).toBe("new-owner");
    expect(sseTotal()).toBe(sseBefore);
  });

  it("REPLY INSERT zero-match maps to the historical service 404 shape (the wire converts to 400), never a generic 500/flat error", () => {
    const a = makeTask(habitatId, "tcc-seam-shape-a");
    const parent = seedComment(a, "tcc-seam-shape-parent");

    seam.interpose = () => {
      getDb().delete(taskComments).where(eq(taskComments.id, parent)).run();
    };

    let caught: unknown;
    try {
      serviceAdd(a, "agent", agentId, "shape probe", parent);
    } catch (err) {
      caught = err;
    }
    // The route's catch maps exactly this message to badRequest(400); pin
    // both the message and the 404 AppError shape it converts from.
    expect((caught as AppError).message).toBe("Parent comment not found");
    expect((caught as AppError).statusCode).toBe(404);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("REPLY INSERT: parent reparented to B between pre-read and INSERT yields zero rows — missing-parent 404, no comment/mention/fan", () => {
    const a = makeTask(habitatId, "tcc-seam-reply-a");
    const b = makeTask(habitatId, "tcc-seam-reply-b");
    const parent = seedComment(a, "tcc-seam-reply-parent");
    const sseBefore = sseTotal();
    const rowsBefore = getDb()
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, a))
      .all().length;

    seam.interpose = () => {
      getDb().update(taskComments).set({ taskId: b }).where(eq(taskComments.id, parent)).run();
    };

    expect(() => serviceAdd(a, "agent", agentId, "reply-after-reparent", parent)).toThrow(
      "Parent comment not found",
    );
    // The reparent moved the parent itself to B; the failed conditional
    // INSERT contributed no row to either Task.
    expect(
      getDb().select().from(taskComments).where(eq(taskComments.taskId, a)).all(),
    ).toHaveLength(rowsBefore - 1);
    expect(
      getDb().select().from(taskComments).where(eq(taskComments.taskId, b)).all(),
    ).toHaveLength(rowsBefore);
    expect(sseTotal()).toBe(sseBefore);
  });

  it("REPLY INSERT: parent deleted between pre-read and INSERT yields zero rows — missing-parent 404, no comment/mention/fan", () => {
    const a = makeTask(habitatId, "tcc-seam-replydis-a");
    const parent = seedComment(a, "tcc-seam-replydis-parent");
    const sseBefore = sseTotal();
    const rowsBefore = getDb()
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, a))
      .all().length;

    seam.interpose = () => {
      getDb().delete(taskComments).where(eq(taskComments.id, parent)).run();
    };

    expect(() => serviceAdd(a, "agent", agentId, "reply-after-delete", parent)).toThrow(
      "Parent comment not found",
    );
    // The interpose removed the parent itself; the failed conditional INSERT
    // contributed no row.
    expect(
      getDb().select().from(taskComments).where(eq(taskComments.taskId, a)).all(),
    ).toHaveLength(rowsBefore - 1);
    expect(sseTotal()).toBe(sseBefore);
  });

  it("positive control after the seam wrappers: same-Task reply through the conditional primitive still succeeds", () => {
    const a = makeTask(habitatId, "tcc-seam-positive-a");
    const parent = seedComment(a, "tcc-seam-positive-parent");
    const created = serviceAdd(a, "agent", agentId, "legit reply", parent);
    expect(created.parentId).toBe(parent);
    expect(created.taskId).toBe(a);
  });
});

describe("CASCADE FENCE — recursive-UNION closure (live sql.js DB, FK enforcement asserted ON)", () => {
  it("raw cross-Task immediate child: DELETE matches zero, every row preserved, no SSE — and the child stays reachable as B's row", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-immediate-a");
    const b = makeTask(habitatId, "tcc-fence-immediate-b");
    const root = seedComment(a, "tcc-fence-immediate-root");
    seedMention(root, "root-mention");
    const foreignChild = rawCrossTaskChild(root, b);
    const sseBefore = sseTotal();
    const beforeRoot = fullSnapshot(root);
    const beforeForeign = fullSnapshot(foreignChild);

    expect(() => serviceRemove(a, root, "agent", agentId)).toThrow("Comment not found");
    expect(fullSnapshot(root)).toEqual(beforeRoot);
    expect(fullSnapshot(foreignChild)).toEqual(beforeForeign);
    assertFkOn();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("raw cross-Task DEEP chain (grandchild under foreign child): rejection preserves the entire chain — full nonempty comment/mention/timestamp snapshots", () => {
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-deep-a");
    const b = makeTask(habitatId, "tcc-fence-deep-b");
    const root = seedComment(a, "tcc-fence-deep-root");
    const sameTaskChild = seedComment(a, "tcc-fence-deep-child", root, "human", "someone-else");
    seedMention(sameTaskChild, "chain-mention");
    const foreignChild = rawCrossTaskChild(sameTaskChild, b);
    const foreignGrandchild = rawCrossTaskChild(foreignChild, b);
    const sseBefore = sseTotal();
    const before = [root, sameTaskChild, foreignChild, foreignGrandchild].map(fullSnapshot);

    expect(() => serviceRemove(a, root, "agent", agentId)).toThrow("Comment not found");
    expect([root, sameTaskChild, foreignChild, foreignGrandchild].map(fullSnapshot)).toEqual(
      before,
    );
    assertFkOn();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("foreign descendant injected AFTER the service pre-read still rejects — an unlocked closure precheck alone would pass", () => {
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-inject-a");
    const b = makeTask(habitatId, "tcc-fence-inject-b");
    const root = seedComment(a, "tcc-fence-inject-root");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      rawCrossTaskChild(root, b);
    };

    expect(() => serviceRemove(a, root, "agent", agentId)).toThrow("Comment not found");
    expect(row(root)).toBeDefined();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("ONE-ROW self-cycle (parentId === own id) with a foreign-Task descendant: closure terminates, rejects, FULL comment/mention/timestamp snapshots preserved", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-selfrow-a");
    const b = makeTask(habitatId, "tcc-selfrow-b");
    const selfRow = seedComment(a, "tcc-selfrow-comment");
    seedMention(selfRow, "selfrow-m");
    // parentId === the same row's own ID: legal under the simple self-FK
    // (the parent row exists — itself) with enforcement ON.
    setParent(selfRow, selfRow);
    assertFkOn();
    const foreign = rawCrossTaskChild(selfRow, b);
    const sseBefore = sseTotal();
    const before = closureSnapshot([selfRow, foreign]);

    expect(() => serviceRemove(a, selfRow, "agent", agentId)).toThrow("Comment not found");
    expect(closureSnapshot([selfRow, foreign])).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
    assertFkOn();
  });

  it("cross-Task parent CYCLE (A→B_foreign→A): UNION closure terminates and rejects with every row preserved", () => {
    // FK enable + read-only verification BEFORE any legal fixture seed —
    // locally evident, not inherited from prior test order.
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-cycle-a");
    const b = makeTask(habitatId, "tcc-fence-cycle-b");
    const ca = seedComment(a, "tcc-fence-cycle-a-comment");
    const cb = seedComment(b, "tcc-fence-cycle-b-comment");
    // ca.parent = cb, cb.parent = ca — legal under the simple self-FK (both
    // rows exist) with enforcement ON.
    setParent(ca, cb);
    setParent(cb, ca);
    assertFkOn();
    const sseBefore = sseTotal();

    expect(() => serviceRemove(a, ca, "agent", agentId)).toThrow("Comment not found");
    expect(row(ca)).toBeDefined();
    expect(row(cb)).toBeDefined();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("same-Task CYCLE: UNION closure terminates; deleting one member removes the whole cycle via FK cascade", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-samecycle-a");
    const c1 = seedComment(a, "tcc-fence-samecycle-1");
    const c2 = seedComment(a, "tcc-fence-samecycle-2");
    assertFkOn();
    setParent(c1, c2);
    setParent(c2, c1);
    assertFkOn();

    expect(() => serviceRemove(a, c1, "agent", agentId)).not.toThrow();
    expect(row(c1)).toBeUndefined();
    expect(row(c2)).toBeUndefined();
  });

  it("same-Task CYCLE plus a foreign-Task descendant: the closure sees both, terminates, and rejects", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-cycle-foreign-a");
    const b = makeTask(habitatId, "tcc-fence-cycle-foreign-b");
    const c1 = seedComment(a, "tcc-fence-cf-1");
    const c2 = seedComment(a, "tcc-fence-cf-2");
    setParent(c1, c2);
    setParent(c2, c1);
    const foreign = rawCrossTaskChild(c2, b);
    const sseBefore = sseTotal();

    expect(() => serviceRemove(a, c1, "agent", agentId)).toThrow("Comment not found");
    expect(row(c1)).toBeDefined();
    expect(row(c2)).toBeDefined();
    expect(row(foreign)).toBeDefined();
    expect(sseTotal()).toBe(sseBefore);
    assertFkOn();
  });

  it("foreign leaf beyond the native cascade depth: the predicate-time fence rejects BEFORE any deletion, so the native FK recursion fault never fires", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-deepleaf-a");
    const b = makeTask(habitatId, "tcc-fence-deepleaf-b");
    const root = seedComment(a, "tcc-fence-deepleaf-root");
    let prev = root;
    for (let i = 0; i < 1050; i++) {
      const id = `tcc-deepleaf-${i}-${Math.random().toString(36).slice(2, 8)}`;
      rawInsert(id, a, prev);
      prev = id;
    }
    const foreignLeaf = rawCrossTaskChild(prev, b);
    const sseBefore = sseTotal();

    // The foreign leaf sits deeper than SQLITE_MAX_TRIGGER_DEPTH: an
    // unfenced delete would cascade into the native recursion fault (500 +
    // rollback). The predicate-time NOT EXISTS sees it first and matches
    // zero — clean 404 mapping, no fault, every row preserved.
    expect(() => serviceRemove(a, root, "agent", agentId)).toThrow("Comment not found");
    expect(row(root)).toBeDefined();
    expect(row(foreignLeaf)).toBeDefined();
    expect(
      getDb()
        .select({ id: taskComments.id })
        .from(taskComments)
        .where(sql`${taskComments.id} LIKE 'tcc-deepleaf-%'`)
        .all(),
    ).toHaveLength(1050);
    expect(sseTotal()).toBe(sseBefore);
    assertFkOn();
  }, 60_000);

  it("legitimate mixed-author same-Task thread still cascades on root deletion — comment rows AND their mention rows — with one root deletion event", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-fence-legit-a");
    const root = seedComment(a, "tcc-fence-legit-root");
    const reply1 = seedComment(a, "reply-other-author", root, "human", "human-author");
    const reply2 = seedComment(a, "reply-own-author", root);
    const grandchild = seedComment(a, "grandchild", reply1, "remote_orcy", "remote-author");
    const other = seedComment(a, "unrelated-root");
    const keepMention = seedMention(other, "keep-mention");
    const m1 = seedMention(root, "root-m");
    const m2 = seedMention(reply1, "reply-m");
    const m3 = seedMention(grandchild, "grandchild-m");
    const sseBefore = sseTotal();

    // Pass-through recorder on the live db.all: observes the REAL raw
    // result of the deleting statement without replacing SQL. The RETURNING
    // set must be the SELECTED ROOT ID ONLY — cascaded descendants are FK
    // work, never RETURNING rows.
    const liveDb = getDb();
    const origAll = liveDb.all.bind(liveDb);
    const rawResults: unknown[] = [];
    liveDb.all = ((...args: unknown[]) => {
      const result = (origAll as (...a: unknown[]) => unknown)(...args);
      rawResults.push(result);
      return result;
    }) as typeof liveDb.all;
    let removed: boolean | undefined;
    try {
      removed = serviceRemove(a, root, "agent", agentId);
    } finally {
      liveDb.all = origAll;
    }
    expect(removed).toBe(true);
    expect(rawResults).toHaveLength(1);
    expect(rawResults[0]).toEqual([{ id: root }]);
    for (const id of [root, reply1, reply2, grandchild]) {
      expect(row(id), id).toBeUndefined();
      expect(mentionsFor(id), `mentions of ${id}`).toHaveLength(0);
    }
    for (const m of [m1, m2, m3]) {
      expect(
        getDb().select().from(taskCommentMentions).where(eq(taskCommentMentions.id, m)).all(),
        m,
      ).toHaveLength(0);
    }
    expect(row(other)).toBeDefined();
    expect(mentionsFor(other).map((m) => m.id)).toEqual([keepMention]);
    assertFkOn();
    const pubs = publishSpy.mock.calls.slice(sseBefore) as unknown as Array<[string, any]>;
    expect(pubs).toHaveLength(1);
    expect(pubs[0][1].type).toBe("task.comment_deleted");
    expect(pubs[0][1].data.taskId).toBe(a);
    expect(pubs[0][1].data.commentId).toBe(root);
  });
});

describe("RECURSION CHARACTERIZATION — deeper than SQLITE_MAX_TRIGGER_DEPTH", () => {
  it("1100-deep same-Task chain (FK ON throughout): native FK trigger-recursion fault surfaces as wrapped RepositoryError with full statement rollback (all rows preserved)", () => {
    enableFk();
    assertFkOn();
    const a = makeTask(habitatId, "tcc-deep-a");
    let prev: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 1100; i++) {
      const id = `tcc-deep-${i}-${Math.random().toString(36).slice(2, 8)}`;
      rawInsert(id, a, prev);
      ids.push(id);
      prev = id;
    }
    assertFkOn();
    // Nonempty durable mention seeded on the chain root so rollback equality
    // is non-vacuous; FULL pre-statement state captured (every deep row's
    // content + timestamps, and every mention row), not {id}/counts.
    seedMention(ids[0]!, "deep-root-m");
    const deepBefore = closureSnapshot(ids);
    const sseBefore = sseTotal();

    // The statement-level fault must propagate (500 wire path via
    // repositoryDeleteError), never flatten to 404/false success — and the
    // rollback preserves every deep row.
    expect(() => serviceRemove(a, ids[0]!, "agent", agentId)).toThrow(RepositoryError);
    // Full-rollback proof matching the production driver: every deep row
    // byte-identical (content + timestamps) AND the seeded mention row
    // preserved — then FK enforcement still ON (read-only assertion).
    expect(closureSnapshot(ids)).toEqual(deepBefore);
    expect(mentionsFor(ids[0]!)).toHaveLength(1);
    expect(sseTotal()).toBe(sseBefore);
    assertFkOn();
  }, 60_000);
});

describe("WIRE — mutation-statement abort triggers (real TCP, DB live, agent key)", () => {
  it("UPDATE fault after successful admission is 500 REPOSITORY_ERROR with the row preserved; wrong-Task stays 404 without executing; dropping the trigger turns the identical request into 200", async () => {
    const owner = makeTask(habitatId, "tcc-trig-upd");
    const other = makeTask(habitatId, "tcc-trig-upd-other");
    const comment = seedComment(owner, "tcc-trig-upd-comment");
    const db = getDb();
    const sseBefore = sseTotal();

    db.run(
      sql`CREATE TRIGGER tcc_update_fault BEFORE UPDATE ON task_comments BEGIN SELECT RAISE(ABORT, 'comment update failure'); END`,
    );

    try {
      // Wrong-Task request under the installed trigger: rejected by the
      // required pair BEFORE the aborting statement executes (the trigger
      // would turn it into 500 if it ran; the call counter pins that the
      // mutation never executed).
      const callsBefore = seam.mutationCalls;
      const wrongTask = await fetch(`${baseUrl}/api/v1/tasks/${other}/comments/${comment}`, {
        method: "PATCH",
        headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hijack" }),
      });
      expect(wrongTask.status).toBe(404);
      expect(seam.mutationCalls).toBe(callsBefore);

      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments/${comment}`, {
        method: "PATCH",
        headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "new content" }),
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("REPOSITORY_ERROR");
      expect(row(comment)!.content).toBe("tcc-trig-upd-comment");
      expect(sseTotal()).toBe(sseBefore);
    } finally {
      db.run(sql`DROP TRIGGER tcc_update_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments/${comment}`, {
      method: "PATCH",
      headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "new content" }),
    });
    expect(control.status).toBe(200);
    expect(row(comment)!.content).toBe("new content");
  }, 30_000);

  it("DELETE fault after successful admission is 500 REPOSITORY_ERROR with the row preserved; wrong-Task stays 404 without executing; dropping the trigger turns the identical request into 204", async () => {
    const owner = makeTask(habitatId, "tcc-trig-del");
    const other = makeTask(habitatId, "tcc-trig-del-other");
    const comment = seedComment(owner, "tcc-trig-del-comment");
    const db = getDb();
    const sseBefore = sseTotal();

    db.run(
      sql`CREATE TRIGGER tcc_delete_fault BEFORE DELETE ON task_comments BEGIN SELECT RAISE(ABORT, 'comment delete failure'); END`,
    );

    try {
      const callsBefore = seam.mutationCalls;
      const wrongTask = await fetch(`${baseUrl}/api/v1/tasks/${other}/comments/${comment}`, {
        method: "DELETE",
        headers: { "x-agent-api-key": agentKey },
      });
      expect(wrongTask.status).toBe(404);
      expect(seam.mutationCalls).toBe(callsBefore);

      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments/${comment}`, {
        method: "DELETE",
        headers: { "x-agent-api-key": agentKey },
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("REPOSITORY_ERROR");
      expect(row(comment)).toBeDefined();
      expect(sseTotal()).toBe(sseBefore);
    } finally {
      db.run(sql`DROP TRIGGER tcc_delete_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments/${comment}`, {
      method: "DELETE",
      headers: { "x-agent-api-key": agentKey },
    });
    expect(control.status).toBe(204);
    expect(row(comment)).toBeUndefined();
  }, 30_000);

  it("true BEFORE INSERT abort on a valid reply stays 500 (never parent-400); dropping the trigger turns the identical request into 201", async () => {
    const owner = makeTask(habitatId, "tcc-trig-ins");
    const parent = seedComment(owner, "tcc-trig-ins-parent");
    const db = getDb();
    const rowsBefore = getDb()
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, owner))
      .all().length;
    const sseBefore = sseTotal();

    db.run(
      sql`CREATE TRIGGER tcc_insert_fault BEFORE INSERT ON task_comments BEGIN SELECT RAISE(ABORT, 'comment insert failure'); END`,
    );

    try {
      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments`, {
        method: "POST",
        headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "reply body", parentId: parent }),
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("REPOSITORY_ERROR");
      expect(
        getDb().select().from(taskComments).where(eq(taskComments.taskId, owner)).all(),
      ).toHaveLength(rowsBefore);
      expect(sseTotal()).toBe(sseBefore);
    } finally {
      db.run(sql`DROP TRIGGER tcc_insert_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${owner}/comments`, {
      method: "POST",
      headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "reply body", parentId: parent }),
    });
    expect(control.status).toBe(201);
  }, 30_000);
});

describe("WIRE — final conditional reply miss after a successful precheck (real TCP, both prefixes)", () => {
  async function replyMissCase(
    prefix: string,
    mutate: "reparent" | "delete",
  ): Promise<void> {
    const a = makeTask(habitatId, `tcc-wire-miss-${prefix.slice(5)}-${mutate}-a`);
    const b = makeTask(habitatId, `tcc-wire-miss-${prefix.slice(5)}-${mutate}-b`);
    const parent = seedComment(a, `tcc-wire-miss-parent-${mutate}`);
    seedMention(parent, `wire-miss-${mutate}`);
    const rowsFor = (t: string) => getDb().select().from(taskComments).where(eq(taskComments.taskId, t)).all();
    const rowsBefore = JSON.parse(JSON.stringify(rowsFor(a)));
    const mentionsBefore = JSON.parse(
      JSON.stringify(getDb().select().from(taskCommentMentions).all()),
    );
    const hooksBefore = containmentHookCalls.length;
    const sseBefore = sseTotal();

    // One-shot mutation AT the counted createReplyComment seam: the parent
    // precheck has ALREADY succeeded, so only the conditional INSERT's
    // WHERE EXISTS can catch the now-reparented/deleted parent.
    seam.interpose = () => {
      if (mutate === "reparent") {
        getDb().update(taskComments).set({ taskId: b }).where(eq(taskComments.id, parent)).run();
      } else {
        getDb().delete(taskComments).where(eq(taskComments.id, parent)).run();
      }
    };

    const res = await fetch(`${baseUrl}${prefix}/tasks/${a}/comments`, {
      method: "POST",
      headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "reply that must not land", parentId: parent }),
    });

    // The route converts the historical service 404 to the wire 400.
    expect(res.status, `${prefix} ${mutate}`).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error, `${prefix} ${mutate} message`).toBe("Parent comment not found");

    // Zero inserted rows on either Task (the interpose itself moved/removed
    // the parent, the failed conditional INSERT contributed nothing), the
    // surviving mention rows match the mutation exactly, zero publication
    // and zero creation-hook fan.
    expect(rowsFor(a), prefix + " " + mutate + " no new rows under A").toEqual([]);
    expect(rowsFor(b).map((r) => r.id)).toEqual(
      mutate === "reparent" ? [parent] : [],
    );
    expect(JSON.parse(JSON.stringify(getDb().select().from(taskCommentMentions).all()))).toEqual(
      mutate === "reparent"
        ? mentionsBefore
        : mentionsBefore.filter((m: any) => m.commentId !== parent),
    );
    expect(sseTotal()).toBe(sseBefore);
    expect(containmentHookCalls.length).toBe(hooksBefore);
  }

  it("parent reparented between precheck and conditional INSERT: POST is wire 400 with zero effects, on BOTH prefixes", async () => {
    await replyMissCase("/api/v1", "reparent");
    await replyMissCase("/api", "reparent");
  }, 30_000);

  it("parent deleted between precheck and conditional INSERT: POST is wire 400 with zero effects, on BOTH prefixes", async () => {
    await replyMissCase("/api/v1", "delete");
    await replyMissCase("/api", "delete");
  }, 30_000);
});
