/**
 * Subtask containment — final-predicate proofs labeled by boundary
 * (nested-resource-contract + independent-review).
 *
 *  1. SEAM (service boundary, real sql.js DB): the guarded behaviors live
 *     BETWEEN the service's synchronous child pre-read and the repository
 *     mutation — no real-wire request can interleave them in single-threaded
 *     synchronous code. The repository module is wrapped (everything else —
 *     service logic, error mapping, the actual SQL — is the real code): the
 *     wrapper fires a one-shot out-of-band DB change at exactly that seam,
 *     then delegates to the REAL implementation against the LIVE database.
 *     A service mock returning null would be insufficient proof; the final
 *     SQL statement actually runs and must match zero. An ID-only write
 *     (or a precheck-only fix) would match the reparented row and FAIL
 *     these tests; restoring an ID-based write must fail the postlookup
 *     parent-change proofs here.
 *
 *  2. WIRE (real TCP into the real application, DB live): a temporary
 *     SQLite BEFORE UPDATE/DELETE trigger aborts the mutation statement
 *     itself AFTER authentication, Task admission and child lookup passed —
 *     the outcome is 500 REPOSITORY_ERROR with the child preserved and zero
 *     operation SSE, never a flattened 404 or false success. The database
 *     stays live so DB-backed agent-key authentication succeeds (closing it
 *     would prove only entry/auth failure). A wrong-parent request under
 *     the installed trigger stays 404 and never reaches the aborting
 *     statement (pinned by the wrapper's call counter). Dropping the
 *     trigger turns the byte-identical request into success. The wrapper
 *     from (1) is inert here unless armed.
 *
 *  3. PRODUCTION DRIVER (better-sqlite3 file DB, repository boundary): the
 *     required-pair UPDATE/DELETE RETURNING primitives prove match,
 *     mismatch, absent-child, repeat-delete and fault propagation on the
 *     production driver, not only the sql.js test driver. No `.run()
 *     .changes` semantics are used anywhere in the source — results come
 *     from RETURNING rows only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as subtaskRepo from "../repositories/subtask.js";
import * as agentRepo from "../repositories/agent.js";
import { taskSubtasks } from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import {
  updateSubtask as serviceUpdate,
  deleteSubtask as serviceDelete,
} from "../services/subtaskService.js";
import { RepositoryError } from "../errors/repository.js";

const seam = vi.hoisted(() => ({
  mutationCalls: 0,
  interpose: null as null | (() => void),
}));

vi.mock("../repositories/subtask.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/subtask.js")>();
  return {
    ...actual,
    updateSubtask: (
      taskId: string,
      subtaskId: string,
      data: Parameters<typeof actual.updateSubtask>[2],
    ) => {
      seam.mutationCalls += 1;
      if (seam.interpose) {
        const fire = seam.interpose;
        seam.interpose = null;
        fire();
      }
      return actual.updateSubtask(taskId, subtaskId, data);
    },
    deleteSubtask: (taskId: string, subtaskId: string) => {
      seam.mutationCalls += 1;
      if (seam.interpose) {
        const fire = seam.interpose;
        seam.interpose = null;
        fire();
      }
      return actual.deleteSubtask(taskId, subtaskId);
    },
  };
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
    createdBy: "tsc-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tsc-seed" }).id;
}

function makeChild(taskId: string, title: string): subtaskRepo.Subtask {
  return subtaskRepo.createSubtask({ taskId, title });
}

function row(subtaskId: string) {
  return getDb().select().from(taskSubtasks).where(eq(taskSubtasks.id, subtaskId)).get();
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  habitatId = habitatRepo.createHabitat({ name: "tsc-habitat" }).id;
  const created = agentRepo.createAgent({
    name: "tsc-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentKey = created.plainApiKey;
}, 120_000);

afterEach(() => {
  seam.interpose = null;
});

afterAll(async () => {
  publishSpy.mockRestore();
  await app.close();
  closeDb();
});

describe("SEAM — post-lookup reparent defeats the final SQL predicate (service boundary, live DB)", () => {
  it("UPDATE: child reparented A→B between pre-read and write matches zero — null result, B row intact, no SSE", async () => {
    const a = makeTask(habitatId, "tsc-seam-upd-a");
    const b = makeTask(habitatId, "tsc-seam-upd-b");
    const kid = makeChild(a, "tsc-seam-upd-child");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().update(taskSubtasks).set({ taskId: b }).where(eq(taskSubtasks.id, kid.id)).run();
    };

    const result = serviceUpdate(a, kid.id, { completed: true });

    expect(result).toBeNull();
    // The B child is intact and untouched: an ID-only SQL write (or a
    // precheck-only fix) would have flipped completed here and failed.
    const after = row(kid.id)!;
    expect(after.taskId).toBe(b);
    expect(after.completed).toBe(false);
    expect(sseCount("subtask.updated", a)).toBe(0);
    expect(sseCount("subtask.updated", b)).toBe(0);
    expect(sseTotal()).toBe(sseBefore);
  });

  it("DELETE: child reparented A→B between pre-read and write matches zero — false result, B row preserved, no SSE", async () => {
    const a = makeTask(habitatId, "tsc-seam-del-a");
    const b = makeTask(habitatId, "tsc-seam-del-b");
    const kid = makeChild(a, "tsc-seam-del-child");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().update(taskSubtasks).set({ taskId: b }).where(eq(taskSubtasks.id, kid.id)).run();
    };

    const result = serviceDelete(a, kid.id);

    expect(result).toBe(false);
    const after = row(kid.id)!;
    expect(after.taskId).toBe(b);
    expect(sseCount("subtask.deleted", a)).toBe(0);
    expect(sseCount("subtask.deleted", b)).toBe(0);
    expect(sseTotal()).toBe(sseBefore);
  });

  it("UPDATE: child deleted between pre-read and write matches zero — null result, no SSE", async () => {
    const a = makeTask(habitatId, "tsc-seam-upddis-a");
    const kid = makeChild(a, "tsc-seam-upddis-child");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().delete(taskSubtasks).where(eq(taskSubtasks.id, kid.id)).run();
    };

    const result = serviceUpdate(a, kid.id, { completed: true });

    expect(result).toBeNull();
    expect(row(kid.id)).toBeUndefined();
    expect(sseTotal()).toBe(sseBefore);
  });

  it("DELETE: child deleted between pre-read and write matches zero — false result, no SSE", async () => {
    const a = makeTask(habitatId, "tsc-seam-deldis-a");
    const kid = makeChild(a, "tsc-seam-deldis-child");
    const sseBefore = sseTotal();

    seam.interpose = () => {
      getDb().delete(taskSubtasks).where(eq(taskSubtasks.id, kid.id)).run();
    };

    const result = serviceDelete(a, kid.id);

    expect(result).toBe(false);
    expect(row(kid.id)).toBeUndefined();
    expect(sseTotal()).toBe(sseBefore);
  });
});

describe("WIRE — mutation-statement abort trigger (real TCP, DB live, agent key)", () => {
  it("UPDATE fault after successful admission is 500 REPOSITORY_ERROR with the child preserved; wrong-parent stays 404 without executing; dropping the trigger turns the identical request into 200", async () => {
    const owner = makeTask(habitatId, "tsc-trig-upd");
    const other = makeTask(habitatId, "tsc-trig-upd-other");
    const kid = makeChild(owner, "tsc-trig-upd-child");
    const db = getDb();
    const sseBefore = sseTotal();

    db.run(
      sql`CREATE TRIGGER tsc_update_fault BEFORE UPDATE ON task_subtasks BEGIN SELECT RAISE(ABORT, 'subtask update failure'); END`,
    );

    try {
      // Wrong-parent request under the installed trigger: rejected by the
      // required pair BEFORE the aborting statement executes (the trigger
      // would turn it into 500 if it ran; the call counter pins that the
      // mutation never executed).
      const callsBefore = seam.mutationCalls;
      const wrongParent = await fetch(`${baseUrl}/api/v1/tasks/${other}/subtasks/${kid.id}`, {
        method: "PATCH",
        headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
      expect(wrongParent.status).toBe(404);
      expect(seam.mutationCalls).toBe(callsBefore);

      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${owner}/subtasks/${kid.id}`, {
        method: "PATCH",
        headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("REPOSITORY_ERROR");
      expect(row(kid.id)!.completed).toBe(false);
      expect(sseCount("subtask.updated", owner)).toBe(0);
      expect(sseTotal()).toBe(sseBefore);
    } finally {
      db.run(sql`DROP TRIGGER tsc_update_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${owner}/subtasks/${kid.id}`, {
      method: "PATCH",
      headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    expect(control.status).toBe(200);
    expect(row(kid.id)!.completed).toBe(true);
  }, 30_000);

  it("DELETE fault after successful admission is 500 REPOSITORY_ERROR with the row preserved; wrong-parent stays 404 without executing; dropping the trigger turns the identical request into 204", async () => {
    const owner = makeTask(habitatId, "tsc-trig-del");
    const other = makeTask(habitatId, "tsc-trig-del-other");
    const kid = makeChild(owner, "tsc-trig-del-child");
    const db = getDb();
    const sseBefore = sseTotal();

    db.run(
      sql`CREATE TRIGGER tsc_delete_fault BEFORE DELETE ON task_subtasks BEGIN SELECT RAISE(ABORT, 'subtask delete failure'); END`,
    );

    try {
      const callsBefore = seam.mutationCalls;
      const wrongParent = await fetch(`${baseUrl}/api/v1/tasks/${other}/subtasks/${kid.id}`, {
        method: "DELETE",
        headers: { "x-agent-api-key": agentKey },
      });
      expect(wrongParent.status).toBe(404);
      expect(seam.mutationCalls).toBe(callsBefore);

      const faulted = await fetch(`${baseUrl}/api/v1/tasks/${owner}/subtasks/${kid.id}`, {
        method: "DELETE",
        headers: { "x-agent-api-key": agentKey },
      });
      expect(faulted.status).toBe(500);
      const body = (await faulted.json()) as any;
      expect(body.code).toBe("REPOSITORY_ERROR");
      expect(row(kid.id)).toBeDefined();
      expect(sseCount("subtask.deleted", owner)).toBe(0);
      expect(sseTotal()).toBe(sseBefore);
    } finally {
      db.run(sql`DROP TRIGGER tsc_delete_fault`);
    }

    const control = await fetch(`${baseUrl}/api/v1/tasks/${owner}/subtasks/${kid.id}`, {
      method: "DELETE",
      headers: { "x-agent-api-key": agentKey },
    });
    expect(control.status).toBe(204);
    expect(row(kid.id)).toBeUndefined();
  }, 30_000);
});

describe("PRODUCTION DRIVER — better-sqlite3 file DB (repository boundary)", () => {
  let dbFile: string;
  let taskIdA: string;
  let taskIdB: string;
  let childId: string;

  beforeEach(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tsc-prod-")), "orcy.db");
    await initDb(dbFile);
    const h = habitatRepo.createHabitat({ name: "tsc-prod-habitat" }).id;
    taskIdA = makeTask(h, "tsc-prod-a");
    taskIdB = makeTask(h, "tsc-prod-b");
    childId = makeChild(taskIdA, "tsc-prod-child").id;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it("UPDATE ... RETURNING: exact pair matches, wrong parent and absent child both match zero", () => {
    const matched = subtaskRepo.updateSubtask(taskIdA, childId, {
      completed: true,
      title: "driven",
    });
    expect(matched).not.toBeNull();
    expect(matched!.taskId).toBe(taskIdA);
    expect(matched!.completed).toBe(true);
    expect(matched!.title).toBe("driven");

    expect(subtaskRepo.updateSubtask(taskIdB, childId, { completed: false })).toBeNull();
    expect(
      subtaskRepo.updateSubtask(taskIdA, "00000000-0000-4000-8000-0000000000c1", {
        completed: false,
      }),
    ).toBeNull();
    // Wrong-parent attempt did not touch the row.
    expect(row(childId)!.completed).toBe(true);
  }, 30_000);

  it("DELETE ... RETURNING: wrong parent false, exact pair true, repeat false", () => {
    expect(subtaskRepo.deleteSubtask(taskIdB, childId)).toBe(false);
    expect(row(childId)).toBeDefined();

    expect(subtaskRepo.deleteSubtask(taskIdA, childId)).toBe(true);
    expect(row(childId)).toBeUndefined();
    expect(subtaskRepo.deleteSubtask(taskIdA, childId)).toBe(false);
  }, 30_000);

  it("write faults propagate as wrapped RepositoryError, never false success", () => {
    const db = getDb();
    db.run(
      sql`CREATE TRIGGER tsc_prod_update_fault BEFORE UPDATE ON task_subtasks BEGIN SELECT RAISE(ABORT, 'prod update failure'); END`,
    );
    expect(() => subtaskRepo.updateSubtask(taskIdA, childId, { completed: true })).toThrow(
      RepositoryError,
    );

    db.run(
      sql`CREATE TRIGGER tsc_prod_delete_fault BEFORE DELETE ON task_subtasks BEGIN SELECT RAISE(ABORT, 'prod delete failure'); END`,
    );
    expect(() => subtaskRepo.deleteSubtask(taskIdA, childId)).toThrow(RepositoryError);
    expect(row(childId)).toBeDefined();
  }, 30_000);
});
