/**
 * Structured-occurrence publication — REAL cross-process contention.
 *
 * Two worker processes (`fixtures/occurrence-worker.ts`) each open their OWN
 * better-sqlite3 file connection (via `initDb`, so the `getDb()` singleton
 * inside the preparation/freezes path is process-local) and contend on the
 * SAME structured occurrence with an IPC barrier.
 *
 * Test 1 (staged protocol): both workers run the insert-or-read winner
 * protocol simultaneously (OCCUR at the barrier). Exactly ONE wins; the loser
 * then publishes FIRST — and must publish the WINNER's frozen bytes (mission
 * id, task ids), never its locally rendered ones. The winner's subsequent
 * intake replays the committed attempt.
 *
 * Test 2 (simultaneous race): both workers run the FULL intake at the same
 * barrier. Exactly one aggregate (Mission + junction + Finding) survives;
 * the loser is a typed outcome or a clean race rollback — never a partial
 * or duplicated publication.
 *
 * # Why a child process (not two connections on one event loop)
 *
 * better-sqlite3 is synchronous — two connections on one event loop serialize
 * by construction. Two OS processes genuinely race for the file-level write
 * lock (the f4BusyTimeout / t9a11 / lifecycle-route precedents).
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
  tasks,
  triageClusterMissions,
  taskCreationAttempts,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as occurrencesRepo from "../repositories/triagePublicationOccurrences.js";
import { normalize } from "../services/habitatSkillService.js";

const WORKER = join(import.meta.dirname, "fixtures", "occurrence-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-lifecycle");

interface WorkerMessage {
  type: "LOADED" | "READY" | "OCCURRED" | "RESULT" | "ERROR";
  outcome?: string;
  fresh?: boolean;
  occurrenceId?: string;
  localMissionId?: string | null;
  frozenMissionId?: string;
  missionId?: string;
  investigationTaskId?: string;
  attemptId?: string;
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

describe("structured occurrence — real cross-process contention", () => {
  let dbPath: string;
  let habitatId: string;
  let clusterKey: string;
  let inputJson: string;

  beforeEach(async () => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `occurrence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();

    await initDb(dbPath);
    const db = getDb();
    db.delete(pulses).run();

    const habitat = habitatRepo.createHabitat({ name: "Occurrence Contention Habitat" });
    habitatId = habitat.id;
    columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });

    clusterKey = normalize("contended deploy");
    const pulseInputs = [1, 2, 3].map((i) =>
      pulseRepo.createPulse({
        habitatId,
        scope: "habitat",
        fromType: "agent",
        fromId: "agent-1",
        signalType: "finding",
        subject: "contended deploy",
        body: `body ${i}`,
        metadata: { findingKind: "bug" },
      }),
    );

    inputJson = JSON.stringify({
      habitatId,
      clusterKey,
      pulses: pulseInputs.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        findingKind: "bug",
      })),
      payload: {
        clusterKey,
        skillCategory: "finding",
        provenanceBreakdown: { finding: 3 },
        signalCount: 3,
        affectedTaskIds: [],
        affectedMissionIds: [],
        agentIds: ["agent-1"],
        crossMissionCount: 0,
        distinctAgentCount: 1,
        timeWindowDays: 7,
        firstSeenAt: pulseInputs[0].createdAt,
        lastSeenAt: pulseInputs[0].createdAt,
      },
    });

    // Close the PARENT's connection before forking so the workers race
    // against a clean lock state.
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  function forkWorker(): {
    child: ChildProcess;
    loaded: Promise<void>;
    ready: Promise<void>;
    occurred: Promise<WorkerMessage>;
    result: Promise<WorkerMessage>;
  } {
    const child = fork(WORKER, [dbPath, inputJson], {
      execArgv: ["--import", "tsx"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      console.warn("[occurrence worker stderr]:", chunk.toString());
    });
    const once = (
      types: WorkerMessage["type"][],
      fail: (err: Error) => void = () => {},
    ): Promise<WorkerMessage> =>
      new Promise((resolve) => {
        const onMessage = (msg: WorkerMessage): void => {
          if (types.includes(msg?.type)) {
            child.off("message", onMessage);
            resolve(msg);
          }
        };
        child.on("message", onMessage);
        child.on("exit", (code, signal) => {
          fail(new Error(`worker exited (code=${code}, signal=${signal}) early`));
        });
      });
    return {
      child,
      loaded: once(["LOADED"]).then(() => undefined),
      ready: once(["READY"]).then(() => undefined),
      occurred: once(["OCCURRED", "ERROR"]),
      result: once(["RESULT", "ERROR"]),
    };
  }

  async function initStaggered(
    w1: ReturnType<typeof forkWorker>,
    w2: ReturnType<typeof forkWorker>,
  ): Promise<void> {
    await Promise.all([w1.loaded, w2.loaded]);
    w1.child.send({ type: "INIT" });
    await w1.ready;
    w2.child.send({ type: "INIT" });
    await w2.ready;
  }

  it("two workers contend on the SAME occurrence: the loser publishes the WINNER's bytes and Task keys", async () => {
    const w1 = forkWorker();
    const w2 = forkWorker();
    try {
      await initStaggered(w1, w2);

      // ---- THE RACE: both workers run the insert-or-read winner protocol --
      w1.child.send({ type: "OCCUR" });
      w2.child.send({ type: "OCCUR" });
      const [o1, o2] = await Promise.all([w1.occurred, w2.occurred]);

      expect(o1.type).toBe("OCCURRED");
      expect(o2.type).toBe("OCCURRED");
      // Exactly ONE winner of the insert-or-read; both derived the SAME id.
      const freshCount = [o1.fresh, o2.fresh].filter(Boolean).length;
      expect(freshCount).toBe(1);
      expect(o1.occurrenceId).toBe(o2.occurrenceId);

      const winner = o1.fresh ? { w: w1, o: o1 } : { w: w2, o: o2 };
      const loser = o1.fresh ? { w: w2, o: o2 } : { w: w1, o: o1 };
      // The loser adopted the winner's row. When it raced the insert it
      // reports its discarded local Mission id (necessarily distinct); when
      // it arrived after the winner committed, the replay FAST PATH means it
      // never rendered locally at all (localMissionId null) — both prove the
      // local render is not the publication source.
      expect(
        loser.o.localMissionId === null || loser.o.localMissionId !== loser.o.frozenMissionId,
      ).toBe(true);

      // ---- The LOSER publishes FIRST — with the winner's frozen bytes -----
      loser.w.child.send({ type: "PUBLISH" });
      const loserResult = await loser.w.result;
      expect(loserResult.type).toBe("RESULT");
      expect(loserResult.outcome).toBe("published");
      // THE load-bearing assertion: the committed Mission is the WINNER's
      // frozen Mission, never the loser's locally rendered one.
      expect(loserResult.missionId).toBe(winner.o.frozenMissionId);
      expect(loserResult.missionId).not.toBe(loser.o.localMissionId);

      // ---- The winner's later intake is a classified no-op ----------------
      // The loser's publication committed the admission, so the identity is
      // now ACTIVE: the winner's intake suppresses (all_active_lifecycles,
      // zero unseen evidence) — never a second investigation. The
      // attempt-level replay branch of the same intake is exercised under real
      // overlap by the simultaneous-race test below.
      const winnerResultPromise = winner.w.result;
      winner.w.child.send({ type: "PUBLISH" });
      const winnerResult = await winnerResultPromise;
      expect(winnerResult.type).toBe("RESULT");
      expect(winnerResult.outcome).toBe("suppressed");
    } finally {
      for (const w of [w1, w2]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    // ---- DURABLE STATE: exactly one frozen row + one aggregate ------------
    await initDb(dbPath);
    const db = getDb();

    const occurrenceRows = occurrencesRepo.listByCluster(habitatId, clusterKey);
    expect(occurrenceRows).toHaveLength(1);
    const occurrence = occurrenceRows[0];

    const missionRows = db
      .select()
      .from(missions)
      .where(eq(missions.habitatId, habitatId))
      .all();
    expect(missionRows).toHaveLength(1);
    // The committed Mission IS the frozen aggregate's Mission — verbatim.
    const frozen = JSON.parse(occurrence.preparedAggregate) as {
      mission: { missionId: string };
      tasks: Array<{ templateKey: string; proposal: { prospectiveTaskId: string } }>;
    };
    expect(missionRows[0].id).toBe(frozen.mission.missionId);

    // The committed investigate Task is the FROZEN task id (Task keys from
    // the winner's snapshot, not the loser's local ones).
    const taskRows = db.select().from(tasks).all();
    expect(taskRows).toHaveLength(1);
    const investigate = frozen.tasks.find((t) => t.templateKey === "investigate")!;
    expect(taskRows[0].id).toBe(investigate.proposal.prospectiveTaskId);

    expect(
      db
        .select()
        .from(triageClusterMissions)
        .where(eq(triageClusterMissions.clusterKey, clusterKey))
        .all(),
    ).toHaveLength(1);

    const findingRows = findingTriageRepo.findByHabitatInStatus(habitatId, ["open"]);
    expect(findingRows).toHaveLength(1);
    expect(findingRows[0].admittedByTriageMissionId).toBe(missionRows[0].id);
    expect(findingRows[0].admittedByInvestigationTaskId).toBe(taskRows[0].id);

    const attempts = db
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, occurrence.id))
      .all();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe("published_pending_observation");
  }, 60_000);

  it("simultaneous FULL-intake race: exactly ONE aggregate survives; the loser is typed or a clean rollback", async () => {
    const w1 = forkWorker();
    const w2 = forkWorker();
    try {
      await initStaggered(w1, w2);

      w1.child.send({ type: "RACE" });
      w2.child.send({ type: "RACE" });
      const [r1, r2] = await Promise.all([w1.result, w2.result]);

      const outcomes = [r1, r2];
      // One published; the other is a typed decision or the known clean
      // race-rollback signature (mission UNIQUE / checkpoint consistency).
      const published = outcomes.filter((r) => r.outcome === "published");
      expect(published).toHaveLength(1);
      for (const r of outcomes) {
        if (r.type === "ERROR") {
          expect(r.message).toMatch(
            /UNIQUE constraint|mission|checkpoint|SQLITE_BUSY|transition/i,
          );
        }
      }
    } finally {
      for (const w of [w1, w2]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    await initDb(dbPath);
    const db = getDb();
    const missionRows = db
      .select()
      .from(missions)
      .where(eq(missions.habitatId, habitatId))
      .all();
    expect(missionRows).toHaveLength(1);
    expect(occurrencesRepo.listByCluster(habitatId, clusterKey)).toHaveLength(1);
    expect(
      db
        .select()
        .from(triageClusterMissions)
        .where(eq(triageClusterMissions.clusterKey, clusterKey))
        .all(),
    ).toHaveLength(1);
    expect(findingTriageRepo.findByHabitatInStatus(habitatId, ["open"])).toHaveLength(1);
    // The surviving aggregate is the frozen one.
    const occurrence = occurrencesRepo.listByCluster(habitatId, clusterKey)[0];
    const frozen = JSON.parse(occurrence.preparedAggregate) as { mission: { missionId: string } };
    expect(missionRows[0].id).toBe(frozen.mission.missionId);
  }, 60_000);
});
