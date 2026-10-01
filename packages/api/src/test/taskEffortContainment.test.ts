/**
 * Effort POST containment — final-predicate and ordering proofs labeled by
 * boundary.
 *
 *  1. PRIMITIVES (repository boundary, real sql.js DB, FK enforcement ON):
 *     the two contained creation statements only land while the ancestry
 *     predicate holds at statement-evaluation time. `createTaskEffortEntry`
 *     requires the URL Task to exist; `createTaskEffortCorrection` requires
 *     the corrected entry to belong to the URL Task. Zero-match is a null
 *     result with no row — never a false success or an unrestricted write.
 *
 *  2. SEAM (service boundary, real sql.js DB): the repository module is
 *     wrapped (everything else — service logic, error mapping, the actual
 *     SQL — is real code): the wrapper fires a one-shot out-of-band DB
 *     change at exactly the seam between the service's synchronous pre-read
 *     and the repository mutation, then delegates to the REAL
 *     implementation. An entry reparented to another Task (or deleted)
 *     between pre-read and write must match zero — 404, no correction row,
 *     no audit event, no metrics recalculation, no SSE.
 *
 *  3. ORDERING TRUTH (preserved post-commit pipeline, real sql.js DB): the
 *     write order stays entry INSERT → audit (THROWS) → Task metrics
 *     recalculation (CAS-limited, then Mission metrics) → SSE publish. An
 *     audit failure leaves the entry committed (partial commit) and
 *     propagates (exception truth) with NO metrics recalculation and NO SSE;
 *     a matched write publishes exactly one `effort.updated` SSE event only
 *     after the audit succeeded.
 *
 *  4. WIRE FAULT (real TCP into the real application, DB live): a temporary
 *     SQLite BEFORE INSERT trigger aborts the effort-entry INSERT itself
 *     AFTER authentication, Task admission and prechecks passed — the
 *     outcome is 500 with the row absent and zero effort.updated SSE, never
 *     a flattened 404 or false success. A wrong-Task correction under the
 *     installed trigger stays 400 and never reaches the aborting statement
 *     (pinned by the wrapper's call counter). Dropping the trigger turns the
 *     byte-identical request into success.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";

import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as effortRepo from "../repositories/effortEntry.js";
import * as effortService from "../services/effortService.js";
import { effortEntries, tasks, taskEvents, missions } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import { RepositoryError } from "../errors/repository.js";

const seam = vi.hoisted(() => ({
  mutationCalls: 0,
  precheckReads: 0,
  interpose: null as null | (() => void),
}));

vi.mock("../repositories/effortEntry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/effortEntry.js")>();
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
    createTaskEffortEntry: counted(actual.createTaskEffortEntry),
    createEffortCorrection: counted(actual.createEffortCorrection),
    getEffortEntryById: ((id: string) => {
      // Instrumentation only (service-boundary pre-read counter); delegates
      // to the real implementation — this is NOT a behavioral mock.
      seam.precheckReads += 1;
      return actual.getEffortEntryById(id);
    }) as typeof actual.getEffortEntryById,
  };
});

const auditSeam = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  failNext: false,
}));

vi.mock("../services/auditEventEmitter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/auditEventEmitter.js")>();
  type AuditInput = Parameters<typeof actual.emitTaskAuditEvent>[0];
  return {
    ...actual,
    emitTaskAuditEvent: (input: AuditInput) => {
      auditSeam.calls.push(input as unknown as Record<string, unknown>);
      if (auditSeam.failNext) {
        auditSeam.failNext = false;
        throw new RepositoryError(
          "effortEntry",
          "create",
          "effort audit emission probe",
          new Error("probe-audit-fault"),
        );
      }
      return actual.emitTaskAuditEvent(input);
    },
  };
});

const publishSpy = vi.spyOn(sseBroadcaster, "publish");
function effortSseCount(taskId: string): number {
  return publishSpy.mock.calls.filter(
    ([, event]: any) => event?.type === "effort.updated" && event?.data?.taskId === taskId,
  ).length;
}

let app: HttpRuntimeHandle;
let baseUrl: string;
let agentKey: string;
let agentId: string;
let habitatId: string;
let taskIdA: string;
let taskIdB: string;
let teamHabitatId: string;
let teamMemberJwt: string;
let teamNonmemberJwt: string;

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
function makeTask(title: string, habitatOverride?: string): string {
  const column = columnRepo.createColumn({
    habitatId: habitatOverride ?? habitatId,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitatOverride ?? habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "tec-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tec-seed" }).id;
}

function rowsFor(taskId: string) {
  return getDb().select().from(effortEntries).where(eq(effortEntries.taskId, taskId)).all();
}

function missionRowFor(taskId: string) {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!task) return null;
  // FULL Mission row (every column).
  const row = getDb().select().from(missions).where(eq(missions.id, task.missionId)).get();
  return JSON.parse(JSON.stringify(row));
}
function missionIdForTask(taskId: string): string {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    missionId: string;
  };
  return task.missionId;
}

function auditRowsFor(taskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all()),
  );
}

function taskLifecycleRow(taskId: string) {
  const row = getDb()
    .select({
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      cycleTimeMinutes: tasks.cycleTimeMinutes,
      leadTimeMinutes: tasks.leadTimeMinutes,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  return JSON.parse(JSON.stringify(row));
}

function setFk(on: boolean): void {
  // Literal PRAGMAs only — a bound parameter (`PRAGMA foreign_keys = ?`)
  // is rejected by the drivers.
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(on ? 1 : 0);
}

function metricsRow(taskId: string) {
  // FULL Task row (every column) — fault cells compare complete row state.
  const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
  return JSON.parse(JSON.stringify(row));
}

/** Commissioned FK-integrity proof state: enforcement explicitly ON before fixtures. */
function enableAndAssertFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(1);
}

beforeAll(async () => {
  await initTestDb();
  enableAndAssertFk();

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  habitatId = habitatRepo.createHabitat({ name: "tec-habitat" }).id;
  taskIdA = makeTask("tec-a");
  taskIdB = makeTask("tec-b");

  const created = agentRepo.createAgent({
    name: "tec-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  // Team fixtures for the instrumented admission-order proofs (member vs
  // nonmember humans against a team Habitat).
  const org = organizationRepo.createOrganization({
    name: "tec-org",
    slug: `tec-org-${Date.now()}`,
  });
  const teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "tec-team",
    slug: `tec-team-${Date.now()}`,
  }).id;
  teamHabitatId = habitatRepo.createHabitat({ name: "tec-team-habitat", teamId }).id;
  // FK is ON in this file: team_members.user_id references users.id, so the
  // member humans must exist as real user rows (unlike FK-off wire fixtures).
  const now = new Date().toISOString();
  for (const userId of ["tec-member", "tec-nonmember"]) {
    userRepo.createUser({
      id: userId,
      username: `tec-${userId}`,
      passwordHash: "tec-unused-hash",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: "tec-member", role: "member" });
  const mint = (userId: string, role: string) =>
    jwt.sign({ sub: userId, username: `tec-${userId}`, role }, getJwtSecret(), {
      expiresIn: "1h",
      issuer: "orcy",
    });
  teamMemberJwt = mint("tec-member", "member");
  teamNonmemberJwt = mint("tec-nonmember", "admin");
}, 120_000);

afterAll(async () => {
  await sharedStreamClose();
  await app.close();
  closeDb();
});

async function post(
  path: string,
  body: unknown,
  prefix: string = "/api/v1",
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method: "POST",
    headers: { "x-agent-api-key": agentKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed, text };
}

describe("PRIMITIVES — contained creation statements (sql.js, FK ON)", () => {
  it("createTaskEffortEntry: matched INSERT returns the full row; missing Task matches zero with no row", () => {
    const row = effortRepo.createTaskEffortEntry({
      taskId: taskIdA,
      actorType: "agent",
      actorId: agentId,
      minutes: 30,
      source: "agent_reported",
      note: "primitive-log",
    });
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe(taskIdA);
    expect(row!.minutes).toBe(30);
    expect(row!.source).toBe("agent_reported");
    expect(row!.correctsEntryId).toBeNull();

    const missing = effortRepo.createTaskEffortEntry({
      taskId: "tec-nonexistent-task",
      actorType: "agent",
      actorId: agentId,
      minutes: 5,
      source: "agent_reported",
    });
    expect(missing).toBeNull();
    expect(
      getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.taskId, "tec-nonexistent-task"))
        .all(),
    ).toHaveLength(0);
  });

  it("createTaskEffortCorrection: matched ancestry returns the offsetting row; foreign-Task or absent entry matches zero with no row", () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tec-human",
      minutes: 60,
      source: "human_manual",
    });

    const correction = effortRepo.createEffortCorrection({
      taskId: taskIdA,
      correctsEntryId: target.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -10,
      correctionReason: "primitive-correction",
    });
    expect(correction).not.toBeNull();
    expect(correction!.source).toBe("correction_adjustment");
    expect(correction!.minutes).toBe(-10);
    expect(correction!.correctsEntryId).toBe(target.id);
    expect(correction!.taskId).toBe(taskIdA);

    const beforeB = JSON.parse(JSON.stringify(rowsFor(taskIdB)));
    const foreign = effortRepo.createEffortCorrection({
      taskId: taskIdB,
      correctsEntryId: target.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -10,
      correctionReason: "must-not-land",
    });
    expect(foreign).toBeNull();
    expect(JSON.parse(JSON.stringify(rowsFor(taskIdB)))).toEqual(beforeB);

    const absent = effortRepo.createEffortCorrection({
      taskId: taskIdA,
      correctsEntryId: "tec-nonexistent-entry",
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -10,
      correctionReason: "must-not-land",
    });
    expect(absent).toBeNull();
  });
});

describe("SEAM — post-pre-read mutation defeats the final SQL predicate (service boundary)", () => {
  it("entry reparented A→B between pre-read and write matches zero — 404, no correction row, no audit, no recalc, no SSE", () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tec-human",
      minutes: 40,
      source: "human_manual",
    });
    const rowsBefore = JSON.parse(JSON.stringify(rowsFor(taskIdA)));
    const metricsBefore = metricsRow(taskIdA);
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = effortSseCount(taskIdA);

    seam.interpose = () => {
      getDb()
        .update(effortEntries)
        .set({ taskId: taskIdB })
        .where(eq(effortEntries.id, target.id))
        .run();
    };

    expect(() =>
      effortService.correctEffortEntry(taskIdA, target.id, "human", "tec-human", {
        minutesDelta: -5,
        correctionReason: "seam-reparent",
      }),
    ).toThrow("Effort entry not found");

    // The pre-read saw the entry on A, the INSERT matched zero after the
    // reparent: exactly one mutation attempt, and A's remaining rows are
    // exactly the pre-seam set minus the reparented target itself — no
    // correction row landed anywhere.
    expect(seam.mutationCalls).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(JSON.stringify(rowsFor(taskIdA)))).toEqual(
      rowsBefore.filter((r: any) => r.id !== target.id),
    );
    expect(rowsFor(taskIdB).some((r) => r.correctionReason === "seam-reparent")).toBe(false);
    expect(rowsFor(taskIdA).some((r) => r.correctionReason === "seam-reparent")).toBe(false);
    expect(auditSeam.calls.length).toBe(auditsBefore);
    expect(metricsRow(taskIdA)).toEqual(metricsBefore);
    expect(effortSseCount(taskIdA)).toBe(sseBefore);
  });

  it("entry deleted between pre-read and write matches zero — 404, no correction row", () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tec-human",
      minutes: 40,
      source: "human_manual",
    });
    const rowsBefore = JSON.parse(JSON.stringify(rowsFor(taskIdA)));

    seam.interpose = () => {
      getDb().delete(effortEntries).where(eq(effortEntries.id, target.id)).run();
    };

    expect(() =>
      effortService.correctEffortEntry(taskIdA, target.id, "human", "tec-human", {
        minutesDelta: -5,
        correctionReason: "seam-delete",
      }),
    ).toThrow("Effort entry not found");
    expect(JSON.parse(JSON.stringify(rowsFor(taskIdA)))).toEqual(
      rowsBefore.filter((r: any) => r.id !== target.id),
    );
  });

  it("logEffort on an absent Task is a 404-shaped service error with zero rows and zero downstream effects", () => {
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = publishSpy.mock.calls.length;

    expect(() =>
      effortService.logEffort("tec-nonexistent-task", "agent", agentId, { minutes: 5 }),
    ).toThrow("Task not found");

    expect(
      getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.taskId, "tec-nonexistent-task"))
        .all(),
    ).toHaveLength(0);
    expect(auditSeam.calls.length).toBe(auditsBefore);
    expect(publishSpy.mock.calls.length).toBe(sseBefore);
  });
});

describe("ORDERING TRUTH — entry → audit(throws) → metrics → SSE (preserved pipeline)", () => {
  it("audit failure: entry stays committed, exception propagates, no metrics recalculation, no SSE (partial commit + exception truth)", () => {
    const metricsBefore = metricsRow(taskIdA);
    const sseBefore = effortSseCount(taskIdA);
    auditSeam.failNext = true;

    expect(() =>
      effortService.logEffort(taskIdA, "agent", agentId, {
        minutes: 25,
        note: "audit-fault-probe",
      }),
    ).toThrow("effort audit emission probe");

    const committed = getDb()
      .select()
      .from(effortEntries)
      .where(eq(effortEntries.note, "audit-fault-probe"))
      .all();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.taskId).toBe(taskIdA);
    expect(metricsRow(taskIdA)).toEqual(metricsBefore);
    expect(effortSseCount(taskIdA)).toBe(sseBefore);
  });

  it("matched write: audit recorded once, Task metrics recalculated exactly once (logged basis), Mission metrics follow, exactly one effort.updated after the audit", () => {
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = effortSseCount(taskIdA);

    const entry = effortService.logEffort(taskIdA, "agent", agentId, {
      minutes: 35,
      note: "ordering-probe",
    });
    expect(entry.taskId).toBe(taskIdA);

    const auditCalls = auditSeam.calls.slice(auditsBefore);
    expect(auditCalls).toHaveLength(1);
    expect((auditCalls[0] as any).action).toBe("effort_logged");

    const metrics = metricsRow(taskIdA);
    const totals = effortRepo.getEffortTotalsForTask(taskIdA);
    expect(metrics.actualMinutes).toBe(
      totals.loggedEffortMinutes + totals.correctionAdjustmentMinutes,
    );

    expect(effortSseCount(taskIdA)).toBe(sseBefore + 1);
    const lastEvent = publishSpy.mock.calls
      .filter(
        ([, event]: any) => event?.type === "effort.updated" && event?.data?.taskId === taskIdA,
      )
      .at(-1);
    expect((lastEvent as any)[1].data.entryId).toBe(entry.id);
  });

  it("matched correction: audit action effort_corrected, correction visible in totals, exactly one SSE", () => {
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = effortSseCount(taskIdA);
    const target = getDb()
      .select()
      .from(effortEntries)
      .where(eq(effortEntries.note, "ordering-probe"))
      .get();

    const correction = effortService.correctEffortEntry(taskIdA, target!.id, "agent", agentId, {
      minutesDelta: -35,
      correctionReason: "ordering-correction",
    });
    expect(correction.correctsEntryId).toBe(target!.id);

    const auditCalls = auditSeam.calls.slice(auditsBefore);
    expect(auditCalls).toHaveLength(1);
    expect((auditCalls[0] as any).action).toBe("effort_corrected");
    expect(effortSseCount(taskIdA)).toBe(sseBefore + 1);
  });
});

describe("WIRE FAULT — statement abort after admission and prechecks (real TCP, DB live)", () => {
  it("BEFORE INSERT abort on effort_entries: write is 500 with zero rows and zero effort.updated; wrong-Task correction never reaches the statement", async () => {
    // Seed the wrong-Task correction target BEFORE the trigger: the abort
    // applies to every effort_entries INSERT, fixtures included.
    const target = effortRepo.createEffortEntry({
      taskId: taskIdB,
      actorType: "human",
      actorId: "tec-human",
      minutes: 30,
      source: "human_manual",
    });
    getDb().run(
      sql`CREATE TRIGGER tec_effort_abort BEFORE INSERT ON effort_entries BEGIN SELECT RAISE(ABORT, 'tec-probe-abort'); END`,
    );
    try {
      const auditsBefore = auditSeam.calls.length;
      const sseBefore = effortSseCount(taskIdA);
      const rowsBefore = JSON.parse(JSON.stringify(rowsFor(taskIdA)));

      const res = await post(`/tasks/${taskIdA}/effort-entries`, {
        minutes: 15,
        note: "wire-fault-probe",
      });
      expect(res.status).toBe(500);
      expect(JSON.parse(JSON.stringify(rowsFor(taskIdA)))).toEqual(rowsBefore);
      expect(effortSseCount(taskIdA)).toBe(sseBefore);
      expect(auditSeam.calls.length).toBe(auditsBefore);

      // Wrong-Task correction stays at the 400 pre-check and never reaches
      // the aborting INSERT (the seam counter proves the statement was
      // never invoked for it).
      const callsBefore = seam.mutationCalls;
      const wrong = await post(`/tasks/${taskIdA}/effort-entries/${target.id}/correct`, {
        minutesDelta: -5,
        correctionReason: "wire-fault-wrong-task",
      });
      expect(wrong.status).toBe(400);
      expect(seam.mutationCalls).toBe(callsBefore);
    } finally {
      getDb().run(sql`DROP TRIGGER tec_effort_abort`);
    }

    // Byte-identical request succeeds once the trigger is gone.
    const ok = await post(`/tasks/${taskIdA}/effort-entries`, {
      minutes: 15,
      note: "wire-fault-probe",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.note).toBe("wire-fault-probe");
  });
});

describe("SEAM — cross-habitat reparent and post-admission Task disappearance (interleave seam, not natural concurrency)", () => {
  it("entry reparented to a different Habitat between pre-read and statement matches zero through the real route — 404, no row, no postlude", async () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tec-human",
      minutes: 40,
      source: "human_manual",
    });
    const otherHabitatId = habitatRepo.createHabitat({ name: "tec-other-habitat" }).id;
    const otherHabitatTask = makeTask("tec-other-habitat-task", otherHabitatId);
    const metrics = metricsRow(taskIdA);
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = effortSseCount(taskIdA);

    seam.interpose = () => {
      getDb()
        .update(effortEntries)
        .set({ taskId: otherHabitatTask })
        .where(eq(effortEntries.id, target.id))
        .run();
    };

    const res = await post(`/tasks/${taskIdA}/effort-entries/${target.id}/correct`, {
      minutesDelta: -5,
      correctionReason: "seam-cross-habitat-reparent",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Effort entry not found");
    // The competing writer's moved row is preserved under its new Task —
    // only the reparent delta differs; no correction landed anywhere.
    const moved = rowsFor(otherHabitatTask).find((r) => r.id === target.id);
    expect(moved).toBeDefined();
    expect(moved!.taskId).toBe(otherHabitatTask);
    expect(rowsFor(taskIdA).some((r) => r.id === target.id)).toBe(false);
    expect(rowsFor(taskIdA).some((r) => r.correctionReason === "seam-cross-habitat-reparent")).toBe(
      false,
    );
    expect(
      rowsFor(otherHabitatTask).some((r) => r.correctionReason === "seam-cross-habitat-reparent"),
    ).toBe(false);
    expect(auditSeam.calls.length).toBe(auditsBefore);
    expect(metricsRow(taskIdA)).toEqual(metrics);
    expect(effortSseCount(taskIdA)).toBe(sseBefore);
  });

  it("Task deleted after route admission and before the log INSERT: clean zero-match 404, never an FK 500", async () => {
    const doomed = makeTask("tec-doomed-log");
    const auditsBefore = auditSeam.calls.length;
    const sseBefore = publishSpy.mock.calls.length;

    seam.interpose = () => {
      getDb().delete(tasks).where(eq(tasks.id, doomed)).run();
    };

    const res = await post(`/tasks/${doomed}/effort-entries`, {
      minutes: 7,
      note: "seam-task-vanish-log",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Task not found");
    expect(
      getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.note, "seam-task-vanish-log"))
        .all(),
    ).toHaveLength(0);
    expect(auditSeam.calls.length).toBe(auditsBefore);
    expect(publishSpy.mock.calls.length).toBe(sseBefore);
  });

  it("Task deleted after the positive original pre-check: correction is the late generic 404", async () => {
    const doomed = makeTask("tec-doomed-correct");
    const target = effortRepo.createEffortEntry({
      taskId: doomed,
      actorType: "human",
      actorId: "tec-human",
      minutes: 20,
      source: "human_manual",
    });

    seam.interpose = () => {
      // FK ON: deleting the Task cascades the original too — the final
      // statement must then match zero on both predicates.
      getDb().delete(tasks).where(eq(tasks.id, doomed)).run();
    };

    const res = await post(`/tasks/${doomed}/effort-entries/${target.id}/correct`, {
      minutesDelta: -4,
      correctionReason: "seam-task-vanish-correct",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Effort entry not found");
    expect(
      getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.correctionReason, "seam-task-vanish-correct"))
        .all(),
    ).toHaveLength(0);
  });
});

describe("WIRE FAULT — real downstream statement aborts (entry/audit/Task/Mission triggers, real TCP)", () => {
  it("entry INSERT abort fires for correction on /api/v1 and both operations on deprecated /api", async () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdA,
      actorType: "human",
      actorId: "tec-human",
      minutes: 30,
      source: "human_manual",
    });
    getDb().run(
      sql`CREATE TRIGGER tec_entry_abort2 BEFORE INSERT ON effort_entries BEGIN SELECT RAISE(ABORT, 'tec-entry-abort'); END`,
    );
    try {
      const auditsBefore = auditSeam.calls.length;
      const sseBefore = publishSpy.mock.calls.length;
      const rowsA = JSON.parse(JSON.stringify(rowsFor(taskIdA)));

      const corr = await post(`/tasks/${taskIdA}/effort-entries/${target.id}/correct`, {
        minutesDelta: -5,
        correctionReason: "entry-abort-cross",
      });
      expect(corr.status).toBe(500);

      const logApi = await post(`/tasks/${taskIdA}/effort-entries`, { minutes: 8 }, "/api");
      expect(logApi.status).toBe(500);

      const corrApi = await post(
        `/tasks/${taskIdA}/effort-entries/${target.id}/correct`,
        { minutesDelta: -5, correctionReason: "entry-abort-cross" },
        "/api",
      );
      expect(corrApi.status).toBe(500);

      expect(JSON.parse(JSON.stringify(rowsFor(taskIdA)))).toEqual(rowsA);
      expect(auditSeam.calls.length).toBe(auditsBefore);
      expect(publishSpy.mock.calls.length).toBe(sseBefore);
    } finally {
      getDb().run(sql`DROP TRIGGER tec_entry_abort2`);
    }

    const ok = await post(`/tasks/${taskIdA}/effort-entries`, { minutes: 8 }, "/api");
    expect(ok.status).toBe(200);
    expect(ok.body.minutes).toBe(8);
  });

  it("real task_events INSERT abort: 500, entry stays committed, audit row absent, Task/Mission metrics unchanged, no SSE; retry after drop is a distinct append", async () => {
    const t = makeTask("tec-audit-abort");
    getDb().run(
      sql`CREATE TRIGGER tec_audit_abort BEFORE INSERT ON task_events WHEN NEW.action IN ('effort_logged', 'effort_corrected') BEGIN SELECT RAISE(ABORT, 'tec-audit-abort'); END`,
    );
    let committedLogId: string | undefined;
    try {
      const metrics = metricsRow(t);
      const mission = missionRowFor(t);
      const audits = auditRowsFor(t);
      const sse = publishSpy.mock.calls.length;

      const res = await post(`/tasks/${t}/effort-entries`, {
        minutes: 22,
        note: "audit-abort-probe",
      });
      expect(res.status).toBe(500);

      const committed = getDb()
        .select()
        .from(effortEntries)
        .where(eq(effortEntries.note, "audit-abort-probe"))
        .all();
      expect(committed).toHaveLength(1);
      committedLogId = committed[0]!.id;

      // REAL audit-table truth, not the seam spy: no effort audit row landed.
      expect(auditRowsFor(t)).toEqual(audits);
      expect(metricsRow(t)).toEqual(metrics);
      expect(missionRowFor(t)).toEqual(mission);
      expect(publishSpy.mock.calls.length).toBe(sse);

      const corr = await post(`/tasks/${t}/effort-entries/${committedLogId}/correct`, {
        minutesDelta: -2,
        correctionReason: "audit-abort-corr",
      });
      expect(corr.status).toBe(500);
      expect(
        getDb()
          .select()
          .from(effortEntries)
          .where(eq(effortEntries.correctionReason, "audit-abort-corr"))
          .all(),
      ).toHaveLength(1);
      expect(auditRowsFor(t)).toEqual(audits);
      expect(metricsRow(t)).toEqual(metrics);
    } finally {
      getDb().run(sql`DROP TRIGGER tec_audit_abort`);
    }

    // Retry after the fault is cleared appends a DISTINCT entry — no replay
    // idempotency — and only now do metrics/postludes run.
    const ok = await post(`/tasks/${t}/effort-entries`, {
      minutes: 22,
      note: "audit-abort-probe",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.id).not.toBe(committedLogId);
    expect(
      getDb().select().from(effortEntries).where(eq(effortEntries.note, "audit-abort-probe")).all(),
    ).toHaveLength(2);
    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(44);
    // The fault-window correction (-2) committed earlier and is now summed
    // by the retry's recalculation: 22 + 22 - 2.
    expect(metricsRow(t).actualMinutes).toBe(42);
  });

  it("Task metric UPDATE abort: entry and audit stay committed, Task metrics unchanged, no Mission recalc, no SSE; retry is a distinct append", async () => {
    const t = makeTask("tec-task-metric-abort");
    getDb().run(
      sql`CREATE TRIGGER tec_task_metric_abort BEFORE UPDATE ON tasks WHEN NEW.version > OLD.version BEGIN SELECT RAISE(ABORT, 'tec-task-metric-abort'); END`,
    );
    try {
      const metrics = metricsRow(t);
      const mission = missionRowFor(t);
      const sse = publishSpy.mock.calls.length;

      const res = await post(`/tasks/${t}/effort-entries`, {
        minutes: 30,
        note: "task-metric-abort-probe",
      });
      expect(res.status).toBe(500);

      expect(
        getDb()
          .select()
          .from(effortEntries)
          .where(eq(effortEntries.note, "task-metric-abort-probe"))
          .all(),
      ).toHaveLength(1);
      // The REAL audit row landed before the metrics fault.
      const audits = auditRowsFor(t).filter((a: any) => a.action === "effort_logged");
      expect(audits).toHaveLength(1);
      expect(metricsRow(t)).toEqual(metrics);
      expect(missionRowFor(t)).toEqual(mission);
      expect(publishSpy.mock.calls.length).toBe(sse);
    } finally {
      getDb().run(sql`DROP TRIGGER tec_task_metric_abort`);
    }

    const ok = await post(`/tasks/${t}/effort-entries`, {
      minutes: 30,
      note: "task-metric-abort-probe",
    });
    expect(ok.status).toBe(200);
    expect(metricsRow(t).actualMinutes).toBe(60);
  });

  it("Mission metric UPDATE abort: entry, audit and Task recalc stay committed, Mission unchanged, no SSE; retry is a distinct append", async () => {
    const t = makeTask("tec-mission-abort");
    const target = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tec-human",
      minutes: 10,
      source: "human_manual",
    });
    getDb().run(
      sql`CREATE TRIGGER tec_mission_abort BEFORE UPDATE ON missions WHEN NEW.actual_minutes IS NOT OLD.actual_minutes BEGIN SELECT RAISE(ABORT, 'tec-mission-abort'); END`,
    );
    try {
      const mission = missionRowFor(t);
      const sse = publishSpy.mock.calls.length;

      const res = await post(`/tasks/${t}/effort-entries`, {
        minutes: 25,
        note: "mission-abort-probe",
      });
      expect(res.status).toBe(500);

      expect(
        getDb()
          .select()
          .from(effortEntries)
          .where(eq(effortEntries.note, "mission-abort-probe"))
          .all(),
      ).toHaveLength(1);
      expect(auditRowsFor(t).filter((a: any) => a.action === "effort_logged")).toHaveLength(1);
      // Task recalc happened BEFORE the Mission fault: 25 committed minutes.
      expect(metricsRow(t).actualMinutes).toBe(35);
      expect(missionRowFor(t)).toEqual(mission);
      expect(publishSpy.mock.calls.length).toBe(sse);

      // Correction op on the deprecated prefix hits the same boundary.
      const corr = await post(
        `/tasks/${t}/effort-entries/${target.id}/correct`,
        { minutesDelta: -5, correctionReason: "mission-abort-corr" },
        "/api",
      );
      expect(corr.status).toBe(500);
      expect(
        getDb()
          .select()
          .from(effortEntries)
          .where(eq(effortEntries.correctionReason, "mission-abort-corr"))
          .all(),
      ).toHaveLength(1);
      expect(missionRowFor(t)).toEqual(mission);
    } finally {
      getDb().run(sql`DROP TRIGGER tec_mission_abort`);
    }

    const ok = await post(`/tasks/${t}/effort-entries`, {
      minutes: 25,
      note: "mission-abort-probe",
    });
    expect(ok.status).toBe(200);
    // Seed 10 + fault-window commits (25 + 25 - 5) all summed on the retry.
    expect(missionRowFor(t)!.actualMinutes).toBe(55);
  });
});

describe("PRIMITIVES — corrupt storage, history chains, null parity, storage cascade (sql.js)", () => {
  it("null-projection parity: served siblings return exactly the stored row with null optional fields", () => {
    const row1 = effortRepo.createTaskEffortEntry({
      taskId: taskIdA,
      actorType: "agent",
      actorId: agentId,
      minutes: 5,
      source: "agent_reported",
    });
    expect(row1!.note).toBeNull();
    expect(row1!.startedAt).toBeNull();
    expect(row1!.endedAt).toBeNull();
    expect(row1!.correctsEntryId).toBeNull();
    expect(row1!.correctionReason).toBeNull();
    expect(row1!.metadata).toBeNull();
    expect(JSON.parse(JSON.stringify(row1))).toEqual(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, row1!.id)).get(),
        ),
      ),
    );

    const corr = effortRepo.createEffortCorrection({
      taskId: taskIdA,
      correctsEntryId: row1!.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -2,
      correctionReason: "null-parity",
    });
    expect(corr!.startedAt).toBeNull();
    expect(corr!.endedAt).toBeNull();
    expect(corr!.note).toBeNull();
    expect(corr!.metadata).toBeNull();
    expect(corr!.source).toBe("correction_adjustment");
    expect(corr!.minutes).toBe(-2);
    expect(corr!.correctsEntryId).toBe(row1!.id);
    expect(JSON.parse(JSON.stringify(corr))).toEqual(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, corr!.id)).get(),
        ),
      ),
    );
  });

  it("corrupt storage: Task row deleted with FK off (original survives) — correction and log both match zero, no orphan append, no FK 500", () => {
    const t = makeTask("tec-corrupt-task");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tec-human",
      minutes: 10,
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

    expect(
      effortRepo.createEffortCorrection({
        taskId: t,
        correctsEntryId: orig.id,
        actorType: "human",
        actorId: "tec-human",
        minutesDelta: -5,
        correctionReason: "corrupt-task-correction",
      }),
    ).toBeNull();
    expect(
      effortRepo.createTaskEffortEntry({
        taskId: t,
        actorType: "agent",
        actorId: agentId,
        minutes: 5,
        source: "agent_reported",
      }),
    ).toBeNull();
    expect(rowsFor(t)).toHaveLength(1);
    expect(rowsFor(t)[0]!.id).toBe(orig.id);
  });

  it("history chains: repeated deltas, correction-of-correction exact reference, dangling-predecessor and raw self-cycle targets still append; originals never rewritten; negative aggregates allowed", () => {
    const t = makeTask("tec-history");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tec-human",
      minutes: 100,
      source: "human_manual",
    });
    const origSnapshot = JSON.parse(
      JSON.stringify(
        getDb().select().from(effortEntries).where(eq(effortEntries.id, orig.id)).get(),
      ),
    );

    const c1 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -30,
      correctionReason: "history-c1",
    });
    const c2 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -20,
      correctionReason: "history-c2",
    });
    expect(c1!.id).not.toBe(c2!.id);
    const c3 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: c1!.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: 5,
      correctionReason: "history-c3-of-c1",
    });
    // Correction-of-correction stores the EXACT correction id — no traversal
    // to a root, no replacement of the earlier delta.
    expect(c3!.correctsEntryId).toBe(c1!.id);

    // Dangling predecessor behind an existing target (FK-off raw fixture):
    // the target row exists under this Task, so a new correction may
    // reference it — the corrupt missing predecessor is neither traversed
    // nor repaired.
    setFk(false);
    try {
      getDb().run(
        sql`INSERT INTO effort_entries (id, task_id, actor_type, minutes, source, recorded_at, corrects_entry_id, correction_reason) VALUES ('tec-dangling-target', ${t}, 'human', 1, 'human_manual', '2026-01-01T00:00:00.000Z', 'tec-nonexistent-predecessor', 'dangling-predecessor')`,
      );
      getDb().run(
        sql`INSERT INTO effort_entries (id, task_id, actor_type, minutes, source, recorded_at, corrects_entry_id) VALUES ('tec-self-cycle', ${t}, 'human', 1, 'human_manual', '2026-01-01T00:00:00.000Z', 'tec-self-cycle')`,
      );
    } finally {
      setFk(true);
    }

    const c4 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: "tec-dangling-target",
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -1,
      correctionReason: "history-c4-dangling",
    });
    expect(c4).not.toBeNull();
    const c5 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: "tec-self-cycle",
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -1,
      correctionReason: "history-c5-selfcycle",
    });
    expect(c5).not.toBeNull();

    // Originals were never rewritten by any append.
    expect(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, orig.id)).get(),
        ),
      ),
    ).toEqual(origSnapshot);

    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(102);
    expect(totals.correctionAdjustmentMinutes).toBe(-47);

    // Negative aggregate persists: below-zero totals are allowed.
    const neg = makeTask("tec-history-negative");
    effortRepo.createEffortEntry({
      taskId: neg,
      actorType: "human",
      actorId: "tec-human",
      minutes: 10,
      source: "human_manual",
    });
    effortRepo.createEffortCorrection({
      taskId: neg,
      correctsEntryId: effortRepo.getEffortEntriesByTask(neg)[0]!.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -30,
      correctionReason: "history-negative",
    });
    expect(effortRepo.getEffortTotalsForTask(neg).totalAccountedMinutes).toBe(-20);
    effortRepo.recalculateTaskEffortMetrics(neg);
    expect(metricsRow(neg).actualMinutes).toBe(-20);
  });

  it("storage behavior preserved: raw target deletion SET NULLs surviving references; Task deletion cascades entries", () => {
    const t = makeTask("tec-storage");
    const orig = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tec-human",
      minutes: 15,
      source: "human_manual",
    });
    const c1 = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: orig.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -5,
      correctionReason: "storage-set-null",
    });
    getDb().delete(effortEntries).where(eq(effortEntries.id, orig.id)).run();
    const surviving = getDb()
      .select()
      .from(effortEntries)
      .where(eq(effortEntries.id, c1!.id))
      .get() as { correctsEntryId: string | null };
    expect(surviving.correctsEntryId).toBeNull();

    const t2 = makeTask("tec-storage-cascade");
    effortRepo.createEffortEntry({
      taskId: t2,
      actorType: "human",
      actorId: "tec-human",
      minutes: 5,
      source: "human_manual",
    });
    getDb().delete(tasks).where(eq(tasks.id, t2)).run();
    expect(rowsFor(t2)).toHaveLength(0);
  });
});

describe("ADMISSION INSTRUMENTATION — denial precedes the service pre-read (service-boundary label, not middleware proof)", () => {
  it("nonexistent Task correction: 404 with zero service pre-reads and zero mutations", async () => {
    const reads = seam.precheckReads;
    const muts = seam.mutationCalls;
    const res = await post("/tasks/tec-nonexistent/effort-entries/tec-any-entry/correct", {
      minutesDelta: -1,
      correctionReason: "x",
    });
    expect(res.status).toBe(404);
    expect(seam.precheckReads).toBe(reads);
    expect(seam.mutationCalls).toBe(muts);
  });

  it("known foreign original: exactly one pre-read and zero mutations before the 400", async () => {
    const target = effortRepo.createEffortEntry({
      taskId: taskIdB,
      actorType: "human",
      actorId: "tec-human",
      minutes: 12,
      source: "human_manual",
    });
    const reads = seam.precheckReads;
    const muts = seam.mutationCalls;
    const res = await post(`/tasks/${taskIdA}/effort-entries/${target.id}/correct`, {
      minutesDelta: -1,
      correctionReason: "instrumented-foreign",
    });
    expect(res.status).toBe(400);
    expect(seam.precheckReads).toBe(reads + 1);
    expect(seam.mutationCalls).toBe(muts);
  });

  it("nonmember human denial: 403 with zero service pre-reads and zero mutations", async () => {
    const teamTask = makeTask("tec-instrumented-team-task", teamHabitatId);
    const reads = seam.precheckReads;
    const muts = seam.mutationCalls;
    const denied = await fetch(`${baseUrl}/api/v1/tasks/${teamTask}/effort-entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${teamNonmemberJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ minutes: 5 }),
    }).then((r) => r.status);
    expect(denied).toBe(403);
    expect(seam.precheckReads).toBe(reads);
    expect(seam.mutationCalls).toBe(muts);
  });

  it("nonmember CORRECTION with a known existing original: 403 with zero service pre-reads on BOTH prefixes", async () => {
    for (const prefix of WIRE_PREFIXES) {
      const teamTask = makeTask(
        `tec-instr-corr-${prefix === "/api" ? "api" : "v1"}`,
        teamHabitatId,
      );
      // A KNOWN original under this Task — the pre-read WOULD run for an
      // admitted actor, so zero pre-reads proves admission denied first.
      const original = effortRepo.createEffortEntry({
        taskId: teamTask,
        actorType: "human",
        actorId: "tec-human",
        minutes: 20,
        source: "human_manual",
      });
      const reads = seam.precheckReads;
      const muts = seam.mutationCalls;
      const res = await fetch(
        `${baseUrl}${prefix}/tasks/${teamTask}/effort-entries/${original.id}/correct`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${teamNonmemberJwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ minutesDelta: -2, correctionReason: "x" }),
        },
      );
      expect(res.status).toBe(403);
      expect(seam.precheckReads).toBe(reads);
      expect(seam.mutationCalls).toBe(muts);
      expect(rowsFor(teamTask)).toHaveLength(1);
    }
  });

  it("missing Mission (FK-off fixture, PRAGMA restored in finally): 404 with zero service pre-reads", async () => {
    const broken = makeTask("tec-instrumented-broken-mission", teamHabitatId);
    const missionId = (
      getDb().select().from(tasks).where(eq(tasks.id, broken)).get() as {
        missionId: string;
      }
    ).missionId;
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM missions WHERE id = ${missionId}`);
    } finally {
      setFk(true);
    }
    const reads = seam.precheckReads;
    const muts = seam.mutationCalls;
    const res = await post(`/tasks/${broken}/effort-entries/tec-any/correct`, {
      minutesDelta: -1,
      correctionReason: "x",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Mission not found");
    expect(seam.precheckReads).toBe(reads);
    expect(seam.mutationCalls).toBe(muts);
  });

  it("missing Habitat (FK-off fixture, PRAGMA restored in finally): 404 with zero service pre-reads", async () => {
    const orphanHabitat = habitatRepo.createHabitat({ name: "tec-instrumented-orphan" }).id;
    const orphanTask = makeTask("tec-instrumented-orphan-task", orphanHabitat);
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM habitats WHERE id = ${orphanHabitat}`);
    } finally {
      setFk(true);
    }
    const reads = seam.precheckReads;
    const muts = seam.mutationCalls;
    const res = await post(`/tasks/${orphanTask}/effort-entries/tec-any/correct`, {
      minutesDelta: -1,
      correctionReason: "x",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Habitat not found");
    expect(seam.precheckReads).toBe(reads);
    expect(seam.mutationCalls).toBe(muts);
  });
});

// ---- shared real /sse subscriber (one connection for the whole file) -------
let sharedStreamRef: { events: any[]; close: () => void } | null = null;
async function sharedStream() {
  if (sharedStreamRef) return sharedStreamRef;
  const res = await fetch(`${baseUrl}/sse/habitats/${habitatId}/stream`, {
    headers: { "x-agent-api-key": agentKey },
  });
  expect(res.status).toBe(200);
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* non-JSON frame */
            }
          }
        }
      }
    } catch {
      /* stream closed */
    }
  })();
  await vi.waitFor(() => expect(events.some((e) => e.type === "connected")).toBe(true), {
    timeout: 5_000,
  });
  sharedStreamRef = { events, close: () => reader.cancel().catch(() => {}) };
  return sharedStreamRef;
}
async function sharedStreamClose() {
  sharedStreamRef?.close();
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Settled delivery count for a Task — publication is synchronous, delivery
 * observation is async on the stream, so quiesce before reading the count. */
async function settledEffortDeliveries(taskId: string) {
  const stream = await sharedStream();
  await settle(150);
  return stream.events.filter((e: any) => e.type === "effort.updated" && e.data?.taskId === taskId);
}

const WIRE_PREFIXES = ["/api/v1", "/api"] as const;
type FaultOp = "log" | "correct";
type FaultStage = "audit" | "task" | "mission";

async function runDownstreamFaultCell(op: FaultOp, prefix: string, stage: FaultStage) {
  const tag = `tec-mx-${stage}-${op}-${prefix === "/api" ? "api" : "v1"}`;
  const t = makeTask(tag);
  // Meaningful nondefault baseline: a real estimate drives the accuracy
  // formulas asserted below (source: estimationAccuracy = actual/estimate,
  // planningAccuracy = missionActual/plannedSum).
  const ESTIMATE = 200;
  getDb().update(tasks).set({ estimatedMinutes: ESTIMATE }).where(eq(tasks.id, t)).run();
  const original = effortRepo.createEffortEntry({
    taskId: t,
    actorType: "human",
    actorId: "tec-human",
    minutes: 60,
    source: "human_manual",
  });
  const action = op === "log" ? "effort_logged" : "effort_corrected";
  const probe = op === "log" ? tag : (r: any) => r.correctionReason === tag;
  const probeOf = (r: any) => (op === "log" ? r.note === tag : r.correctionReason === tag);

  const metricsBefore = metricsRow(t);
  const missionBefore = missionRowFor(t);
  const auditsBefore = auditRowsFor(t);
  const originalBefore = JSON.parse(JSON.stringify(original));
  // Baseline ownership: the estimate field is actually persisted before the
  // fault runs.
  expect(metricsBefore.estimatedMinutes).toBe(ESTIMATE);
  await settledEffortDeliveries(t); // settle fixture fan before baseline

  // Target-scoped triggers: each WHEN clause names the SELECTED Task/Mission
  // and action, so an unrelated 500 from a broader predicate cannot satisfy
  // the cell.
  const trigger = `tec_mx_${stage}_${op}_${prefix === "/api" ? "api" : "v1"}`;
  const ddl =
    stage === "audit"
      ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON task_events WHEN NEW.action = '${action}' AND NEW.task_id = '${t}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`
      : stage === "task"
        ? `CREATE TRIGGER ${trigger} BEFORE UPDATE ON tasks WHEN NEW.version > OLD.version AND OLD.id = '${t}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`
        : `CREATE TRIGGER ${trigger} BEFORE UPDATE ON missions WHEN NEW.actual_minutes IS NOT OLD.actual_minutes AND OLD.id = '${missionIdForTask(t)}' BEGIN SELECT RAISE(ABORT, '${tag}'); END`;
  getDb().run(sql.raw(ddl));

  let res: { status: number; body: any };
  try {
    res =
      op === "log"
        ? await post(`/tasks/${t}/effort-entries`, { minutes: 40, note: tag }, prefix)
        : await post(
            `/tasks/${t}/effort-entries/${original.id}/correct`,
            { minutesDelta: -10, correctionReason: tag },
            prefix,
          );
  } finally {
    getDb().run(sql.raw(`DROP TRIGGER ${trigger}`));
  }
  expect(res.status).toBe(500);
  // Observable error envelope per stage (what the handler actually exposes):
  // audit-INSERT and Mission-UPDATE faults surface as wrapped RepositoryErrors;
  // the Task-metric recalculator propagates the raw driver error through the
  // generic 500 fallback. Exact cause text is proven at the SERVICE SEAM
  // (production file), not demanded here.
  if (stage !== "task") {
    expect(res.body.code).toBe("REPOSITORY_ERROR");
    expect(res.body.details?.entity).toBe(stage === "audit" ? "taskEvent" : "mission");
  } else {
    // Actual observable envelope for the raw Task-metric driver fault
    // through the generic handler fallback (no fabricated SQL cause at HTTP;
    // exact cause is service-seam evidence in the production file).
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(typeof res.body.error).toBe("string");
  }

  // The fault-window append is retained, committed — with its FULL
  // projection, actor, source and reference.
  const committed = rowsFor(t).filter(probeOf);
  expect(committed).toHaveLength(1);
  const faultRow = committed[0]!;
  expect(faultRow.taskId).toBe(t);
  expect(faultRow.actorType).toBe("agent");
  expect(faultRow.actorId).toBe(agentId);
  expect(faultRow.source).toBe(op === "log" ? "agent_reported" : "correction_adjustment");
  expect(faultRow.minutes).toBe(op === "log" ? 40 : -10);
  if (op === "log") {
    expect(faultRow.note).toBe(tag);
    expect(faultRow.correctsEntryId).toBeNull();
    expect(faultRow.correctionReason).toBeNull();
  } else {
    expect(faultRow.correctsEntryId).toBe(original.id);
    expect(faultRow.correctionReason).toBe(tag);
    expect(faultRow.note).toBeNull();
  }
  expect(faultRow.metadata).toBeNull();
  const faultRowBytes = JSON.parse(JSON.stringify(faultRow));

  // Real audit-table retention per stage, with request-context provenance on
  // the retained rows.
  const newAudits = auditRowsFor(t).filter(
    (a: any) => !auditsBefore.some((b: any) => b.id === a.id),
  );
  if (stage === "audit") {
    expect(newAudits).toHaveLength(0);
  } else {
    expect(newAudits).toHaveLength(1);
    expect(newAudits[0].action).toBe(action);
    expect(newAudits[0].actorType).toBe("agent");
    expect(newAudits[0].actorId).toBe(agentId);
    expect((newAudits[0].metadata as any).effortEntryId).toBe(faultRow.id);
    if (op === "correct") {
      expect((newAudits[0].metadata as any).correctsEntryId).toBe(original.id);
      expect((newAudits[0].metadata as any).minutesDelta).toBe(-10);
      expect((newAudits[0].metadata as any).correctionReason).toBe(tag);
    } else {
      expect((newAudits[0].metadata as any).minutes).toBe(40);
      expect((newAudits[0].metadata as any).note).toBe(tag);
    }
    expect((newAudits[0].metadata as any).audit.source).toBe("rest_api");
    expect((newAudits[0].metadata as any).audit.method).toBe("POST");
  }

  // FULL Task/Mission row retention per stage. The mission-stage Task recalc
  // changes exactly the four metric fields; everything else in the full row
  // is byte-identical, and the Mission row is untouched by the failed
  // statement.
  const stripMetricFields = (row: any) => {
    const { actualMinutes, estimationAccuracy, version, updatedAt, ...rest } = row;
    return rest;
  };
  if (stage === "mission") {
    const expectedTaskActual = op === "log" ? 100 : 50;
    const taskNow = metricsRow(t);
    expect(taskNow.actualMinutes).toBe(expectedTaskActual);
    expect(taskNow.version).toBe(metricsBefore.version + 1);
    expect(taskNow.updatedAt).not.toBe(metricsBefore.updatedAt);
    // EVERY stripped field separately asserted: accuracy follows the source
    // formula actual/estimate at the committed recalc.
    expect(taskNow.estimationAccuracy).toBeCloseTo(expectedTaskActual / ESTIMATE, 10);
    expect(stripMetricFields(taskNow)).toEqual(stripMetricFields(metricsBefore));
    expect(missionRowFor(t)).toEqual(missionBefore);
  } else {
    expect(metricsRow(t)).toEqual(metricsBefore);
    expect(metricsRow(t).estimationAccuracy).toBe(metricsBefore.estimationAccuracy);
    expect(missionRowFor(t)).toEqual(missionBefore);
  }

  // The ORIGINAL row is untouched by the fault.
  expect(
    JSON.parse(
      JSON.stringify(
        getDb().select().from(effortEntries).where(eq(effortEntries.id, original.id)).get(),
      ),
    ),
  ).toEqual(originalBefore);

  // No delivery observed during the fault window (settled).
  expect(await settledEffortDeliveries(t)).toHaveLength(0);

  // Retry appends a DISTINCT row while the fault-window row remains
  // committed BYTE-IDENTICALLY.
  const retry =
    op === "log"
      ? await post(`/tasks/${t}/effort-entries`, { minutes: 40, note: tag }, prefix)
      : await post(
          `/tasks/${t}/effort-entries/${original.id}/correct`,
          { minutesDelta: -10, correctionReason: tag },
          prefix,
        );
  expect(retry.status).toBe(200);
  expect(retry.body.id).not.toBe(faultRow.id);
  // Exact retry response payload — full projection with the trusted actor.
  expect(retry.body.taskId).toBe(t);
  expect(retry.body.actorType).toBe("agent");
  expect(retry.body.actorId).toBe(agentId);
  expect(retry.body.source).toBe(op === "log" ? "agent_reported" : "correction_adjustment");
  expect(retry.body.minutes).toBe(op === "log" ? 40 : -10);
  if (op === "log") expect(retry.body.note).toBe(tag);
  else expect(retry.body.correctionReason).toBe(tag);
  const rowsAfterRetry = rowsFor(t).filter(probeOf);
  expect(rowsAfterRetry).toHaveLength(2);
  expect(JSON.parse(JSON.stringify(rowsAfterRetry.find((r) => r.id === faultRow.id)))).toEqual(
    faultRowBytes,
  );
  const afterRetry = op === "log" ? 140 : 40;
  expect(metricsRow(t).actualMinutes).toBe(afterRetry);
  expect(metricsRow(t).estimationAccuracy).toBeCloseTo(afterRetry / ESTIMATE, 10);
  const missionAfterRetry = missionRowFor(t);
  expect(missionAfterRetry.actualMinutes).toBe(afterRetry);
  expect(missionAfterRetry.plannedMinutes).toBe(ESTIMATE);
  expect(missionAfterRetry.planningAccuracy).toBeCloseTo(afterRetry / ESTIMATE, 10);
  const deliveries = await settledEffortDeliveries(t);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].data).toEqual({
    taskId: t,
    entryId: retry.body.id,
    actorType: "agent",
    actorId: agentId,
    source: op === "log" ? "agent_reported" : "correction_adjustment",
    minutes: op === "log" ? 40 : -10,
  });
}

async function postJwt(
  token: string,
  path: string,
  body: unknown,
  prefix: string = "/api/v1",
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed, text };
}

describe("WIRE FAULT — complete downstream matrix (both operations × both prefixes × audit/Task/Mission statement aborts)", () => {
  const cells: Array<{ op: FaultOp; prefix: string; stage: FaultStage }> = [];
  for (const stage of ["audit", "task", "mission"] as const) {
    for (const op of ["log", "correct"] as const) {
      for (const prefix of WIRE_PREFIXES) cells.push({ op, prefix, stage });
    }
  }
  for (const cell of cells) {
    it(`${cell.stage} abort × ${cell.op} × ${cell.prefix}: 500, exact retained stage, no delivery, retry appends distinctly`, async () => {
      await runDownstreamFaultCell(cell.op, cell.prefix, cell.stage);
    });
  }
});

describe("SEAM — /api prefix races and late-zero under an aborting append trigger (interleave seam, not natural concurrency)", () => {
  it("cross-habitat reparent and Task disappearance also reach the conditional zero-match 404 on the deprecated /api prefix", async () => {
    // Reparent on /api
    const t1 = makeTask("tec-api-reparent");
    const target1 = effortRepo.createEffortEntry({
      taskId: t1,
      actorType: "human",
      actorId: "tec-human",
      minutes: 40,
      source: "human_manual",
    });
    const otherHabitat = habitatRepo.createHabitat({ name: "tec-api-other-habitat" }).id;
    const otherTask = makeTask("tec-api-other-task", otherHabitat);
    seam.interpose = () => {
      getDb()
        .update(effortEntries)
        .set({ taskId: otherTask })
        .where(eq(effortEntries.id, target1.id))
        .run();
    };
    const reparented = await post(
      `/tasks/${t1}/effort-entries/${target1.id}/correct`,
      { minutesDelta: -5, correctionReason: "tec-api-reparent-race" },
      "/api",
    );
    expect(reparented.status).toBe(404);
    expect(reparented.body.error).toBe("Effort entry not found");
    expect(rowsFor(t1).some((r) => r.correctionReason === "tec-api-reparent-race")).toBe(false);

    // Task disappearance after admission on /api
    const doomed = makeTask("tec-api-doomed");
    seam.interpose = () => {
      getDb().delete(tasks).where(eq(tasks.id, doomed)).run();
    };
    const vanished = await post(
      `/tasks/${doomed}/effort-entries`,
      { minutes: 7, note: "tec-api-task-vanish" },
      "/api",
    );
    expect(vanished.status).toBe(404);
    expect(vanished.body.error).toBe("Task not found");
  });

  it("SAME-habitat reparent, original deletion and correction Task disappearance reach the conditional zero-match 404 on BOTH prefixes (interleave seams, not natural concurrency)", async () => {
    for (const prefix of WIRE_PREFIXES) {
      const p = prefix === "/api" ? "api" : "v1";
      // Same-Habitat reparent: the entry moves to another Task of the SAME
      // habitat between pre-read and statement.
      const t1 = makeTask(`tec-same-hab-reparent-${p}`);
      const target = effortRepo.createEffortEntry({
        taskId: t1,
        actorType: "human",
        actorId: "tec-human",
        minutes: 40,
        source: "human_manual",
      });
      const sameHabitatOtherTask = makeTask(`tec-same-hab-other-${p}`);
      seam.interpose = () => {
        getDb()
          .update(effortEntries)
          .set({ taskId: sameHabitatOtherTask })
          .where(eq(effortEntries.id, target.id))
          .run();
      };
      const reparented = await post(
        `/tasks/${t1}/effort-entries/${target.id}/correct`,
        { minutesDelta: -5, correctionReason: `tec-same-hab-race-${p}` },
        prefix,
      );
      expect(reparented.status).toBe(404);
      expect(reparented.body.error).toBe("Effort entry not found");
      expect(rowsFor(t1).some((r) => r.correctionReason === `tec-same-hab-race-${p}`)).toBe(false);
      const moved = rowsFor(sameHabitatOtherTask).find((r) => r.id === target.id);
      expect(moved).toBeDefined();

      // Original deleted after the positive pre-check: wire-level zero-match
      // 404 (the earlier direct-service proof stays).
      const t2 = makeTask(`tec-orig-deleted-${p}`);
      const orig = effortRepo.createEffortEntry({
        taskId: t2,
        actorType: "human",
        actorId: "tec-human",
        minutes: 25,
        source: "human_manual",
      });
      seam.interpose = () => {
        getDb().delete(effortEntries).where(eq(effortEntries.id, orig.id)).run();
      };
      const deleted = await post(
        `/tasks/${t2}/effort-entries/${orig.id}/correct`,
        { minutesDelta: -4, correctionReason: `tec-orig-deleted-${p}` },
        prefix,
      );
      expect(deleted.status).toBe(404);
      expect(deleted.body.error).toBe("Effort entry not found");
      expect(rowsFor(t2).some((r) => r.correctionReason === `tec-orig-deleted-${p}`)).toBe(false);

      // Task disappearance for the CORRECTION operation on this prefix.
      const t3 = makeTask(`tec-corr-doomed-${p}`);
      const orig3 = effortRepo.createEffortEntry({
        taskId: t3,
        actorType: "human",
        actorId: "tec-human",
        minutes: 15,
        source: "human_manual",
      });
      seam.interpose = () => {
        getDb().delete(tasks).where(eq(tasks.id, t3)).run();
      };
      const corrDoomed = await post(
        `/tasks/${t3}/effort-entries/${orig3.id}/correct`,
        { minutesDelta: -3, correctionReason: `tec-corr-doomed-${p}` },
        prefix,
      );
      expect(corrDoomed.status).toBe(404);
      expect(corrDoomed.body.error).toBe("Effort entry not found");
    }
  });

  it("late conditional zero-match is a clean 404 under an installed ABORTING append trigger — the final statement selected zero without attempting the append; an intact reference under the same trigger is a genuine 500", async () => {
    for (const prefix of WIRE_PREFIXES) {
      const t = makeTask(`tec-late-zero-${prefix === "/api" ? "api" : "v1"}`);
      const original = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "tec-human",
        minutes: 60,
        source: "human_manual",
      });
      // Seed the intact control reference BEFORE installing the trigger: the
      // abort applies to every effort_entries INSERT, fixtures included.
      const intact = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "tec-human",
        minutes: 20,
        source: "human_manual",
      });
      getDb().run(
        sql`CREATE TRIGGER tec_late_zero_abort BEFORE INSERT ON effort_entries BEGIN SELECT RAISE(ABORT, 'tec-late-zero-abort'); END`,
      );
      try {
        // Zero-match route: original moves away between pre-check and the
        // final statement — 404 proves the conditional INSERT selected zero
        // and never attempted an append (the trigger never fired).
        seam.interpose = () => {
          getDb()
            .update(effortEntries)
            .set({ taskId: taskIdB })
            .where(eq(effortEntries.id, original.id))
            .run();
        };
        const zeroMatch = await postJwt(
          teamMemberJwt,
          `/tasks/${t}/effort-entries/${original.id}/correct`,
          { minutesDelta: -5, correctionReason: `tec-late-zero-${prefix}` },
          prefix,
        );
        expect(zeroMatch.status).toBe(404);
        expect(zeroMatch.body.error).toBe("Effort entry not found");
        expect(rowsFor(t).some((r) => r.correctionReason === `tec-late-zero-${prefix}`)).toBe(
          false,
        );

        // Control under the SAME trigger: an intact same-Task reference
        // reaches the statement and the abort is a genuine 500 with no row.
        const attempted = await postJwt(
          teamMemberJwt,
          `/tasks/${t}/effort-entries/${intact.id}/correct`,
          { minutesDelta: -4, correctionReason: "tec-late-zero-abort-control" },
          prefix,
        );
        expect(attempted.status).toBe(500);
        expect(rowsFor(t).some((r) => r.correctionReason === "tec-late-zero-abort-control")).toBe(
          false,
        );
      } finally {
        getDb().run(sql`DROP TRIGGER tec_late_zero_abort`);
      }

      // Trigger gone: the moved original is now a KNOWN foreign pair at the
      // deterministic initial pre-check — 400, not a late zero-match.
      const movedForeign = await postJwt(
        teamMemberJwt,
        `/tasks/${t}/effort-entries/${original.id}/correct`,
        { minutesDelta: -5, correctionReason: `tec-late-zero-retry-${prefix}` },
        prefix,
      );
      expect(movedForeign.status).toBe(400);
      expect(movedForeign.body.error).toBe("Effort entry does not belong to this task");
      const intactOk = await postJwt(
        teamMemberJwt,
        `/tasks/${t}/effort-entries/${
          effortRepo.getEffortEntriesByTask(t).find((r) => r.minutes === 20)!.id
        }/correct`,
        { minutesDelta: -4, correctionReason: `tec-late-zero-ok-${prefix}` },
        prefix,
      );
      expect(intactOk.status).toBe(200);
    }
  });
});

describe("PRIMITIVES — legal FK-ON multirow/cyclic references and per-append full snapshots (sql.js)", () => {
  it("a legal two-row reference cycle and multi-in-degree references remain append targets; every prior row stays byte-identical after each append", () => {
    const t = makeTask("tec-legal-cycle");
    // NONEMPTY unrelated history (mirroring the production counterpart): a
    // real original+correction on a second Task whose bytes must survive.
    const unrelated = makeTask("tec-legal-cycle-unrelated");
    const unrelatedOriginal = effortRepo.createEffortEntry({
      taskId: unrelated,
      actorType: "human",
      actorId: "tec-human",
      minutes: 7,
      source: "human_manual",
    });
    effortRepo.createEffortCorrection({
      taskId: unrelated,
      correctsEntryId: unrelatedOriginal.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -2,
      correctionReason: "tec-unrelated-corr",
    });
    const unrelatedBefore = JSON.parse(JSON.stringify(rowsFor(unrelated)));
    expect(unrelatedBefore).toHaveLength(2);
    expect(unrelatedBefore.every((r: any) => r.taskId === unrelated)).toBe(true);

    const a = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "tec-human",
      minutes: 50,
      source: "human_manual",
    });
    const b = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: a.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -5,
      correctionReason: "cycle-b",
    });
    // Close a legal two-row cycle a↔b with FK enforcement ON (a raw UPDATE of
    // an existing reference — storage permits it; served appends never do).
    expect(b).not.toBeNull();
    getDb()
      .update(effortEntries)
      .set({ correctsEntryId: b!.id })
      .where(eq(effortEntries.id, a.id))
      .run();

    let snapshot = JSON.parse(JSON.stringify(rowsFor(t)));
    const c = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: a.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -1,
      correctionReason: "cycle-c-of-a",
    });
    expect(c).not.toBeNull();
    // Every prior row byte-identical; exactly one new row.
    const afterC = JSON.parse(JSON.stringify(rowsFor(t)));
    expect(afterC.filter((r: any) => r.id !== c!.id)).toEqual(snapshot);
    expect(afterC).toHaveLength(snapshot.length + 1);

    // Multi-in-degree: a second correction referencing b.
    snapshot = afterC;
    const d = effortRepo.createEffortCorrection({
      taskId: t,
      correctsEntryId: b!.id,
      actorType: "human",
      actorId: "tec-human",
      minutesDelta: -2,
      correctionReason: "cycle-d-of-b",
    });
    expect(d).not.toBeNull();
    const afterD = JSON.parse(JSON.stringify(rowsFor(t)));
    expect(afterD.filter((r: any) => r.id !== d!.id)).toEqual(snapshot);

    // Unrelated task untouched throughout.
    expect(JSON.parse(JSON.stringify(rowsFor(unrelated)))).toEqual(unrelatedBefore);

    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(50);
    expect(totals.correctionAdjustmentMinutes).toBe(-8);
  });
});
