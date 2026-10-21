import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { originalOnceEntitlement } from "./fixtures/scheduled-task-entitlement-original.js";
import { createOutsideWorkspaceApiLayout, type CompiledApiLayout } from "./compiledApiLayout.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const SOURCE_DRIZZLE = join(PACKAGE_ROOT, "drizzle");
const WORKER = join(import.meta.dirname, "fixtures", "scheduled-history-upgrade-worker.mjs");
const TAG = "0084_scheduled_occurrence_history";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
interface Input { id: string; runCount: number; label: string }
interface Ledger { id: number; hash: string; created_at: number }
interface Result {
  type: "RESULT"; pid: number; inputs: Input[]; results: (Input & { verdict: string })[];
  backfillExecutions: number; selectedMigrationDir: string; allMigrationReadsOwned: boolean;
  journalMode: string; busyTimeout: number;
}
interface Barrier {
  type: "BACKFILL"; pid: number; inTransaction: boolean; summaryRows: number;
  backfillHash: string; migrationFileHash: string; selectedMigrationDir: string;
  allMigrationReadsOwned: boolean; journalMode: string; busyTimeout: number;
}
interface WorkerError { type: "ERROR"; pid: number; message: string; cause?: string }
interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface Running {
  child: ChildProcess; message: Promise<Result | Barrier | WorkerError>; exit: Promise<Exit>;
  diagnostics: () => string;
}
let ownedRoot = "";
let packageDir = "";
let ownedDrizzle = "";
let ownedLayout: CompiledApiLayout | undefined;
let sourceBefore: Record<string, string> | undefined;
let fullJournal: Buffer;
let journal: { entries: { tag: string; when: number }[]; [key: string]: unknown };
const children = new Set<Running>();
let evidenceSequence = 0;

function evidence(label: string, value: unknown) {
  const directory = process.env.ORCY_NATIVE_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `history-upgrade-parent-${process.pid}-${String(++evidenceSequence).padStart(3, "0")}-${label}.json`),
    `${JSON.stringify(value, null, 2)}\n`);
}

function sourceBinding() {
  const bytes = readFileSync(join(SOURCE_DRIZZLE, "meta", "_journal.json"));
  const entries = JSON.parse(bytes.toString()).entries as { tag: string }[];
  return Object.fromEntries([["meta/_journal.json", sha(bytes)], ...entries.map(({ tag }) => [tag, sha(readFileSync(join(SOURCE_DRIZZLE, `${tag}.sql`)))])]);
}
function start(file: string, mode: string, inputs: Input[] = []): Running {
  const child = spawn(process.execPath, [WORKER, packageDir, file, mode, JSON.stringify(inputs)], {
    cwd: packageDir, stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048", JWT_SECRET: randomBytes(32).toString("hex") },
  });
  let stdout = "", stderr = "", buffer = "", received = false;
  const diagnostics = () => `pid=${child.pid} stdout=${stdout} stderr=${stderr}`;
  child.stdout!.on("data", (chunk) => { stdout = (stdout + chunk).slice(-16_384); });
  child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
  let rejectMessage: (error: Error) => void = () => {};
  const message = new Promise<Result | Barrier | WorkerError>((accept, reject) => {
    rejectMessage = reject;
    (child.stdio[3] as Readable).on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 65_536) { reject(new Error(`oversized worker protocol: ${diagnostics()}`)); child.kill("SIGKILL"); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0 || received) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        evidence(`worker-${child.pid}-${mode}-message`, message);
        received = true; accept(message);
      }
      catch (error) { reject(error); child.kill("SIGKILL"); }
    });
  });
  // A failing fixture can finish before its caller awaits the message.
  void message.catch(() => {});
  const deadline = setTimeout(() => {
    rejectMessage(new Error(`worker deadline exceeded: ${diagnostics()}`));
    child.kill("SIGKILL");
  }, 20_000);
  const exit = new Promise<Exit>((accept) => {
    child.once("error", (error) => rejectMessage(error));
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (!received) rejectMessage(new Error(`worker exited before protocol message: ${diagnostics()}`));
      accept({ code, signal });
    });
  });
  const running = { child, message, exit, diagnostics };
  children.add(running);
  return running;
}
async function run(file: string, mode: string, inputs: Input[] = []) {
  const worker = start(file, mode, inputs);
  const [message, exit] = await Promise.all([worker.message, worker.exit]);
  evidence(`worker-${worker.child.pid}-${mode}-exit`, { message, exit, diagnostics: worker.diagnostics() });
  if (message.type !== "RESULT") throw new Error(`${JSON.stringify(message)} ${worker.diagnostics()}`);
  expect(exit, `${JSON.stringify(message)} ${worker.diagnostics()}`).toEqual({ code: 0, signal: null });
  expect(message.pid).toBe(worker.child.pid);
  expect(message.pid).not.toBe(process.pid);
  expect(message.selectedMigrationDir).toBe(realpathSync(ownedDrizzle));
  expect(message.allMigrationReadsOwned).toBe(true);
  expect(message.journalMode).toBe("wal");
  expect(message.busyTimeout).toBe(5000);
  return message;
}
function open(file: string) {
  const reader = new Database(file, { readonly: true });
  reader.pragma("busy_timeout = 5000");
  expect(reader.pragma("journal_mode", { simple: true })).toBe("wal");
  return reader;
}
function snapshot(reader: Database.Database, inputs: Input[]) {
  const db = drizzle(reader, { schema });
  return {
    occurrences: reader.prepare("SELECT * FROM scheduled_occurrences ORDER BY id").all(),
    schedules: reader.prepare("SELECT * FROM scheduled_tasks ORDER BY id").all(),
    ledger: reader.prepare("SELECT * FROM __drizzle_migrations ORDER BY id").all() as Ledger[],
    oracle: inputs.map((input) => ({ ...input, verdict: originalOnceEntitlement(db, input) })),
  };
}
function readSnapshot(file: string, inputs: Input[]) {
  const reader = open(file);
  try { return snapshot(reader, inputs); } finally { reader.close(); }
}
function newObjects(reader: Database.Database) {
  return reader.prepare(`SELECT name FROM sqlite_master WHERE name = 'scheduled_occurrence_history'
    OR name = 'idx_scheduled_occurrences_schedule_ordinal'
    OR (type = 'trigger' AND name LIKE 'scheduled_occurrence_history_%') ORDER BY name`).all();
}
function expectedLedger(entries: { tag: string; when: number }[]) {
  return entries.map(({ tag, when }) => ({ hash: sha(readFileSync(join(ownedDrizzle, `${tag}.sql`))), created_at: when }));
}
async function legacy(file: string) {
  const cutover = journal.entries.findIndex(({ tag }) => tag === TAG);
  expect(cutover).toBeGreaterThan(0);
  const entries = journal.entries.slice(0, cutover);
  writeFileSync(join(ownedDrizzle, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  let result: Result;
  try { result = await run(file, "legacy"); }
  finally { writeFileSync(join(ownedDrizzle, "meta", "_journal.json"), fullJournal); }
  expect(result!.backfillExecutions).toBe(0);
  const before = readSnapshot(file, result!.inputs);
  evidence(`legacy-${basename(file)}`, { inputs: result!.inputs, snapshot: before });
  expect(before.ledger.map(({ hash, created_at }) => ({ hash, created_at }))).toEqual(expectedLedger(entries));
  expect(Object.fromEntries(before.oracle.map(({ label, verdict }) => [label, verdict]))).toEqual({
    complete: "unconsumed", duplicates: "unknown", gap: "unknown", consumed: "consumed", unknown: "unknown",
    odd: "unconsumed", empty: "unconsumed", "missing-count": "unknown", orphan: "consumed",
  });
  const reader = open(file);
  try {
    expect(newObjects(reader)).toEqual([]);
    expect(reader.prepare("SELECT id FROM scheduled_tasks WHERE id='retained-orphan-history'").get()).toBeUndefined();
  } finally { reader.close(); }
  return { inputs: result!.inputs, before };
}
function assertUpgraded(file: string, inputs: Input[], before: ReturnType<typeof readSnapshot>) {
  const reader = open(file);
  try {
    const after = snapshot(reader, inputs);
    evidence(`upgraded-${basename(file)}`, after);
    expect(after.occurrences).toEqual(before.occurrences);
    expect(after.schedules).toEqual(before.schedules);
    expect(after.oracle).toEqual(before.oracle);
    expect(after.ledger.slice(0, before.ledger.length)).toEqual(before.ledger);
    expect(after.ledger.map(({ hash, created_at }) => ({ hash, created_at }))).toEqual(expectedLedger(journal.entries));
    const aggregates = reader.prepare(`SELECT scheduled_task_id, count(*) AS total_count,
      count(*) - count(DISTINCT ordinal) AS duplicate_ordinal_rows,
      coalesce(sum(CASE WHEN json_valid(schedule_revision) THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType')='once' THEN 1 ELSE 0 END ELSE 0 END),0) AS once_count,
      coalesce(sum(CASE WHEN json_valid(schedule_revision) THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType') IN ('once','interval','cron') THEN 0 ELSE 1 END ELSE 1 END),0) AS unknown_count,
      1 AS trusted FROM scheduled_occurrences GROUP BY scheduled_task_id ORDER BY scheduled_task_id`).all();
    expect(reader.prepare("SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id").all()).toEqual(aggregates);
    expect(newObjects(reader).map((row) => (row as { name: string }).name)).toEqual([
      "idx_scheduled_occurrences_schedule_ordinal", "scheduled_occurrence_history",
      "scheduled_occurrence_history_conflict_insert", "scheduled_occurrence_history_conflict_update",
      "scheduled_occurrence_history_delete", "scheduled_occurrence_history_insert", "scheduled_occurrence_history_update",
    ]);
    return after;
  } finally { reader.close(); }
}
function checkpointOwnedFixture(file: string, inputs: Input[], expected: ReturnType<typeof readSnapshot>) {
  // A closed readonly WAL reader can leave empty WAL/SHM sidecars. Finish the
  // owned fixture with a read/write checkpoint after every reader has closed.
  const writer = new Database(file);
  writer.pragma("busy_timeout = 5000");
  const receipt: Record<string, unknown> = { pid: process.pid, file };
  try {
    const before = snapshot(writer, inputs);
    const historyBefore = writer.prepare("SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id").all();
    receipt.before = before; receipt.historyBefore = historyBefore;
    expect(before).toEqual(expected);
    const checkpoint = writer.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
    receipt.checkpoint = checkpoint;
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].busy).toBe(0);
    const after = snapshot(writer, inputs);
    const historyAfter = writer.prepare("SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id").all();
    receipt.after = after; receipt.historyAfter = historyAfter;
    expect(after).toEqual(before);
    expect(historyAfter).toEqual(historyBefore);
  } finally {
    writer.close();
    receipt.closed = true;
    receipt.sidecarsAfterClose = { wal: existsSync(`${file}-wal`), shm: existsSync(`${file}-shm`) };
    evidence(`checkpoint-cleanup-${basename(file)}`, receipt);
  }
}

beforeAll(() => {
  sourceBefore = sourceBinding();
  fullJournal = readFileSync(join(SOURCE_DRIZZLE, "meta", "_journal.json"));
  journal = JSON.parse(fullJournal.toString());
  ownedRoot = mkdtempSync(join(tmpdir(), "orcy-history-upgrade-"));
  const child = relative(WORKSPACE_ROOT, ownedRoot);
  expect(child === ".." || child.startsWith("../") || isAbsolute(child), "compiled package must be outside workspace lookup").toBe(true);
  if (process.env.ORCY_NATIVE_EVIDENCE_DIR) {
    const evidenceChild = relative(ownedRoot, resolve(process.env.ORCY_NATIVE_EVIDENCE_DIR));
    expect(evidenceChild === ".." || evidenceChild.startsWith("../") || isAbsolute(evidenceChild),
      "native evidence must survive owned fixture cleanup").toBe(true);
  }
  evidence("source-before", { source: sourceBefore, ownedRoot, journal });
  // The run's shared compiled artifact is copied into an owned package outside
  // the workspace: a workspace build would select the source migrations, this
  // dedicated layout selects the owned package branch.
  ownedLayout = createOutsideWorkspaceApiLayout({ root: ownedRoot });
  packageDir = ownedLayout.packageDir;
  ownedDrizzle = ownedLayout.drizzleDir;
  expect(lstatSync(ownedDrizzle).isSymbolicLink()).toBe(false);
});
afterAll(async () => {
  try {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    }
    await Promise.all([...children].map(({ exit }) => exit));
    if (sourceBefore) {
      const sourceAfter = sourceBinding();
      evidence("source-after", { source: sourceAfter, ownedRoot });
      expect(sourceAfter, "source migrations must never be mutated through fixture links").toEqual(sourceBefore);
    }
  } finally {
    ownedLayout?.cleanup();
    if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  }
});

describe.sequential("compiled production scheduled-history migration", () => {
  it("upgrades actual legacy history without rewriting evidence and reopens idempotently", async () => {
    const file = join(ownedRoot, "upgrade.db");
    const { inputs, before } = await legacy(file);
    const upgraded = await run(file, "upgrade", inputs);
    expect(upgraded.backfillExecutions).toBe(1);
    expect(upgraded.results).toEqual(before.oracle);
    const after = assertUpgraded(file, inputs, before);
    const reopened = await run(file, "upgrade", inputs);
    expect(reopened.pid).not.toBe(upgraded.pid);
    expect(reopened.backfillExecutions).toBe(0);
    expect(reopened.results).toEqual(before.oracle);
    expect(assertUpgraded(file, inputs, before)).toEqual(after);
    checkpointOwnedFixture(file, inputs, after);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
  });

  it("rolls back an executed backfill after writer death and cleanly restarts the production upgrade", async () => {
    const file = join(ownedRoot, "interrupted.db");
    const { inputs, before } = await legacy(file);
    const reader = open(file);
    let readerOpen = true;
    const writer = start(file, "pause", inputs);
    try {
      reader.exec("BEGIN");
      expect(snapshot(reader, inputs)).toEqual(before);
      const barrier = await writer.message;
      if (barrier.type !== "BACKFILL") throw new Error(`${JSON.stringify(barrier)} ${writer.diagnostics()}`);
      expect(barrier.pid).toBe(writer.child.pid);
      expect(barrier.pid).not.toBe(process.pid);
      expect(barrier.inTransaction).toBe(true);
      expect(barrier.summaryRows).toBeGreaterThan(0);
      expect(barrier.selectedMigrationDir).toBe(realpathSync(ownedDrizzle));
      expect(barrier.allMigrationReadsOwned).toBe(true);
      expect(barrier.journalMode).toBe("wal");
      expect(barrier.busyTimeout).toBe(5000);
      const migration = readFileSync(join(ownedDrizzle, `${TAG}.sql`), "utf8");
      const backfill = migration.split("--> statement-breakpoint").map((text) => text.trim())
        .find((text) => text.includes("count(DISTINCT ordinal)") && text.includes("GROUP BY scheduled_task_id"))!;
      expect(barrier.backfillHash).toBe(sha(backfill));
      expect(barrier.migrationFileHash).toBe(sha(migration));
      expect(newObjects(reader)).toEqual([]);
      expect(snapshot(reader, inputs)).toEqual(before);
      evidence("reader-while-backfill-held", { readerPid: process.pid, barrier,
        objects: newObjects(reader), snapshot: snapshot(reader, inputs) });
      expect(writer.child.kill("SIGKILL")).toBe(true);
      const killed = await writer.exit;
      evidence("writer-killed", { barrier, exit: killed, diagnostics: writer.diagnostics() });
      expect(killed, writer.diagnostics()).toEqual({ code: null, signal: "SIGKILL" });
      reader.exec("ROLLBACK"); reader.close(); readerOpen = false;
      // A fresh connection cannot hide failed rollback behind an older snapshot.
      const rolledBack = readSnapshot(file, inputs);
      evidence("fresh-reader-after-writer-death", rolledBack);
      expect(rolledBack).toEqual(before);
      const fresh = open(file);
      try { expect(newObjects(fresh)).toEqual([]); } finally { fresh.close(); }
      const restarted = await run(file, "upgrade", inputs);
      expect(restarted.pid).not.toBe(barrier.pid);
      expect(restarted.backfillExecutions).toBe(1);
      expect(restarted.results).toEqual(before.oracle);
      const after = assertUpgraded(file, inputs, before);
      checkpointOwnedFixture(file, inputs, after);
      expect(existsSync(`${file}-wal`)).toBe(false);
      expect(existsSync(`${file}-shm`)).toBe(false);
    } finally {
      if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill("SIGKILL");
      await writer.exit;
      if (readerOpen) reader.close();
    }
  });
});
