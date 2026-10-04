/**
 * Workflow node integrity — PRODUCTION driver (better-sqlite3, file-backed,
 * WAL, FK-enforced) statement-level proofs:
 *
 *  - the journal is WAL with foreign_keys ON (the FK semantics the fences
 *    assume);
 *  - the conditional Workflow/gate writes + portable `SELECT changes()`
 *    oracle run on the production driver (missing/foreign endpoints are a
 *    zero-match that throws, not a silent no-op);
 *  - ATTACH DRIFT ROLLBACK: a deterministic seam mutates the persisted world
 *    AFTER the first valid gate INSERT has actually executed and BEFORE the
 *    second final statement — the second conditional gate INSERT matches
 *    zero rows, attach surfaces 409 CONFLICT `Workflow context changed`, and
 *    the whole bundle (Workflow + first gate) rolls back with NO post-commit
 *    audit. The seam records the first-write milestone, so a regression to
 *    write-without-transaction cannot pass via prevalidation;
 *  - INJECTED SQL FAULT after the first gate INSERT surfaces as a 5xx with
 *    the same full rollback.
 *
 * The seam patches `better-sqlite3`'s `Database.prototype.prepare` — the
 * connection the service actually uses — a real repository seam, not a
 * service mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb, closeDb, getDb } from "../db/index.js";
import { workflows, taskWorkflowGates, missionEvents, failureContexts, missions } from "../db/schema/index.js";
import {
  buildRecoveryLinkageParticipant,
  type RecoveryLinkage,
} from "../services/taskRecoveryPublication.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { workflowRoutes } from "../routes/workflow.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import type { Database } from "better-sqlite3";

const JWT_SECRET = "dev-secret-change-in-production";

function adminHeaders(): Record<string, string> {
  const token = jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
  return { authorization: `Bearer ${token}` };
}

async function buildApp(): Promise<FastifyInstance> {
  const f = Fastify({ logger: false });
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(f);
  await f.register(
    async (v1) => {
      await v1.register(workflowRoutes);
    },
    { prefix: "/api/v1" },
  );
  await f.ready();
  return f;
}

let app: FastifyInstance;
let dbFile: string;
let habitatId: string;
let missionId: string;
let taskA: string;
let taskB: string;
let taskC: string;

// --- The deterministic drift/fault seam ----------------------------------
type Statement = ReturnType<Database["prepare"]>;
let restoreSeam: (() => void) | null = null;
/** Set by the seam once the FIRST conditional gate INSERT has EXECUTED. */
let firstGateInsertExecuted = false;
/** Executed (same connection, mid-transaction) right after the first gate INSERT. */
let onFirstGateInsert: (() => void) | null = null;

/**
 * Patches the raw better-sqlite3 connection behind `getDb()` (drizzle's
 * `$client`) so that the FIRST execution of the conditional gate INSERT
 * triggers `afterFirstGateInsert` on the same connection —
 * deterministically between the first gate write and the second final
 * statement. An own-property patch on the live instance, restored by
 * deleting it; no service or route mocking.
 */
function installDriftSeam(afterFirstGateInsert: () => void): void {
  if (restoreSeam) return;
  const client = (getDb() as unknown as { $client: Database }).$client;
  const originalPrepare = client.prepare.bind(client);
  onFirstGateInsert = afterFirstGateInsert;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).prepare = function patchedPrepare(source: string, ...rest: unknown[]) {
    const stmt = (originalPrepare as unknown as (s: string, ...a: unknown[]) => Statement)(
      source,
      ...rest,
    );
    if (
      typeof source === "string" &&
      source.includes("INSERT INTO task_workflow_gates") &&
      source.includes("RETURNING")
    ) {
      const origGet = stmt.get.bind(stmt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stmt as any).get = (...args: unknown[]) => {
        const out = (origGet as unknown as (...a: unknown[]) => unknown)(...args);
        if (!firstGateInsertExecuted) {
          firstGateInsertExecuted = true;
          onFirstGateInsert?.();
        }
        return out;
      };
    }
    return stmt;
  };
  restoreSeam = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (client as any).prepare;
    restoreSeam = null;
  };
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-wf-integrity-")), "orcy.db");
  await initDb(dbFile);
  app = await buildApp();

  const habitat = habitatRepo.createHabitat({ name: "Prod Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "Todo", order: 0 });
  missionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "selected",
    createdBy: "t",
  }).id;
  taskA = taskCrudRepo.createTask({ missionId, title: "A", createdBy: "t" }).id;
  taskB = taskCrudRepo.createTask({ missionId, title: "B", createdBy: "t" }).id;
  taskC = taskCrudRepo.createTask({ missionId, title: "C", createdBy: "t" }).id;
  firstGateInsertExecuted = false;
  onFirstGateInsert = null;
});

afterEach(async () => {
  restoreSeam?.();
  await app.close();
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

function attachBody(gates: Array<{ upstreamTaskKey: string; downstreamTaskKey: string }>) {
  return {
    definition: {
      gates: gates.map((g) => ({ ...g, gateType: "on_complete" as const })),
    },
    variables: {},
  };
}

function counts(): { workflows: number; gates: number; audits: number } {
  const db = getDb();
  return {
    workflows: db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.missionId, missionId))
      .all().length,
    gates: db
      .select({ id: taskWorkflowGates.id })
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.missionId, missionId))
      .all().length,
    audits: db
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, missionId))
      .all()
      .filter((e) => e.action === "workflow_attached").length,
  };
}

describe("workflow node integrity — production driver (better-sqlite3, WAL, FK)", () => {
  it("runs on the production driver journal (WAL, foreign_keys ON)", () => {
    const journal = (getDb().all(sql`PRAGMA journal_mode`) as Array<{ journal_mode: string }>)[0]!;
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    const fk = (getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>)[0]!;
    expect(fk.foreign_keys).toBe(1);
  });

  it("conditional writes on the production driver: a foreign-Mission endpoint (legal FKs) is a zero-match refusal, not a silent no-op", async () => {
    const column = columnRepo.createColumn({ habitatId, name: "Other", order: 1 });
    const otherMission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "other",
      createdBy: "t",
    }).id;
    const foreignTask = taskCrudRepo.createTask({
      missionId: otherMission,
      title: "foreign",
      createdBy: "t",
    }).id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([{ upstreamTaskKey: taskA, downstreamTaskKey: foreignTask }]),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid workflow nodes");
    expect(counts()).toEqual({ workflows: 0, gates: 0, audits: 0 });
  });

  it("DRIFT ROLLBACK: after the FIRST gate INSERT executes, moving the second node to another Mission yields 409 + full rollback + no audit (first-write milestone observed)", async () => {
    const column = columnRepo.createColumn({ habitatId, name: "DriftCol", order: 2 });
    const driftMission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "drift-target",
      createdBy: "t",
    }).id;

    installDriftSeam(() => {
      // Mid-transaction, same connection: reparent the SECOND gate's
      // downstream task into another Mission. The second conditional gate
      // INSERT's endpoint predicate must now match zero rows.
      getDb().run(sql`UPDATE tasks SET mission_id = ${driftMission} WHERE id = ${taskC}`);
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: taskC },
      ]),
    });

    // The seam MUST have observed the first gate INSERT actually execute —
    // otherwise this test would silently degrade to a prevalidation proof.
    expect(firstGateInsertExecuted).toBe(true);
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Workflow context changed");
    expect(body.code).toBe("CONFLICT");
    // Full rollback: zero Workflow, zero gates (including the FIRST gate
    // that really inserted before the drift), zero post-commit audit.
    expect(counts()).toEqual({ workflows: 0, gates: 0, audits: 0 });
  });

  it("DRIFT ROLLBACK (upstream endpoint): reparenting the second gate's UPSTREAM node after the first gate INSERT yields 409 + full rollback", async () => {
    const column = columnRepo.createColumn({ habitatId, name: "DriftColU", order: 3 });
    const driftMission = missionRepo.createMission({
      habitatId,
      columnId: column.id,
      title: "drift-target-upstream",
      createdBy: "t",
    }).id;

    installDriftSeam(() => {
      // Mid-transaction, same connection: reparent the SECOND gate's
      // UPSTREAM task into another Mission. The upstream endpoint predicate
      // must catch the drift at the final statement.
      getDb().run(sql`UPDATE tasks SET mission_id = ${driftMission} WHERE id = ${taskB}`);
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: taskC },
      ]),
    });

    expect(firstGateInsertExecuted).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("Workflow context changed");
    expect(counts()).toEqual({ workflows: 0, gates: 0, audits: 0 });
  });

  it("INJECTED SQL FAULT after the first gate INSERT surfaces 5xx with full rollback", async () => {
    installDriftSeam(() => {
      // Infrastructure fault mid-transaction: invalid SQL on the same
      // connection aborts the attach's own transaction.
      getDb().run(sql`THIS IS NOT SQL`);
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: taskC },
      ]),
    });

    expect(firstGateInsertExecuted).toBe(true);
    expect([500, 503]).toContain(res.statusCode);
    expect(counts()).toEqual({ workflows: 0, gates: 0, audits: 0 });
  });

  it("positive attach on the production driver: 201 + both gates + one audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/missions/${missionId}/workflow`,
      headers: adminHeaders(),
      payload: attachBody([
        { upstreamTaskKey: taskA, downstreamTaskKey: taskB },
        { upstreamTaskKey: taskB, downstreamTaskKey: taskC },
      ]),
    });
    expect(res.statusCode).toBe(201);
    expect(counts()).toEqual({ workflows: 1, gates: 2, audits: 1 });
  });
});

// ===========================================================================
// Recovery participant final statements on the PRODUCTION driver.
//
// The participant owns its own conditional SQL (it does not use the shared
// primitives). These are the driver counterparts of the sql.js controls:
// final-CAS no-match, final-context no-match, the allowed same-Q match, and
// the drift-after-a-real-first-write rollback — all executed through the real
// better-sqlite3 connection, with FK enforcement ON, inside the caller's
// transaction. Drift rows are LEGALLY valid foreign rows (independent FKs
// allow them), so only the statement-time predicates can refuse.
// ===========================================================================

describe("workflow node integrity — Recovery participant on the production driver", () => {
  const NEXT_GATE_INSERT = "INSERT INTO task_workflow_gates";
  const POINTER_CAS = "UPDATE task_workflow_gates";
  const CONTEXT_UPDATE = "UPDATE failure_contexts";

  /** A Workflow + a depth-0 gate U→D, optionally with a Failure Context. */
  function seedRecoveryGate(withContext: boolean): {
    workflowId: string;
    gateId: string;
    downstreamTaskId: string;
    failureContextId: string | null;
  } {
    const db = getDb();
    const workflowId = `wf-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const gateId = `gate-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.insert(workflows)
      .values({ id: workflowId, missionId, habitatId, status: "active", createdBy: "t" })
      .run();
    db.insert(taskWorkflowGates)
      .values({
        id: gateId,
        workflowId,
        missionId,
        habitatId,
        upstreamTaskId: taskA,
        downstreamTaskId: taskB,
        gateType: "on_fail",
        matchConfig: null,
        condition: null,
        satisfied: false,
        recoveryDepth: 0,
      })
      .run();
    let failureContextId: string | null = null;
    if (withContext) {
      failureContextId = `fctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.insert(failureContexts)
        .values({
          id: failureContextId,
          failedTaskId: taskA,
          workflowId,
          habitatId,
          failureKind: "lifecycle_failed",
          failureReason: "drift",
          bundle: {
            artifacts: [],
            recentLifecycleEvents: [],
            experienceSignals: [],
            experienceCategorySummary: {},
            retryHistory: [],
          },
          bundleSchemaVersion: 1,
          recoveryDepth: 0,
        })
        .run();
    }
    return { workflowId, gateId, downstreamTaskId: taskB, failureContextId };
  }

  function linkageFor(seed: ReturnType<typeof seedRecoveryGate>): RecoveryLinkage {
    return {
      gateId: seed.gateId,
      workflowId: seed.workflowId,
      habitatId,
      missionId,
      downstreamTaskId: seed.downstreamTaskId,
      recoveryDepth: 0,
      ...(seed.failureContextId ? { failureContextId: seed.failureContextId } : {}),
    };
  }

  /**
   * Runs the real participant inside a real transaction against a REAL
   * persisted Recovery Task Q, through a `$client.prepare` seam on the actual
   * better-sqlite3 connection. `statements` records which final statements
   * actually executed, in order — so a refusal can never be attributed to a
   * later write than the one under test. `onBefore` runs on the same
   * connection immediately BEFORE a matching statement executes.
   */
  function runParticipant(
    linkage: RecoveryLinkage,
    qId: string,
    onBefore?: (sql: string) => void,
  ): { statements: string[]; error: unknown } {
    const statements: string[] = [];
    const participant = buildRecoveryLinkageParticipant(linkage);
    const client = getDb();
    const raw = (client as unknown as { $client: Database }).$client;
    const originalPrepare = raw.prepare.bind(raw);
    // The drift callback itself issues an UPDATE on the same connection; that
    // write must NOT re-enter the seam (it would recurse and masquerade as
    // the participant's own statement).
    let inCallback = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (raw as any).prepare = function patched(source: string, ...rest: unknown[]) {
      const stmt = (originalPrepare as unknown as (s: string, ...a: unknown[]) => Statement)(
        source,
        ...rest,
      );
      if (
        !inCallback &&
        typeof source === "string" &&
        (source.includes("INSERT INTO task_workflow_gates") ||
          source.includes("UPDATE task_workflow_gates") ||
          source.includes("UPDATE failure_contexts"))
      ) {
        const origGet = stmt.get.bind(stmt);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (stmt as any).get = (...args: unknown[]) => {
          statements.push(
            source.includes("INSERT INTO")
              ? "next-gate INSERT"
              : source.includes("task_workflow_gates")
                ? "pointer CAS"
                : "context UPDATE",
          );
          if (onBefore) {
            inCallback = true;
            try {
              onBefore(source);
            } finally {
              inCallback = false;
            }
          }
          return (origGet as unknown as (...a: unknown[]) => unknown)(...args);
        };
      }
      return stmt;
    };

    let error: unknown;
    try {
      client.transaction((tx) =>
        participant(
          tx as unknown as TaskPublicationDbClient,
          {
            task: { id: qId } as never,
            event: undefined as never,
            attemptId: "prod",
            proposal: undefined as never,
          },
        ),
      );
    } catch (err) {
      error = err;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (raw as any).prepare;
    }
    return { statements, error };
  }

  function otherMissionInHabitat(title: string): string {
    const column = columnRepo.createColumn({ habitatId, name: title, order: 91 });
    return missionRepo.createMission({ habitatId, columnId: column.id, title, createdBy: "t" }).id;
  }

  it("final pointer CAS: Workflow reparented to another valid Mission after the next-gate INSERT → refusal + whole-bundle rollback on the production driver", () => {
    const seed = seedRecoveryGate(true);
    const qId = taskCrudRepo.createTask({ missionId, title: "Q", createdBy: "t" }).id;
    const otherMission = otherMissionInHabitat("W drift");
    const { statements, error } = runParticipant(linkageFor(seed), qId, (s) => {
      if (s.includes(POINTER_CAS)) {
        getDb().run(sql`UPDATE workflows SET mission_id = ${otherMission} WHERE id = ${seed.workflowId}`);
      }
    });

    // The next-gate INSERT really executed first; the CAS is what refused.
    expect(statements.includes("next-gate INSERT")).toBe(true);
    expect(statements.includes("pointer CAS")).toBe(true);
    expect(String((error as Error).message)).toContain("lost its recovery-pointer CAS");
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, seed.gateId)).get()
        ?.recoveryTaskId,
    ).toBeNull();
    expect(getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.recoveryDepth, 1)).all()).toHaveLength(0);
  });

  it("final context UPDATE: the context is claimed by an unrelated Q before the UPDATE → refusal + whole-bundle rollback on the production driver", () => {
    const seed = seedRecoveryGate(true);
    const qId = taskCrudRepo.createTask({ missionId, title: "Q", createdBy: "t" }).id;
    const otherQ = taskCrudRepo.createTask({ missionId, title: "otherQ", createdBy: "t" }).id;
    const { statements, error } = runParticipant(linkageFor(seed), qId, (s) => {
      if (s.includes(CONTEXT_UPDATE)) {
        getDb().run(
          sql`UPDATE failure_contexts SET recovery_task_id = ${otherQ} WHERE id = ${seed.failureContextId}`,
        );
      }
    });

    // Assert the error FIRST so a wrong-refusal message is visible, then the
    // statement sequence.
    expect(String((error as Error).message)).toContain("failure-context link for");
    expect(statements).toEqual(["next-gate INSERT", "pointer CAS", "context UPDATE"]);
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, seed.gateId)).get()
        ?.recoveryTaskId,
    ).toBeNull();
  });

  it("a same-Q context pointer is an ALLOWED match on the production driver (not refused as a loser)", () => {
    const seed = seedRecoveryGate(true);
    const qId = taskCrudRepo.createTask({ missionId, title: "Q", createdBy: "t" }).id;
    getDb()
      .update(failureContexts)
      .set({ recoveryTaskId: qId })
      .where(eq(failureContexts.id, seed.failureContextId!))
      .run();

    const { statements, error } = runParticipant(linkageFor(seed), qId);

    expect(error).toBeUndefined();
    expect(statements.includes("context UPDATE")).toBe(true);
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, seed.gateId)).get()
        ?.recoveryTaskId,
    ).toBe(qId);
  });

  it("final pointer CAS: selected Mission reparented into a separately VALID Habitat after the next-gate INSERT → refusal + whole-bundle rollback on the production driver", () => {
    const seed = seedRecoveryGate(true);
    const qId = taskCrudRepo.createTask({ missionId, title: "Q", createdBy: "t" }).id;
    // A legal, separately valid Habitat: the reparent is FK-legal, so only the
    // statement-time Mission/Habitat predicate can refuse it — every gate
    // scalar still names M/H and every Task still belongs to M.
    const foreignHabitat = habitatRepo.createHabitat({ name: "CAS drift Habitat" });
    let driftObserved = false;
    const { statements, error } = runParticipant(linkageFor(seed), qId, (s) => {
      if (s.includes(POINTER_CAS)) {
        getDb().run(sql`UPDATE missions SET habitat_id = ${foreignHabitat.id} WHERE id = ${missionId}`);
        // Observed INSIDE the transaction: the rollback undoes the reparent,
        // so this is the only point at which the drift is observable, and it
        // is what makes the refusal non-vacuous.
        driftObserved =
          getDb().select().from(missions).where(eq(missions.id, missionId)).get()?.habitatId ===
          foreignHabitat.id;
      }
    });

    expect(statements).toEqual(["next-gate INSERT", "pointer CAS"]);
    expect(String((error as Error).message)).toContain("lost its recovery-pointer CAS");
    expect(driftObserved).toBe(true);
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, seed.gateId)).get()
        ?.recoveryTaskId,
    ).toBeNull();
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.recoveryDepth, 1)).all(),
    ).toHaveLength(0);
  });

  it("next-gate INSERT: upstream U reparented before the INSERT → the INSERT itself refuses (no CAS, no context write)", () => {
    const seed = seedRecoveryGate(true);
    const qId = taskCrudRepo.createTask({ missionId, title: "Q", createdBy: "t" }).id;
    const otherMission = otherMissionInHabitat("U drift");
    const { statements, error } = runParticipant(linkageFor(seed), qId, (s) => {
      if (s.includes(NEXT_GATE_INSERT)) {
        getDb().run(sql`UPDATE tasks SET mission_id = ${otherMission} WHERE id = ${taskA}`);
      }
    });

    expect(statements.includes("pointer CAS")).toBe(false);
    expect(String((error as Error).message)).toContain("next-depth gate insert matched no rows");
    expect(
      getDb().select().from(taskWorkflowGates).where(eq(taskWorkflowGates.id, seed.gateId)).get()
        ?.recoveryTaskId,
    ).toBeNull();
  });
});
