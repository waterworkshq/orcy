/**
 * Local role administration — forked-worker race fixture (R1).
 *
 * argv: <dbPath> <mode> <actorUserId> <assignmentId> <revisionId> <scopeKind>
 *       <scopeId> <scopeIncarnation> <expectedScopeVersion> [gateDir] [gateRelease]
 *
 * `assignmentId` carries the agent registry id in the issuing modes (the
 * typed principal must exist or the command 404s before its audit write) and
 * the target grant id in `revoke`; `definitionId` is not needed by any mode
 * because both issuing commands address the grant through `revisionId`.
 *
 * The worker runs REAL governance COMMANDS on its OWN better-sqlite3
 * connection against the same file the parent uses — production
 * `initDb()` (WAL + busy_timeout), the real command service, real
 * transactions.
 *
 * Modes:
 *
 *   issue        — invoke the real `createAssignment` command. Reports the
 *                  created assignment id/version, or the thrown error.
 *
 *   revoke       — invoke the real `revokeAssignment` command. Reports the
 *                  resulting row state/version, or the thrown error.
 *
 *   custody      — invoke the real `deleteHabitat` command (the custody
 *                  bundle: revoke grants → materialize → retire ledgers →
 *                  delete row, one IMMEDIATE reservation). Reports completion
 *                  or the thrown error.
 *
 *   issue-seam   — the STALE-EXPECTATION proof (pre-reservation gate). Invokes
 *                  the real `createAssignment` command with a TEST-OWNED
 *                  interception of THIS connection's `.transaction()` so the
 *                  command blocks BEFORE it opens its writer reservation
 *                  (BEGIN IMMEDIATE), on a SYNCHRONOUS filesystem gate — not
 *                  between the command's reads and its write inside the
 *                  reservation. The parent's competing writer commits on its
 *                  own connection while this frame is held; the gate then
 *                  releases and the SAME command runs start-to-finish against
 *                  the peer's already-committed state. This is NOT an
 *                  in-transaction race — blocking inside the reservation would
 *                  hold SQLite's single write lock and deadlock the peer (see
 *                  the placement note below). Production source is untouched —
 *                  no production hook exists; the swap is confined to this
 *                  worker process's own client object.
 *
 * Gate protocol (test-owned private dir): the worker writes
 * `<gateDir>/entered` before blocking; the parent writes `<gateDir>/<release>`
 * to release it.
 *
 * The block is genuinely wakeable: each poll iteration runs a short blocking
 * `Atomics.wait` in a throwaway child so this frame stays synchronous (the
 * command call must not be split by an await) while the filesystem check
 * between waits still observes the parent's release promptly.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initDb, closeDb, getDb } from "../../db/index.js";
import {
  createAssignment,
  revokeAssignment,
} from "../../services/localRoleAdministration.js";
import { deleteHabitat } from "../../services/habitatService.js";

const [
  dbPath,
  mode,
  actorUserId,
  assignmentId,
  revisionId,
  scopeKind,
  scopeId,
  scopeIncarnationRaw,
  expectedScopeVersionRaw,
  gateDir,
  gateRelease,
] = process.argv.slice(2);

const scopeIncarnation = Number(scopeIncarnationRaw);
const expectedScopeVersion = Number(expectedScopeVersionRaw);

/** Synchronous, wakeable filesystem barrier (see module docstring). */
function blockUntilReleased(): void {
  writeFileSync(join(gateDir!, "entered"), String(process.pid));
  const releasePath = join(gateDir!, gateRelease!);
  const deadline = Date.now() + 60_000;
  while (!existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error("gate release timeout after 60s");
    spawnSync(
      process.execPath,
      ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);"],
      { timeout: 1000 },
    );
  }
}

async function go(): Promise<void> {
  await initDb(dbPath);

  if (mode === "issue") {
    const assignment = createAssignment({
      actorUserId,
      principalType: "agent",
      principalId: assignmentId!,
      revisionId,
      scopeKind: scopeKind as "habitat",
      scopeId,
      scopeIncarnation,
      expectedScopeVersion,
    });
    process.send?.({ kind: "ok", op: "issue", id: assignment.id, version: assignment.version });
    await closeDb();
    process.exit(0);
  }

  if (mode === "revoke") {
    const row = revokeAssignment({
      actorUserId,
      assignmentId: assignmentId!,
      scopeIncarnation,
      expectedScopeVersion,
      expectedAssignmentVersion: 1,
      reason: "racing revoke",
    });
    process.send?.({ kind: "ok", op: "revoke", state: row.state, version: row.version });
    await closeDb();
    process.exit(0);
  }

  if (mode === "custody") {
    deleteHabitat(scopeId);
    process.send?.({ kind: "ok", op: "custody" });
    await closeDb();
    process.exit(0);
  }

  if (mode === "issue-seam") {
    mkdirSync(gateDir!, { recursive: true });
    // TEST-OWNED seam interception, placed BEFORE the command opens its
    // reservation.
    //
    // Placement is load-bearing and was established empirically: every command
    // opens `BEGIN IMMEDIATE`, which acquires SQLite's single write lock at
    // BEGIN — not at first write. Blocking anywhere INSIDE the callback
    // therefore still holds the write lock, and the peer writer can only
    // commit once this worker's reservation ends. With the barrier inside the
    // transaction the two sides deadlock until the gate deadline (an earlier
    // run of this test demonstrated exactly that).
    //
    // Blocking here instead means: this command has NOT yet opened its
    // reservation, the peer commits freely, and then the SAME real command
    // runs start to finish with the peer's committed state already in the
    // database. Every read it makes — scope existence, governor authority, and
    // the ledger CAS expectation — is therefore evaluated inside its own fresh
    // reservation against the peer's committed version, which is exactly the
    // serialization property under proof.
    //
    // Production source is untouched; the swap is confined to this worker
    // process's own db client object.
    type TxFn = (tx: unknown) => unknown;
    const holder = getDb() as unknown as {
      transaction: (cb: TxFn, cfg?: unknown) => unknown;
    };
    const originalTransaction = holder.transaction;
    holder.transaction = function blockingTransaction(cb: TxFn, cfg?: unknown) {
      blockUntilReleased();
      return originalTransaction.call(holder, cb, cfg);
    };

    // The ACTUAL command — one synchronous invocation that runs entirely
    // after the peer's commit.
    const assignment = createAssignment({
      actorUserId,
      principalType: "agent",
      principalId: assignmentId!,
      revisionId,
      scopeKind: scopeKind as "habitat",
      scopeId,
      scopeIncarnation,
      expectedScopeVersion,
    });
    holder.transaction = originalTransaction;
    process.send?.({ kind: "ok", op: "issue-seam", id: assignment.id, version: assignment.version });
    await closeDb();
    process.exit(0);
  }

  throw new Error(`unknown mode ${mode}`);
}

process.on("message", (msg: { type: string }) => {
  if (msg.type === "GO") {
    go().catch((err) => {
      process.send?.({ kind: "error", message: String(err) });
      process.exit(1);
    });
  }
});
process.send?.({ type: "READY" });