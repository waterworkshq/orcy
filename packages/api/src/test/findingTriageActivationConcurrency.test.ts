/**
 * Finding Triage Lifecycle — REAL cross-process manual-vs-Release activation
 * race (restored lifecycle T5).
 *
 * Two worker processes (`fixtures/lifecycle-activate-worker.ts`) each open
 * their OWN better-sqlite3 file connection and race the SAME `triaged`
 * finding on the SAME gated corrective Mission at the SAME time (IPC barrier:
 * both workers report READY before the parent sends GO back-to-back):
 *
 *   - worker A: MANUAL activation (human actor + expected Mission version)
 *   - worker B: the INTERNAL Release-mode entry (Release identity + gate proof)
 *
 * The assertion: exactly ONE worker applies; the loser converges to a TYPED
 * outcome (replayed/conflict/busy) — never an unclassified error or a raw
 * SQLITE_BUSY 500. The final durable state is ONE complete group attribution:
 *
 *   - manual win  → gate CLEARED, every row attributed `manual`
 *   - release win → gate RETAINED (no cleared historical gate), every row
 *                   attributed `release` with the Release id
 *
 * and exactly ONE Mission `updated` activation event exists either way.
 *
 * # Why a child process
 *
 * better-sqlite3 is synchronous — two connections on one event loop serialize
 * by construction. Two OS processes genuinely contend for the file-level
 * write lock (lifecycle-route-worker precedent).
 *
 * # Why a separate file
 *
 * The kernel tests use `initTestDb()` (sql.js, in-memory). THIS test needs a
 * REAL better-sqlite3 FILE DB shared between the forked workers (the
 * findingTriageLifecycleConcurrency precedent).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { missionEvents } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as missionRepo from "../repositories/mission.js";
import {
  TEST_ONLY_SKIP_IN_TX_AUTHORITY,
 routeFinding } from "../services/findingTriageLifecycle.js";

const WORKER = join(import.meta.dirname, "fixtures", "lifecycle-activate-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-lifecycle");

const GATE = { releaseGateType: "patch" as const, releaseGateVersion: "9.9.9" };
const RELEASE_ID = "release-race-1";

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

describe("activation — real cross-process manual vs Release race", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `activation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("manual and Release workers racing the SAME gated Mission → ONE applies, loser converges typed; no cleared gate on a Release win", async () => {
    // ----- PARENT SETUP ---------------------------------------------------
    await initDb(dbPath);

    const habitat = habitatRepo.createHabitat({ name: "Activation Race Habitat" });
    columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });

    const pulse = pulseRepo.createPulse({
      habitatId: habitat.id,
      scope: "habitat",
      fromType: "human",
      fromId: "user-1",
      signalType: "finding",
      subject: "Raced deferred finding",
      body: "Race body",
      metadata: { findingKind: "pre_existing_bug" },
    });
    const seeded = findingTriageRepo.createForPulse(pulse);
    const routed = routeFinding({
      findingId: seeded.id,
      actor: { type: "human", id: "user-1", authority: TEST_ONLY_SKIP_IN_TX_AUTHORITY },
      route: {
        bucket: "defer_to_patch",
        missionTitle: "Corrective: raced",
        missionDescription: "Raced corrective work",
        ...GATE,
      },
    });
    if (routed.outcome !== "applied") throw new Error("seed routeFinding failed");
    const findingId = routed.value.id;
    const missionId = routed.value.correctiveMissionId!;
    const missionVersion = missionRepo.getMissionById(missionId)!.version;

    // Sanity: gated, triaged, not yet activated.
    expect(routed.value.status).toBe("triaged");
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");

    closeDb();

    const manualMode = JSON.stringify({
      kind: "manual",
      expectedMissionVersion: missionVersion,
    });
    const releaseMode = JSON.stringify({
      kind: "release",
      releaseId: RELEASE_ID,
      ...GATE,
    });

    // ----- FORK TWO WORKERS ----------------------------------------------
    const forkWorker = (
      label: string,
      modeJson: string,
    ): {
      child: ChildProcess;
      ready: Promise<void>;
      result: Promise<WorkerMessage>;
    } => {
      const child = fork(WORKER, [dbPath, findingId, modeJson], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[activation worker-${label} stderr]:`, chunk.toString());
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

    const manual = forkWorker("manual", manualMode);
    const release = forkWorker("release", releaseMode);

    let manualResult: WorkerMessage;
    let releaseResult: WorkerMessage;
    try {
      // IPC barrier: both primed, then fire as close to simultaneously as
      // the event loop allows.
      await Promise.all([manual.ready, release.ready]);
      manual.child.send({ type: "GO" });
      release.child.send({ type: "GO" });

      [manualResult, releaseResult] = await Promise.all([manual.result, release.result]);
    } finally {
      for (const w of [manual, release]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    if (manualResult.type === "ERROR") console.warn("[activation manual ERROR]:", manualResult.message);
    if (releaseResult.type === "ERROR") console.warn("[activation release ERROR]:", releaseResult.message);

    // ----- THE LOAD-BEARING ASSERTION -------------------------------------
    // Neither worker may return an unclassified error. Under contention the
    // outcomes are typed: the winner `applied`, the loser converged
    // (replayed against the winner's committed group, a typed conflict, or
    // busy from exhausted contention).
    expect(manualResult.type).toBe("RESULT");
    expect(releaseResult.type).toBe("RESULT");

    const outcomes = [manualResult.outcome!, releaseResult.outcome!];
    const winners = outcomes.filter((o) => o === "applied");
    const losers = outcomes.filter((o) => o === "replayed" || o === "conflict" || o === "busy");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // ----- PARENT POST-RACE: durable DB state -----------------------------
    await initDb(dbPath);

    const finding = findingTriageRepo.getById(findingId)!;
    const mission = missionRepo.getMissionById(missionId)!;

    // ONE complete group attribution: the group is activated exactly once.
    expect(finding.status).toBe("in_progress");
    expect(finding.activatedAt).not.toBeNull();

    if (manualResult.outcome === "applied") {
      // Manual win: gate cleared, manual attribution, NO Release charge.
      expect(finding.activationCause).toBe("manual");
      expect(finding.activationReleaseId).toBeNull();
      expect(mission.releaseGateType).toBeNull();
      expect(mission.releaseGateVersion).toBeNull();
    } else {
      // Release win: gate RETAINED (no cleared historical gate), Release
      // attribution on every row.
      expect(finding.activationCause).toBe("release");
      expect(finding.activationReleaseId).toBe(RELEASE_ID);
      expect(mission.releaseGateType).toBe("patch");
      expect(mission.releaseGateVersion).toBe("9.9.9");
    }

    // Version CASed exactly once across both racers.
    expect(mission.version).toBe(missionVersion + 1);

    // Exactly ONE Mission `updated` activation event.
    const activationEvents = getDb()
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, missionId))
      .all()
      .filter((e) => e.action === "updated");
    expect(activationEvents).toHaveLength(1);
  }, 60_000);
});
