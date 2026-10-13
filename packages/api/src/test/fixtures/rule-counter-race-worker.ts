/**
 * Review-rule counter — interleaved competing-writer fixture (forked).
 *
 * argv: <dbPath> <ruleId> <mode> [gateDir [gateRelease]]
 *
 *   update    — on GO: one plain complete repository update on its own real
 *               connection (the SECOND writer).
 *
 *   preread   — on GO: invoke the ACTUAL reviewRule.update as the original
 *               writer with a narrow TEST-OWNED interception at the
 *               repository's real getById→UPDATE seam: this worker wraps its
 *               own Drizzle client's `.update()` so the original invocation
 *               blocks, between its pre-read SELECT and its UPDATE, on a
 *               SYNCHRONOUS filesystem gate — a real wakeable barrier (the
 *               filesystem is the shared channel; no IPC callbacks are
 *               needed while blocked). The parent releases the gate only
 *               after the second writer's real repository update has
 *               committed; the SAME original reviewRule.update call then
 *               completes in its original synchronous frame. The repository
 *               source is untouched; no production hook exists.
 *
 * Gate protocol (test-owned, private fixture dir): the worker writes
 * <gateDir>/entered before blocking; the parent writes <gateDir>/<release>
 * to release.
 *
 *   mutate    — on GO: block at the REAL production reservation seam, then
 *               run the ACTUAL reviewGovernance.updateRuleCommand on this
 *               process's own real connection. Blocked by wrapping this
 *               process's `getDb().transaction` so the FIRST transaction
 *               opened by the command blocks BEFORE the reservation begins
 *               (never inside it — a barrier inside an IMMEDIATE transaction
 *               deadlocks the peer writer). Used to widen the SAME-request
 *               admission→mutation window: the parent commits a revocation
 *               while this command has authenticated/admitted but not yet
 *               reserved. argv: <dbPath> <ruleId> mutate <gateDir> <release>
 *
 *   revoke    — on GO: revoke the named agent's active role assignment
 *               through the REAL repository primitive
 *               (revokeAssignmentWithClient) inside its own IMMEDIATE
 *               transaction. argv: <dbPath> <ruleId> revoke <assignmentId>
 *
 * Reports { kind:"ok", version } (the repository's own return value) or
 * { kind:"error", message }.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { sql } from "drizzle-orm";
import { bumpReviewRoundWithClient } from "../../repositories/reviewSafety.js";
import { join } from "node:path";
import { initDb, closeDb, getDb } from "../../db/index.js";
import * as reviewRule from "../../repositories/reviewRule.js";
import { revokeAssignmentWithClient } from "../../repositories/roleFoundation.js";
import { updateRuleCommand, addReviewerCommand } from "../../services/reviewGovernance.js";
import { reviewRules } from "../../db/schema/index.js";

const [dbPath, ruleId, mode, gateDir, gateRelease] = process.argv.slice(2);
// In reviewer modes (`writenow`/`getwrite`/`admwait`) the ruleId slot carries
// the TASK id instead.
const taskId = ruleId;

/**
 * Pin the two connections' shared-file/WAL/FK facts to stdout so the parent
 * can assert both processes really opened the same canonical production DB.
 */
function printDriverReceipt(): void {
  const raw = getDb() as unknown as {
    get: (q: unknown) => unknown;
  };
  const journal = (raw.get(sql`pragma journal_mode`) as { journal_mode?: string })
    ?.journal_mode;
  const fk = (raw.get(sql`pragma foreign_keys`) as { foreign_keys?: number })
    ?.foreign_keys;
  console.log(`DRIVER file=${realpathSync(dbPath)} journal=${journal} fk=${fk}`);
}

/**
 * Synchronous filesystem barrier — genuinely wakeable: each poll iteration
 * runs a 20ms blocking Atomics.wait in a short-lived child so this frame
 * stays synchronous AND stops burning CPU, while the filesystem check
 * between waits observes the parent's release file promptly.
 */
function blockUntilReleased(): void {
  writeFileSync(join(gateDir!, "entered"), String(process.pid));
  const releasePath = join(gateDir!, gateRelease!);
  const deadline = Date.now() + 60_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("gate release timeout after 60s");
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);"], { timeout: 1000 });
  }
}

async function go(): Promise<void> {
  await initDb(dbPath);

  if (mode === "update") {
    const updated = reviewRule.update(ruleId, { name: `second-${process.pid}` });
    process.send?.({ kind: "ok", version: updated?.version ?? null });
    await closeDb();
    process.exit(0);
  }

  if (mode === "preread") {
    mkdirSync(gateDir!, { recursive: true });
    // TEST-OWNED seam interception: wrap THIS client's .update so the FIRST
    // reviewRules UPDATE issued by the original invocation blocks at the
    // seam. reviewRule.update's own getById SELECT has already run by then —
    // the block lands strictly between pre-read and UPDATE.
    type UpdateFn = (...args: unknown[]) => unknown;
    const holder = getDb() as unknown as { update: UpdateFn };
    const originalUpdate: UpdateFn = holder.update.bind(holder);
    let interceptedOnce = false;
    holder.update = function interceptedUpdate(this: unknown, ...args: unknown[]) {
      if (!interceptedOnce && args.includes(reviewRules)) {
        interceptedOnce = true;
        blockUntilReleased(); // second writer commits on ITS connection while this frame holds
      }
      return originalUpdate(...args);
    } as UpdateFn;

    // The ACTUAL repository operation — one synchronous invocation whose
    // internal UPDATE passes through the intercepted seam above.
    const updated = reviewRule.update(ruleId, { name: `first-${process.pid}` });

    process.send?.({ kind: "ok", version: updated?.version ?? null });
    await closeDb();
    process.exit(0);
  }

  if (mode === "mutate") {
    mkdirSync(gateDir!, { recursive: true });
    // Test-owned seam on THIS connection: block the command's FIRST
    // transaction BEFORE its reservation opens. Blocking inside an IMMEDIATE
    // transaction would hold the SQLite write lock and deadlock the peer
    // revoker; blocking here means the command has been dispatched but has NOT
    // yet begun to reserve — exactly the window the parent exploits.
    type TxFn = (cb: (tx: unknown) => unknown, cfg?: unknown) => unknown;
    const holder = getDb() as unknown as { transaction: TxFn };
    const originalTransaction: TxFn = holder.transaction.bind(holder);
    let blockedOnce = false;
    holder.transaction = function blockingTransaction(
      cb: (tx: unknown) => unknown,
      cfg?: unknown,
    ) {
      if (!blockedOnce) {
        blockedOnce = true;
        blockUntilReleased();
      }
      return originalTransaction(cb, cfg);
    } as TxFn;

    // The ACTUAL production command — its own reservation, its own evaluator
    // read, its own audit. No copied SQL, no production hook.
    const updated = updateRuleCommand({
      ruleId,
      actor: { type: "agent", id: process.env.WORKER_ACTOR_ID! },
      fields: { name: `worker-${process.pid}` },
    });
    process.send?.({ kind: "ok", version: updated.version });
    await closeDb();
    process.exit(0);
  }

  if (mode === "revoke") {
    // The REAL repository primitive, in its own IMMEDIATE reservation, on this
    // process's own connection. The target assignment arrives by ENV, never by
    // a positional argv slot that could silently arrive undefined.
    const assignmentId = process.env.WORKER_ASSIGNMENT_ID;
    if (!assignmentId) throw new Error("revoke mode requires WORKER_ASSIGNMENT_ID");
    const revoked = getDb().transaction((tx: unknown) =>
      revokeAssignmentWithClient(tx as never, assignmentId, "worker-revoke"),
    );
    // A no-op would report a null version; that must never read as success.
    if (!revoked) throw new Error(`no assignment ${assignmentId} to revoke`);
    process.send?.({ kind: "ok", version: revoked.version });
    await closeDb();
    process.exit(0);
  }

  if (mode === "writenow") {
    // A REAL cross-process reviewer WRITE that commits IMMEDIATELY on this
    // process's own connection — no gate. The parent drives it synchronously
    // from inside its own served-GET read window, so the commit lands
    // between the parent's roster read and its token read. Gating here would
    // deadlock: the parent cannot release a gate while blocked on the worker.
    const reviewerId = process.env.WORKER_REVIEWER_ID;
    if (!reviewerId) throw new Error("writenow mode requires WORKER_REVIEWER_ID");
    addReviewerCommand({
      taskId,
      reviewerId,
      reviewerType: "human",
      actor: { type: "agent", id: process.env.WORKER_ACTOR_ID! },
    });
    process.send?.({ kind: "ok", version: null });
    await closeDb();
    process.exit(0);
  }

  if (mode === "rosterwait") {
    // A's peer writer, preinitialized: READY arrives after initDb with WAL/FK
    // pragmas live on the production file. On GO, blocks on the shared
    // filesystem gate (entered marker), then performs REAL authorized writes
    // on this process's own connection:
    //   1. bumpReviewRoundWithClient — requirement reviewRound/requirementVersion
    //      change, which the token hashes but the roster rows do not carry;
    //   2. addReviewerCommand — a new roster row.
    // Both commit while the parent's GET read transaction holds its snapshot,
    // so a two-read GET (roster at T1, token at T2) would serve a stale roster
    // with a fresh token — the exact split the discriminator asserts against.
    printDriverReceipt();
    mkdirSync(gateDir!, { recursive: true });
    blockUntilReleased();
    const reviewerId = process.env.WORKER_REVIEWER_ID;
    if (!reviewerId) throw new Error("rosterwait mode requires WORKER_REVIEWER_ID");
    bumpReviewRoundWithClient(getDb() as never, taskId);
    addReviewerCommand({
      taskId,
      reviewerId,
      reviewerType: "human",
      actor: { type: "agent", id: process.env.WORKER_ACTOR_ID! },
    });
    writeFileSync(join(gateDir!, "peer-commit"), String(process.pid));
    process.send?.({ kind: "ok", version: null });
    await closeDb();
    process.exit(0);
  }

  if (mode === "getwrite") {
    // A real cross-process reviewer WRITE on this process's own connection,
    // driven by the parent through the existing gate protocol: the worker
    // blocks at <gateDir>/entered, the parent releases it and the row
    // commits. Used to land a write INSIDE the parent's GET read window.
    mkdirSync(gateDir!, { recursive: true });
    blockUntilReleased();
    const reviewerId = process.env.WORKER_REVIEWER_ID;
    if (!reviewerId) throw new Error("getwrite mode requires WORKER_REVIEWER_ID");
    addReviewerCommand({
      taskId,
      reviewerId,
      reviewerType: "human",
      actor: { type: "agent", id: process.env.WORKER_ACTOR_ID! },
    });
    process.send?.({ kind: "ok", version: null });
    await closeDb();
    process.exit(0);
  }

  if (mode === "admwait") {
    // B's request carrier: a REAL API-key-authenticated HTTP PATCH through the
    // production Fastify assembly on a real socket. The transport admission
    // (policy guard → route preHandler → handler entry) completes; the
    // request is then held at a TEST-OWNED seam BEFORE the command opens its
    // IMMEDIATE reservation — interposing on the singleton's .transaction
    // BEFORE the server starts, so the first transaction any handler opens
    // (this PATCH's updateRuleCommand) blocks at the filesystem gate. Revocation
    // or expiry-crossing commits on an independent peer connection while the
    // SAME request is held; releasing the gate lets the reservation's fresh
    // evaluator read decide. argv: <dbPath> <ruleId> admwait <gateDir> <release>
    printDriverReceipt();
    mkdirSync(gateDir!, { recursive: true });
    const port = Number(process.env.WORKER_HTTP_PORT);
    const apiKey = process.env.WORKER_API_KEY;
    if (!port || !apiKey) throw new Error("admwait mode requires WORKER_HTTP_PORT and WORKER_API_KEY");

    type TxFn = (cb: (tx: unknown) => unknown, cfg?: unknown) => unknown;
    const holder = getDb() as unknown as { transaction: TxFn };
    const originalTransaction: TxFn = holder.transaction.bind(holder);
    let blockedOnce = false;
    holder.transaction = function blockingTransaction(
      cb: (tx: unknown) => unknown,
      cfg?: unknown,
    ) {
      if (!blockedOnce) {
        blockedOnce = true;
        blockUntilReleased();
      }
      return originalTransaction(cb, cfg);
    } as TxFn;

    const { createHttpApplication } = await import("../../httpApp.js");
    const app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]);
    await app.finalize();
    await app.listen({ port, host: "127.0.0.1" });
    process.send?.({ type: "LISTENING", port });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/review-rules/${ruleId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-agent-api-key": apiKey },
        body: JSON.stringify({ name: "held-window-attempt" }),
      });
      const bodyText = await res.text();
      process.send?.({ kind: "http", status: res.status, body: bodyText });
    } finally {
      await app.close();
      await closeDb();
      process.exit(0);
    }
  }

  if (mode === "waitonly") {
    // B's deadline-crossing waiter: sleeps until WORKER_CROSS_AT (epoch ms) —
    // a deadline that was in the FUTURE when the held request was admitted —
    // then verifies the wall clock has actually reached/passed it and signals
    // via the existing marker protocol. It performs NO database write: the
    // stored expiresAt bytes are never touched, and the refusal under proof
    // comes from the evaluator comparing the UNCHANGED stored deadline
    // against a now-later wall clock. argv: <dbPath> <ruleId> waitonly <gateDir> <gateRelease>; env WORKER_CROSS_AT.
    const crossAt = Number(process.env.WORKER_CROSS_AT);
    if (!crossAt) throw new Error("waitonly requires WORKER_CROSS_AT");
    mkdirSync(gateDir!, { recursive: true });
    while (Date.now() < crossAt) {
      spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);"], { timeout: 1000 });
    }
    if (Date.now() < crossAt) throw new Error("waitonly exited before its deadline");
    writeFileSync(join(gateDir!, "deadline-crossed"), String(crossAt));
    process.send?.({ kind: "ok", version: null });
    await closeDb();
    process.exit(0);
  }

  throw new Error(`unknown mode ${mode}`);
}

process.on("message", async (msg: { type: string }) => {
  if (msg.type === "GO") {
    try {
      await go();
    } catch (err) {
      process.send?.({ kind: "error", message: String(err) });
      process.exit(1);
    }
  }
});
process.send?.({ type: "READY" });
