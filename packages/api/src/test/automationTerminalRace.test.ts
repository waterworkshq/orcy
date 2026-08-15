/**
 * FU2 — stale-lease TOCTOU: a checkpoint proved by the OLD worker can NEVER
 * end up `attention_required` (real cross-process race).
 *
 * The sequential case is already covered elsewhere (proof-before-classify →
 * resume in `automationInboxRecovery`); THIS file races a genuinely separate
 * OS process (old worker) against the recovery drain on a shared file DB, as
 * the fix requires. Two connections on one event loop serialize by
 * construction, so `child_process.fork` + IPC is mandatory.
 *
 * # The invariant (asserted after every round)
 *   NOT (delivery.state === 'attention_required' AND any checkpoint is
 *   'proved').
 *
 * With the FU2 reservation (`BEGIN IMMEDIATE` over classify + re-lease |
 * mark-attention) + the fence-bound attention CAS, exactly one ordering can
 * commit per delivery:
 *   - the old worker's proof lands BEFORE the reservation → recovery sees it
 *     proved → resumes → terminal with the proved receipt;
 *   - recovery's reservation commits first (attention or resume) → the old
 *     worker's later proof is rejected by the cleared/superseded fence.
 *
 * The OLD code (checkpoint-read then a separate, non-fence-bound attention
 * CAS) could interleave the proof between the read and the write, leaving
 * `attention_required` WITH an authoritative proved receipt — the defect this
 * file pins.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { closeDb, getDb, initDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { admitReleaseShippedEventToInbox } from "../services/automationInboxService.js";

const WORKER = join(import.meta.dirname, "fixtures", "lifecycle-inbox-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-terminal-race");

const T0 = "2026-01-01T00:00:00.000Z";
const T_LATE = "2026-01-01T01:00:00.000Z"; // every short lease is expired
const ROUNDS = 4;

interface WorkerMessage {
  type: "READY" | "DRAIN_REPORT" | "LEASED" | "PROVED" | "ERROR";
  acquired?: boolean;
  fence?: string;
  ok?: boolean;
  report?: {
    considered: number;
    leased: number;
    outcomes: Record<string, number>;
    errors: string[];
  };
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

function forkWorker(dbPath: string) {
  const child = fork(WORKER, [dbPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    console.warn("[race worker stderr]:", chunk.toString());
  });
  const once = (type: WorkerMessage["type"]): Promise<WorkerMessage> =>
    new Promise((resolve, reject) => {
      const onMessage = (msg: WorkerMessage): void => {
        if (msg?.type === type) {
          child.off("message", onMessage);
          resolve(msg);
        }
        if (msg?.type === "ERROR") {
          child.off("message", onMessage);
          reject(new Error(`worker error: ${msg.message}`));
        }
      };
      child.on("message", onMessage);
      child.on("exit", (code, signal) => {
        reject(new Error(`worker exited (code=${code}, signal=${signal}) early`));
      });
    });
  return { child, ready: once("READY"), next: once };
}

async function initWorker(child: ChildProcess, handle: ReturnType<typeof forkWorker>) {
  child.send({ type: "INIT" });
  await handle.ready;
}

/** Seed a fresh file DB with one release rule + one admitted delivery. */
async function seed(
  dbPath: string,
): Promise<{ habitatId: string; deliveryId: string; actionKey: string }> {
  await initDb(dbPath);
  const h = boardRepo.createHabitat({ name: "Terminal Race Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  const rule = ruleRepo.createAutomationRule({
    habitatId: h.id,
    name: "Race Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: { type: "always" } as never,
    actions: [
      {
        type: "notify",
        template: "RACE",
        severity: "info",
        recipients: [{ type: "human", userId: "user-1" }],
      },
    ] as never,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "test",
  });
  const admitted = admitReleaseShippedEventToInbox({
    habitatId: h.id,
    eventId: `rel-race-${Math.random().toString(36).slice(2)}`,
    payload: { eventId: "rel-race" },
  });
  const inboxId =
    admitted.outcome === "admitted" || admitted.outcome === "replayed" ? admitted.inboxId : "";
  const delivery = deliveryRepo.listDeliveriesForInbox(inboxId)[0];
  const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
  const actionKey = deliveryRepo.computeActionKey(revision.actions[0]);
  closeDb();
  return { habitatId: h.id, deliveryId: delivery.id, actionKey };
}

describe("FU2: stale-lease TOCTOU — old worker race vs recovery (cross-process)", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it(`INVARIANT over ${ROUNDS} rounds: never attention-with-proved-receipt`, async () => {
    // Round 0 happens in this test's own dbPath; the rest reuse fresh DBs
    // seeded per round (the recovery drain processes every drainable row, so
    // rounds cannot share one DB).
    for (let round = 0; round < ROUNDS; round++) {
      const { deliveryId, actionKey } = await seed(dbPath);

      const wOld = forkWorker(dbPath);
      const wRec = forkWorker(dbPath);
      try {
        await initWorker(wOld.child, wOld);
        await initWorker(wRec.child, wRec);

        // Old worker leases (expires ~1s after T0), then "goes quiet".
        const leased = wOld.next("LEASED");
        wOld.child.send({ type: "LEASE", deliveryId, ttlMs: 1000, now: T0 });
        const leaseMsg = await leased;
        expect(leaseMsg.acquired).toBe(true);
        const oldFence = leaseMsg.fence!;

        // THE RACE: the old worker proves its action (a BURST of rapid
        // writes, widening the window that a regression could slip a proof
        // through) while recovery drains the now-expired lease — fired
        // near-simultaneously on two OS processes.
        const PROVE_BURST = 3;
        const provePs = Array.from({ length: PROVE_BURST }, () => wOld.next("PROVED"));
        const drainP = wRec.next("DRAIN_REPORT");
        wRec.child.send({ type: "DRAIN", now: T_LATE, leaseTtlMs: 60_000 });
        for (let b = 0; b < PROVE_BURST; b++) {
          wOld.child.send({
            type: "PROVE",
            deliveryId,
            fence: oldFence,
            actionIndex: 0,
            actionKey,
            now: T_LATE,
          });
        }
        await Promise.all([...provePs, drainP]);
      } finally {
        for (const w of [wOld, wRec]) {
          if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
        }
      }

      // --- DURABLE STATE: assert the invariant -----------------------------
      await initDb(dbPath);
      const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
      const checkpoints = deliveryRepo.listCheckpointsForDelivery(deliveryId);
      closeDb();

      const provedCount = checkpoints.filter((c) => c.state === "proved").length;
      if (delivery.state === "attention_required") {
        // Recovery won: the old worker's proof (if any) was rejected.
        expect(
          provedCount,
          `round ${round}: attention_required must NOT carry a proved receipt`,
        ).toBe(0);
      } else {
        // Either the proof landed first (resume → terminal) or the delivery
        // was executed by the drain; it must never be stuck `leased`.
        expect(
          ["terminal", "attention_required"].includes(delivery.state),
          `round ${round}: expected a settled state, got ${delivery.state}`,
        ).toBe(true);
      }
      cleanupDb(dbPath);
    }
  }, 120_000);
});
