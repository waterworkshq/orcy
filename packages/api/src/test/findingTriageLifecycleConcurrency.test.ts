/**
 * Finding Triage Lifecycle — REAL cross-process concurrency for `routeFinding`.
 *
 * Two worker processes (`fixtures/lifecycle-route-worker.ts`) each open their
 * OWN better-sqlite3 file connection and call `routeFinding` for the SAME
 * finding with the SAME route intent at the SAME time (IPC barrier: both
 * workers report READY before the parent sends GO back-to-back).
 *
 * The assertion: exactly ONE worker applies; the loser returns a TYPED
 * outcome (`replayed` via the stored route fingerprint, or `conflict`, or
 * `busy` from exhausted contention) — NEVER an unclassified error / raw
 * SQLITE_BUSY 500. Exactly ONE corrective Mission exists afterwards.
 *
 * # Why a child process (not two connections on one event loop)
 *
 * better-sqlite3 is synchronous — two connections on one event loop
 * serialize by construction. That would be a serial substitute, not real
 * overlapping lock ownership (the f4BusyTimeout + t9a11 precedents +
 * MEMORY.md § Migration Plumbing pattern). Two OS processes genuinely race
 * for the file-level write lock.
 *
 * # Why a separate file (not appended to findingTriageLifecycle.test.ts)
 *
 * The main lifecycle tests use `initTestDb()` (sql.js, in-memory). THIS test
 * needs a REAL better-sqlite3 FILE DB shared between the forked workers via
 * SQLite's file-locking protocol. The close/re-init dance would be fragile
 * when sharing a file with the sql.js tests — f4BusyTimeout.test.ts sets
 * the precedent of separating file-DB concurrency tests into their own file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { missions, missionEvents, pulses } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";

const WORKER = join(import.meta.dirname, "fixtures", "lifecycle-route-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-lifecycle");

interface WorkerMessage {
  type: "READY" | "RESULT" | "ERROR";
  outcome?: string;
  reason?: string;
  message?: string;
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

describe("routeFinding — real cross-process concurrency", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("two workers racing the SAME route → exactly ONE applies, loser gets replay/conflict/busy (never an unclassified error)", async () => {
    // ----- PARENT SETUP: open the file DB + seed an open finding ---------
    await initDb(dbPath);

    const habitat = habitatRepo.createHabitat({ name: "Lifecycle Concurrency Habitat" });
    columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });

    const pulse = pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "Raced finding",
      body: "Concurrency test body",
      metadata: { findingKind: "pre_existing_bug" },
    });
    const finding = findingTriageRepo.createForPulse(pulse);
    const findingId = finding.id;

    const missionsBefore = getDb().select().from(missions).all().length;

    // Sanity: pre-race state — finding open, no route.
    expect(finding.status).toBe("open");
    expect(finding.routeFingerprint).toBeNull();

    // Close the PARENT's connection before forking so the workers race
    // against a clean lock state. Re-open post-race for the assertions.
    closeDb();

    // The SAME route intent for both workers (same fingerprint — the loser
    // should REPLAY against the winner's committed fingerprint).
    const routeJson = JSON.stringify({
      bucket: "fix_now",
      missionTitle: "Corrective: raced",
      missionDescription: "Both workers race this exact intent",
    });

    // ----- FORK TWO WORKERS ----------------------------------------------
    const forkWorker = (
      label: string,
    ): {
      child: ChildProcess;
      ready: Promise<void>;
      result: Promise<WorkerMessage>;
    } => {
      const child = fork(WORKER, [dbPath, findingId, routeJson], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      // Surface worker stderr for diagnostics (zero-noise on pass).
      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[lifecycle worker-${label} stderr]:`, chunk.toString());
      });
      const ready = new Promise<void>((resolve, reject) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "READY") {
            child.off("message", onMessage);
            resolve();
          }
        };
        child.on("message", onMessage);
        child.on("exit", (code, signal) => {
          reject(new Error(`worker exited (code=${code}, signal=${signal}) before READY`));
        });
      });
      const result = new Promise<WorkerMessage>((resolve) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "RESULT" || msg?.type === "ERROR") {
            child.off("message", onMessage);
            resolve(msg);
          }
        };
        child.on("message", onMessage);
      });
      return { child, ready, result };
    };

    const w1 = forkWorker("1");
    const w2 = forkWorker("2");

    try {
      // IPC barrier: wait for both workers to be primed (DB open + module
      // loaded), THEN fire both as close to simultaneously as the event loop
      // allows. The workers' deferred-call design minimizes skew — this is
      // the overlap proof: both processes hold open connections and issue
      // BEGIN IMMEDIATE within the same scheduling window, contending for
      // the file-level write lock.
      await Promise.all([w1.ready, w2.ready]);

      w1.child.send({ type: "GO" });
      w2.child.send({ type: "GO" });

      // Collect both results.
      const [r1, r2] = await Promise.all([w1.result, w2.result]);

      // Surface worker errors visibly (only fires on infrastructure throws).
      if (r1.type === "ERROR") console.warn("[lifecycle worker-1 ERROR]:", r1.message);
      if (r2.type === "ERROR") console.warn("[lifecycle worker-2 ERROR]:", r2.message);

      // ----- THE LOAD-BEARING ASSERTION ---------------------------------
      // Neither worker may return an unclassified error — under contention
      // the outcomes are typed (applied | replayed | conflict | busy), and
      // the loser's classification is deterministic against the winner's
      // committed state. A raw SQLITE_BUSY 500 would land in the ERROR
      // branch and fail here.
      expect(r1.type).toBe("RESULT");
      expect(r2.type).toBe("RESULT");

      const outcomes = [r1.outcome!, r2.outcome!];
      const winners = outcomes.filter((o) => o === "applied");
      const losers = outcomes.filter((o) => o === "replayed" || o === "conflict" || o === "busy");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
    } finally {
      // Ensure no lingering workers regardless of assertion outcome.
      for (const w of [w1, w2]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    // ----- PARENT POST-RACE ASSERTIONS: durable DB state -----------------
    await initDb(dbPath);
    const db = getDb();

    // Exactly ONE corrective Mission was created (the loser's Mission
    // creation, had it proceeded past classification, would make this 2 —
    // the BEGIN IMMEDIATE serialization + stored-fingerprint replay
    // jointly defend this).
    const missionsAfter = db.select().from(missions).all();
    expect(missionsAfter.length).toBe(missionsBefore + 1);

    // The finding is routed exactly once: in_progress, one fingerprint, one
    // Mission link, activation attribution recorded.
    const after = findingTriageRepo.getById(findingId);
    expect(after!.status).toBe("in_progress");
    expect(after!.bucket).toBe("fix_now");
    expect(after!.routeFingerprint).not.toBeNull();
    expect(after!.correctiveMissionId).not.toBeNull();
    expect(missionsAfter.some((m) => m.id === after!.correctiveMissionId)).toBe(true);
    expect(after!.activatedAt).not.toBeNull();
    expect(after!.activationCause).toBe("manual");

    // Exactly ONE Mission `created` event (the loser's event, had its
    // transaction not been serialized behind the winner, would double this).
    const events = db
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, after!.correctiveMissionId!))
      .all();
    expect(events.filter((e) => e.action === "created")).toHaveLength(1);
  }, 60_000);
});
