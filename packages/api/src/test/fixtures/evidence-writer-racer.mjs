/**
 * evidence-writer-racer.mjs — the competing writer for the REAL native
 * selected-interval proof (repair grant §5).
 *
 * Spawned BY the parent test (child_process.fork) with argv:
 *   [0] dbPath — a private temp-file SQLite database the parent seeded
 *   [1] dir    — the milestone directory shared with the parent
 *
 * File-milestone protocol (explicit barriers; no timing/duration claims):
 *   ready  — worker wrote it after opening its OWN connection with
 *            PRAGMA busy_timeout = 0
 *   go1    — parent wrote it INSIDE its synchronous report-bundle
 *            transaction callback, immediately AFTER the under-reservation
 *            candidate reread (selected record read completed) and BEFORE
 *            any report INSERT/UPDATE
 *   sel    — parent's milestone recording the selected existing record id
 *            read under the reservation (the observation anchor)
 *   r1     — worker's phase-1 result: its BEGIN IMMEDIATE attempt outcome
 *            with stage/code preserved (SQLITE_BUSY at acquisition is the
 *            expected fence outcome; any other error is reported as itself,
 *            never relabeled contention)
 *   go2    — parent wrote it AFTER its report callback returned and
 *            committed
 *   r2     — worker's phase-2 result: the same legitimate sentinel INSERT +
 *            COMMIT must now succeed
 *
 * The sentinel write targets `code_evidence_links` with complete mandatory
 * fields and no provider/network path. On EVERY exit path (success or
 * error) the worker closes its own connection, flushes its final IPC
 * message through the send callback, disconnects, clears its fallback
 * timer/listeners and exits naturally — process.exit is not used.
 */
import { writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const [dbPath, dir] = process.argv.slice(2);

function publish(file, payload) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
}

function waitFor(file, deadlineMs) {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > deadlineMs) {
      throw new Error(`barrier timeout waiting for ${file}`);
    }
  }
  return readFileSync(file, "utf-8");
}

function describeSqliteError(err) {
  return {
    name: err && err.name ? err.name : null,
    code: err && err.code ? err.code : null,
    message: err && err.message ? err.message : String(err),
  };
}

function writeResult(db, dir, phase1) {
  const phase2 = {
    phase: 2,
    beginError: null,
    insertError: null,
    commitError: null,
    inserted: false,
    committed: false,
  };
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    phase2.beginError = describeSqliteError(err);
  }
  if (!phase2.beginError) {
    try {
      db.prepare(
        `INSERT INTO code_evidence_links (
           id, target_type, target_id, evidence_type, evidence_id,
           external_url, normalized_external_url, title, description,
           link_source, link_sources, linked_by_type, linked_by_id, linked_at,
           verification_state, confidence, status, corrected_by_type,
           corrected_by_id, corrected_at, correction_reason, replacement_link_id,
           allow_external_repository, metadata
         ) VALUES (
           'racer-sentinel', 'task', 'racer-sentinel-target', 'commit', NULL,
           NULL, NULL, 'racer sentinel', NULL,
           'agent_reported', '["agent_reported"]', 'agent', 'racer-worker',
           datetime('now'),
           'unverified', 0.5, 'active', NULL,
           NULL, NULL, NULL, NULL,
           0, '{}'
         )`,
      ).run();
      phase2.inserted = true;
    } catch (err) {
      phase2.insertError = describeSqliteError(err);
    }
    if (phase2.inserted) {
      try {
        db.exec("COMMIT");
        phase2.committed = true;
      } catch (err) {
        phase2.commitError = describeSqliteError(err);
      }
    } else {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* rollback of an unmodified transaction */
      }
    }
  }
  publish(join(dir, "r2"), JSON.stringify({ phase1Stage: phase1, ...phase2 }));
}

async function main(dbPath, dir) {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    publish(join(dir, "ready"), "1");

    // Phase 1: attempt BEGIN IMMEDIATE while the parent's report bundle
    // holds the write reservation. busy_timeout=0 = fail at acquisition.
    waitFor(join(dir, "go1"), 15000);
    const phase1 = { phase: 1, stage: null, beginError: null };
    try {
      db.exec("BEGIN IMMEDIATE");
      phase1.stage = "begin-ok";
    } catch (err) {
      phase1.stage = "begin";
      phase1.beginError = describeSqliteError(err);
    }
    publish(join(dir, "r1"), JSON.stringify(phase1));
    if (phase1.stage === "begin-ok") {
      // Unexpected during phase 1 (the parent should still hold the
      // reservation). Record it honestly and roll back — the parent's
      // assertion decides; a deferred parent transaction lands here.
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
    }

    publish(join(dir, "phase1-rollback-ack"), phase1.stage);

    // Phase 2: after the parent's commit, the same legitimate sentinel
    // write must succeed end to end.
    waitFor(join(dir, "go2"), 15000);
    writeResult(db, dir, phase1.stage);
  } finally {
    // Cleanup on EVERY path: close the owned connection first.
    try {
      db.close();
    } catch {
      /* connection already closed by an earlier failure */
    }
  }

  // Final IPC must flush before disconnect; then a natural return exits 0.
  await new Promise((resolve, reject) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send({ done: true }, undefined, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  if (process.connected) {
    // Await the REAL disconnect event; the safety timer is cleared on settle
    // so no fallback completion can stand in for the observed disconnect.
    await new Promise((resolve, reject) => {
      const onDisconnect = () => {
        clearTimeout(timer);
        process.removeListener("disconnect", onDisconnect);
        resolve();
      };
      const timer = setTimeout(() => {
        process.removeListener("disconnect", onDisconnect);
        reject(new Error("reviewer-worker-disconnect-deadline"));
      }, 2000);
      process.once("disconnect", onDisconnect);
      process.disconnect();
    });
  }
}

if (!dbPath || !dir) {
  console.error("evidence-writer-racer: dbPath and milestone dir are required");
  process.exitCode = 2;
} else {
  main(dbPath, dir).catch((err) => {
    console.error("evidence-writer-racer:", err);
    process.exitCode = 1;
    if (process.connected) {
      try {
        process.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  });
}
