/**
 * REAL cross-process write overlap for the task-metadata save core
 * (services/tasks/humanTaskMetadata.ts) — GREEN characterization; the overlap
 * evidence is the deliverable.
 *
 * A holder child process holds a genuine `BEGIN IMMEDIATE` reservation on the
 * file DB while a saver child process runs the production
 * `saveTaskMetadataWithClient` on its OWN connection. Barriers (HELD before
 * SAVE is sent; SAVING before RELEASE is sent) make every case observe a held
 * reservation overlapping a waiting save — never a READY/GO simultaneous pair
 * (PRD E11). The holder commits its RELEASE payload INSIDE the open
 * reservation, so the waiting saver's BEGIN unblocks only against committed
 * state and its prechecks re-evaluate post-commit authority/eligibility/fences
 * (PRD E2/E3/E6).
 *
 * # Why forked children (not two connections on one loop)
 *
 * better-sqlite3 is synchronous: a save on the parent's event loop blocks the
 * parent for the whole busy_timeout (db/index.ts:294), so the parent could
 * never order RELEASE — the waiting save must live in its own process
 * (the findingTriageLifecycleConcurrency.test.ts IPC pattern, WITHOUT its
 * authority bypass: the saver runs against real persisted authority).
 *
 * GROUND anchors per case: PRD E2 (authority re-read under the reservation),
 * E3 (eligibility re-check), E6 (one BEGIN IMMEDIATE reservation; busy/lock
 * acquisition failures map to 503 with no retry), E11 (honest discriminators).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { missions, taskEvents, tasks, users } from "../db/schema/index.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import { computeMetadataEditIdentityWithClient } from "../services/tasks/humanTaskMetadata.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";

const WORKER = join(import.meta.dirname, "fixtures", "human-task-metadata-worker.ts");

// ---------------------------------------------------------------------------
// IPC harness — deadlines on every wait, cleanup on every failure path
// ---------------------------------------------------------------------------

interface SaverOutcome {
  ok: boolean;
  changed?: boolean;
  code?: string;
  currentVersion?: number;
}

interface WorkerMessage {
  type: "READY" | "HELD" | "SAVING" | "RESULT" | "RELEASED" | "WORKER_ERROR";
  result?: SaverOutcome;
  message?: string;
}

interface Forked {
  child: ChildProcess;
  ready: Promise<void>;
}

const liveChildren: ChildProcess[] = [];

function forkWorker(label: string, argv: string[], order: string[]): Forked {
  const child = fork(WORKER, argv, {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  liveChildren.push(child);
  child.stderr?.on("data", (chunk: Buffer) => {
    console.warn(`[metadata-overlap worker-${label} stderr]:`, chunk.toString());
  });
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: WorkerMessage): void => {
      if (msg?.type === "READY") {
        child.off("message", onMessage);
        child.off("exit", onExit);
        resolve();
      } else if (msg?.type === "WORKER_ERROR") {
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(new Error(`worker-${label} failed at boot: ${msg.message}`));
      }
    };
    const onExit = (code: number | null, signal: string | null): void => {
      reject(new Error(`worker-${label} exited (code=${code}, signal=${signal}) before READY`));
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
  void order; // order is captured in waitFor below
  return { child, ready };
}

/** Waits for a worker message type with a hard IPC deadline; records arrival order. */
function waitFor(child: ChildProcess, type: WorkerMessage["type"], label: string, order: string[], timeoutMs = 30_000): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off("message", onMessage);
      child.off("exit", onExit);
      reject(new Error(`timeout (${timeoutMs}ms) waiting for worker-${label} ${type}`));
    }, timeoutMs);
    const onMessage = (msg: WorkerMessage): void => {
      if (settled) return;
      if (msg?.type === type) {
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        order.push(type);
        resolve(msg);
      } else if (msg?.type === "WORKER_ERROR") {
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(new Error(`worker-${label} error while waiting for ${type}: ${msg.message}`));
      }
    };
    const onExit = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`worker-${label} exited (code=${code}, signal=${signal}) while waiting for ${type}`));
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

// ---------------------------------------------------------------------------
// Fixture — team habitat, current editor member, pending unassigned task
// (PRD E2 team rule + E3 editable shape; the T3 persistence suite owns the
// personal-habitat shape)
// ---------------------------------------------------------------------------

interface Fixture {
  member: string;
  teamId: string;
  habitatId: string;
  missionId: string;
  taskId: string;
  expectedVersion: number;
  expectedTaskIdentity: string;
}

function setup(): Fixture {
  const db = getDb();
  const member = randomUUID();
  db.insert(users).values({ id: member, username: member, passwordHash: "fixture", role: "editor" }).run();
  const org = orgRepo.createOrganization({ name: "Metadata overlap", slug: randomUUID() });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "Overlap team", slug: randomUUID() });
  memberRepo.addMember({ teamId: team.id, userId: member, role: "member" });
  const habitat = habitatRepo.createHabitat({ name: "Metadata overlap habitat", teamId: team.id });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
  const mission = missionRepo.createMission({ habitatId: habitat.id, title: "Mission", createdBy: "fixture" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", description: "body", priority: "medium", createdBy: "fixture" });
  const row = db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
  return {
    member,
    teamId: team.id,
    habitatId: habitat.id,
    missionId: mission.id,
    taskId: task.id,
    expectedVersion: row.version,
    expectedTaskIdentity: computeMetadataEditIdentityWithClient(db, {
      taskId: task.id,
      missionId: mission.id,
      habitatId: habitat.id,
      createdAt: row.createdAt,
    }),
  };
}

function taskRow(taskId: string) {
  return taskRepo.getTaskById(taskId)!;
}
function updatedEvents(taskId: string) {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().filter((e) => e.action === "updated");
}

// ---------------------------------------------------------------------------
// One overlap case: HELD barrier -> SAVE (SAVING ack) -> RELEASE -> RESULT.
// `releaseAfterResult` (case f) holds past the saver's bounded wait instead:
// the holder releases only after the short-timeout saver has already refused.
// ---------------------------------------------------------------------------

interface OverlapCaseOptions {
  payload: { kind: string; missionId?: string; teamId?: string; agentId?: string; title?: string };
  saverTitle?: string;
  shortTimeoutSaver?: boolean;
  releaseAfterResult?: boolean;
}

async function overlapCase(f: Fixture, options: OverlapCaseOptions): Promise<{ result: SaverOutcome; order: string[] }> {
  closeDb(); // fork against a clean lock state; re-open post-race for assertions
  const order: string[] = [];
  const holder = forkWorker("holder", [join(dir, "overlap.sqlite"), f.taskId, f.member], order);
  const saver = forkWorker("saver", [join(dir, "overlap.sqlite"), f.taskId, f.member], order);
  try {
    await Promise.all([holder.ready, saver.ready]);
    holder.child.send({ type: "HOLD" });
    await waitFor(holder.child, "HELD", "holder", order);
    if (options.shortTimeoutSaver) saver.child.send({ type: "SHORT_TIMEOUT" });
    saver.child.send({
      type: "SAVE",
      input: {
        expectedVersion: f.expectedVersion,
        expectedTaskIdentity: f.expectedTaskIdentity,
        title: options.saverTitle ?? "Saver title",
      },
    });
    await waitFor(saver.child, "SAVING", "saver", order);
    if (options.releaseAfterResult) {
      // Hold past the bounded wait: the saver refuses while the reservation is
      // still held, and only then does the holder release.
      const msg = await waitFor(saver.child, "RESULT", "saver", order);
      holder.child.send({ type: "RELEASE", payload: options.payload });
      await waitFor(holder.child, "RELEASED", "holder", order);
      return { result: msg.result!, order };
    }
    holder.child.send({ type: "RELEASE", payload: options.payload });
    await waitFor(holder.child, "RELEASED", "holder", order);
    const msg = await waitFor(saver.child, "RESULT", "saver", order);
    return { result: msg.result!, order };
  } finally {
    for (const w of [holder, saver]) {
      if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------
// Suite lifecycle
// ---------------------------------------------------------------------------

let dir: string;
let app: HttpRuntimeHandle | undefined;
const priorEnv = Object.fromEntries(
  ["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((key) => [key, process.env[key]]),
);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orcy-metadata-overlap-"));
  await initDb(join(dir, "overlap.sqlite"));
}, 120_000);

afterEach(async () => {
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
  try {
    await app?.close();
  } finally {
    app = undefined;
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("human task metadata save — real cross-process write overlap", () => {
  // GROUND: PRD E6/E11 — HELD strictly before SAVING: a held reservation overlapping the launched save (never a READY/GO pair), then the waiting save re-evaluates against committed state and succeeds.
  it("(a) a committed non-Task write under the hold lets the waiting save succeed", async () => {
    const f = setup();
    const { result, order } = await overlapCase(f, {
      payload: { kind: "mission_title", missionId: f.missionId, title: "Renamed under hold" },
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(result).toEqual({ ok: true, changed: true });
    await initDb(join(dir, "overlap.sqlite"));
    const task = taskRow(f.taskId);
    expect(task).toMatchObject({ title: "Saver title", version: f.expectedVersion + 1, status: "pending" });
    const events = updatedEvents(f.taskId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "human", actorId: f.member, fromStatus: "pending", toStatus: "pending" });
    expect(getDb().select().from(missions).where(eq(missions.id, f.missionId)).get()).toMatchObject({ title: "Renamed under hold" });
  });

  // GROUND: PRD E6 — exactly one writer commits on equal baselines: the holder's in-reservation save-equivalent commits; the waiting save refuses VERSION_CONFLICT; exactly one updated event exists.
  it("(b) an in-reservation save-equivalent commits and the waiting save refuses VERSION_CONFLICT", async () => {
    const f = setup();
    const { result, order } = await overlapCase(f, {
      payload: { kind: "raw_save", title: "Holder committed" },
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(result).toEqual({ ok: false, code: "VERSION_CONFLICT", currentVersion: f.expectedVersion + 1 });
    await initDb(join(dir, "overlap.sqlite"));
    const task = taskRow(f.taskId);
    expect(task).toMatchObject({ title: "Holder committed", version: f.expectedVersion + 1 });
    expect(updatedEvents(f.taskId)).toHaveLength(1); // the holder's write — the refused save added none
  });

  // GROUND: PRD E2 — authority is re-read under the reservation: membership revoked (task version untouched) while the save waits → FORBIDDEN, no task write, no event.
  it("(c) membership revoked under the hold → the waiting save is FORBIDDEN", async () => {
    const f = setup();
    const { result, order } = await overlapCase(f, {
      payload: { kind: "membership_revoke", teamId: f.teamId },
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    await initDb(join(dir, "overlap.sqlite"));
    expect(taskRow(f.taskId)).toMatchObject({ title: "Task", version: f.expectedVersion, status: "pending" });
    expect(updatedEvents(f.taskId)).toHaveLength(0);
    expect(memberRepo.getMember(f.teamId, f.member)).toBeNull(); // the revocation really committed
  });

  // GROUND: PRD E3 — eligibility is re-checked under the reservation: a competing claim commits → NOT_EDITABLE, the claim survives, no event from the refused save.
  it("(d) a competing claim under the hold → the waiting save is NOT_EDITABLE", async () => {
    const f = setup();
    const { agent } = agentRepo.createAgent({
      name: `metadata-overlap-${randomUUID()}`,
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
    const { result, order } = await overlapCase(f, {
      payload: { kind: "claim", agentId: agent.id },
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(result).toEqual({ ok: false, code: "NOT_EDITABLE" });
    await initDb(join(dir, "overlap.sqlite"));
    expect(taskRow(f.taskId)).toMatchObject({ assignedAgentId: agent.id, status: "claimed" });
    expect(updatedEvents(f.taskId)).toHaveLength(0);
  });

  // GROUND: PRD E3 — a Mission archived under the hold (verified on the actual postimage row) → the waiting save is NOT_EDITABLE.
  it("(e) the Mission archived under the hold → the waiting save is NOT_EDITABLE", async () => {
    const f = setup();
    const { result, order } = await overlapCase(f, {
      payload: { kind: "mission_archive", missionId: f.missionId },
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(result).toEqual({ ok: false, code: "NOT_EDITABLE" });
    await initDb(join(dir, "overlap.sqlite"));
    expect(getDb().select().from(missions).where(eq(missions.id, f.missionId)).get()).toMatchObject({ isArchived: true });
    expect(taskRow(f.taskId)).toMatchObject({ title: "Task", version: f.expectedVersion });
    expect(updatedEvents(f.taskId)).toHaveLength(0);
  });

  // GROUND: PRD E6 — a bounded busy_timeout (300ms) exhausted while the reservation is still held → CONTENTION, no task write, no event; the holder released only after the refusal.
  it("(f) a short busy_timeout exhausted under a still-held reservation → CONTENTION", async () => {
    const f = setup();
    const { result, order } = await overlapCase(f, {
      payload: { kind: "none" },
      shortTimeoutSaver: true,
      releaseAfterResult: true,
    });
    expect(order.indexOf("HELD")).toBeLessThan(order.indexOf("SAVING"));
    expect(order.indexOf("RESULT")).toBeLessThan(order.indexOf("RELEASED")); // the hold outlasted the bounded wait
    expect(result).toEqual({ ok: false, code: "CONTENTION" });
    await initDb(join(dir, "overlap.sqlite"));
    expect(taskRow(f.taskId)).toMatchObject({ title: "Task", version: f.expectedVersion });
    expect(updatedEvents(f.taskId)).toHaveLength(0);
  });

  // GROUND: PRD E6 — through the real HTTP app the same exhausted wait maps to 503 SERVICE_UNAVAILABLE with no retry: the row and events stay untouched (a retry would have applied the write after release).
  it("(f-http) through the real HTTP app the exhausted wait maps to 503 SERVICE_UNAVAILABLE without retrying", async () => {
    const f = setup();
    process.env.SLACK_SIGNING_SECRET = "metadata-overlap-slack-secret";
    process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.ORCY_REGISTRATION_TOKEN = "metadata-overlap-reg-token";
    delete process.env.HOST;
    app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]);
    await app.finalize();
    const token = jwt.sign({ sub: f.member, username: f.member, role: "editor" }, getJwtSecret(), { issuer: "orcy", expiresIn: "1h" });
    // The app's own connection waits a bounded 300ms (the precedent of
    // findingTriageLifecycleConcurrency.test.ts:250) instead of production's 5s
    // so the held reservation exhausts it deterministically.
    getDb().run(sql`PRAGMA busy_timeout = 300`);

    const order: string[] = [];
    const holder = forkWorker("holder", [join(dir, "overlap.sqlite"), f.taskId, f.member], order);
    try {
      await holder.ready;
      holder.child.send({ type: "HOLD" });
      await waitFor(holder.child, "HELD", "holder", order);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/tasks/${f.taskId}/metadata`,
        headers: { authorization: `Bearer ${token}` },
        payload: { expectedVersion: f.expectedVersion, expectedTaskIdentity: f.expectedTaskIdentity, title: "HTTP title" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("SERVICE_UNAVAILABLE");

      // No retry: the refused request left the row and events untouched.
      expect(taskRow(f.taskId)).toMatchObject({ title: "Task", version: f.expectedVersion });
      expect(updatedEvents(f.taskId)).toHaveLength(0);

      holder.child.send({ type: "RELEASE", payload: { kind: "none" } });
      await waitFor(holder.child, "RELEASED", "holder", order);
    } finally {
      if (holder.child.exitCode === null && !holder.child.killed) holder.child.kill("SIGKILL");
    }
  }, 60_000);
});
