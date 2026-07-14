/**
 * F4 — Lock-holder child process.
 *
 * Forked by f4BusyTimeout.test.ts to produce REAL cross-process write-lock
 * contention. Two synchronous better-sqlite3 connections on one event loop can
 * accidentally produce a serial substitute rather than genuine overlapping lock
 * ownership (the ticket's guardrail), so the lock holder runs as a separate OS
 * process here.
 *
 * Usage: node f4-lock-holder.mjs <dbPath> <holdMs> <mode>
 *   dbPath  — absolute path to the shared SQLite file
 *   holdMs  — milliseconds to hold the write lock before releasing (mode=release)
 *   mode    — "release" (default): BEGIN IMMEDIATE, hold, COMMIT, exit
 *             "stick":           BEGIN IMMEDIATE, hold until killed (parent
 *                                observes SQLITE_BUSY, then terminates this child)
 *
 * IPC: emits { type: "ACQUIRED" } immediately after BEGIN IMMEDIATE succeeds
 * (the write lock is held at that point) and { type: "RELEASED" } after COMMIT
 * when mode=release. The parent awaits ACQUIRED before attempting its own
 * contended write so ordering is deterministic.
 */
import Database from "better-sqlite3";

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? "200");
const mode = process.argv[4] ?? "release";

const send = typeof process.send === "function" ? process.send.bind(process) : null;

const db = new Database(dbPath);
// The holder never waits — it is the lock owner. Immediate contention on the
// parent's side is the point of the test.
db.pragma("busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");

if (send) send({ type: "ACQUIRED" });

await new Promise((resolve) => setTimeout(resolve, holdMs));

if (mode === "release") {
  db.exec("COMMIT");
  if (send) send({ type: "RELEASED" });
} else {
  // "stick": keep the write lock until the parent terminates this process.
  await new Promise(() => {});
}

db.close();
