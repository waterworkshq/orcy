/**
 * F4 — Bounded SQLite busy_timeout on production connections.
 *
 * Proves the three acceptance criteria:
 *  1. A production connection created by `initDb()` reports busy_timeout = 5000.
 *  2. A short external write lock held by a SEPARATE PROCESS is tolerated: the
 *     application connection waits (bounded) and its write succeeds on release.
 *  3. Contention that exceeds the configured bound still surfaces SQLITE_BUSY —
 *     the timeout is not swallowed into a silent success or a different error.
 *
 * Why a child process (not two connections in one event loop): better-sqlite3 is
 * synchronous, so a write lock held by connection A on the main thread cannot be
 * released while connection B is mid-write on the same thread — that would be a
 * serial substitute, not real overlapping lock ownership. The lock holder here
 * is a separate OS process (fixtures/f4-lock-holder.mjs) forked via child_process.
 *
 * The R4 final-approval concurrency suite (concurrencyFinalApproval.test.ts)
 * intentionally sets busy_timeout = 0 on its second connection to prove immediate
 * SQLITE_BUSY serialization; F4 does not touch that test or its design.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeDb, initDb, getDb } from "../db/index.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "f4-lock-holder.mjs");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-f4");
const PROD_TIMEOUT_MS = 5000;

interface LockMessage {
  type: "ACQUIRED" | "RELEASED";
}

/** Fork the lock-holder child and resolve once it reports the write lock held. */
function holdLock(
  dbPath: string,
  holdMs: number,
  mode: "release" | "stick",
): { child: ChildProcess; acquired: Promise<void> } {
  const child = fork(FIXTURE, [dbPath, String(holdMs), mode], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const acquired = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: LockMessage) => {
      if (msg?.type === "ACQUIRED") {
        child.off("message", onMessage);
        resolve();
      }
    };
    child.on("message", onMessage);
    child.on("exit", (code, signal) => {
      reject(
        new Error(`lock-holder exited (code=${code}, signal=${signal}) before acquiring the lock`),
      );
    });
  });
  return { child, acquired };
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore — already gone
      }
    }
  }
}

describe("F4 — Bounded SQLite busy_timeout on production connections", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `f4-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  // ------------------------------------------------------------------
  // AC 1 — production connection reports busy_timeout = 5000
  // ------------------------------------------------------------------
  it("configures busy_timeout = 5000 on the production better-sqlite3 connection", async () => {
    await initDb(dbPath);
    const db = getDb();
    const row = db.get(sql`PRAGMA busy_timeout`) as { timeout: number } | undefined;
    expect(row?.timeout).toBe(PROD_TIMEOUT_MS);
  });

  // ------------------------------------------------------------------
  // AC 2 — a transient external write lock is tolerated; the app write waits
  // and succeeds after the holder releases.
  // ------------------------------------------------------------------
  it("waits and succeeds when a separate process holds a brief write lock", async () => {
    await initDb(dbPath);
    const db = getDb();
    // Sanity: this connection has the production bound.
    expect((db.get(sql`PRAGMA busy_timeout`) as { timeout: number }).timeout).toBe(PROD_TIMEOUT_MS);

    const holdMs = 400;
    const { child, acquired } = holdLock(dbPath, holdMs, "release");
    let childExitedCleanly = false;
    child.on("exit", (code) => {
      // mode=release exits 0 after COMMIT.
      childExitedCleanly = code === 0;
    });

    try {
      // Wait until the holder genuinely owns the write lock.
      await acquired;

      const start = Date.now();
      // The application's write contends for the lock. With busy_timeout = 5000
      // and a 400 ms hold, this must block and then succeed on release.
      expect(() => db.run(sql`BEGIN IMMEDIATE`)).not.toThrow();
      const elapsed = Date.now() - start;
      db.run(sql`COMMIT`);

      // It actually waited (well above zero) and stayed within the bound.
      expect(elapsed).toBeGreaterThanOrEqual(holdMs / 2);
      expect(elapsed).toBeLessThan(PROD_TIMEOUT_MS);

      // The holder released cleanly.
      await new Promise<void>((resolve) => {
        if (child.killed || child.exitCode !== null) return resolve();
        child.on("exit", () => resolve());
      });
      expect(childExitedCleanly).toBe(true);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });

  // ------------------------------------------------------------------
  // AC 3 — contention beyond the configured bound surfaces SQLITE_BUSY.
  //
  // The production bound is 5000 ms (pinned by AC 1). Waiting >5 s per test run
  // is impractical, so this case reuses the SAME production connection and
  // overrides busy_timeout to a short value via the standard PRAGMA. This keeps
  // the verification behaviorally real — a genuine cross-process write lock held
  // beyond the configured bound surfaces SQLITE_BUSY rather than being swallowed
  // into a silent success or a different error — while completing in well under
  // a second.
  // ------------------------------------------------------------------
  it("surfaces SQLITE_BUSY (not swallowed) when contention exceeds the bound", async () => {
    await initDb(dbPath);
    const db = getDb();
    expect((db.get(sql`PRAGMA busy_timeout`) as { timeout: number }).timeout).toBe(PROD_TIMEOUT_MS);

    // Shrink the bound for this scenario only.
    const shortBoundMs = 150;
    db.run(sql`PRAGMA busy_timeout = ${sql.raw(String(shortBoundMs))}`);
    expect((db.get(sql`PRAGMA busy_timeout`) as { timeout: number }).timeout).toBe(shortBoundMs);

    const { child, acquired } = holdLock(dbPath, 60_000, "stick");

    try {
      await acquired;

      const start = Date.now();
      // Contention beyond the bound must surface as SQLITE_BUSY / SQLITE_LOCKED.
      let thrown: unknown;
      try {
        db.run(sql`BEGIN IMMEDIATE`);
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - start;

      expect(thrown).toBeDefined();
      // drizzle-orm wraps the better-sqlite3 SqliteError; the real message/code
      // live on `.cause` (the generic wrapper message is "Failed to run ...").
      const cause = (thrown as { cause?: { message?: string; code?: string } }).cause;
      const errText = String(cause?.message ?? (thrown as Error)?.message ?? thrown);
      expect(errText).toMatch(/busy|locked/i);
      if (cause?.code) expect(cause.code).toMatch(/BUSY|LOCKED/);
      // It waited approximately the bound (not immediate, not forever).
      expect(elapsed).toBeGreaterThanOrEqual(shortBoundMs - 60);
      expect(elapsed).toBeLessThan(shortBoundMs + 1500);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });
});
