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
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { missions, missionEvents, pulses } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import { withImmediateLifecycleTransaction } from "../services/findingTriageLifecycle.js";

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

  it("writer reservation under a REAL held lock: one BEGIN IMMEDIATE attempt, typed busy, command never entered, no rollback", async () => {
    // Same file-DB + second-connection contention pattern as the
    // agentDeletionFileDb precedent: the PARENT connection (getDb) owns the
    // lifecycle code under test; conn2 holds BEGIN IMMEDIATE so the parent's
    // phase-1 acquisition genuinely collides with a real SQLite write lock.
    // No domain fixture is needed — the wrapper's command callback is never
    // entered, so the test exercises initDb + the lock alone.
    await initDb(dbPath);

    // Bounded wait on the PARENT connection (production uses 5s; the
    // contention is instantaneous — conn2 already holds the write lock when
    // the wrapper's BEGIN IMMEDIATE fires).
    getDb().run(sql`PRAGMA busy_timeout = 250`);

    const conn2 = new (await import("better-sqlite3")).default(dbPath);
    conn2.pragma("busy_timeout = 100");
    try {
      conn2.exec("BEGIN IMMEDIATE"); // REAL externally-held write lock

      // Instrument the SUPPLIED client: capture each statement's SQL text
      // via the connection's own drizzle dialect encoder (no hand-rolled
      // queryChunks parsing) and delegate the real run to the locked DB.
      // The wrapper receives this proxy as its db client, so the count
      // reflects the statements the wrapper actually issued.
      const statements: string[] = [];
      const real = getDb();
      const dialect = (real as unknown as { dialect: { sqlToQuery: (s: unknown) => { sql: string } } }).dialect;
      const proxied = new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "run") {
            const runFn = Reflect.get(target, prop, receiver).bind(target);
            return (stmt: unknown) => {
              statements.push(dialect.sqlToQuery(stmt).sql);
              return runFn(stmt as Parameters<typeof runFn>[0]);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      let fnEntered = false;
      const outcome = withImmediateLifecycleTransaction(
        () => {
          fnEntered = true;
          return { outcome: "applied" as const, value: null };
        },
        proxied as unknown as Parameters<typeof withImmediateLifecycleTransaction>[1],
      );

      // Phase-1 acquisition failure is TYPED busy with a retry hint — never
      // an unclassified SQLITE_BUSY throw, and the command callback was
      // never entered (no phase-2 ran, so nothing to roll back).
      expect(outcome.outcome).toBe("busy");
      expect(typeof (outcome as { retryAfterMs?: number }).retryAfterMs).toBe("number");
      expect(fnEntered).toBe(false);

      // Exactly ONE statement was issued — the BEGIN IMMEDIATE attempt —
      // delegated to the genuinely locked database. No ROLLBACK (or any
      // other statement) may fire after an acquisition failure.
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("BEGIN IMMEDIATE");
      expect(statements.join(" ")).not.toContain("ROLLBACK");
    } finally {
      // Tolerant cleanup: only roll back when the external lock was actually
      // held (the discriminator's no-lock variant never opens a transaction,
      // and a cleanup SqliteError would mask the real assertion failure).
      if (conn2.inTransaction) conn2.exec("ROLLBACK");
      conn2.close();
    }
  });
});
