/**
 * Release epoch reconciliation — REAL cross-process frozen-cap race
 * (restored lifecycle T7).
 *
 * Two worker processes (`fixtures/lifecycle-release-epoch-worker.ts`) each
 * open their OWN better-sqlite3 file connection and reconcile the SAME
 * frozen Release epoch while FORCED to select different (overlapping) group
 * subsets:
 *
 *   - worker A: groups [m1, m3]
 *   - worker B: groups [m2, m3]
 *
 * with a frozen cap of 2 over three size-1 groups. The IPC barrier proves
 * overlap (both workers READY before GO is sent back-to-back). Every group
 * transaction rereads the used capacity (`activation_release_id` count)
 * under `BEGIN IMMEDIATE`, so whichever worker commits second against the
 * shared group must defer against the frozen budget:
 *
 *   - cumulative activated Finding count NEVER exceeds the frozen cap;
 *   - no group is partially activated;
 *   - every group ends with a terminal disposition;
 *   - the final locked pass closes the epoch exactly once.
 *
 * # Mutate/revert discriminator
 * Breaking the under-lock capacity reread (e.g. `countReleaseAttributed
 * FindingsWithClient` returning a stale 0) makes THIS test fail with 3
 * release-attributed findings against the frozen cap of 2.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
  releaseActivationEpochs,
  releaseActivationEpochGroups,
  releaseProjectionDeliveries,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import {
  bootstrapReleaseWithEpoch,
  finalizeActivationEpoch,
} from "../services/releaseReconciliationService.js";

const WORKER = join(import.meta.dirname, "fixtures", "lifecycle-release-epoch-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-lifecycle");

const ACTOR = { type: "human" as const, id: "user-1" };

interface WorkerMessage {
  type: "READY" | "RESULT" | "FINALIZED" | "ERROR";
  outcomes?: Array<{ missionId: string; disposition: string; detail: string | null }>;
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

describe("release epoch — real cross-process frozen-cap race", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(
      TEMP_DIR,
      `release-epoch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("two workers forced onto different overlapping groups never exceed the frozen cap", async () => {
    // ----- PARENT SETUP ---------------------------------------------------
    await initDb(dbPath);

    const habitat = habitatRepo.createHabitat({ name: "Epoch Race Habitat" });
    habitatRepo.updateHabitat(habitat.id, {
      releaseSettings: {
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: 2, // THE FROZEN CAP
      },
    });
    const columnId = columnRepo.createColumn({
      habitatId: habitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    }).id;

    const missionIds: string[] = [];
    for (const title of ["m1", "m2", "m3"]) {
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId,
        title,
        createdBy: "triage-agent",
        releaseGateType: "minor",
      });
      const pulse = pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        scope: "mission",
        fromType: "agent",
        fromId: "agent-1",
        signalType: "finding",
        subject: title,
        body: "",
        metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
      });
      const t = findingTriageRepo.createForPulse(pulse);
      findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
      findingTriageRepo.setTriageMissionId(t.id, mission.id);
      missionIds.push(mission.id);
    }

    // Bootstrap the epoch WITHOUT reconciling (the workers own the race).
    const boot = bootstrapReleaseWithEpoch(habitat.id, "0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });
    if (boot.status !== "created") throw new Error(`unexpected bootstrap status ${boot.status}`);
    const releaseId = boot.release.id;

    const epochRow = getDb()
      .select()
      .from(releaseActivationEpochs)
      .where(eq(releaseActivationEpochs.releaseId, releaseId))
      .get()!;
    expect(epochRow.frozenCap).toBe(2);
    expect(
      getDb()
        .select()
        .from(releaseActivationEpochGroups)
        .where(eq(releaseActivationEpochGroups.epochId, epochRow.id))
        .all(),
    ).toHaveLength(3);

    closeDb();

    // ----- FORK TWO WORKERS, FORCED ONTO DIFFERENT GROUPS -----------------
    const forkWorker = (
      label: string,
      onlyMissionIds: string[],
    ): {
      child: ChildProcess;
      ready: Promise<void>;
      result: Promise<WorkerMessage>;
      finalized: Promise<WorkerMessage>;
    } => {
      const child = fork(WORKER, [dbPath, releaseId, JSON.stringify(onlyMissionIds)], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        console.warn(`[epoch worker-${label} stderr]:`, chunk.toString());
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
      const finalized = new Promise<WorkerMessage>((resolve) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (msg?.type === "FINALIZED" || msg?.type === "ERROR") {
            child.off("message", onMessage);
            resolve(msg);
          }
        };
        child.on("message", onMessage);
      });
      return { child, ready, result, finalized };
    };

    // Different (overlapping) selections: A owns m1, B owns m2, both m3.
    const workerA = forkWorker("a", [missionIds[0]!, missionIds[2]!]);
    const workerB = forkWorker("b", [missionIds[1]!, missionIds[2]!]);

    let resultA: WorkerMessage;
    let resultB: WorkerMessage;
    try {
      // IPC barrier: both primed, then fire as close to simultaneously as
      // the event loop allows.
      await Promise.all([workerA.ready, workerB.ready]);
      workerA.child.send({ type: "GO" });
      workerB.child.send({ type: "GO" });

      [resultA, resultB] = await Promise.all([workerA.result, workerB.result]);
    } finally {
      // Workers wait for FINALIZE after RESULT; only clean up if they never
      // got there.
    }

    expect(resultA.type).toBe("RESULT");
    expect(resultB.type).toBe("RESULT");
    const allOutcomes = [...(resultA.outcomes ?? []), ...(resultB.outcomes ?? [])];
    // The forced subsets prove the workers selected different groups and
    // genuinely contended on the shared one (m3 appears in both subsets).
    expect(resultA.outcomes).toHaveLength(2);
    expect(resultB.outcomes).toHaveLength(2);
    const sharedGroupOutcomes = [
      ...(resultA.outcomes ?? []).filter((o) => o.missionId === missionIds[2]),
      ...(resultB.outcomes ?? []).filter((o) => o.missionId === missionIds[2]),
    ];
    expect(sharedGroupOutcomes).toHaveLength(2);
    // The loser of the shared group converged to a classified outcome
    // (activated by the winner, or deferred_budget / already-classified).
    expect(
      sharedGroupOutcomes.every((o) =>
        ["activated", "deferred_budget", "deferred_changed", "deferred_oversized"].includes(
          o.disposition,
        ),
      ),
    ).toBe(true);
    void allOutcomes;

    // ----- POST-RACE ASSERTIONS (durable state) ---------------------------
    await initDb(dbPath);

    const attributed = getDb()
      .select()
      .from(findingTriageTable)
      .all()
      .filter((f) => f.activationReleaseId === releaseId);

    // THE LOAD-BEARING ASSERTION: the hard cumulative Finding cap held.
    expect(attributed.length).toBeLessThanOrEqual(2);
    // All-or-none groups: every mission's linked finding set is uniformly
    // activated or untouched.
    for (const missionId of missionIds) {
      const linked = findingTriageRepo.findByTriageMissionId(missionId);
      const statuses = new Set(linked.map((f) => f.status));
      expect(statuses.size).toBe(1);
      if (linked[0]!.status === "in_progress") {
        expect(linked.every((f) => f.activationReleaseId === releaseId)).toBe(true);
        expect(linked.every((f) => f.activationCause === "release")).toBe(true);
      } else {
        expect(linked[0]!.status).toBe("triaged");
      }
    }

    // ----- FINAL LOCKED PASS ---------------------------------------------
    closeDb();
    try {
      workerA.child.send({ type: "FINALIZE" });
      workerB.child.send({ type: "FINALIZE" });
      const [finalA, finalB] = await Promise.all([workerA.finalized, workerB.finalized]);
      expect(finalA.type).toBe("FINALIZED");
      expect(finalB.type).toBe("FINALIZED");
    } finally {
      for (const w of [workerA, workerB]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    await initDb(dbPath);

    // Exactly two groups activated against the frozen cap; the third is an
    // explicit budget deferral — never lost, never pending.
    const groups = getDb()
      .select()
      .from(releaseActivationEpochGroups)
      .where(eq(releaseActivationEpochGroups.releaseId, releaseId))
      .all();
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.disposition === "activated")).toHaveLength(2);
    expect(groups.filter((g) => g.disposition === "deferred_budget")).toHaveLength(1);
    expect(groups.every((g) => g.disposition !== "pending")).toBe(true);

    // The epoch closed exactly once and the activation projection completed.
    const epoch = getDb()
      .select()
      .from(releaseActivationEpochs)
      .where(eq(releaseActivationEpochs.releaseId, releaseId))
      .get()!;
    expect(epoch.completedAt).not.toBeNull();
    expect(epoch.frozenCap).toBe(2);
    const activationProjection = getDb()
      .select()
      .from(releaseProjectionDeliveries)
      .where(eq(releaseProjectionDeliveries.releaseId, releaseId))
      .all()
      .find((p) => p.projectionKind === "activation_reconciliation")!;
    expect(activationProjection.state).toBe("completed");

    // Final cumulative check after the final pass: still never over cap.
    expect(
      getDb()
        .select()
        .from(findingTriageTable)
        .all()
        .filter((f) => f.activationReleaseId === releaseId),
    ).toHaveLength(2);

    // Idempotent re-finalization from the parent changes nothing.
    const counts = finalizeActivationEpoch(releaseId);
    expect(counts.activatedFindingCount).toBe(2);
    expect(
      getDb().select().from(releasesTable).where(eq(releasesTable.id, releaseId)).all(),
    ).toHaveLength(1);
    void missions;
  }, 60_000);
});
