/** Native WAL process-crash and first-claim races; service authorization is stubbed explicitly. */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { useCompiledApi } from "./compiledApiFixture.js";

const compiled = useCompiledApi();
const workerPath = join(import.meta.dirname, "fixtures", "reserved-occurrence-native-worker.mjs");
// Retain raw barriers/results (including failures) for the owner to archive.
const evidenceRoot = process.env.ORCY_NATIVE_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "orcy-reserved-native-"));
mkdirSync(evidenceRoot, { recursive: true });
let sequence = 0;
interface Proof {
  pid: number; workerId: string; journalMode: string; busyTimeout: number; error?: string;
  phase?: string; inTransaction?: boolean; nativeRowCount?: number; nativeChanges?: number; sql?: string;
  occurrence?: { state: string; lease_owner: string | null }; result: Record<string, unknown>;
}
interface Seed { scheduleId: string; habitatId: string }
interface Occurrence {
  id: string; scheduled_task_id: string; scheduled_for: string; ordinal: number; attempt_id: string;
  state: string; lease_owner: string | null; lease_expires_at: string | null; schedule_revision: string; result: string | null;
}
interface Snapshot {
  occurrence: Occurrence; occurrenceCount: number; attempts: number; coordination: { id: string; state: string }[];
  consumption: { run_count: number; enabled: number; next_run_at: string; last_run_at: string };
  missions: number; tasks: number; handlerCalls: number; handlerPids: number[]; journalMode: unknown;
}
interface Exit { code: number | null; signal: NodeJS.Signals | null; error?: string }
interface ProcessRun {
  child: ChildProcess; output: string; marker: string; release: string; exited: Promise<Exit>; diagnostics: () => string;
}
const children = new Set<ProcessRun>();
function start(directory: string, dbPath: string, action: string, options: Record<string, unknown> = {}): ProcessRun {
  const prefix = join(directory, `${++sequence}-${action}`);
  const output = `${prefix}-result.json`, marker = `${prefix}-barrier.json`, release = `${prefix}-release`;
  const child = spawn(process.execPath, [workerPath, compiled.distDir, dbPath, action,
    JSON.stringify({ ...options, output, marker, release })], {
    env: { ...process.env, JWT_SECRET: "native-recovery-test-secret-0123456789abcdef0123456789abcdef" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_000); });
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_000); });
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => {
      writeFileSync(`${prefix}-stdio.txt`, diagnostics);
      resolve({ code, signal });
    });
  });
  const processRun = { child, output, marker, release, exited, diagnostics: () => diagnostics };
  children.add(processRun);
  return processRun;
}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function finish(run: ProcessRun): Promise<Proof> {
  const exit = await bounded(run.exited, `native child ${run.child.pid}`);
  expect(exit, run.diagnostics()).toEqual({ code: 0, signal: null });
  const proof = JSON.parse(readFileSync(run.output, "utf8")) as Proof;
  expect(proof.error).toBeUndefined();
  expect(proof.pid).not.toBe(process.pid);
  expect(proof.workerId).toContain(`-${proof.pid}-`);
  expect(proof.journalMode).toBe("wal");
  expect(proof.busyTimeout).toBe(5000);
  return proof;
}
async function barrier(run: ProcessRun): Promise<Proof> {
  await bounded((async () => {
    while (!existsSync(run.marker)) {
      if (run.child.exitCode !== null || run.child.signalCode !== null) {
        throw new Error(`Child exited before barrier: ${run.diagnostics()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })(), `native barrier ${run.child.pid}`);
  const proof = JSON.parse(readFileSync(run.marker, "utf8")) as Proof;
  expect(proof.pid).not.toBe(process.pid);
  expect(proof.workerId).toContain(`-${proof.pid}-`);
  expect(proof.journalMode).toBe("wal");
  expect(proof.busyTimeout).toBe(5000);
  expect(proof.inTransaction).toBe(false);
  return proof;
}
afterEach(async () => {
  for (const run of children) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await bounded(run.exited, "cleanup native child", 5000);
  }
  children.clear();
});
async function seed(directory: string, shape: string, scheduleType: string): Promise<{ dbPath: string; seed: Seed }> {
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "native.db");
  const proof = await finish(start(directory, dbPath, "seed", { shape, scheduleType, caseName: `case-${++sequence}` }));
  return { dbPath, seed: proof.result as unknown as Seed };
}
function readState(dbPath: string, seed: Seed): Snapshot {
  // Separate native connection while child processes are paused: this proves
  // committed visibility independently of their return values or in-memory rows.
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    const occurrence = db.prepare("SELECT * FROM scheduled_occurrences WHERE scheduled_task_id = ?").get(seed.scheduleId) as Occurrence;
    const missions = (db.prepare("SELECT count(*) AS n FROM missions WHERE habitat_id = ?").get(seed.habitatId) as { n: number }).n;
    const tasks = (db.prepare("SELECT count(*) AS n FROM tasks t JOIN missions m ON m.id = t.mission_id WHERE m.habitat_id = ?")
      .get(seed.habitatId) as { n: number }).n;
    return {
      occurrence,
      occurrenceCount: (db.prepare("SELECT count(*) AS n FROM scheduled_occurrences WHERE scheduled_task_id = ?").get(seed.scheduleId) as { n: number }).n,
      attempts: occurrence ? (db.prepare("SELECT count(*) AS n FROM task_creation_attempts WHERE source_scope_id = ?").get(occurrence.id) as { n: number }).n : 0,
      coordination: occurrence ? db.prepare("SELECT id, state FROM task_creation_attempts WHERE source_scope_id = ? AND attempt_key = 'occurrence'")
        .all(occurrence.id) as { id: string; state: string }[] : [],
      consumption: db.prepare("SELECT run_count, enabled, next_run_at, last_run_at FROM scheduled_tasks WHERE id = ?").get(seed.scheduleId) as Snapshot["consumption"],
      missions, tasks, journalMode: db.pragma("journal_mode", { simple: true }),
      handlerCalls: (db.prepare("SELECT count(*) AS n FROM fixture_handler_invocations WHERE schedule_id = ?").get(seed.scheduleId) as { n: number }).n,
      handlerPids: (db.prepare("SELECT worker_pid FROM fixture_handler_invocations WHERE schedule_id = ? ORDER BY id").all(seed.scheduleId) as { worker_pid: number }[])
        .map((row) => row.worker_pid),
    };
  } finally { db.close(); }
}
function checkpoint(directory: string, label: string, snapshot: Snapshot): void {
  writeFileSync(join(directory, `${label}-independent-state.json`), JSON.stringify(snapshot, null, 2));
}
function expectSameReservation(before: Snapshot, after: Snapshot): void {
  expect(after.occurrence).toMatchObject({ id: before.occurrence.id, scheduled_task_id: before.occurrence.scheduled_task_id,
    scheduled_for: before.occurrence.scheduled_for, ordinal: before.occurrence.ordinal,
    attempt_id: before.occurrence.attempt_id, schedule_revision: before.occurrence.schedule_revision });
  expect(after.occurrenceCount).toBe(1);
  expect(after.coordination).toHaveLength(1);
  expect(after.consumption).toEqual(before.consumption);
}
function expectPublished(state: Snapshot, shape: string): void {
  expect(state.journalMode).toBe("wal");
  expect(state.occurrence.state).toBe("published");
  expect(state.coordination).toEqual([{ id: state.occurrence.attempt_id, state: "created" }]);
  expect(state.missions).toBe(shape === "handler" ? 0 : 1);
  expect(state.tasks).toBe(shape === "handler" ? 0 : 1);
  expect(state.handlerCalls).toBe(shape === "handler" ? 1 : 0);
  expect(state.attempts).toBe(shape === "handler" ? 1 : 2);
}
const crashCases = [
  { entry: "manual", scheduleType: "once", shape: "inline" },
  { entry: "manual", scheduleType: "interval", shape: "inline" },
  { entry: "poll", scheduleType: "once", shape: "inline" },
  { entry: "poll", scheduleType: "interval", shape: "inline" },
  { entry: "manual", scheduleType: "once", shape: "template" },
  { entry: "manual", scheduleType: "once", shape: "handler" },
];
describe("reserved occurrence native WAL recovery", () => {
  it.each(crashCases)("survives reservation COMMIT SIGKILL: $entry $scheduleType $shape, with a positive control", async ({ entry, scheduleType, shape }) => {
    const directory = mkdtempSync(join(evidenceRoot, `${entry}-${scheduleType}-${shape}-`));
    const setup = await seed(directory, shape, scheduleType);
    const original = start(directory, setup.dbPath, "publish", { scheduleId: setup.seed.scheduleId, entry, barrier: "commit" });
    expect((await barrier(original)).phase).toBe("reservation_COMMIT_returned");
    const reserved = readState(setup.dbPath, setup.seed);
    checkpoint(directory, "reserved-before-kill", reserved);
    expect(reserved.occurrence).toMatchObject({ state: "reserved", lease_owner: null, lease_expires_at: null, ordinal: 0 });
    expect(reserved.coordination).toEqual([{ id: reserved.occurrence.attempt_id, state: "pending" }]);
    expect(reserved.attempts).toBe(1);
    expect(reserved.consumption).toMatchObject({ run_count: 1, enabled: scheduleType === "once" ? 0 : 1 });
    expect([reserved.missions, reserved.tasks, reserved.handlerCalls]).toEqual([0, 0, 0]);
    if (entry === "manual") expect(JSON.parse(reserved.occurrence.schedule_revision)._manualTrigger)
      .toMatchObject({ actorId: "native-manual-actor", scheduledFor: "2000-01-01T00:00:00.000Z" });
    original.child.kill("SIGKILL");
    expect((await bounded(original.exited, "reservation SIGKILL")).signal).toBe("SIGKILL");
    const recoveryProof = await finish(start(directory, setup.dbPath, "recover", { scheduleId: setup.seed.scheduleId }));
    const recovered = readState(setup.dbPath, setup.seed);
    checkpoint(directory, "recovered-after-restart", recovered);
    expectSameReservation(reserved, recovered);
    expectPublished(recovered, shape);
    if (shape === "handler") expect(recovered.handlerPids).toEqual([recoveryProof.pid]);
    const replay = await finish(start(directory, setup.dbPath, "replay", { scheduleId: setup.seed.scheduleId }));
    expect(replay.result).toMatchObject({ replayed: true, occurrenceId: reserved.occurrence.id, occurrenceState: "published" });
    expect(readState(setup.dbPath, setup.seed)).toEqual(recovered);

    const controlDirectory = join(directory, "positive-control");
    const control = await seed(controlDirectory, shape, scheduleType);
    await finish(start(controlDirectory, control.dbPath, "publish", { scheduleId: control.seed.scheduleId, entry }));
    const published = readState(control.dbPath, control.seed);
    checkpoint(controlDirectory, "published-without-kill", published);
    expectPublished(published, shape);
    expect(published.consumption.run_count).toBe(1);
  }, 90_000);

  it.each(["recovery", "original"] as const)("only the %s first-claim winner executes while the other process is paused", async (winner) => {
    const directory = mkdtempSync(join(evidenceRoot, `race-${winner}-`));
    const setup = await seed(directory, "handler", "once");
    const original = start(directory, setup.dbPath, "publish", { scheduleId: setup.seed.scheduleId, entry: "manual", barrier: "commit" });
    await barrier(original);
    const reserved = readState(setup.dbPath, setup.seed);
    const recovery = start(directory, setup.dbPath, "recover", { scheduleId: setup.seed.scheduleId,
      ...(winner === "original" ? { barrier: "scan" } : {}) });
    expect(recovery.child.pid).not.toBe(original.child.pid);
    let originalProof: Proof, recoveryProof: Proof;
    if (winner === "original") {
      const scanned = await barrier(recovery);
      expect(scanned).toMatchObject({ phase: "native_reserved_scan_returned", nativeRowCount: 1, occurrence: { state: "reserved" } });
      expect(scanned.sql).toContain("order by");
      writeFileSync(original.release, "release original after the real recovery SELECT");
      originalProof = await finish(original);
      writeFileSync(recovery.release, "return the real stale rows and attempt the CAS");
      recoveryProof = await finish(recovery);
      expect(recoveryProof.result).toMatchObject({ scanned: 1, terminalized: 0, skipped: 1,
        details: [{ occurrenceId: reserved.occurrence.id, publication: "illegal_source_state" }] });
    } else {
      recoveryProof = await finish(recovery);
      expect(recoveryProof.result).toMatchObject({ scanned: 1, terminalized: 1 });
      writeFileSync(original.release, "release original after recovery completed");
      originalProof = await finish(original);
    }
    const completed = readState(setup.dbPath, setup.seed);
    checkpoint(directory, "race-completed", completed);
    expectSameReservation(reserved, completed);
    expectPublished(completed, "handler");
    expect(recoveryProof.workerId).not.toBe(originalProof.workerId);
    expect(completed.handlerPids).toEqual([winner === "original" ? originalProof.pid : recoveryProof.pid]);
  }, 90_000);

  it.each([false, true])("recovers after SIGKILL immediately after initial claim; persistent guard mismatch=$0", async (mismatch) => {
    const directory = mkdtempSync(join(evidenceRoot, `claim-kill-${mismatch}-`));
    const setup = await seed(directory, "inline", "once");
    const original = start(directory, setup.dbPath, "publish", { scheduleId: setup.seed.scheduleId, entry: "manual", barrier: "commit" });
    await barrier(original);
    const reserved = readState(setup.dbPath, setup.seed);
    original.child.kill("SIGKILL");
    await bounded(original.exited, "original killed before claim");
    if (mismatch) {
      const db = new Database(setup.dbPath);
      try { db.prepare("UPDATE scheduled_tasks SET mission_title = ? WHERE id = ?").run("Actual persistent schedule edit", setup.seed.scheduleId); }
      finally { db.close(); }
    }
    const recovery = start(directory, setup.dbPath, "recover", { scheduleId: setup.seed.scheduleId, barrier: "claim",
      recoveryOptions: { now: "2020-01-01T00:00:00.000Z", leaseDurationMs: 1 } });
    const claimed = await barrier(recovery);
    expect(claimed).toMatchObject({ phase: "native_initial_claim_committed", nativeChanges: 1,
      occurrence: { state: "publishing", lease_owner: claimed.workerId } });
    const afterClaim = readState(setup.dbPath, setup.seed);
    checkpoint(directory, "claimed-before-kill", afterClaim);
    expectSameReservation(reserved, afterClaim);
    expect([afterClaim.missions, afterClaim.tasks]).toEqual([0, 0]);
    recovery.child.kill("SIGKILL");
    expect((await bounded(recovery.exited, "initial claim SIGKILL")).signal).toBe("SIGKILL");
    for (let pass = 1; pass <= (mismatch ? 3 : 1); pass++) {
      const proof = await finish(start(directory, setup.dbPath, "expired", { scheduleId: setup.seed.scheduleId,
        recoveryOptions: { now: `2020-01-01T00:00:0${pass}.000Z`, leaseDurationMs: 1, maxReclaims: 2 } }));
      expect(proof.result).toMatchObject({ scanned: 1, reclaimed: 1 });
      const state = readState(setup.dbPath, setup.seed);
      checkpoint(directory, `expired-restart-pass-${pass}`, state);
      expectSameReservation(reserved, state);
      if (!mismatch) expectPublished(state, "inline");
      else {
        expect(JSON.parse(state.occurrence.result!).reclaimCount).toBe(pass);
        expect(state.occurrence.state).toBe(pass === 3 ? "rejected" : "publishing");
        expect([state.missions, state.tasks]).toEqual([0, 0]);
        if (pass === 3) {
          expect(proof.result).toMatchObject({ exhausted: 1, terminalized: 1 });
          expect(JSON.parse(state.occurrence.result!)).toMatchObject({ reason: "recovery_exhausted", reclaimCount: 3 });
          expect(state.coordination).toEqual([{ id: reserved.occurrence.attempt_id, state: "batch_rejected" }]);
        } else {
          expect(proof.result).toMatchObject({ resumable: 1, details: [{ resume: "schedule_guard_mismatch" }] });
        }
      }
    }
  }, 90_000);
});
