/**
 * Effort POST containment — PRODUCTION DRIVER proofs (better-sqlite3 file
 * DB, repository boundary, FK enforcement on). Not production-driver HTTP
 * evidence: these prove the contained creation primitives' final-statement
 * semantics — the conditional Task-ancestry INSERT for logEffort, the
 * conditional entry→Task ancestry INSERT for corrections, RETURNING-row
 * parity with a plain refetch, and statement-fault propagation (wrapped
 * RepositoryError, never false success or zero-match) — on the driver
 * production serves, not only the sql.js test driver.
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
import * as effortRepo from "../repositories/effortEntry.js";
import * as effortService from "../services/effortService.js";
import { effortEntries, tasks, missions, taskEvents } from "../db/schema/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { RepositoryError } from "../errors/repository.js";

let dbFile: string;
let habitatId: string;
let taskIdA: string;
let taskIdB: string;

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
    createdBy: "tep-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tep-seed" }).id;
}

function rowsFor(taskId: string) {
  return getDb().select().from(effortEntries).where(eq(effortEntries.taskId, taskId)).all();
}

function row(id: string) {
  return getDb().select().from(effortEntries).where(eq(effortEntries.id, id)).get();
}

function setFk(on: boolean): void {
  // Literal PRAGMAs only — a bound parameter is rejected by the drivers.
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(on ? 1 : 0);
}

function metricsRow(taskId: string) {
  // FULL Task row (every column).
  const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
  return t ? JSON.parse(JSON.stringify(t)) : null;
}

function missionRowFor(taskId: string) {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!task) return null;
  const row = getDb().select().from(missions).where(eq(missions.id, task.missionId)).get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function missionIdForTask(taskId: string): string {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    missionId: string;
  };
  return task.missionId;
}

function habitatIdForTask(taskId: string): string {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    missionId: string;
  };
  const mission = getDb()
    .select({ habitatId: missions.habitatId })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .get() as { habitatId: string };
  return mission.habitatId;
}

function enableAndAssertFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tep-")), "orcy.db");
  await initDb(dbFile);
  enableAndAssertFk();
  habitatId = habitatRepo.createHabitat({ name: "tep-habitat" }).id;
  taskIdA = makeTask("tep-a");
  taskIdB = makeTask("tep-b");
});

afterEach(() => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe("PRODUCTION DRIVER — contained creation primitives", () => {
  it("createTaskEffortEntry: matched conditional INSERT returns the row (RETURNING parity with a plain refetch); missing Task returns null with no row", () => {
    const created = effortRepo.createTaskEffortEntry({
      taskId: taskIdA,
      actorType: "agent",
      actorId: "tep-agent",
      minutes: 45,
      source: "agent_reported",
      note: "tep-log",
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-01T10:45:00.000Z",
    });
    expect(created).not.toBeNull();
    // RETURNING row equals a fresh drizzle select of the same row.
    expect(JSON.parse(JSON.stringify(created))).toEqual(
      JSON.parse(JSON.stringify(row(created!.id))),
    );
    expect(created!.startedAt).toBe("2026-01-01T10:00:00.000Z");

    const missing = effortRepo.createTaskEffortEntry({
      taskId: "tep-nonexistent-task",
      actorType: "agent",
      minutes: 5,
      source: "agent_reported",
    });
    expect(missing).toBeNull();
    expect(
      getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.taskId, "tep-nonexistent-task"))
        .all(),
    ).toHaveLength(0);
  });

  it("createTaskEffortCorrection: matched entry→Task ancestry inserts the offsetting row; foreign-Task or absent entry matches zero with no row", () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tep-human",
      minutes: 60,
      source: "human_manual",
    });

    const correction = effortRepo.createEffortCorrection({
      taskId: taskIdA,
      correctsEntryId: target.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -15,
      correctionReason: "tep-correction",
      note: "tep-note",
    });
    expect(correction).not.toBeNull();
    expect(JSON.parse(JSON.stringify(correction))).toEqual(
      JSON.parse(JSON.stringify(row(correction!.id))),
    );
    expect(correction!.correctsEntryId).toBe(target.id);
    expect(correction!.taskId).toBe(taskIdA);

    const beforeB = JSON.parse(JSON.stringify(rowsFor(taskIdB)));
    expect(
      effortRepo.createEffortCorrection({
        taskId: taskIdB,
        correctsEntryId: target.id,
        actorType: "human",
        actorId: "tep-human",
        minutesDelta: -15,
        correctionReason: "tep-foreign",
      }),
    ).toBeNull();
    expect(
      effortRepo.createEffortCorrection({
        taskId: taskIdA,
        correctsEntryId: "tep-nonexistent-entry",
        actorType: "human",
        actorId: "tep-human",
        minutesDelta: -15,
        correctionReason: "tep-absent",
      }),
    ).toBeNull();
    expect(JSON.parse(JSON.stringify(rowsFor(taskIdB)))).toEqual(beforeB);
    expect(rowsFor(taskIdA).some((r) => r.correctionReason === "tep-foreign")).toBe(false);
    expect(rowsFor(taskIdA).some((r) => r.correctionReason === "tep-absent")).toBe(false);
  });

  it("statement faults propagate as wrapped RepositoryError with the row absent — never false success or zero-match", () => {
    // Seed the correction target BEFORE the trigger: the abort applies to
    // every effort_entries INSERT, fixtures included.
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tep-human",
      minutes: 60,
      source: "human_manual",
    });
    getDb().run(
      sql`CREATE TRIGGER tep_effort_abort BEFORE INSERT ON effort_entries BEGIN SELECT RAISE(ABORT, 'tep-probe-abort'); END`,
    );
    try {
      expect(() =>
        effortRepo.createTaskEffortEntry({
          taskId: taskIdA,
          actorType: "agent",
          minutes: 5,
          source: "agent_reported",
        }),
      ).toThrow(RepositoryError);

      expect(() =>
        effortRepo.createEffortCorrection({
          taskId: taskIdA,
          correctsEntryId: target.id,
          actorType: "human",
          actorId: "tep-human",
          minutesDelta: -5,
          correctionReason: "tep-fault",
        }),
      ).toThrow(RepositoryError);

      expect(rowsFor(taskIdA).every((r) => r.correctionReason !== "tep-fault")).toBe(true);
    } finally {
      getDb().run(sql`DROP TRIGGER tep_effort_abort`);
    }

    // The identical call succeeds once the trigger is gone.
    const ok = effortRepo.createTaskEffortEntry({
      taskId: taskIdA,
      actorType: "agent",
      minutes: 5,
      source: "agent_reported",
    });
    expect(ok).not.toBeNull();
  });

  it("corrupt storage: Task row deleted with FK off (original survives) — correction matches zero on the missing-Task predicate, log matches zero, no orphan append", () => {
    const t = makeTask("tep-corrupt-task");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tep-human",
      minutes: 60,
      source: "human_manual",
    });
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM tasks WHERE id = ${t}`);
    } finally {
      setFk(true);
    }

    expect(getDb().select().from(tasks).where(eq(tasks.id, t)).all()).toHaveLength(0);
    expect(rowsFor(t)).toHaveLength(1); // surviving corrupt original

    const correction = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -10,
      correctionReason: "tep-corrupt-correction",
    });
    expect(correction).toBeNull();
    expect(
      effortRepo.createTaskEffortEntry({
        taskId: t,
        actorType: "agent",
        actorId: "tep-agent",
        minutes: 5,
        source: "agent_reported",
      }),
    ).toBeNull();
    expect(rowsFor(t)).toHaveLength(1);
    expect(rowsFor(t)[0]!.id).toBe(orig.id);
  });

  it("null-projection parity on the production driver: both siblings return exactly the stored row with null optional fields", () => {
    const logged = effortRepo.createTaskEffortEntry({
      taskId: taskIdA,
      actorType: "agent",
      actorId: "tep-agent",
      minutes: 7,
      source: "agent_reported",
    });
    expect(logged!.note).toBeNull();
    expect(logged!.startedAt).toBeNull();
    expect(logged!.endedAt).toBeNull();
    expect(logged!.correctsEntryId).toBeNull();
    expect(logged!.correctionReason).toBeNull();
    expect(logged!.metadata).toBeNull();
    expect(JSON.parse(JSON.stringify(logged))).toEqual(JSON.parse(JSON.stringify(row(logged!.id))));

    const corr = effortRepo.createEffortCorrection({
      taskId: taskIdA,
      correctsEntryId: logged!.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -2,
      correctionReason: "tep-null-parity",
    });
    expect(corr!.startedAt).toBeNull();
    expect(corr!.endedAt).toBeNull();
    expect(corr!.note).toBeNull();
    expect(corr!.metadata).toBeNull();
    expect(corr!.source).toBe("correction_adjustment");
    expect(JSON.parse(JSON.stringify(corr))).toEqual(JSON.parse(JSON.stringify(row(corr!.id))));
  });

  it("history chains on the production driver: repeated targets, correction-of-correction, dangling predecessor and raw self-cycle targets append; originals never rewritten; negative totals persist", () => {
    const t = makeTask("tep-history");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tep-human",
      minutes: 100,
      source: "human_manual",
    });
    const origSnapshot = JSON.parse(JSON.stringify(orig));

    const c1 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -30,
      correctionReason: "tep-hist-c1",
    });
    const c2 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -20,
      correctionReason: "tep-hist-c2",
    });
    expect(c1!.id).not.toBe(c2!.id);
    const c3 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: c1!.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: 5,
      correctionReason: "tep-hist-c3-of-c1",
    });
    expect(c3!.correctsEntryId).toBe(c1!.id);

    setFk(false);
    try {
      getDb().run(
        sql`INSERT INTO effort_entries (id, task_id, actor_type, minutes, source, recorded_at, corrects_entry_id, correction_reason) VALUES ('tep-dangling-target', ${t}, 'human', 1, 'human_manual', '2026-01-01T00:00:00.000Z', 'tep-nonexistent-predecessor', 'tep-dangling-predecessor')`,
      );
      getDb().run(
        sql`INSERT INTO effort_entries (id, task_id, actor_type, minutes, source, recorded_at, corrects_entry_id) VALUES ('tep-self-cycle', ${t}, 'human', 1, 'human_manual', '2026-01-01T00:00:00.000Z', 'tep-self-cycle')`,
      );
    } finally {
      setFk(true);
    }

    expect(
      effortRepo.createEffortCorrection({
        taskId: t,
        correctsEntryId: "tep-dangling-target",
        actorType: "human",
        actorId: "tep-human",
        minutesDelta: -1,
        correctionReason: "tep-hist-dangling",
      }),
    ).not.toBeNull();
    expect(
      effortRepo.createEffortCorrection({
        taskId: t,
        correctsEntryId: "tep-self-cycle",
        actorType: "human",
        actorId: "tep-human",
        minutesDelta: -1,
        correctionReason: "tep-hist-selfcycle",
      }),
    ).not.toBeNull();

    expect(JSON.parse(JSON.stringify(row(orig.id)))).toEqual(origSnapshot);

    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(102);
    expect(totals.correctionAdjustmentMinutes).toBe(-47);

    const neg = makeTask("tep-history-negative");
    effortRepo.createEffortEntry({
      taskId: neg,
      actorType: "human",
      actorId: "tep-human",
      minutes: 10,
      source: "human_manual",
    });
    effortRepo.createEffortCorrection({
      taskId: neg,
      correctsEntryId: effortRepo.getEffortEntriesByTask(neg)[0]!.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -30,
      correctionReason: "tep-history-negative",
    });
    effortRepo.recalculateTaskEffortMetrics(neg);
    expect(metricsRow(neg)!.actualMinutes).toBe(-20);
  });

  it("storage behavior on the production driver: raw target deletion SET NULLs references; Task deletion cascades entries", () => {
    const t = makeTask("tep-storage");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tep-human",
      minutes: 15,
      source: "human_manual",
    });
    const c1 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -5,
      correctionReason: "tep-storage-set-null",
    });
    getDb().delete(effortEntries).where(eq(effortEntries.id, orig.id)).run();
    expect((row(c1!.id) as { correctsEntryId: string | null }).correctsEntryId).toBeNull();

    const t2 = makeTask("tep-storage-cascade");
    effortRepo.createEffortEntry({
      taskId: t2,
      actorType: "human",
      actorId: "tep-human",
      minutes: 5,
      source: "human_manual",
    });
    getDb().delete(tasks).where(eq(tasks.id, t2)).run();
    expect(rowsFor(t2)).toHaveLength(0);
  });

  it("service-seam partial faults on the production driver (labeled SERVICE-SEAM, not HTTP): real audit rows and a real broadcaster subscriber prove retained stages; retries append distinctly", () => {
    type Op = "log" | "correct";
    type Stage = "audit" | "task" | "mission";
    const combos: Array<{ op: Op; stage: Stage }> = [];
    for (const stage of ["audit", "task", "mission"] as const) {
      for (const op of ["log", "correct"] as const) combos.push({ op, stage });
    }

    for (const { op, stage } of combos) {
      const tag = `tep-svc-${stage}-${op}`;
      const t = makeTask(tag);
      // Meaningful nondefault estimate drives the accuracy assertions
      // (source formula: estimationAccuracy = actual/estimate).
      const ESTIMATE = 200;
      getDb().update(tasks).set({ estimatedMinutes: ESTIMATE }).where(eq(tasks.id, t)).run();
      const original = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "tep-human",
        minutes: 60,
        source: "human_manual",
      });
      const originalBefore = JSON.parse(JSON.stringify(original));
      const action = op === "log" ? "effort_logged" : "effort_corrected";
      const probeOf = (r: any) => (op === "log" ? r.note === tag : r.correctionReason === tag);
      const metricsBefore = metricsRow(t);
      const missionBefore = missionRowFor(t);
      expect(metricsBefore.estimatedMinutes).toBe(ESTIMATE);
      const habitatId = habitatIdForTask(t);
      const missionId = missionIdForTask(t);

      // Real subscriber on the actual habitat stream handler list — the
      // service seam's direct broadcaster subscription (not an HTTP client).
      const observed: any[] = [];
      const unsubscribe = sseBroadcaster.subscribe(habitatId, (event: any) => {
        if (event?.type === "effort.updated") observed.push(event);
      });
      // Target-scoped triggers: the WHEN clause names the SELECTED
      // Task/Mission and action.
      const ddl =
        stage === "audit"
          ? `CREATE TRIGGER tep_svc_${stage}_${op} BEFORE INSERT ON task_events WHEN NEW.action = '${action}' AND NEW.task_id = '${t}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`
          : stage === "task"
            ? `CREATE TRIGGER tep_svc_${stage}_${op} BEFORE UPDATE ON tasks WHEN NEW.version > OLD.version AND OLD.id = '${t}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`
            : `CREATE TRIGGER tep_svc_${stage}_${op} BEFORE UPDATE ON missions WHEN NEW.actual_minutes IS NOT OLD.actual_minutes AND OLD.id = '${missionId}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`;
      getDb().run(sql.raw(ddl));
      // SERVICE SEAM exact-cause proof: the RAISE tag is visible in the
      // propagated error's own message (raw driver fault, Task stage) or in
      // the RepositoryError's causeMessage (audit/Mission stages).
      const expectCause = (err: unknown) => {
        const anyErr = err as { message?: string; cause?: { message?: string } };
        const texts = `${anyErr?.message ?? ""} ${anyErr?.cause?.message ?? ""}`;
        expect(texts).toContain(tag);
      };
      try {
        if (op === "log") {
          try {
            effortService.logEffort(t, "agent", "tep-agent", { minutes: 40, note: tag });
            expect.unreachable("fault must propagate");
          } catch (err) {
            expectCause(err);
            if (stage !== "task") expect(err).toBeInstanceOf(RepositoryError);
          }
        } else {
          try {
            effortService.correctEffortEntry(t, original.id, "human", "tep-human", {
              minutesDelta: -10,
              correctionReason: tag,
            });
            expect.unreachable("fault must propagate");
          } catch (err) {
            expectCause(err);
            if (stage !== "task") expect(err).toBeInstanceOf(RepositoryError);
          }
        }
      } finally {
        getDb().run(sql.raw(`DROP TRIGGER tep_svc_${stage}_${op}`));
        unsubscribe();
      }

      // The fault-window append is committed with its full projection.
      const committed = rowsFor(t).filter(probeOf);
      expect(committed).toHaveLength(1);
      const faultRow = committed[0]!;
      expect(faultRow.taskId).toBe(t);
      expect(faultRow.actorType).toBe(op === "log" ? "agent" : "human");
      expect(faultRow.actorId).toBe(op === "log" ? "tep-agent" : "tep-human");
      expect(faultRow.source).toBe(op === "log" ? "agent_reported" : "correction_adjustment");
      expect(faultRow.minutes).toBe(op === "log" ? 40 : -10);
      expect(faultRow.metadata).toBeNull();
      const faultRowBytes = JSON.parse(JSON.stringify(faultRow));

      // REAL audit rows (not seam spies): retention per stage with exact
      // actor, reference, delta metadata and request-context provenance.
      const auditRows = getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, t))
        .all() as any[];
      const effortAudits = auditRows.filter((a) => a.action === action);
      if (stage === "audit") {
        expect(effortAudits).toHaveLength(0);
      } else {
        expect(effortAudits).toHaveLength(1);
        expect(effortAudits[0].actorType).toBe(op === "log" ? "agent" : "human");
        expect(effortAudits[0].actorId).toBe(op === "log" ? "tep-agent" : "tep-human");
        expect((effortAudits[0].metadata as any).effortEntryId).toBe(faultRow.id);
        if (op === "correct") {
          expect((effortAudits[0].metadata as any).correctsEntryId).toBe(original.id);
          expect((effortAudits[0].metadata as any).minutesDelta).toBe(-10);
          expect((effortAudits[0].metadata as any).correctionReason).toBe(tag);
        } else {
          expect((effortAudits[0].metadata as any).minutes).toBe(40);
          expect((effortAudits[0].metadata as any).note).toBe(tag);
        }
        // Service-seam provenance ABSENCE asserted explicitly: outside an
        // HTTP request context no provenance scope exists, so the stored
        // metadata carries NO audit block (HTTP cells assert the opposite).
        expect((effortAudits[0].metadata as any).audit).toBeUndefined();
      }

      // FULL Task/Mission row retention per stage (mission stage changes
      // exactly the four Task metric fields).
      const stripMetricFields = (row: any) => {
        const { actualMinutes, estimationAccuracy, version, updatedAt, ...rest } = row;
        return rest;
      };
      if (stage === "mission") {
        const taskNow = metricsRow(t)!;
        const expectedTaskActual = op === "log" ? 100 : 50;
        expect(taskNow.actualMinutes).toBe(expectedTaskActual);
        expect(taskNow.version).toBe(metricsBefore!.version + 1);
        expect(taskNow.updatedAt).not.toBe(metricsBefore!.updatedAt);
        expect(taskNow.estimationAccuracy).toBeCloseTo(expectedTaskActual / ESTIMATE, 10);
        expect(stripMetricFields(taskNow)).toEqual(stripMetricFields(metricsBefore));
        expect(missionRowFor(t)).toEqual(missionBefore);
      } else {
        expect(metricsRow(t)).toEqual(metricsBefore);
        expect(metricsRow(t)!.estimationAccuracy).toBe(metricsBefore!.estimationAccuracy);
        expect(missionRowFor(t)).toEqual(missionBefore);
      }
      expect(
        JSON.parse(
          JSON.stringify(
            getDb().select().from(effortEntries).where(eq(effortEntries.id, original.id)).get(),
          ),
        ),
      ).toEqual(originalBefore);

      // No publication reached the subscriber during the fault window.
      expect(observed.filter((e: any) => e.data?.taskId === t)).toHaveLength(0);

      // Retry appends a DISTINCT row; the subscriber observes exactly one
      // delivery for it and the fault-window row stays byte-identical.
      const retryObserved: any[] = [];
      const unsub2 = sseBroadcaster.subscribe(habitatId, (e: any) => retryObserved.push(e));
      const retried =
        op === "log"
          ? effortService.logEffort(t, "agent", "tep-agent", { minutes: 40, note: tag })
          : effortService.correctEffortEntry(t, original.id, "human", "tep-human", {
              minutesDelta: -10,
              correctionReason: tag,
            });
      unsub2();
      expect(retried.id).not.toBe(faultRow.id);
      expect(retried.taskId).toBe(t);
      expect(retried.actorType).toBe(op === "log" ? "agent" : "human");
      expect(retried.actorId).toBe(op === "log" ? "tep-agent" : "tep-human");
      expect(retried.minutes).toBe(op === "log" ? 40 : -10);
      expect(retried.source).toBe(op === "log" ? "agent_reported" : "correction_adjustment");
      const rowsAfterRetry = rowsFor(t).filter(probeOf);
      expect(rowsAfterRetry).toHaveLength(2);
      expect(JSON.parse(JSON.stringify(rowsAfterRetry.find((r) => r.id === faultRow.id)))).toEqual(
        faultRowBytes,
      );
      const after = op === "log" ? 140 : 40;
      expect(metricsRow(t)!.actualMinutes).toBe(after);
      expect(metricsRow(t)!.estimationAccuracy).toBeCloseTo(after / ESTIMATE, 10);
      const missionAfterRetry = missionRowFor(t)!;
      expect(missionAfterRetry.actualMinutes).toBe(after);
      expect(missionAfterRetry.plannedMinutes).toBe(ESTIMATE);
      expect(missionAfterRetry.planningAccuracy).toBeCloseTo(after / ESTIMATE, 10);
      const deliveries = retryObserved.filter(
        (e: any) => e?.type === "effort.updated" && e.data?.taskId === t,
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].data.entryId).toBe(retried.id);
      expect(deliveries[0].data.actorId).toBe(op === "log" ? "tep-agent" : "tep-human");
    }
  });

  it("legal FK-ON multirow/cyclic references on the production driver with NONEMPTY unrelated history; every prior row stays byte-identical after each append", () => {
    const t = makeTask("tep-legal-cycle");
    // NONEMPTY unrelated history on a second Task — its unchanged assertion
    // has real rows to preserve.
    const unrelated = makeTask("tep-legal-cycle-unrelated");
    const unrelatedOriginal = effortRepo.createEffortEntry({
      taskId: unrelated,
      actorType: "human",
      actorId: "tep-human",
      minutes: 7,
      source: "human_manual",
    });
    effortRepo.createEffortCorrection({
      taskId: unrelated,
      correctsEntryId: unrelatedOriginal.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -2,
      correctionReason: "tep-unrelated-corr",
    });
    const unrelatedBefore = JSON.parse(JSON.stringify(rowsFor(unrelated)));
    expect(unrelatedBefore).toHaveLength(2);

    const a = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tep-human",
      minutes: 50,
      source: "human_manual",
    });
    const b = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: a.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -5,
      correctionReason: "tep-cycle-b",
    });
    // Close a legal two-row cycle a↔b with FK enforcement ON (raw UPDATE of
    // an existing reference — storage permits it; served appends never do).
    getDb()
      .update(effortEntries)
      .set({ correctsEntryId: b!.id })
      .where(eq(effortEntries.id, a.id))
      .run();

    let snapshot = JSON.parse(JSON.stringify(rowsFor(t)));
    expect(snapshot).toHaveLength(2);
    const c = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: a.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -1,
      correctionReason: "tep-cycle-c-of-a",
    });
    expect(c).not.toBeNull();
    // EVERY prior row byte-identical; exactly one new row.
    const afterC = JSON.parse(JSON.stringify(rowsFor(t)));
    expect(afterC.filter((r: any) => r.id !== c!.id)).toEqual(snapshot);
    expect(afterC).toHaveLength(snapshot.length + 1);

    // Multi-in-degree: a second correction referencing b.
    snapshot = afterC;
    const d = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: b!.id,
      actorType: "human",
      actorId: "tep-human",
      minutesDelta: -2,
      correctionReason: "tep-cycle-d-of-b",
    });
    expect(d).not.toBeNull();
    const afterD = JSON.parse(JSON.stringify(rowsFor(t)));
    expect(afterD.filter((r: any) => r.id !== d!.id)).toEqual(snapshot);

    // Unrelated history untouched throughout.
    expect(JSON.parse(JSON.stringify(rowsFor(unrelated)))).toEqual(unrelatedBefore);

    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(50);
    expect(totals.correctionAdjustmentMinutes).toBe(-8);
  });
});
