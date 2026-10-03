/**
 * REAL native competing-writer proof for the report bundle's selected
 * interval, on the production better-sqlite3 driver (repair grant §5).
 *
 * What this proves: the report bundle's synchronous immediate transaction
 * acquires the write reservation BEFORE its selected reads/writes —
 * verified by wrapping the ACTUAL under-reservation candidate reread in
 * `recheckUnderReservation` (a configured, existing-record case): the real
 * read executes, a selected-read milestone is recorded, the worker is
 * released, and its independent BEGIN IMMEDIATE (busy_timeout=0) fails at
 * ACQUISITION with actual SQLITE_BUSY — all before any report INSERT/UPDATE
 * runs. After the report commits, the same legitimate sentinel write
 * succeeds. This is the selected-interval fence ONLY: later out-of-scope
 * writers can still write (phase 2 shows exactly that); no permanent
 * uniqueness, membership-revocation or waiting-duration claim is made, and
 * no sleep/duration assertion exists.
 *
 * A deferred transaction would let the worker's BEGIN succeed before any
 * parent write (phase-1 stage "begin-ok"), failing the acquisition-stage
 * assertion — that discriminator is reserved to the independent reviewer's
 * private mutation and is not run here.
 *
 * The barrier wraps the commit-repository candidate reread via a test-owned
 * module mock; the production callback stays synchronous (bounded
 * synchronous polling, no awaits inside it).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const realFindByRepoAndShaWithClient = vi.hoisted(() => ({
  impl: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock("../repositories/codeCommitRepository.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  realFindByRepoAndShaWithClient.impl = actual[
    "findByRepoAndShaWithClient"
  ] as typeof realFindByRepoAndShaWithClient.impl;
  const barrierState = {
    dir: null as null | string,
    rootClient: null as unknown,
    fired: false,
    selectedRecordId: null as string | null,
    phase1: null as unknown,
  };
  (actual as { __racerBarrier?: unknown }).__racerBarrier = barrierState;
  return {
    ...actual,
    findByRepoAndShaWithClient(client: unknown, repositoryId: string, sha: string) {
      // The ACTUAL under-reservation candidate reread runs first; the
      // selected-read milestone and the worker release happen after it and
      // before ANY report INSERT/UPDATE (recheckUnderReservation precedes
      // every write in the bundle).
      const rows = (
        realFindByRepoAndShaWithClient.impl as (...a: unknown[]) => Array<{ id: string }>
      )(client, repositoryId, sha);
      // Fire only on the IN-TRANSACTION reread (client !== root db), never
      // on the plan-time selection read.
      if (!barrierState.fired && barrierState.dir && client !== barrierState.rootClient) {
        barrierState.fired = true;
        barrierState.selectedRecordId = rows.length === 1 ? rows[0]!.id : null;
        writeFileSync(
          join(barrierState.dir, "sel"),
          String(barrierState.selectedRecordId ?? "none"),
        );
        writeFileSync(join(barrierState.dir, "go1"), "1");
        // Bounded synchronous wait for the worker's BEGIN outcome — still
        // inside the transaction callback, no awaits, no fixed sleep.
        const r1Path = join(barrierState.dir, "r1");
        const start = Date.now();
        while (!existsSync(r1Path)) {
          if (Date.now() - start > 10000) {
            throw new Error("writer-racer: barrier timeout waiting for worker phase-1 result");
          }
        }
        barrierState.phase1 = JSON.parse(readFileSync(r1Path, "utf-8"));
        const acknowledgement = join(barrierState.dir, "phase1-rollback-ack");
        while (!existsSync(acknowledgement)) {
          if (Date.now() - start > 10000) throw new Error("reviewer-phase1-ack-deadline");
        }
        const outcome = barrierState.phase1 as { stage: string; beginError: { code?: string } | null };
        expect(readFileSync(acknowledgement, "utf-8")).toBe(outcome.stage);
        // This assertion runs BEFORE every parent write. A later separately
        // granted deferred discriminator reaches begin-ok and fails here.
        expect(outcome.stage).toBe("begin");
        expect(outcome.beginError?.code).toBe("SQLITE_BUSY");
      }
      return rows;
    },
  };
});

import { initDb, closeDb, getDb } from "../db/index.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import { codeCommits, codeEvidenceLinks } from "../db/schema/index.js";
import {
  buildReportPlan,
  executeReportPlan,
  finalizeReportPlan,
} from "../services/codeEvidence/reportPlan.js";

const RACER = join(import.meta.dirname, "fixtures", "evidence-writer-racer.mjs");
const ACTOR = { type: "agent" as const, id: "racer-parent-agent" };

let dbFile: string;
let dir: string;
let child: ChildProcess;
let childExit: Promise<{ code: number | null; signal: string | null }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orcy-writer-race-"));
  dbFile = join(dir, "race.db");
  await initDb(dbFile);
  (
    codeCommitRepo as unknown as { __racerBarrier: { rootClient: unknown } }
  ).__racerBarrier.rootClient = getDb();
});

afterAll(async () => {
  closeDb();
  if (child && child.exitCode === null && !child.killed) {
    child.kill();
  }
  await childExit?.catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("report bundle selected interval vs a real competing writer", () => {
  it("reserves BEFORE its selected reads/writes (acquisition-stage BUSY), then admits the same write after commit", async () => {
    // Seed on the real driver through the production repositories.
    const { habitat, columns } = habitatService.createHabitat({
      name: "racer-habitat",
      defaultColumns: true,
    });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0]!.id,
      title: "racer-mission",
      createdBy: "racer",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "racer-task",
      createdBy: "racer",
    });
    // CONFIGURED repository + EXISTING commit record: the plan attaches, so
    // the under-reservation reread in recheckUnderReservation runs and the
    // barrier observes a real selected-record read, not a first-write path.
    const repoRow = codeEvidenceRepository.create({
      habitatId: habitat.id,
      provider: "github",
      repoSlug: "org/racer",
      verificationState: "verified",
    })!;
    const sha = "a".repeat(40);
    const existing = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
      message: "pre-existing selected record",
      verificationState: "verified",
    })!;

    const barrier = (codeCommitRepo as unknown as { __racerBarrier: { dir: null | string } })
      .__racerBarrier;
    expect(barrier).toBeDefined();
    barrier.dir = dir;

    const plan = buildReportPlan({ kind: "task", rawId: task.id }, { commits: [{ sha }] });
    finalizeReportPlan(plan);

    // Spawn the independent writer on its own connection.
    child = fork(RACER, [dbFile, dir], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    childExit = new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const readyPath = join(dir, "ready");
    const startReady = Date.now();
    while (!existsSync(readyPath)) {
      if (Date.now() - startReady > 10000) throw new Error("worker never became ready");
    }

    const execution = executeReportPlan(plan, ACTOR);

    // The barrier observed the SELECTED EXISTING record under the
    // reservation, before any write.
    const barrierState = barrier as unknown as {
      fired: boolean;
      selectedRecordId: string | null;
      phase1: { stage: string; beginError: { code: string | null } | null } | null;
    };
    expect(barrierState.fired).toBe(true);
    expect(barrierState.selectedRecordId).toBe(existing.id);
    expect(readFileSync(join(dir, "sel"), "utf-8")).toBe(existing.id);

    // Phase 1: actual acquisition-stage SQLITE_BUSY while the parent held
    // the reservation across the selected read.
    expect(barrierState.phase1).not.toBeNull();
    expect(barrierState.phase1!.stage).toBe("begin");
    expect(barrierState.phase1!.beginError?.code).toBe("SQLITE_BUSY");

    // The report committed its own selections: the attach kept the existing
    // record byte-for-byte selected, and the link landed on the canonical id.
    const commitRows = getDb().select().from(codeCommits).where(eq(codeCommits.sha, sha)).all();
    expect(commitRows).toHaveLength(1);
    expect(commitRows[0]!.id).toBe(existing.id);
    expect(commitRows[0]!.message).toBe("pre-existing selected record");
    const linkRows = getDb()
      .select()
      .from(codeEvidenceLinks)
      .all()
      .filter((r) => r.targetId === task.id && r.targetType === "task");
    expect(linkRows).toHaveLength(1);
    expect(execution.result.links).toHaveLength(1);
    // No sentinel slipped into the selected interval.
    expect(
      getDb()
        .select()
        .from(codeEvidenceLinks)
        .all()
        .filter((r) => r.id === "racer-sentinel"),
    ).toHaveLength(0);

    // Phase 2: same legitimate write now succeeds after the report commit.
    writeFileSync(join(dir, "go2"), "1");
    const r2Path = join(dir, "r2");
    const startR2 = Date.now();
    while (!existsSync(r2Path)) {
      if (Date.now() - startR2 > 10000) throw new Error("worker phase-2 result timeout");
    }
    const phase2 = JSON.parse(readFileSync(r2Path, "utf-8")) as {
      beginError: { code: string | null } | null;
      insertError: unknown;
      commitError: unknown;
      inserted: boolean;
      committed: boolean;
    };
    expect(phase2.beginError).toBeNull();
    expect(phase2.insertError).toBeNull();
    expect(phase2.commitError).toBeNull();
    expect(phase2.inserted).toBe(true);
    expect(phase2.committed).toBe(true);
    expect(
      getDb()
        .select()
        .from(codeEvidenceLinks)
        .all()
        .filter((r) => r.id === "racer-sentinel"),
    ).toHaveLength(1);

    // Confirmed parent-observed natural exit 0 within the parent-owned
    // deadline; the timer is CLEARED on settle and a timeout kills the
    // owned worker and FAILS the test.
    let exitTimer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        childExit.then((r) => ({ ...r, timedOut: false as const })),
        new Promise<{ timedOut: true }>((resolve) => {
          exitTimer = setTimeout(() => resolve({ timedOut: true }), 5000);
        }),
      ]);
      if (outcome.timedOut) {
        child.kill();
        throw new Error("worker did not exit naturally after final IPC flush/disconnect");
      }
      expect(outcome.code).toBe(0);
      expect(outcome.signal).toBeNull();
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
    }
  });
});
