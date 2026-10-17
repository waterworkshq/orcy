/**
 * Custody restore re-enrollment + canonical task delete + truthful audit
 * actors — exercised on REAL publication paths (no helper reseeding).
 *
 * Fixture classification (preflight-legal combinations only):
 *   - `missions:replace` REQUIRES `tasks` declared `replace|reset`
 *     (validateCrossDomainDispositions — missions delete cascades tasks).
 *     "missions replace + tasks omitted" is an ILLEGAL combination; the
 *     cascade-custody seam is covered by the legal `tasks:reset` variant.
 *   - `columns:replace` REQUIRES `missions:replace|reset`. A tasks-only
 *     restore therefore omits habitatSettings/columns/missions entirely
 *     (preserve) and declares subtasks/dependencies `replace` (children of
 *     the replaced tasks domain).
 *   - A scope with no ledger history reads VIRTUAL (active, incarnation 1)
 *     — legitimate. Cases asserting incarnation 2 first drive the real
 *     mission-custody retire as a precondition (materialize + retire inc 1).
 *   - `getScopeStateWithClient` returns null once the RESOURCE row is gone
 *     (deleted) — intentional. Post-delete retirement is asserted against
 *     the RAW governance_scopes ledger (retained retired rows), never the
 *     scope-state helper.
 *
 * Driver coverage: restore path on the sql.js snapshot AND production
 * better-sqlite3 (FK enforcement). Status: UNRUN (serialized gate freeze;
 * parent runs the suite).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import {
  columns as columnsTable,
  governanceAudit,
  governanceScopes,
  habitats,
  missions,
  roleAssignments,
  tasks,
  users,
} from "../db/schema/index.js";
import { prepareImport } from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";
import {
  evaluatePermissionsWithClient,
  getScopeStateWithClient,
} from "../services/localAuthorization.js";
import { deleteTask } from "../services/tasks/index.js";
import {
  retireMissionCustodyWithClient,
  retireTaskCustodyWithClient,
} from "../services/governanceCustody.js";
import { createAgent } from "../repositories/agent.js";

// Publication-path mocks mirror importPublication.test.ts / the production
// scoped-delete suite: pre-commit effects silenced, DB logic real.
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => undefined },
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

const EXPORTED_AT = "2026-07-20T12:00:00.000Z";
const TS = "2025-01-01T00:00:00Z";
const BUILTIN_ASSIGN_DEF = "builtin-role-review-coordinator";
const BUILTIN_ASSIGN_REV = "builtin-role-review-coordinator-rev-1";

interface SeedTree {
  habitatId: string;
  columnId: string;
  missionId: string;
  taskId: string;
}

function seedFull(prefix: string): SeedTree {
  const db = getDb();
  const habitatId = `${prefix}-hab-${randomUUID()}`;
  const columnId = `${prefix}-col`;
  const missionId = `${prefix}-mission`;
  const taskId = `${prefix}-task`;
  db.insert(habitats)
    .values({ id: habitatId, name: prefix, description: "", createdAt: TS, updatedAt: TS })
    .run();
  db.insert(columnsTable)
    .values({
      id: columnId,
      habitatId,
      name: "Todo",
      order: 0,
      autoAdvance: false,
      requiresClaim: false,
      nextColumnId: null,
      isTerminal: false,
    })
    .run();
  db.insert(missions)
    .values({
      id: missionId,
      habitatId,
      columnId,
      title: "M",
      description: "",
      acceptanceCriteria: "",
      priority: "medium",
      labels: [],
      status: "not_started",
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      createdBy: "test",
      createdAt: TS,
      updatedAt: TS,
    })
    .run();
  db.insert(tasks)
    .values({
      id: taskId,
      missionId,
      title: "T",
      description: "",
      priority: "medium",
      status: "pending",
      createdBy: "test",
      createdAt: TS,
      updatedAt: TS,
    })
    .run();
  return { habitatId, columnId, missionId, taskId };
}

function seedTaskRow(missionId: string, taskId: string, title: string): void {
  getDb()
    .insert(tasks)
    .values({
      id: taskId,
      missionId,
      title,
      description: "",
      priority: "medium",
      status: "pending",
      createdBy: "test",
      createdAt: TS,
      updatedAt: TS,
    })
    .run();
}

function restoreManifest(
  s: SeedTree,
  name: string,
  opts?: { tasks?: "replace" | "reset" },
): HabitatImportManifest {
  const domains: HabitatImportManifest["domains"] = {
    habitatSettings: {
      disposition: "replace",
      data: { sourceId: s.habitatId, name, description: "", settings: {} },
    },
    columns: {
      disposition: "replace",
      data: [
        {
          sourceId: s.columnId,
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
          sourceId: s.missionId,
          title: "M",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          dependsOnSourceIds: [],
          blocksSourceIds: [],
          dueAt: null,
        },
      ],
    },
    subtasks: { disposition: "replace", data: [] },
    dependencies: { disposition: "replace", data: [] },
  };
  if ((opts?.tasks ?? "replace") === "replace") {
    domains.tasks = {
      disposition: "replace",
      data: [
        {
          sourceId: s.taskId,
          missionSourceId: s.missionId,
          title: "T",
          description: "",
          priority: "medium",
          requiredDomain: null,
          requiredCapabilities: [],
        },
      ],
    };
  } else {
    domains.tasks = { disposition: "reset", data: [] };
  }
  return {
    version: 3,
    manifestId: `custody-${randomUUID()}`,
    generatedAt: EXPORTED_AT,
    mode: "replacement",
    identityPolicy: "restore",
    lineage: {
      sourceHabitatId: s.habitatId,
      sourceExportedAt: EXPORTED_AT,
      sourceManifestId: null,
    },
    domains,
  };
}

function prepareAndPublish(manifest: HabitatImportManifest, habitatId: string): void {
  const preparedResult = prepareImport({
    rawManifest: manifest,
    habitatId,
    mode: "replacement",
    manifestId: manifest.manifestId,
    actor: { type: "human", id: "user-fix" },
    auditSource: "rest_api",
  });
  expect(preparedResult.outcome, JSON.stringify(preparedResult)).toBe("prepared");
  if (preparedResult.outcome !== "prepared") return;
  const outcome = publishImportAggregateWithClient(getDb(), { prepared: preparedResult.prepared });
  expect(outcome.outcome).toBe("published");
}

// --- ledger / authority helpers -------------------------------------------

/** Scope-state helper — null once the RESOURCE row is deleted (intentional). */
function scopeState(kind: "mission" | "task", id: string) {
  return getScopeStateWithClient(getDb() as never, kind, id);
}

/** RAW ledger read: does a RETAINED retired incarnation exist for the key? */
function ledgerRetired(kind: "mission" | "task", id: string): boolean {
  return (
    getDb()
      .select({ id: governanceScopes.scopeId })
      .from(governanceScopes)
      .where(
        and(
          eq(governanceScopes.scopeKind, kind),
          eq(governanceScopes.scopeId, id),
          isNotNull(governanceScopes.retiredAt),
        ),
      )
      .all().length > 0
  );
}

function auditRows(objectId: string) {
  return getDb().select().from(governanceAudit).where(eq(governanceAudit.objectId, objectId)).all();
}

/** Real custody retire preconditions (materialize + retire incarnation 1). */
function priorRetireTask(taskId: string): void {
  getDb().transaction(
    (tx) => {
      retireTaskCustodyWithClient(tx as never, taskId, "prior delete", {
        actorType: "human",
        actorId: "user-prior",
      });
    },
    { behavior: "immediate" },
  );
}

function priorRetireMission(missionId: string): void {
  getDb().transaction(
    (tx) => {
      retireMissionCustodyWithClient(tx as never, missionId, "prior delete", {
        actorType: "human",
        actorId: "user-prior",
      });
    },
    { behavior: "immediate" },
  );
}

function makeIssuer(): string {
  const id = `u-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  getDb()
    .insert(users)
    .values({
      id,
      username: id,
      passwordHash: "x",
      displayName: id,
      role: "editor",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function seedActiveGrant(taskId: string, incarnation: number, agentId: string, issuer: string) {
  const id = `asg-${randomUUID().slice(0, 8)}`;
  getDb()
    .insert(roleAssignments)
    .values({
      id,
      principalType: "agent",
      principalId: agentId,
      definitionId: BUILTIN_ASSIGN_DEF,
      revisionId: BUILTIN_ASSIGN_REV,
      scopeKind: "task",
      scopeId: taskId,
      scopeIncarnation: incarnation,
      state: "active",
      version: 1,
      issuerUserId: issuer,
      issuedAt: new Date().toISOString(),
    })
    .run();
  return id;
}

function grantRow(id: string) {
  return getDb().select().from(roleAssignments).where(eq(roleAssignments.id, id)).get();
}

// ---------------------------------------------------------------------------
// Driver 1: sql.js snapshot harness
// ---------------------------------------------------------------------------

describe("custody restore re-enrollment + canonical delete (sql.js snapshot)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("projects callerless custody as unknown and excludes it from identified human counts without rewriting history", () => {
    const internal = seedFull("unknown-attribution");
    const human = seedFull("human-attribution");
    const agent = seedFull("agent-attribution");
    expect(deleteTask(internal.taskId).success).toBe(true);
    expect(deleteTask(human.taskId, { actorType: "human", actorId: "user-del" }).success).toBe(true);
    expect(deleteTask(agent.taskId, { actorType: "agent", actorId: "agent-del" }).success).toBe(true);
    const before = getDb().select().from(governanceAudit).all();
    expect(auditRows(internal.taskId)).toEqual([
      expect.objectContaining({ actorType: "human", actorId: "unknown" }),
    ]);
    // Consumer SQL from DATABASE.md: the retained sentinel is a separate
    // attribution category; it is never counted as an identified human.
    const projection = getDb().select({
      actorType: sql<string>`CASE WHEN actor_type = 'human' AND actor_id = 'unknown'
        THEN 'unknown' ELSE actor_type END`,
      actorId: governanceAudit.actorId,
    }).from(governanceAudit).all();
    expect(projection).toEqual(expect.arrayContaining([
      { actorType: "unknown", actorId: "unknown" },
      { actorType: "human", actorId: "user-del" },
      { actorType: "agent", actorId: "agent-del" },
    ]));
    const count = getDb().select({ count: sql<number>`COUNT(*)` })
      .from(governanceAudit)
      .where(sql`actor_type = 'human' AND actor_id <> 'unknown'`).get();
    expect(count?.count).toBe(1);
    expect(getDb().select().from(governanceAudit).all()).toEqual(before);
  });

  it("same-id restore re-enrolls retired scopes: inc2 active, old grant revoked, new grant authorizes", () => {
    const s = seedFull("fix1");
    const agent = createAgent({
      name: `a-${randomUUID().slice(0, 6)}`,
      type: "claude-code",
      domain: "backend",
    }).agent;
    const issuer = makeIssuer();

    // Precondition: BOTH scopes carry retired incarnation-1 history (the
    // pre-restore state a same-lineage restore must recover from).
    priorRetireMission(s.missionId);
    expect(scopeState("task", s.taskId)?.status).toBe("retired");
    expect(scopeState("mission", s.missionId)?.status).toBe("retired");

    // A stale ACTIVE grant pinned to the retired incarnation — must not
    // survive the restore's custody transition.
    const oldGrantId = seedActiveGrant(s.taskId, 1, agent.id, issuer);

    prepareAndPublish(restoreManifest(s, "Restored"), s.habitatId);

    // Scopes: fresh ACTIVE incarnation 2 under the SAME ids.
    const st = scopeState("task", s.taskId);
    expect(st?.status).toBe("active");
    expect(st?.incarnation).toBe(2);
    const ms = scopeState("mission", s.missionId);
    expect(ms?.status).toBe("active");
    expect(ms?.incarnation).toBe(2);

    // The task row came back under the SAME id (restore contract).
    expect(getDb().select().from(tasks).where(eq(tasks.id, s.taskId)).get()?.id).toBe(s.taskId);

    // Old grant revoked by the transition.
    expect(grantRow(oldGrantId)?.state).toBe("revoked");

    // A RAW grant row at incarnation 2 on the restored scope (not the
    // managed createAssignment route) — the evaluator then authorizes
    // through it, proving authority is actually restored, not just the
    // ledger row.
    const newGrantId = seedActiveGrant(s.taskId, 2, agent.id, issuer);
    expect(grantRow(newGrantId)?.state).toBe("active");
    const verdict = evaluatePermissionsWithClient(
      getDb() as never,
      { type: "agent", id: agent.id },
      "review.assign",
      { scopeKind: "task", scopeId: s.taskId },
    );
    expect(verdict.allowed).toBe(true);

    // Audit: retirement (prior) + re-enrollment (import) with real actors
    // and actual incarnations.
    const rows = auditRows(s.taskId);
    const retired = rows.find((r) => r.operation === "task.custody_retired");
    expect(retired?.actorType).toBe("human");
    expect(retired?.actorId).toBe("user-prior");
    expect(retired?.scopeIncarnation).toBe(1);
    const reenrolled = rows.find((r) => r.operation === "task.custody_reenrolled");
    expect(reenrolled?.actorType).toBe("human");
    expect(reenrolled?.actorId).toBe("user-fix");
    expect(reenrolled?.scopeIncarnation).toBe(2);
  });

  it("missions:replace + tasks:reset (legal combo) retires child tasks before the cascade; restored mission re-enrolls", () => {
    // "missions:replace + tasks omitted" is REFUSED by preflight
    // (incompatible_disposition — the mission delete cascades tasks). The
    // legal coverage for the cascade-custody seam is tasks:reset: the
    // missions scoped-delete collects child task ids while the rows exist
    // and retires them (none are in a restore set — reset re-inserts
    // nothing); the restored mission re-enrolls.
    const s = seedFull("fix2");
    priorRetireMission(s.missionId);

    prepareAndPublish(restoreManifest(s, "CascadeReset", { tasks: "reset" }), s.habitatId);

    // Child task row is gone; its ledger is RETAINED retired (raw read —
    // the scope-state helper intentionally nulls on deleted resources).
    expect(getDb().select().from(tasks).where(eq(tasks.id, s.taskId)).get()).toBeUndefined();
    expect(ledgerRetired("task", s.taskId)).toBe(true);

    // Restored mission: fresh active incarnation 2, row back under same id.
    const ms = scopeState("mission", s.missionId);
    expect(ms?.status).toBe("active");
    expect(ms?.incarnation).toBe(2);
    expect(getDb().select().from(missions).where(eq(missions.id, s.missionId)).get()?.id).toBe(
      s.missionId,
    );
  });

  it("tasks-only restore: restored task re-enrolls, non-restored sibling retires (parents preserved)", () => {
    const s = seedFull("fix3");
    const siblingId = "fix3-task-b";
    seedTaskRow(s.missionId, siblingId, "B");
    priorRetireTask(s.taskId);

    // Preserved parent envelopes still populate source-ID reference mappings;
    // omitting the missions envelope leaves missionSourceId unresolved.
    const m = restoreManifest(s, "TasksOnly");
    m.domains.habitatSettings!.disposition = "preserve";
    m.domains.columns!.disposition = "preserve";
    m.domains.missions!.disposition = "preserve";
    prepareAndPublish(m, s.habitatId);

    const st = scopeState("task", s.taskId);
    expect(st?.status).toBe("active");
    expect(st?.incarnation).toBe(2);
    // Sibling was scoped-deleted (not in the restore set) → retained retired.
    expect(getDb().select().from(tasks).where(eq(tasks.id, siblingId)).get()).toBeUndefined();
    expect(ledgerRetired("task", siblingId)).toBe(true);
  });

  it("tasks:reset under restore does NOT re-enroll (reset re-inserts nothing)", () => {
    const s = seedFull("fix4");
    // `tasks:reset` is handled by the in-place execution-state reset, not the
    // scoped-delete; its custody seam must not fire a re-enrollment.
    prepareAndPublish(restoreManifest(s, "ResetTasks", { tasks: "reset" }), s.habitatId);
    expect(auditRows(s.taskId).some((r) => r.operation === "task.custody_reenrolled")).toBe(false);
  });

  it("remap replacement retires the old scopes (no re-enrollment)", () => {
    const s = seedFull("fix5");
    const manifest = restoreManifest(s, "Remapped");
    manifest.identityPolicy = "remap";
    manifest.lineage = {
      sourceHabitatId: null,
      sourceExportedAt: EXPORTED_AT,
      sourceManifestId: null,
    };
    prepareAndPublish(manifest, s.habitatId);

    // Old ids are gone (remap allocates fresh ones) — the scope-state
    // helper nulls on deleted resources; retirement is the RETAINED ledger.
    expect(ledgerRetired("task", s.taskId)).toBe(true);
    expect(ledgerRetired("mission", s.missionId)).toBe(true);
    expect(auditRows(s.taskId).some((r) => r.operation === "task.custody_reenrolled")).toBe(false);
  });

  it("deleteTask by feat- alias deletes the canonical row (no false 204)", () => {
    const s = seedFull("fix6");
    const result = deleteTask(`feat-${s.taskId}`, { actorType: "human", actorId: "user-del" });
    expect(result.success).toBe(true);
    expect(getDb().select().from(tasks).where(eq(tasks.id, s.taskId)).get()).toBeUndefined();
    // Retained retired ledger on the canonical id, audited with the real actor.
    expect(ledgerRetired("task", s.taskId)).toBe(true);
    const retired = auditRows(s.taskId).find((r) => r.operation === "task.custody_retired");
    expect(retired?.actorId).toBe("user-del");
    expect(retired?.scopeIncarnation).toBe(1);
  });

  it("no-op retire (already retired, no active row) writes no audit row", () => {
    const s = seedFull("fix7");
    priorRetireTask(s.taskId);
    const firstCount = auditRows(s.taskId).length;
    getDb().transaction(
      (tx) => {
        retireTaskCustodyWithClient(tx as never, s.taskId, "second", {
          actorType: "human",
          actorId: "u1",
        });
      },
      { behavior: "immediate" },
    );
    expect(auditRows(s.taskId).length).toBe(firstCount);
  });
});

// ---------------------------------------------------------------------------
// Driver 2: production better-sqlite3 (FK enforcement) — restore paths
// ---------------------------------------------------------------------------

describe("custody restore re-enrollment (production better-sqlite3 driver)", () => {
  let dbPath: string;
  beforeEach(async () => {
    dbPath = join(tmpdir(), `orcy-custody-restore-${randomUUID()}.db`);
    await initDb(dbPath);
  });
  afterEach(() => {
    closeDb();
    rmSync(dbPath, { force: true });
  });

  it("restore re-enrollment commits with FK enforcement on and scope reads active", () => {
    const s = seedFull("fixp");
    priorRetireMission(s.missionId);
    prepareAndPublish(restoreManifest(s, "RestoredP"), s.habitatId);
    const st = scopeState("task", s.taskId);
    expect(st?.status).toBe("active");
    expect(st?.incarnation).toBe(2);
    expect(getDb().select().from(tasks).where(eq(tasks.id, s.taskId)).get()?.id).toBe(s.taskId);
  });

  it("missions:replace + tasks:reset retires children before cascade under FK enforcement", () => {
    const s = seedFull("fixq");
    priorRetireMission(s.missionId);
    prepareAndPublish(restoreManifest(s, "CascadeResetQ", { tasks: "reset" }), s.habitatId);
    expect(ledgerRetired("task", s.taskId)).toBe(true);
    expect(scopeState("mission", s.missionId)?.incarnation).toBe(2);
  });
});
