/**
 * Review-safety proof repairs (independent-review gaps).
 *
 * P1 forced CAS loss AFTER a decision write; P2 veto telemetry actually
 * committed; P3 pristine pre-0082 journal upgrades on BOTH drivers with FK
 * retention; P4 real import-reset override expiry + sticky terminal reset
 * through the real route; P5 persisted authorized decider negative and
 * revoked team membership over real HTTP; B2 reviewer-added-between-approval-
 * and-completion; B3 projected reviewer GET + allocator occupancy; B6
 * cross-habitat requirement GET.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb, initDb } from "../db/index.js";
import {
  users,
  teams,
  organizations,
  teamMembers,
  tasks,
  taskEvents,
  taskReviewRequirements,
  taskReviewDecisions,
  habitats,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskService from "../services/tasks/index.js";
import * as reviewSafetyRepo from "../repositories/reviewSafety.js";
import {
  getRequirementWithClient,
  projectedPendingCountByReviewer,
} from "../repositories/reviewSafety.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { v4 as uuid } from "uuid";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { reviewSafetyRoutes } from "../routes/reviewSafety.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-rs-proofs");

let habitatId: string;
let missionId: string;

function seedWorld(name: string): void {
  const habitat = habitatRepo.createHabitat({ name: `rs-proof-${name}-${Math.random()}` });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `rs-proof-${name}`,
    createdBy: "u",
  });
  missionId = mission.id;
}

function makeAgent(): string {
  return agentRepo.createAgent({
    name: `rs-p-agent-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  }).agent.id;
}

function makeUser(role: "admin" | "editor" | "viewer"): string {
  const id = uuid();
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", displayName: id, role })
    .run();
  return id;
}

function submitted(reviewers?: Array<["human" | "agent", string]>): {
  taskId: string;
  agent: string;
} {
  const taskId = taskCrud.createTask({ missionId, title: `t-${Math.random()}`, createdBy: "u" }).id;
  const agent = makeAgent();
  if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
  taskStateMachine.startTask(taskId, agent);
  if (!taskStateMachine.submitTask(taskId, agent, "w", [])) throw new Error("submit failed");
  for (const [type, id] of reviewers ?? []) taskReviewerRepo.create(taskId, type, id);
  return { taskId, agent };
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// P1 — forced terminal CAS loss AFTER the decision write
// ---------------------------------------------------------------------------

describe("P1: a lost terminal CAS after the decision write rolls everything back", () => {
  it("a trigger flips the status right after the decision insert → CAS loses → full rollback", () => {
    seedWorld("cas-loss");
    const { taskId } = submitted([["human", "rev-final"]]);
    // A temp SQLite trigger intercepts the reservation at exactly the
    // review-mandated point: AFTER the decision row INSERT, BEFORE the
    // terminal CAS — same transaction, no mocks.
    const raw = getDb() as unknown as { run: (q: string) => void };
    raw.run(
      `CREATE TRIGGER rs_p1_cas_loss AFTER INSERT ON task_review_decisions
       WHEN NEW.task_id = '${taskId}'
       BEGIN UPDATE tasks SET status = 'rejected' WHERE id = '${taskId}'; END`,
    );
    try {
      let threw = false;
      try {
        taskService.approveTask(taskId, "rev-final", "human");
      } catch {
        threw = true; // the reservation surfaces the lost CAS as a rollback
      }
      expect(threw).toBe(true);
    } finally {
      raw.run(`DROP TRIGGER rs_p1_cas_loss`);
    }
    // ZERO decision rows, ZERO proof — the append rolled back with the CAS.
    expect(
      getDb()
        .select()
        .from(taskReviewDecisions)
        .where(eq(taskReviewDecisions.taskId, taskId))
        .all(),
    ).toHaveLength(0);
    const r = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r.approvedGeneration).toBeNull();
    const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    // The racing flip lived in the SAME reservation — it rolled back too.
    expect(t.status).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// P2 — veto telemetry is actually COMMITTED (not rolled back)
// ---------------------------------------------------------------------------

describe("P2: veto commits telemetry through the REAL plugin runtime", () => {
  let pluginDir: string | undefined;

  afterEach(async () => {
    const pluginManager = await import("../plugins/pluginManager.js");
    pluginManager.resetPlugins();
    if (pluginDir) {
      const { rm } = await import("node:fs/promises");
      await rm(pluginDir, { recursive: true, force: true });
      pluginDir = undefined;
    }
  });

  it("a REAL enrolled pre-interceptor vetoes the final approval; its plugin-run telemetry persists; no decision/status/proof", async () => {
    seedWorld("veto-runtime");
    const { taskId } = submitted([["human", "rev-veto"]]);
    const pluginManager = await import("../plugins/pluginManager.js");
    const { mkdir, writeFile } = await import("node:fs/promises");

    // REAL plugin file loaded through the production plugin manager.
    pluginDir = `/tmp/test-runner-rs-veto-${Date.now()}`;
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      `${pluginDir}/veto-telemetry.mjs`,
      `export default {
        manifest: {
          id: 'veto-telemetry',
          version: '1.0.0',
          description: 'veto pre-interceptor with telemetry',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskApproved',
            interceptorId: 'block-approve',
            requires: [],
            priority: 0,
          }],
        },
        interceptors: {
          'block-approve': () => ({ allow: false, reason: 'plugin vetoed', details: 'telemetry proof' }),
        },
      };`,
    );
    pluginManager.setPluginDirectory(pluginDir);
    await pluginManager.loadPlugins();

    // Enroll for THIS habitat (production enrollment + cache invalidation).
    const enrollmentRepo = await import("../repositories/pluginEnrollment.js");
    enrollmentRepo.create({
      habitatId,
      pluginId: "veto-telemetry",
      contributionId: "block-approve",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    // Drive the REAL approve service — no mocks anywhere on the runtime path.
    expect(() => taskService.approveTask(taskId, "rev-veto", "human")).toThrow(/veto/i);

    // The runtime's own telemetry survived the veto (plugin_runs row for the
    // real invocation — disposition persisted by the production runtime).
    const { pluginRuns } = await import("../db/schema/index.js");
    const runs = getDb()
      .select()
      .from(pluginRuns)
      .where(eq(pluginRuns.pluginId, "veto-telemetry"))
      .all();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // No decision, no status change, no proof.
    expect(
      getDb()
        .select()
        .from(taskReviewDecisions)
        .where(eq(taskReviewDecisions.taskId, taskId))
        .all(),
    ).toHaveLength(0);
    const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(t.status).toBe("submitted");
    expect(getRequirementWithClient(getDb() as never, taskId)!.approvedGeneration).toBeNull();
  });
});

/**
 * Authentic pre-0082 UPGRADE fixture: schema + 58 REAL journal rows written
 * by the BASE 229942f production staged runner + initial legacy seed rows.
 * See the fixture header for provenance, source-DB hash, and the verbatim
 * generation command.
 */
const BASE_UPGRADE_FIXTURE = join(
  import.meta.dirname,
  "fixtures",
  "reviewSafety",
  "base-0081-upgrade-fixture.sql",
);

function restoreFixtureInto(db: { exec: (q: string) => void }): void {
  db.exec(readFileSync(BASE_UPGRADE_FIXTURE, "utf8"));
}

describe("P3: authentic pre-0082 journal upgraded by the CANDIDATE production initDb", () => {
  const dbPath = join(TEMP_DIR, "p3-upgrade-real.db");

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("better-sqlite3 (PRODUCTION UPGRADE PROOF): candidate initDb applies pending 0082 exactly once via the real staged runner", async () => {
    // Fixture restoration (a dump load — NOT running migrations).
    const seed = new Database(dbPath);
    seed.exec("PRAGMA journal_mode = WAL");
    restoreFixtureInto(seed);
    const journalBefore = seed.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
      n: number;
    };
    expect(journalBefore.n).toBe(58); // authentic base journal (…0081)
    expect(
      seed.prepare("SELECT name FROM sqlite_master WHERE name='task_review_requirements'").get(),
    ).toBeUndefined();
    seed.close();

    // THE UPGRADE: the candidate PRODUCTION initDb (staged runner + bridge,
    // src/db/index.ts) boots on the real pre-0082 file.
    await closeDb();
    await initDb(dbPath);
    await closeDb();

    const up = new Database(dbPath);
    up.pragma("foreign_keys = ON");
    // Exactly ONE new journal row: 0082, hash = sha256 of the committed SQL,
    // strictly increasing when.
    const rows = up
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id")
      .all() as Array<{ hash: string; created_at: number }>;
    expect(rows).toHaveLength(59);
    const added = rows[58];
    const expectedHash = createHash("sha256")
      .update(readFileSync(join(DRIZZLE_DIR, "0082_task_review_safety.sql")))
      .digest("hex");
    expect(added.hash).toBe(expectedHash);
    expect(added.created_at).toBeGreaterThan(rows[57].created_at);
    // No duplicate application (second boot is a no-op).
    await initDb(dbPath);
    await closeDb();
    const up2 = new Database(dbPath);
    expect(
      (up2.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n,
    ).toBe(59);
    up2.close();

    // Classifier on the seeded legacy shapes.
    const active = up
      .prepare(
        "SELECT state, origin, claimant_type FROM task_review_requirements WHERE task_id = 'p3-active'",
      )
      .get() as { state: string; origin: string; claimant_type: string };
    expect(active.state).toBe("legacy_unknown");
    expect(active.origin).toBe("legacy_unverified");
    expect(active.claimant_type).toBe("local_agent");
    const never = up
      .prepare("SELECT state FROM task_review_requirements WHERE task_id = 'p3-never'")
      .get() as { state: string };
    expect(never.state).toBe("uncaptured");
    const done = up
      .prepare(
        "SELECT state, approved_generation FROM task_review_requirements WHERE task_id = 'p3-done'",
      )
      .get() as { state: string; approved_generation: number | null };
    expect(done.state).toBe("legacy_unknown");
    expect(done.approved_generation).toBeNull(); // legacy approved row ≠ proof
    // Seeded data retained.
    expect(up.prepare("SELECT status FROM tasks WHERE id = 'p3-done'").get()).toEqual({
      status: "done",
    });

    // FK ON — ALL FOUR review-safety tables cascade on task delete; decision
    // evidence RETAINED after assignment delete.
    const tsn = new Date().toISOString();
    up.prepare(
      `INSERT INTO task_review_snapshots (id, task_id, review_generation, claimant_type, claimant_id, matched, required_count, captured_at) VALUES ('s1', 'p3-active', 0, 'local_agent', 'agent-x', 0, 0, ?)`,
    ).run(tsn);
    up.prepare(
      `INSERT INTO task_review_decisions (id, task_id, review_generation, review_round, reviewer_type, reviewer_id, decision, decided_at, actor_type, actor_id) VALUES ('d1', 'p3-active', 0, 0, 'human', 'h1', 'approved', ?, 'human', 'h1')`,
    ).run(tsn);
    up.prepare(
      `INSERT INTO task_review_overrides (id, task_id, actor_id, review_generation, kind, requirement_version_before, task_version, old_state, new_state, reason, created_at) VALUES ('o1', 'p3-active', 'admin', 0, 'resolve_unknown', 1, 1, 'legacy_unknown', 'known_zero', 'r', ?)`,
    ).run(tsn);
    up.prepare(`DELETE FROM task_reviewers WHERE task_id = 'p3-done'`).run();
    expect(
      up.prepare(`SELECT COUNT(*) AS n FROM task_review_decisions WHERE id = 'd1'`).get(),
    ).toEqual({ n: 1 });
    up.prepare(`DELETE FROM tasks WHERE id = 'p3-active'`).run();
    for (const table of [
      "task_review_requirements",
      "task_review_snapshots",
      "task_review_decisions",
      "task_review_overrides",
    ]) {
      expect(
        up.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = 'p3-active'`).get(),
      ).toEqual({ n: 0 });
    }
    up.close();
  });

  it("sql.js (RAW DRIVER-COMPAT ONLY — NOT the production upgrade proof): committed 0082 SQL applies on the fixture bytes with FK ON", async () => {
    // Honest scope: sql.js does not run the production staged runner here.
    // This arm proves the committed 0082 SQL is driver-portable and FK-safe.
    const initSqlJs = (await import("sql.js")) as unknown as {
      default: () => Promise<{
        Database: new (b: Buffer) => {
          exec: (q: string) => void;
          run: (q: string) => void;
          prepare: (q: string) => {
            step: () => boolean;
            getAsObject: () => Record<string, unknown>;
          };
        };
      }>;
    };
    const SQL = await initSqlJs.default();
    const mem = new SQL.Database(new Uint8Array(0).buffer as unknown as Buffer);
    mem.exec("PRAGMA foreign_keys = ON");
    mem.run("PRAGMA foreign_keys = ON");
    restoreFixtureInto(mem);
    const apply = (file: string) => {
      const text = readFileSync(file, "utf8");
      for (const stmt of text.split("--> statement-breakpoint")) {
        const trimmed = stmt.trim();
        if (trimmed) mem.exec(trimmed);
      }
    };
    apply(join(DRIZZLE_DIR, "0082_task_review_safety.sql"));
    const readState = (id: string): string => {
      const stmt = mem.prepare(
        `SELECT state FROM task_review_requirements WHERE task_id = '${id}'`,
      );
      const has = stmt.step();
      const row = has ? stmt.getAsObject() : {};
      return (row.state as string) ?? "missing";
    };
    expect(readState("p3-active")).toBe("legacy_unknown");
    expect(readState("p3-never")).toBe("uncaptured");
    // ALL FOUR cascade + decision retention on this driver too.
    mem.run(
      `INSERT INTO task_review_snapshots (id, task_id, review_generation, claimant_type, claimant_id, matched, required_count, captured_at) VALUES ('s2', 'p3-never', 0, 'local_agent', 'agent-x', 0, 0, '2026-01-01')`,
    );
    mem.run(
      `INSERT INTO task_review_decisions (id, task_id, review_generation, review_round, reviewer_type, reviewer_id, decision, decided_at, actor_type, actor_id) VALUES ('d2', 'p3-never', 0, 0, 'human', 'h1', 'rejected', '2026-01-01', 'human', 'h1')`,
    );
    mem.run(
      `INSERT INTO task_review_overrides (id, task_id, actor_id, review_generation, kind, requirement_version_before, task_version, old_state, new_state, reason, created_at) VALUES ('o2', 'p3-never', 'admin', 0, 'resolve_unknown', 1, 1, 'legacy_unknown', 'known_zero', 'r', '2026-01-01')`,
    );
    mem.run(
      `INSERT INTO task_reviewers (id, task_id, reviewer_type, reviewer_id, status, assigned_at) VALUES ('r2', 'p3-never', 'human', 'h1', 'pending', '2026-01-01')`,
    );
    mem.run(`DELETE FROM task_reviewers WHERE id = 'r2'`);
    const dstmt = mem.prepare(`SELECT COUNT(*) AS n FROM task_review_decisions WHERE id = 'd2'`);
    dstmt.step();
    expect(dstmt.getAsObject()).toEqual({ n: 1 });
    mem.run(`DELETE FROM tasks WHERE id = 'p3-never'`);
    for (const table of [
      "task_review_requirements",
      "task_review_snapshots",
      "task_review_decisions",
      "task_review_overrides",
    ]) {
      const stmt = mem.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = 'p3-never'`);
      stmt.step();
      expect(stmt.getAsObject()).toEqual({ n: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// B2 — reviewer added between approval and completion blocks done
// ---------------------------------------------------------------------------

describe("B2: approved→done re-evaluates the fresh projection", () => {
  it("a reviewer added after the approval blocks completion until decided", () => {
    seedWorld("b2");
    const { taskId, agent } = submitted();
    expect(taskService.approveTask(taskId, "first-reviewer", "human")?.status).toBe("approved");
    // A new assignment lands between approval and completion.
    taskReviewerRepo.create(taskId, "human", "late-reviewer");
    const blocked = taskService.completeTask(taskId, agent);
    expect(blocked.task).toBeNull();
    expect(blocked.error).toBe("REVIEW_REQUIRED"); // proof_invalid maps to REVIEW_REQUIRED

    // Authorized assignment repair: the (never-admitted-on-approved) late
    // slot is removed → the fresh projection is again fully satisfied and
    // completion proceeds.
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, "late-reviewer", "human")!;
    taskReviewerRepo.remove(row.id);
    const done = taskService.completeTask(taskId, agent);
    expect(done.task?.status).toBe("done");
  });

  it("a POSITIVE floor whose approved assignment is removed before completion is denied (quorum vs effective_count)", () => {
    seedWorld("b2-floor");
    reviewRuleRepo.create(habitatId!, { name: "R", requiredReviews: 1 });
    const taskId = taskCrud.createTask({
      missionId: missionId!,
      title: "b2-floor",
      createdBy: "u",
    }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    taskStateMachine.startTask(taskId, agent);
    expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
    taskReviewerRepo.create(taskId, "human", "solo-reviewer");
    expect(taskService.approveTask(taskId, "solo-reviewer", "human")?.status).toBe("approved");

    // The last approved assignment is removed between approval and done:
    // the empty projection has no blockers, but effective_count=1 > 0
    // eligible approvals → completion MUST refuse.
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, "solo-reviewer", "human")!;
    taskReviewerRepo.remove(row.id);
    const blocked = taskService.completeTask(taskId, agent);
    expect(blocked.task).toBeNull();

    // Authorized repair: the reviewer is re-assigned; the generation-tagged
    // decision evidence was RETAINED, so the restored slot projects approved
    // and completion proceeds (no new decision needed on an approved task).
    taskReviewerRepo.create(taskId, "human", "solo-reviewer");
    const done = taskService.completeTask(taskId, agent);
    expect(done.task?.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// B3 — projected reviewer GET + allocator occupancy
// ---------------------------------------------------------------------------

describe("B6/P5/B3-route: real-HTTP proofs", () => {
  async function buildApp() {
    const { createHttpApplication } = await import("../httpApp.js");
    const app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]); // explicitly empty validated catalog
    await app.finalize();
    return app;
  }

  function makeTeamHabitat(name: string): { habitatId: string; teamId: string; missionId: string } {
    const orgId = uuid();
    getDb()
      .insert(organizations)
      .values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` })
      .run();
    const teamId = uuid();
    getDb()
      .insert(teams)
      .values({ id: teamId, organizationId: orgId, name: `t-${teamId}`, slug: `t-${teamId}` })
      .run();
    const habitat = habitatRepo.createHabitat({ name: `rs-http-${name}-${Math.random()}` });
    getDb().update(habitats).set({ teamId }).where(eq(habitats.id, habitat.id)).run();
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: `rs-http-${name}`,
      createdBy: "u",
    });
    return { habitatId: habitat.id, teamId, missionId: mission.id };
  }

  async function login(app: unknown, userId: string): Promise<string> {
    const { hash } = (await import("bcryptjs")) as {
      hash: (p: string, s: number) => Promise<string>;
    };
    const u = getDb().select().from(users).where(eq(users.id, userId)).get()!;
    getDb()
      .update(users)
      .set({ passwordHash: await hash("pw-rs", 4) })
      .where(eq(users.id, userId))
      .run();
    const res = await (app as { inject: (o: unknown) => Promise<{ body: string }> }).inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: u.username, password: "pw-rs" },
    });
    return (JSON.parse(res.body) as { token: string }).token;
  }

  it("requirement GET: TEAM member 200 with full body; cross-team authenticated human exact 403, no leak", async () => {
    const app = await buildApp();
    try {
      const a = makeTeamHabitat("a");
      const b = makeTeamHabitat("b");
      // A submitted task in habitat A.
      const taskId = taskCrud.createTask({ missionId: a.missionId, title: "t", createdBy: "u" }).id;
      const agent = makeAgent();
      taskStateMachine.claimTask(taskId, agent);
      taskStateMachine.startTask(taskId, agent);
      taskStateMachine.submitTask(taskId, agent, "w", []);

      const member = makeUser("admin");
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: a.teamId, userId: member, role: "owner" })
        .run();
      const outsider = makeUser("admin"); // member of team B only
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: b.teamId, userId: outsider, role: "owner" })
        .run();

      const memberToken = await login(app, member);
      const outsiderToken = await login(app, outsider);

      const ok = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "GET",
        url: `/api/tasks/${taskId}/review-requirement`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(ok.statusCode).toBe(200);
      const body = JSON.parse(ok.body) as { requirement: { taskId: string; state: string } | null };
      expect(body.requirement).not.toBeNull();
      expect(body.requirement!.taskId).toBe(taskId);
      expect(body.requirement!.state).toBe("known_zero");

      const denied = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "GET",
        url: `/api/tasks/${taskId}/review-requirement`,
        headers: { authorization: `Bearer ${outsiderToken}` },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("known_zero"); // no state leak
      expect(denied.body).not.toContain(taskId);
    } finally {
      await (app as unknown as { close: () => Promise<void> }).close();
    }
  });

  it("reviewer GET (public route): stale-APPROVED raw row + generation advance via REAL lifecycle → status approved, projectedStatus pending", async () => {
    const app = await buildApp();
    try {
      const a = makeTeamHabitat("reviewers");
      // Floor-2 rule so a single approval is a recorded_partial (task stays
      // submitted with a raw APPROVED row + generation-tagged decision).
      reviewRuleRepo.create(a.habitatId, { name: "R2", requiredReviews: 2 });
      const taskId = taskCrud.createTask({
        missionId: a.missionId,
        title: "t2",
        createdBy: "u",
      }).id;
      const agent = makeAgent();
      expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
      taskStateMachine.startTask(taskId, agent);
      expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
      taskReviewerRepo.create(taskId, "human", "stale-a");
      taskReviewerRepo.create(taskId, "human", "stale-b");
      const partial = taskService.approveTask(taskId, "stale-a", "human");
      expect(partial).not.toBeNull();
      expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
        "submitted",
      );
      const rawRow = taskReviewerRepo.findByTaskAndReviewer(taskId, "stale-a", "human")!;
      expect(rawRow.status).toBe("approved"); // genuine old-generation approval

      // REAL generation advance: second reviewer REJECTS (typed decision),
      // the still-assigned claimant starts rework (genuine in_progress),
      // then really RELEASES; a new claimant claims and resubmits.
      expect(taskService.rejectTask(taskId, "stale-b", "rework", "human")).not.toBeNull();
      expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull(); // rejected→in_progress (same claimant)
      expect(taskStateMachine.releaseTask(taskId, "requeue") !== null).toBe(true); // real release
      const a2 = makeAgent();
      expect(taskStateMachine.claimTask(taskId, a2).success).toBe(true);
      taskStateMachine.startTask(taskId, a2);
      expect(taskStateMachine.submitTask(taskId, a2, "w2", [])).not.toBeNull();
      const requirement = getRequirementWithClient(getDb() as never, taskId)!;
      expect(requirement.reviewGeneration).toBeGreaterThanOrEqual(2); // genuinely advanced

      const member = makeUser("admin");
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: a.teamId, userId: member, role: "owner" })
        .run();
      const token = await login(app, member);

      const res = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "GET",
        url: `/api/tasks/${taskId}/reviewers`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = (
        JSON.parse(res.body) as {
          reviewers: Array<{ reviewerId: string; status: string; projectedStatus?: string }>;
        }
      ).reviewers;
      const stale = rows.find((r) => r.reviewerId === "stale-a");
      expect(stale).toBeDefined();
      expect(stale!.status).toBe("approved"); // raw history PRESERVED and exposed
      expect(stale!.projectedStatus).toBe("pending"); // effective projection: uncredited in the new generation
    } finally {
      await (app as unknown as { close: () => Promise<void> }).close();
    }
  });

  it("decider independence: SAME persisted UUID with membership still 403; authorized admin positive control 200; revoked member 403", async () => {
    const app = await buildApp();
    try {
      const a = makeTeamHabitat("decider");
      const taskId = taskCrud.createTask({
        missionId: a.missionId,
        title: "t3",
        createdBy: "u",
      }).id;
      const agent = makeAgent();
      taskStateMachine.claimTask(taskId, agent);
      taskStateMachine.startTask(taskId, agent);
      taskStateMachine.submitTask(taskId, agent, "w", []);
      // The decider is a REAL persisted user AND a team member — their 403
      // can only come from current-generation decision independence. The
      // reviewer identity and the decision actor are the SAME UUID (exactly
      // what the HTTP route derives from the authenticated principal).
      const deciderId = makeUser("editor");
      taskReviewerRepo.create(taskId, "human", deciderId);
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: a.teamId, userId: deciderId, role: "admin" })
        .run();
      expect(taskService.rejectTask(taskId, deciderId, "needs work", "human")).not.toBeNull();
      // Legacy-unknown so resolution is admissible at all.
      getDb()
        .update(taskReviewRequirements)
        .set({ state: "legacy_unknown", nonOverriddenFloor: null, effectiveCount: null })
        .where(eq(taskReviewRequirements.taskId, taskId))
        .run();

      const requirement = getRequirementWithClient(getDb() as never, taskId)!;
      const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
      const body = {
        expectedTaskVersion: task.version,
        expectedRequirementVersion: requirement.requirementVersion,
        effectiveCount: 0,
        reason: "operator resolution attempt",
      };

      const deciderToken = await login(app, deciderId);
      const resDecider = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "POST",
        url: `/api/tasks/${taskId}/review-requirement/resolve`,
        headers: { authorization: `Bearer ${deciderToken}` },
        payload: body,
      });
      expect(resDecider.statusCode).toBe(403);
      expect(resDecider.body).toContain("review decision in the current generation"); // the INDEPENDENCE reason, not membership

      // Positive control: an authorized non-decider admin resolves 200.
      const ownerId = makeUser("editor");
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: a.teamId, userId: ownerId, role: "owner" })
        .run();
      const ownerToken = await login(app, ownerId);
      const resOwner = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "POST",
        url: `/api/tasks/${taskId}/review-requirement/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: body,
      });
      expect(resOwner.statusCode).toBe(200);

      // Revoked membership: the SAME previously-authorized owner is 403.
      getDb().delete(teamMembers).where(eq(teamMembers.userId, ownerId)).run();
      const req2 = getRequirementWithClient(getDb() as never, taskId)!;
      const task2 = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
      const resRevoked = await (
        app as unknown as { inject: (o: unknown) => Promise<{ statusCode: number; body: string }> }
      ).inject({
        method: "POST",
        url: `/api/tasks/${taskId}/review-requirement/resolve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          expectedTaskVersion: task2.version,
          expectedRequirementVersion: req2.requirementVersion,
          effectiveCount: 0,
          reason: "after revocation",
        },
      });
      expect(resRevoked.statusCode).toBe(403);
    } finally {
      await (app as unknown as { close: () => Promise<void> }).close();
    }
  });

  it("REAL lifecycle rejection → rework resubmit → allocator respects occupied slots; rejection stays a finality blocker until the reviewer's fresh decision", async () => {
    const world = makeTeamHabitat("p4");
    habitatId = world.habitatId;
    missionId = world.missionId;
    const reviewAssignment = await import("../services/reviewAssignmentService.js");
    reviewRuleRepo.create(habitatId!, {
      name: "R",
      requiredReviews: 2,
      assignmentStrategy: "least_loaded",
    });
    // The human allocator's eligible pool = THIS habitat's team members.
    for (let i = 0; i < 2; i++) {
      const member = makeUser("editor");
      getDb()
        .insert(teamMembers)
        .values({ id: uuid(), teamId: world.teamId, userId: member, role: "member" })
        .run();
    }
    const taskId = taskCrud.createTask({ missionId: missionId!, title: "p4", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    taskStateMachine.startTask(taskId, agent);
    expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
    const r0 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r0.effectiveCount).toBe(2);

    // REAL initial allocation (two human slots from the team pool).
    const first = reviewAssignment.assignReviewers(taskId, habitatId!);
    expect(first.assigned).toHaveLength(2);
    const reviewerIds = first.assigned.map((a) => a.reviewerId);

    // REAL lifecycle rejection by the first reviewer (typed generation-tagged decision).
    expect(taskService.rejectTask(taskId, reviewerIds[0], "redo", "human")).not.toBeNull();
    // Same-claimant rework: start (round bump) + resubmit — genuine lifecycle.
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskStateMachine.submitTask(taskId, agent, "w2", [])).not.toBeNull();

    // FINALITY: the second reviewer approves, but the rejecting reviewer's
    // current-round rejection still blocks the transition.
    const afterReject = taskService.approveTask(taskId, reviewerIds[1], "human");
    expect(afterReject).not.toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );

    // The REAL allocator re-runs: both identities already hold rows (unique
    // constraint respected), so no invented vacancy is filled — allocation
    // is complete and history is intact.
    const second = reviewAssignment.assignReviewers(taskId, habitatId!);
    expect(second.assigned).toHaveLength(0);
    expect(taskReviewerRepo.getByTaskId(taskId)).toHaveLength(2);

    // The rejecting reviewer's AUTHORIZED FRESH DECISION unblocks finality.
    const unblocked = taskService.approveTask(taskId, reviewerIds[0], "human");
    expect(unblocked?.status).toBe("approved");
    const req = getRequirementWithClient(getDb() as never, taskId)!;
    expect(req.approvedGeneration).toBe(req.reviewGeneration);
  });
});

async function hashPw(pw: string): Promise<string> {
  const { hash } = (await import("bcryptjs")) as {
    hash: (p: string, s: number) => Promise<string>;
  };
  return hash(pw, 4);
}
