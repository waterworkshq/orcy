/**
 * Automation inbox lease/fence — REAL cross-process contention.
 *
 * Two worker processes (`fixtures/lifecycle-inbox-worker.ts`) each open their
 * OWN better-sqlite3 file connection and race on the SAME inbox delivery.
 *
 * Test 1: both drain simultaneously — exactly ONE lease/fence winner per
 * delivery; the notify action executes exactly once; one run row.
 *
 * Test 2: a stale worker (expired lease, superseded fence) can neither
 * terminalize the delivery nor forge checkpoint proof after a newer fence
 * (or an attention classification) has taken over; a risk-acknowledged
 * successor then executes exactly once.
 *
 * # Why a child process (not two connections on one event loop)
 *
 * better-sqlite3 is synchronous — two connections on one event loop
 * serialize by construction. Two OS processes genuinely race for the
 * file-level write lock (the occurrence-worker / lifecycle-route precedents).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import { notificationEvents, automationRuleRuns } from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import {
  admitReleaseShippedEventToInbox,
  createAutomationDeliverySuccessorGeneration,
  drainAutomationInbox,
} from "../services/automationInboxService.js";

const WORKER = join(import.meta.dirname, "fixtures", "lifecycle-inbox-worker.ts");
const TEMP_DIR = join(import.meta.dirname, "..", "..", ".test-lifecycle");

const T0 = "2026-01-01T00:00:00.000Z";
const T_LATE = "2026-01-01T01:00:00.000Z"; // every short lease is expired

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

interface WorkerMessage {
  type: "READY" | "DRAIN_REPORT" | "LEASED" | "FINALIZED" | "PROVED" | "ERROR";
  report?: {
    considered: number;
    leased: number;
    outcomes: Record<string, number>;
    errors: string[];
  };
  acquired?: boolean;
  fence?: string;
  ok?: boolean;
  message?: string;
}

function forkWorker(dbPath: string) {
  const child = fork(WORKER, [dbPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    console.warn("[inbox worker stderr]:", chunk.toString());
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
  const next = once;
  return { child, ready: once("READY"), next };
}

async function initWorker(child: ChildProcess, handle: ReturnType<typeof forkWorker>) {
  child.send({ type: "INIT" });
  await handle.ready;
}

/** Seed a fresh file DB with one release rule + one admitted delivery. */
async function seed(
  dbPath: string,
  template: string,
): Promise<{ habitatId: string; inboxId: string; deliveryId: string }> {
  await initDb(dbPath);
  const h = boardRepo.createHabitat({ name: "Inbox Fencing Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  ruleRepo.createAutomationRule({
    habitatId: h.id,
    name: "Fencing Rule",
    priority: 0,
    trigger: { type: "event", eventType: "release.shipped" } as never,
    condition: { type: "always" } as never,
    actions: [
      {
        type: "notify",
        template,
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
    eventId: "rel-fence",
    payload: { eventId: "rel-fence" },
  });
  const inboxId =
    admitted.outcome === "admitted" || admitted.outcome === "replayed" ? admitted.inboxId : "";
  const deliveryId = deliveryRepo.listDeliveriesForInbox(inboxId)[0].id;
  closeDb();
  return { habitatId: h.id, inboxId, deliveryId };
}

function renderedTemplates(habitatId: string): string[] {
  const db = getDb();
  return db
    .select({ payload: notificationEvents.payload })
    .from(notificationEvents)
    .where(eq(notificationEvents.habitatId, habitatId))
    .all()
    .map((r) => String((r.payload as { renderedTemplate?: unknown })?.renderedTemplate ?? ""));
}

describe("automation inbox lease/fence — real cross-process contention", () => {
  let dbPath: string;

  beforeEach(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    dbPath = join(TEMP_DIR, `inbox-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    cleanupDb(dbPath);
    closeDb();
  });

  afterEach(() => {
    closeDb();
    cleanupDb(dbPath);
  });

  it("two consumer processes race: exactly ONE lease/fence winner, one execution, one run row", async () => {
    const seedInfo = await seed(dbPath, "RACE");

    const w1 = forkWorker(dbPath);
    const w2 = forkWorker(dbPath);
    try {
      await initWorker(w1.child, w1);
      await initWorker(w2.child, w2);

      // ---- THE RACE: both consumers drain the same inbox simultaneously --
      const r1 = w1.next("DRAIN_REPORT");
      const r2 = w2.next("DRAIN_REPORT");
      w1.child.send({ type: "DRAIN", now: T0 });
      w2.child.send({ type: "DRAIN", now: T0 });
      const [report1, report2] = await Promise.all([r1, r2]);

      // Exactly one worker leased the delivery; the other saw nothing
      // drainable (the winner's lease/terminalization committed first) or
      // lost the lease CAS — never both.
      const totalLeased = report1.report!.leased + report2.report!.leased;
      expect(totalLeased).toBe(1);
      const totalExecuted =
        (report1.report!.outcomes["executed:succeeded"] ?? 0) +
        (report2.report!.outcomes["executed:succeeded"] ?? 0);
      expect(totalExecuted).toBe(1);
      expect([...report1.report!.errors, ...report2.report!.errors]).toEqual([]);
    } finally {
      for (const w of [w1, w2]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    // ---- DURABLE STATE: one execution, one proved checkpoint, one run ----
    await initDb(dbPath);
    const delivery = deliveryRepo.getDeliveryById(seedInfo.deliveryId)!;
    expect(delivery.state).toBe("terminal");
    expect(delivery.terminalDisposition).toBe("succeeded");
    expect(renderedTemplates(seedInfo.habitatId)).toEqual(["RACE"]);

    const checkpoints = deliveryRepo.listCheckpointsForDelivery(seedInfo.deliveryId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].state).toBe("proved");
    expect(checkpoints[0].receipt).toMatchObject({ eventId: expect.any(String) });

    // One run row for this delivery generation (keyed by the delivery id).
    const runRows = getDb()
      .select({ id: automationRuleRuns.id })
      .from(automationRuleRuns)
      .where(eq(automationRuleRuns.eventDedupeKey, seedInfo.deliveryId))
      .all();
    expect(runRows).toHaveLength(1);
    expect(delivery.automationRunId).toBe(runRows[0].id);
  });

  it("a stale worker cannot terminalize or forge proof after a newer fence owns the delivery", async () => {
    const seedInfo = await seed(dbPath, "STALE");

    // Worker A (the future stale worker) takes a SHORT lease and "dies".
    const wA = forkWorker(dbPath);
    const wB = forkWorker(dbPath);
    try {
      await initWorker(wA.child, wA);
      await initWorker(wB.child, wB);

      const leased = wA.next("LEASED");
      wA.child.send({ type: "LEASE", deliveryId: seedInfo.deliveryId, ttlMs: 1000, now: T0 });
      const leaseMsg = await leased;
      expect(leaseMsg.acquired).toBe(true);
      const staleFence = leaseMsg.fence!;

      // Worker B drains after expiry: the unproved notify action declares no
      // idempotency contract → attention_required, NEVER auto-executed.
      const rB = wB.next("DRAIN_REPORT");
      wB.child.send({ type: "DRAIN", now: T_LATE });
      const reportB = await rB;
      expect(reportB.report!.outcomes["attention_required"]).toBe(1);

      // The stale worker's fence is superseded: it can neither terminalize…
      const fin = wA.next("FINALIZED");
      wA.child.send({
        type: "FINALIZE",
        deliveryId: seedInfo.deliveryId,
        fence: staleFence,
        now: T_LATE,
      });
      const finMsg = await fin;
      expect(finMsg.ok).toBe(false);

      // …nor forge checkpoint proof into the generation it no longer owns.
      const prove = wA.next("PROVED");
      wA.child.send({
        type: "PROVE",
        deliveryId: seedInfo.deliveryId,
        fence: staleFence,
        actionIndex: 0,
        actionKey: "v1:irrelevant",
        now: T_LATE,
      });
      const proveMsg = await prove;
      expect(proveMsg.ok).toBe(false);
    } finally {
      for (const w of [wA, wB]) {
        if (w.child.exitCode === null && !w.child.killed) w.child.kill("SIGKILL");
      }
    }

    // ---- DURABLE STATE + risk-acknowledged successor resolution ----------
    await initDb(dbPath);
    const delivery = deliveryRepo.getDeliveryById(seedInfo.deliveryId)!;
    expect(delivery.state).toBe("attention_required");
    expect(renderedTemplates(seedInfo.habitatId)).toEqual([]); // never auto-executed

    const successor = createAutomationDeliverySuccessorGeneration({
      deliveryId: seedInfo.deliveryId,
      actorType: "human",
      actorId: "user-1",
      reason: "operator confirmed the notify never landed",
      ackDuplicateRisk: true,
    });
    expect(successor.outcome).toBe("created");

    const report = await drainAutomationInbox({ now: T_LATE });
    expect(report.outcomes["executed:succeeded"]).toBe(1);
    expect(renderedTemplates(seedInfo.habitatId)).toEqual(["STALE"]);
    expect(deliveryRepo.getDeliveryById(seedInfo.deliveryId)!.terminalDisposition).toBe(
      "superseded",
    );
  });
});
