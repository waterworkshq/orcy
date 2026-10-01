/**
 * Attachment delete process-boundary workers (fork targets, plain ESM).
 *
 * Four subcommands, each run as an INDEPENDENT PROCESS against a private
 * better-sqlite3 database file and a private upload dir. Milestones are fork
 * IPC messages or milestone files — never sleeps-as-synchronization.
 *
 *   lock-hold <dbFile> <teamId> <userId> <goFile>
 *     Opens its own connection, BEGIN IMMEDIATE, IPC 'locked', then commits a
 *     real team_members removal INSIDE the held transaction, IPC 'committed',
 *     exits. The parent touches the goFile only after observing the served
 *     request's transaction invocation (entry seam). What the pair OBSERVES:
 *     the held lock, the immediate invocation, callback acquisition, this
 *     worker's committed removal, and the command's current-fact reads
 *     observing that committed removal (the denial). Whether the delete's
 *     BEGIN was ATTEMPTED while the lock was still held is NOT observable
 *     from this process pair — that stays BLOCKED in the suite's labelling;
 *     no no-yield/cross-process ordering is claimed here.
 *
 *   lock-hold-assign <dbFile> <taskId> <goFile>
 *     Same held-writer shape for the ASSIGNMENT contender required by the
 *     original matrix: inside the held BEGIN IMMEDIATE it clears the Task's
 *     assigned_agent_id, then commits after the parent's transaction-entry
 *     milestone. A served delete by the now-unassigned non-uploader agent
 *     must re-read the cleared current fact and deny with the action 403.
 *     Same observed/blocked boundary as lock-hold: no cross-process
 *     blocked-BEGIN ordering is claimed.
 *
 *   busy-probe <dbFile> <holdFile> <attemptFile> <releaseFile>
 *     Waits for holdFile (milestone), then with busy_timeout=0 attempts
 *     BEGIN IMMEDIATE + INSERT + COMMIT on its own connection. ONLY a
 *     SQLITE_BUSY outcome at the BEGIN (acquisition) stage is recorded as
 *     busy; any other failure (failed INSERT/COMMIT, or a non-BUSY begin
 *     error) is propagated as a probe-error IPC and a nonzero exit — never
 *     relabelled busy. After releaseFile appears the retry must COMMIT
 *     ('phase2' ok), preserving the after-release commit control.
 *
 *   crash-precommit <dbFile> <uploadDir>
 *     Boots the REAL built command (dist/). The pause rides a TEST-OWNED
 *     call-through synchronous transaction-callback wrapper on the worker's
 *     private DB: the original immediate transaction is captured before
 *     replacement and every call is delegated. For the command's own
 *     transaction, the wrapper runs the ORIGINAL callback to completion
 *     (conditional DELETE, RETURNING verification and target-absence
 *     postcheck have all finished — completed-before-COMMIT, NOT
 *     in-statement, NOT an observed COMMIT outcome), then observes the
 *     exact target absence and native inTransaction on the same connection
 *     inside the still-open transaction, emits the exact-ID/name/state
 *     milestone, and pauses before returning to the native helper's COMMIT.
 *     (The earlier AFTER-DELETE trigger + custom-function nested SELECT was
 *     rejected by the native connection and is retired; its failed-IPC
 *     record is preserved by the process result, not relabelled.) Parent
 *     SIGKILLs; SQLite recovery must roll back so row + bytes survive. A
 *     separate connection reading while paused sees the OLD COMMITTED row —
 *     old-row visibility, NOT uncommitted-absence evidence.
 *
 *   crash-postcommit <dbFile> <uploadDir>
 *     A LABELLED TEST-ONLY SEAM (node:module registerHooks): a plain mutation
 *     of require("fs").unlinkSync is INVISIBLE to the dist module graph's ESM
 *     named bindings (probed empirically), so the pause is installed as a
 *     synchronous load-time source transform of EXACTLY
 *     dist/services/fileStorage.js — bound by the FULL module URL (never a
 *     suffix match), requiring exactly one successful installation. The
 *     transform re-binds `unlinkSync` to a call-through wrapper that defers
 *     to globalThis.__AAD_UNLINK_PAUSE and then calls the REAL unlinkSync.
 *     Production bytes on disk are untouched; only this worker's in-memory
 *     module copy is wrapped, and the pause sits at the unlink entry — after
 *     the command transaction returned (commit completed) and before the real
 *     unlink. The 'paused-postcommit' milestone carries the EXACT attachment
 *     id, stored name and path. Parent SIGKILLs; the row must be absent while
 *     the bytes survive. Deregistration goes through the installed runtime's
 *     supported API shape and is reported, not assumed.
 *
 *   enoent-probe <dbFile> <uploadDir>
 *     The same exact-URL fileStorage transform, with a wrapper that removes
 *     the test-owned target file IMMEDIATELY BEFORE invoking the real
 *     unlinkSync: deleteFile's existsSync has already passed, so the REAL
 *     unlink observes a genuine ENOENT and propagates it. The worker reports
 *     the caught error's code/errno (mandatory observation — anything else
 *     fails the proof), the exact attachment id/stored name, and the sibling
 *     file it created. This replaces an earlier in-suite
 *     `vi.spyOn(node:fs, 'unlinkSync')` attempt: the runtime rejects spying
 *     on the node:fs ESM namespace, and an unavailable mandatory observation
 *     must fail the proof, not silently pass it.
 *
 * The command is invoked through its ordinary trusted internal boundary
 * (request-like object with the genuine key header) — labelled
 * command-level, not wire-level, execution of the actual production code.
 * Every seam here is source-recorded design: none of these process proofs
 * has been executed under the current grant; the coordinator reopens
 * targeted verification separately.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Synchronous worker-log write. NEVER stderr: vitest drains child stderr
 * asynchronously and a full pipe would block writeSync(2) mid-proof (the
 * observed 30s stall). A log-file fd under the worker's own process dir is
 * unblockable and captured as IPC/crash evidence.
 */
let __aadLogFd = null;
function say(msg) {
  try {
    if (__aadLogFd === null) {
      const path = process.env.AAD_WORKER_LOG || "/dev/null";
      __aadLogFd = require("fs").openSync(path, "a");
    }
    require("fs").writeSync(__aadLogFd, `AAD-WORKER: ${msg}\n`);
  } catch {
    /* diagnostics must never break the proof */
  }
}

const require = createRequire(import.meta.url);
const cjsFs = require("fs");

function blockSync(ms) {
  // Synchronous bounded block on the main thread (allowed in Node).
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function send(msg, callback) {
  if (process.send) process.send(msg, callback);
  else if (callback) callback();
}

function waitFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${path}`);
    blockSync(5);
  }
}

function touch(path) {
  writeFileSync(path, "");
}

/**
 * Deregister a node:module registerHooks result across the API shapes seen
 * in the wild: Node returns a callable deregistration function (also exposed
 * with integer properties), and some builds return `{ deregister() }`. An
 * unrecognized shape is REPORTED, never assumed — the cleanup claim stays
 * conditional on the installed runtime's supported API.
 */
function deregisterHooks(hookHandle) {
  if (typeof hookHandle === "function") {
    hookHandle();
    return "function";
  }
  if (hookHandle && typeof hookHandle.deregister === "function") {
    hookHandle.deregister();
    return "deregister-method";
  }
  say(`AAD-SEAM: unrecognized registerHooks result shape: ${String(typeof hookHandle)}`);
  return "unsupported";
}

/**
 * Exact-identity fileStorage load transform. `body` is the replacement
 * `unlinkSync` body (source string) with `real` and `a` in scope. The
 * transform binds the FULL module URL (never a suffix match), counts
 * installations, fails loudly on unsupported loading (non-string/non-Buffer
 * source with an unreadable file) and only patches the known dist import
 * line. Returns { expectInstalled, deregister }; expectInstalled() must be
 * awaited after the dist graph first loads fileStorage and throws unless
 * exactly one installation occurred.
 */
async function patchFileStorageUnlink(body) {
  const { registerHooks } = await import("node:module");
  if (typeof registerHooks !== "function") {
    throw new Error("AAD-SEAM: node:module registerHooks unavailable in this runtime");
  }
  const EXPECTED_URL = new URL("../../../dist/services/fileStorage.js", import.meta.url).href;
  let installed = 0;
  const hookHandle = registerHooks({
    load(url, context, nextLoad) {
      if (url !== EXPECTED_URL) return nextLoad(url, context);
      installed += 1;
      const r = nextLoad(url, context);
      let src = typeof r.source === "string" ? r.source : null;
      if (src === null && Buffer.isBuffer(r.source)) src = r.source.toString("utf-8");
      if (src === null) {
        try {
          src = cjsFs.readFileSync(new URL(url), "utf-8");
        } catch (err) {
          throw new Error(`AAD-SEAM: unsupported load for ${url}: ${String(err)}`);
        }
      }
      const patched = src.replace(
        'import { mkdirSync, writeFileSync, createReadStream, unlinkSync, existsSync } from "fs";',
        `import { mkdirSync, writeFileSync, createReadStream, existsSync } from "fs";
import * as __aadFs from "fs";
const unlinkSync = ((real) => function unlinkSync(...a) {
${body}
})(__aadFs.unlinkSync);`,
      );
      if (patched === src) {
        throw new Error("AAD-SEAM: fileStorage import line not found for the transform");
      }
      return { ...r, source: patched, shortCircuit: true };
    },
  });
  return {
    expectInstalled: () => {
      if (installed !== 1) {
        throw new Error(
          `AAD-SEAM: expected exactly one fileStorage load transform, saw ${installed}`,
        );
      }
    },
    deregister: () => deregisterHooks(hookHandle),
  };
}

/** Real fixtures through the built repositories, on the worker's own DB. */
async function bootRealWorld(dbFile, uploadDir) {
  process.env.UPLOAD_DIR = uploadDir;
  mkdirSync(uploadDir, { recursive: true });
  const db = await import("../../../dist/db/index.js");
  await db.initDb(dbFile);
  const habitatRepo = await import("../../../dist/repositories/habitat.js");
  const userRepo = await import("../../../dist/repositories/user.js");
  const teamRepo = await import("../../../dist/repositories/team.js");
  const organizationRepo = await import("../../../dist/repositories/organization.js");
  const teamMemberRepo = await import("../../../dist/repositories/teamMember.js");
  const columnRepo = await import("../../../dist/repositories/column.js");
  const missionRepo = await import("../../../dist/repositories/mission.js");
  const taskRepo = await import("../../../dist/repositories/taskCrud.js");
  const agentRepo = await import("../../../dist/repositories/agent.js");
  const attachmentRepo = await import("../../../dist/repositories/attachment.js");

  const org = organizationRepo.createOrganization({
    name: "aad-w-org",
    slug: `aad-w-${Date.now()}`,
  });
  const teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "aad-w-team",
    slug: `aad-w-t-${Date.now()}`,
  }).id;
  const habitatId = habitatRepo.createHabitat({ name: "aad-w-habitat", teamId }).id;
  // FK ordering: team_members.user_id references users.id — create the human
  // BEFORE the membership row.
  const nowIso = new Date().toISOString();
  userRepo.createUser({
    id: "aad-w-human",
    username: "aad-w-human",
    passwordHash: "aad-w-unused",
    role: "admin",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  teamMemberRepo.addMember({ teamId, userId: "aad-w-human", role: "member" });

  let columnId = 0;
  const mkTask = (title) => {
    const col = columnRepo.createColumn({
      habitatId,
      name: `aad-w-col-${title}-${++columnId}`,
      order: columnId,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId,
      columnId: col.id,
      title: `aad-w-m-${title}`,
      createdBy: "aad-w-human",
    });
    return taskRepo.createTask({ missionId: mission.id, title, createdBy: "aad-w-human" }).id;
  };
  const taskId = mkTask("aad-w-task");

  const agent = agentRepo.createAgent({
    name: "aad-w-agent",
    type: "opencode",
    domain: "fullstack",
    capabilities: [],
  });

  const storedName = `aad-w-${Date.now()}-bytes.bin`;
  const cjsWrite = require("fs");
  cjsWrite.writeFileSync(join(uploadDir, storedName), Buffer.from("AAD-WORKER-BYTES", "utf-8"));
  const attachment = attachmentRepo.createAttachment({
    taskId,
    filename: storedName,
    originalName: "bytes.bin",
    mimeType: "application/octet-stream",
    sizeBytes: Buffer.byteLength("AAD-WORKER-BYTES", "utf-8"),
    uploadedBy: "aad-w-human",
  });

  const rowidRow = db.getDb().all(
    // rowid retained for diagnostics (the pause now rides a trigger + custom function).
    // eslint-disable-next-line no-undef
    (await import("drizzle-orm"))
      .sql`SELECT rowid AS rowid FROM task_attachments WHERE id = ${attachment.id}`,
  );
  return {
    db: db.getDb(),
    attachmentId: attachment.id,
    storedName,
    uploadDir,
    agentId: agent.agent.id,
    agentKey: agent.plainApiKey,
    rowid: rowidRow[0].rowid,
    raw: db.getDb().$client,
  };
}

function humanRequest(attachmentId) {
  return {
    params: { id: attachmentId },
    headers: {},
    agent: undefined,
    user: { id: "aad-w-human", role: "admin", type: "human" },
  };
}

/**
 * EXACT-MODULE TIMER-OWNERSHIP FIXTURE (owned-timer-fix grant; module-private,
 * used exclusively by the enoent-probe branch): a load transform bound to the
 * FULL URL of dist/middleware/rateLimit.js that verifies the reviewed
 * unconditional cleanup-interval expression occurs EXACTLY ONCE and replaces
 * only that creation site with a call-through capture. The capture delegates
 * the REAL native setInterval with the module's OWN callback and delay,
 * returns the real Timeout unchanged, and records ONLY type-level facts
 * (source binding, delay, callback name, public hasRef at capture). Exactly
 * one installation and one creation are required — anything else fails
 * loudly. No global timer interception, no duration/name heuristics, no
 * unref, no production change; the handle is disposed by THIS worker's
 * ordinary cleanup via clearInterval on the captured handle alone.
 */
async function captureRateLimitCleanupInterval() {
  const { registerHooks } = await import("node:module");
  const EXPECTED_URL = new URL("../../../dist/middleware/rateLimit.js", import.meta.url).href;
  const SOURCE_LINE = "setInterval(cleanup, 60_000);";
  const state = {
    url: EXPECTED_URL,
    sourceLine: SOURCE_LINE,
    installations: 0,
    creations: 0,
    capturedHandle: null,
    delay: null,
    callbackName: null,
    hasRefAtCapture: null,
    deregistered: false,
  };
  const hookHandle = registerHooks({
    load(url, context, nextLoad) {
      if (url !== EXPECTED_URL) return nextLoad(url, context);
      state.installations += 1;
      const r = nextLoad(url, context);
      let src = typeof r.source === "string" ? r.source : null;
      if (src === null && Buffer.isBuffer(r.source)) src = r.source.toString("utf-8");
      if (src === null) {
        try {
          src = cjsFs.readFileSync(new URL(url), "utf-8");
        } catch (err) {
          throw new Error(`AAD-TIMER: unsupported load for ${url}: ${String(err)}`);
        }
      }
      const occurrences = src.split(SOURCE_LINE).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `AAD-TIMER: expected exactly one cleanup-interval expression in rateLimit.js, found ${occurrences}`,
        );
      }
      const patched = src.replace(
        SOURCE_LINE,
        "globalThis.__AAD_RATE_LIMIT_TIMER_CAPTURE(cleanup, 60_000);",
      );
      return { ...r, source: patched, shortCircuit: true };
    },
  });
  globalThis.__AAD_RATE_LIMIT_TIMER_CAPTURE = (callback, delay) => {
    state.creations += 1;
    const real = setInterval(callback, delay); // the REAL native setInterval, delegated
    state.capturedHandle = real;
    state.delay = delay;
    state.callbackName = callback && callback.name ? callback.name : "anonymous";
    state.hasRefAtCapture = typeof real.hasRef === "function" ? real.hasRef() : "unavailable";
    return real; // the module discards it; the real handle is preserved
  };
  state.deregister = () => {
    if (state.deregistered) return;
    state.deregistered = true;
    deregisterHooks(hookHandle);
    delete globalThis.__AAD_RATE_LIMIT_TIMER_CAPTURE;
  };
  return state;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "lock-hold") {
    const [dbFile, teamId, userId] = args;
    const Database = require("better-sqlite3");
    say(`lock-hold dbFile=${dbFile} exists=${existsSync(dbFile)}`);
    const db = new Database(dbFile);
    db.pragma("busy_timeout = 10000");
    const tbl = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'team_members'")
      .get();
    say(`lock-hold team_members present=${JSON.stringify(tbl)}`);
    db.exec("BEGIN IMMEDIATE");
    say("lock acquired");
    send({ type: "locked" });
    // Hold the writer reservation until the parent's transaction-entry
    // milestone. Cross-process blocked-BEGIN ordering is NOT claimed here
    // (see the header); the denial-side current-fact observation carries the
    // ordering evidence that is actually supported.
    const [goFile] = args.slice(3);
    waitFile(goFile, 15000);
    const delInfo = db
      .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .run(teamId, userId);
    db.exec("COMMIT");
    say("committed changes=" + delInfo.changes);
    send({ type: "committed", changes: delInfo.changes, teamId, userId });
    db.close();
    // Ordinary exit: process.exit immediately after an IPC send can truncate
    // the queued message; exitCode + return lets Node flush the channel and
    // exit naturally with the intended code.
    process.exitCode = 0;
    return;
  }

  if (cmd === "lock-hold-assign") {
    const [dbFile, taskId] = args;
    const Database = require("better-sqlite3");
    say(`lock-hold-assign dbFile=${dbFile} taskId=${taskId}`);
    const db = new Database(dbFile);
    db.pragma("busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    say("lock acquired");
    send({ type: "locked" });
    // Hold the writer reservation until the parent's transaction-entry
    // milestone; same observed/blocked boundary as lock-hold.
    const [goFile] = args.slice(2);
    waitFile(goFile, 15000);
    const updInfo = db
      .prepare("UPDATE tasks SET assigned_agent_id = NULL WHERE id = ?")
      .run(taskId);
    db.exec("COMMIT");
    say("committed assignment clear changes=" + updInfo.changes);
    send({ type: "committed", changes: updInfo.changes, taskId });
    db.close();
    process.exitCode = 0; // natural, flushed exit (see lock-hold)
    return;
  }

  if (cmd === "busy-probe") {
    const [dbFile, holdFile, attemptFile, releaseFile] = args;
    // Do NOT pre-touch the attempt file: the in-transaction hold must observe
    // the phase-1 RESULT line (not mere existence), which is only written
    // after the hold milestone proves the reservation is active. This makes
    // the BUSY outcome deterministic instead of a startup race.
    say("busy-probe waiting for in-tx hold");
    waitFile(holdFile, 20000);
    touch(attemptFile);
    say("busy-probe hold seen, attempting phase1");
    const Database = require("better-sqlite3");
    const db = new Database(dbFile);
    db.pragma("busy_timeout = 0");
    const errCode = (err) => (err && err.code ? err.code : null);
    // Stage-exact attempt: ONLY a SQLITE_BUSY at the BEGIN (acquisition)
    // stage is contention. A failed INSERT or COMMIT — or a begin failure
    // that is not SQLITE_BUSY — is an unexpected error and propagates; it is
    // never relabelled busy.
    const attempt = () => {
      try {
        db.exec("BEGIN IMMEDIATE");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        return {
          ok: false,
          stage: "begin",
          code: errCode(err),
          message: String(err.message || err),
        };
      }
      try {
        db.prepare("INSERT INTO aad_busy_probe (id) VALUES (1)").run();
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        return {
          ok: false,
          stage: "write",
          code: errCode(err),
          message: String(err.message || err),
        };
      }
      return { ok: true, stage: "done", code: null, message: null };
    };
    const isBusy = (r) => r.ok === false && r.stage === "begin" && r.code === "SQLITE_BUSY";
    // Phase 1: attempt during the served delete's writer reservation. Only
    // the intended acquisition-stage SQLITE_BUSY is acceptable.
    const first = attempt();
    appendFileSync(attemptFile, `phase1=${JSON.stringify(first)}\n`);
    if (!isBusy(first)) {
      send({ type: "probe-error", phase: 1, result: first });
      process.exitCode = 2; // parent fails fast on probe-error
      return;
    }
    // Phase 2: wait for the release milestone, then retry until the commit
    // control succeeds. Transient begin-stage BUSY is tolerable here; any
    // write-stage failure or non-BUSY begin failure propagates.
    say("busy-probe phase1 recorded: " + JSON.stringify(first));
    waitFile(releaseFile, 15000);
    say("busy-probe released, attempting phase2");
    let second = { ok: false, stage: "begin", code: "no-attempt", message: null };
    for (let i = 0; i < 200; i++) {
      second = attempt();
      if (second.ok) break;
      if (!isBusy(second)) {
        send({ type: "probe-error", phase: 2, result: second });
        process.exitCode = 5;
        return;
      }
      blockSync(10);
    }
    appendFileSync(attemptFile, `phase2=${JSON.stringify(second)}\n`);
    send({ type: "probe-done", phase1: first, phase2: second });
    db.close();
    process.exitCode = second.ok ? 0 : 3; // natural, flushed exit
    return;
  }

  if (cmd === "crash-precommit") {
    const [dbFile, uploadDir] = args;
    const world = await bootRealWorld(dbFile, uploadDir);
    // TEST-OWNED call-through synchronous transaction-callback wrapper (the
    // earlier AFTER-DELETE trigger + custom-function nested SELECT was
    // rejected by the native connection — "busy executing a query" — and is
    // RETIRED). The original transaction is captured BEFORE replacement;
    // every call is delegated to it with the supplied client/options. For
    // the command's own immediate transaction only, the wrapper runs the
    // ORIGINAL synchronous callback to completion (conditional DELETE,
    // RETURNING verification and target-absence postcheck have all finished
    // — labelled so, NOT in-statement and NOT an observed COMMIT outcome),
    // then — still inside that open transaction, before returning to the
    // native helper's COMMIT — observes the exact target absence and the
    // native inTransaction flag, emits the exact-ID/name/state milestone,
    // and pauses. The parent SIGKILLs inside the pause; SQLite recovery must
    // roll the uncommitted transaction back. Observer failure fails loudly.
    const origTx = world.db.transaction.bind(world.db);
    let wrappedOnce = false;
    world.db.transaction = function wrappedTransaction(cb, opts) {
      if (opts && opts.behavior === "immediate" && !wrappedOnce) {
        wrappedOnce = true;
        return origTx(
          (tx) => {
            const result = cb(tx); // original callback fully completed
            let exactTargetAbsent = null;
            let inTransaction = null;
            let observationError = null;
            try {
              exactTargetAbsent =
                world.raw
                  .prepare("SELECT count(*) AS c FROM task_attachments WHERE id = ?")
                  .get(world.attachmentId).c === 0;
              inTransaction = world.raw.inTransaction === true;
            } catch (err) {
              observationError = String(err && err.message ? err.message : err);
            }
            if (observationError !== null) {
              send({ type: "precommit-observation-unsupported", observationError });
              process.exitCode = 9;
              return result; // loud failure path; parent fails fast
            }
            send({
              type: "paused-precommit",
              phase: "callback-completed-before-commit",
              attachmentId: world.attachmentId,
              storedName: world.storedName,
              exactTargetAbsent,
              inTransaction,
            });
            blockSync(60000); // Parent SIGKILLs within this window.
            return result; // unreachable in the intended path
          },
          opts,
        );
      }
      return origTx(cb, opts);
    };
    const attachmentRepo = await import("../../../dist/repositories/attachment.js");
    const admitted = attachmentRepo.getAttachmentById(world.attachmentId);
    attachmentRepo.deleteAttachment(humanRequest(world.attachmentId), admitted);
    // Unreachable in the intended path; a return means the wrapper never fired.
    send({ type: "unexpected-return" });
    process.exitCode = 4;
    return;
  }

  if (cmd === "crash-postcommit") {
    const [dbFile, uploadDir] = args;
    // LABELLED TEST-ONLY SEAM: see the header comment. The pause sits at the
    // unlink entry — after the command transaction returned (commit
    // completed) and before the real unlink. The seam is installed BEFORE
    // any dist import so the transform applies at fileStorage's first load.
    const seam = await patchFileStorageUnlink(
      `  if (globalThis.__AAD_UNLINK_PAUSE) globalThis.__AAD_UNLINK_PAUSE(...a);
  return real.apply(__aadFs, a);`,
    );
    let worldRef = null;
    try {
      globalThis.__AAD_UNLINK_PAUSE = (path) => {
        if (typeof path === "string" && path.endsWith(".aad-postcommit-pause.bin")) {
          say(`postcommit pause entered at ${path}`);
          // Typed exact-target milestone: the nonempty attachment id and
          // stored name travel WITH the path so the parent never has to
          // guess or fall back to /attachments/undefined.
          send({
            type: "paused-postcommit",
            path,
            attachmentId: worldRef ? worldRef.attachmentId : null,
            storedName: path.split("/").pop(),
          });
          blockSync(60000); // Parent SIGKILLs within this window.
        }
      };
      worldRef = await bootRealWorld(dbFile, uploadDir);
      seam.expectInstalled();
      const { eq } = await import("drizzle-orm");
      const schema = await import("../../../dist/db/schema/index.js");
      const pauseName = `aad-${Date.now()}.aad-postcommit-pause.bin`;
      writeFileSync(join(uploadDir, pauseName), Buffer.from("AAD-POSTCOMMIT-BYTES", "utf-8"));
      say(
        `pause file ${join(uploadDir, pauseName)} exists=${existsSync(join(uploadDir, pauseName))}`,
      );
      worldRef.db
        .update(schema.taskAttachments)
        .set({ filename: pauseName })
        .where(eq(schema.taskAttachments.id, worldRef.attachmentId))
        .run();
      const attachmentRepo = await import("../../../dist/repositories/attachment.js");
      const admitted = attachmentRepo.getAttachmentById(worldRef.attachmentId);
      say(`admitted filename ${admitted && admitted.filename}`);
      attachmentRepo.deleteAttachment(humanRequest(worldRef.attachmentId), admitted);
      // Ordinary unexpected-return path: report and let the finally below
      // run the supported hook cleanup and connection close, then exit with
      // the recorded code (process.exit inside try would skip the finally).
      send({ type: "unexpected-return" });
      process.exitCode = 4;
      return;
    } finally {
      const seamShape = seam.deregister();
      say(`postcommit seam deregistered via ${seamShape}`);
      try {
        const db = await import("../../../dist/db/index.js");
        db.closeDb();
      } catch (err) {
        say(`postcommit closeDb best-effort: ${String(err && err.message ? err.message : err)}`);
      }
    }
  }

  if (cmd === "enoent-probe") {
    const [dbFile, uploadDir] = args;
    // LABELLED TEST-ONLY SEAM: for exactly the test-owned target path (read
    // from a global so the seam can be installed BEFORE any dist import —
    // the transform must apply at fileStorage's FIRST load), the wrapper
    // removes the owned file IMMEDIATELY BEFORE invoking the real unlink —
    // deleteFile's existsSync has already passed, so the REAL unlink
    // observes a genuine ENOENT and propagates it.
    const seam = await patchFileStorageUnlink(
      `  if (typeof a[0] === "string" && a[0] === globalThis.__AAD_ENOENT_TARGET) {
    real.apply(__aadFs, a); // the seam removes the owned file first
  }
  return real.apply(__aadFs, a); // then the REAL unlink observes ENOENT`,
    );
    // Ordinary-path cleanup is an ASSERTED result: the deregistration shape
    // and DB close are captured below and reported over IPC; an unsupported
    // cleanup shape or failed close makes this ordinary worker FAIL, because
    // a clean process exit is not otherwise evidence of cleanup.
    let cleanup = { deregistration: "unknown", dbClosed: false, cleanupError: null };
    let pendingResult = null;
    // DIAGNOSTIC RECORDS ONLY (enoent-lifecycle-diagnostic grant): type-only
    // stage observations appended synchronously to a file inside THIS
    // worker's own private fixture directory (derived from the granted
    // uploadDir). Values are recorded, never guessed: the active-resource
    // TYPE list from the public process API, the IPC connected flag, and
    // the actual close/callback/disconnect outcomes. No credentials, no
    // file contents, no expanded SQL, no arbitrary handle enumeration, no
    // timers/loops to keep the process alive for reporting. Behaviour is
    // unchanged by these records.
    const diagFile = join(uploadDir, "..", "enoent-lifecycle.jsonl");
    const diag = (stage, extra = {}) => {
      try {
        appendFileSync(
          diagFile,
          JSON.stringify({
            stage,
            utc: new Date().toISOString(),
            activeResources:
              typeof process.getActiveResourcesInfo === "function"
                ? process.getActiveResourcesInfo()
                : "unavailable",
            connected: process.connected,
            ...extra,
          }) + "\n",
        );
      } catch {
        /* diagnostics must never change behaviour */
      }
    };
    // Exact-module timer-ownership capture: installed BEFORE bootRealWorld
    // (the dist graph evaluates rateLimit during boot) and finished —
    // hook deregistered, temporary global removed — immediately after,
    // requiring exactly one installation and one creation.
    const timer = await captureRateLimitCleanupInterval();
    try {
      const world = await bootRealWorld(dbFile, uploadDir);
      timer.deregister();
      if (timer.installations !== 1 || timer.creations !== 1) {
        throw new Error(
          `AAD-TIMER: expected exactly one installation/creation, saw ${timer.installations}/${timer.creations}`,
        );
      }
      seam.expectInstalled();
      const targetPath = join(uploadDir, world.storedName);
      globalThis.__AAD_ENOENT_TARGET = targetPath;
      // A REAL sibling attachment row owning a real file: the parent asserts
      // this exact row ID and its unchanged bytes, so sibling preservation
      // is proven against stored data, not just an orphan file.
      const attachmentRepo = await import("../../../dist/repositories/attachment.js");
      const siblingTaskId = world.raw
        .prepare("SELECT task_id AS t FROM task_attachments WHERE id = ?")
        .get(world.attachmentId).t;
      const siblingName = `aad-enoent-sibling-${Date.now()}.bin`;
      writeFileSync(join(uploadDir, siblingName), Buffer.from("AAD-ENOENT-SIBLING-BYTES", "utf-8"));
      const sibling = attachmentRepo.createAttachment({
        taskId: siblingTaskId,
        filename: siblingName,
        originalName: "sibling.bin",
        mimeType: "application/octet-stream",
        sizeBytes: Buffer.byteLength("AAD-ENOENT-SIBLING-BYTES", "utf-8"),
        uploadedBy: "aad-w-human",
      });
      const admitted = attachmentRepo.getAttachmentById(world.attachmentId);
      let caught = null;
      try {
        attachmentRepo.deleteAttachment(humanRequest(world.attachmentId), admitted);
      } catch (err) {
        caught = {
          code: err && err.code ? err.code : null,
          errno: err && typeof err.errno === "number" ? err.errno : null,
          message: String(err && err.message ? err.message : err),
          isAppError: Boolean(err && err.statusCode),
        };
      }
      const rowAfter = world.raw
        .prepare("SELECT id FROM task_attachments WHERE id = ?")
        .get(world.attachmentId);
      pendingResult = {
        type: caught && caught.code === "ENOENT" ? "enoent-observed" : "enoent-not-observed",
        attachmentId: world.attachmentId,
        storedName: world.storedName,
        siblingId: sibling.id,
        siblingName,
        targetPath,
        caught,
        rowAbsent: rowAfter === undefined,
      };
      return;
    } finally {
      diag("before-cleanup", {
        caughtCode: pendingResult && pendingResult.caught ? pendingResult.caught.code : null,
      });
      cleanup.deregistration = seam.deregister();
      try {
        const db = await import("../../../dist/db/index.js");
        db.closeDb();
        cleanup.dbClosed = true;
      } catch (err) {
        cleanup.cleanupError = String(err && err.message ? err.message : err);
      }
      // The owned sync worker-log fd is never closed by current behaviour
      // (a plain fs fd does not reference the event loop); its OPEN state is
      // recorded, not changed.
      // Dispose ONLY the captured exact handle through ordinary cleanup.
      let timerCleared = false;
      if (timer.capturedHandle) {
        clearInterval(timer.capturedHandle);
        timerCleared = true;
      }
      diag("timer-captured", {
        timerUrl: timer.url,
        timerSourceLine: timer.sourceLine,
        timerInstallations: timer.installations,
        timerCreations: timer.creations,
        timerDelay: timer.delay,
        timerCallbackName: timer.callbackName,
        timerHasRefAtCapture: timer.hasRefAtCapture,
        timerDeregistered: timer.deregistered,
      });
      diag("after-cleanup", {
        deregistration: cleanup.deregistration,
        dbClosed: cleanup.dbClosed,
        cleanupError: cleanup.cleanupError,
        logFdOpen: __aadLogFd !== null,
        timerCaptured: timer.capturedHandle !== null,
        timerCleared,
      });
      if (pendingResult) {
        // Report the ACTUAL cleanup outcome with the observation; the parent
        // requires a supported deregistration shape and a completed close.
        const timerOk =
          timer.installations === 1 &&
          timer.creations === 1 &&
          timer.capturedHandle !== null &&
          timer.deregistered &&
          timerCleared; // cleared above, before this send
        const cleanupOk =
          cleanup.deregistration !== "unsupported" &&
          cleanup.dbClosed &&
          !cleanup.cleanupError &&
          timerOk;
        process.exitCode =
          pendingResult.type === "enoent-observed" && pendingResult.rowAbsent && cleanupOk
            ? 0
            : 6;
        // OWN THE FINAL IPC LIFECYCLE: send the observation/cleanup payload
        // with a COMPLETION CALLBACK, then explicitly DISCONNECT the
        // worker's IPC channel — an open fork channel references the event
        // loop and defeated the previous natural exit. No forced exit is
        // used as cleanup proof; a send/disconnect error records a nonzero
        // code and is reported, not retried.
        send(
          {
            ...pendingResult,
            cleanup: {
              ...cleanup,
              timerCaptured: timer.capturedHandle !== null,
              timerCleared,
              timerInstallations: timer.installations,
              timerCreations: timer.creations,
            },
          },
          (sendErr) => {
          diag("send-callback", {
            sendError: sendErr ? String(sendErr && sendErr.message ? sendErr.message : sendErr) : null,
          });
          if (sendErr) {
            say(`final IPC send error: ${String(sendErr && sendErr.message ? sendErr.message : sendErr)}`);
            process.exitCode = 8;
            return;
          }
          try {
            if (process.connected) process.disconnect();
            diag("after-disconnect", { disconnectOutcome: "returned" });
          } catch (err) {
            diag("after-disconnect", {
              disconnectOutcome: `error:${String(err && err.message ? err.message : err)}`,
            });
            say(
              `IPC disconnect error: ${String(err && err.message ? err.message : err)}`,
            );
            process.exitCode = 8;
          }
        });
      } else {
        process.exitCode = 7; // no observation produced — cleanup still ran
      }
    }
  }

  throw new Error(`unknown subcommand: ${cmd}`);
}

main().catch((err) => {
  send({ type: "worker-error", message: String(err && err.stack ? err.stack : err) });
  process.exit(1);
});
