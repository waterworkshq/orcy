import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join, relative, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const [packageDir, databaseFile, mode, inputsJson = "[]"] = process.argv.slice(2);
const migrationDir = fs.realpathSync(join(packageDir, "drizzle"));
const journalFile = join(migrationDir, "meta", "_journal.json");
assert(!fs.lstatSync(join(packageDir, "drizzle")).isSymbolicLink());
const rawReadFile = fs.readFileSync;
const migrationSql = rawReadFile(join(migrationDir, "0084_scheduled_occurrence_history.sql"), "utf8");
const backfills = migrationSql.split("--> statement-breakpoint").map((statement) => statement.trim())
  .filter((statement) => statement.includes("count(DISTINCT ordinal)") && statement.includes("GROUP BY scheduled_task_id"));
assert.equal(backfills.length, 1);
const backfill = backfills[0];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const emit = (message) => {
  if (process.env.ORCY_NATIVE_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.ORCY_NATIVE_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(join(process.env.ORCY_NATIVE_EVIDENCE_DIR,
      `history-upgrade-worker-${process.pid}-${mode}-${message.type}.json`), `${JSON.stringify(message, null, 2)}\n`);
  }
  fs.writeSync(3, `${JSON.stringify(message)}\n`);
};
const at = (file) => import(pathToFileURL(join(packageDir, "dist", file)).href);
let tracking = false;
const migrationReads = [];
let backfillExecutions = 0;
let closeDb;
const originalPrepare = Database.prototype.prepare;

function readsAreOwned() {
  return migrationReads.length > 0 && migrationReads.includes(journalFile) && migrationReads.every((file) => {
    const child = relative(migrationDir, file);
    return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
  });
}

// Observe actual production migration file reads without changing their bytes,
// return values or the staged runner. The compiled module imports this public
// builtin after its ESM bindings are synchronized.
fs.readFileSync = function (file, ...args) {
  if (tracking && typeof file === "string" && /[/\\]drizzle[/\\](?:meta[/\\]_journal\.json|\d{4}_[^/\\]+\.sql)$/.test(file)) {
    migrationReads.push(fs.realpathSync(file));
  }
  return Reflect.apply(rawReadFile, this, [file, ...args]);
};
syncBuiltinESMExports();

Database.prototype.prepare = function (text, ...args) {
  const connection = this;
  const statement = Reflect.apply(originalPrepare, connection, [text, ...args]);
  if (text === backfill) {
    const run = statement.run;
    statement.run = function (...params) {
      const result = Reflect.apply(run, this, params);
      backfillExecutions++;
      assert(connection.inTransaction, "the actual backfill must run inside the production writer transaction");
      assert(readsAreOwned(), "production migration reads escaped the owned copy");
      if (mode === "pause") {
        const count = Reflect.apply(originalPrepare, connection, ["SELECT count(*) AS n FROM scheduled_occurrence_history"]).get().n;
        assert(count > 0, "pause only after the real backfill has materialized seeded history");
        emit({ type: "BACKFILL", pid: process.pid, inTransaction: connection.inTransaction,
          summaryRows: count, backfillHash: sha(text), migrationFileHash: sha(migrationSql),
          selectedMigrationDir: migrationDir, allMigrationReadsOwned: readsAreOwned(),
          journalMode: connection.pragma("journal_mode", { simple: true }),
          busyTimeout: connection.pragma("busy_timeout", { simple: true }) });
        // Dedicated synchronous fd3 write is already delivered to the parent;
        // no process.send callback/event-loop progress is needed for the barrier.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("the paused migration must be terminated by its parent");
      }
      return result;
    };
  }
  return statement;
};

async function seedLegacy(native) {
  const habitats = await at("repositories/habitat.js");
  const schedules = await at("repositories/scheduledTask.js");
  const habitat = habitats.createHabitat({ name: "History upgrade" });
  const recurring = '{"scheduleType":"interval"}';
  const once = '{"scheduleType":"once"}';
  const specs = [
    { label: "complete", runCount: 3, rows: [[0, recurring], [1, '{"scheduleType":"cron"}'], [2, recurring]] },
    { label: "duplicates", runCount: 4, rows: [[0, recurring], [0, recurring], [0, recurring], [3, recurring]] },
    { label: "gap", runCount: 2, rows: [[0, recurring], [2, recurring]] },
    { label: "consumed", runCount: 0, rows: [[7, once], [0, "{"], [0, null]] },
    { label: "unknown", runCount: 2, rows: [[0, "{"], [1, null]] },
    { label: "odd", runCount: 3, rows: [[0, recurring], [0.5, recurring], [2, recurring]] },
    { label: "empty", runCount: 0, rows: [] },
    { label: "missing-count", runCount: 9, rows: [] },
    { label: "orphan", runCount: 0, rows: [[0, once], [2, "null"]], orphan: true },
  ];
  const insert = native.prepare(`INSERT INTO scheduled_occurrences
    (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision, state)
    VALUES (?, ?, ?, ?, ?, 'rejected')`);
  const inputs = [];
  native.transaction(() => {
    for (const spec of specs) {
      const schedule = spec.orphan ? { id: "retained-orphan-history" } : schedules.createScheduledTask({
        habitatId: habitat.id, name: spec.label, missionTitle: "Upgrade sentinel",
        scheduleType: "interval", intervalMinutes: 60, nextRunAt: "2090-01-01T00:00:00.000Z", createdBy: "upgrade-test",
      });
      spec.rows.forEach(([ordinal, revision], index) => insert.run(
        `${spec.label}-${index}`, schedule.id, `2000-${spec.label}-${index}`, ordinal, revision,
      ));
      if (!spec.orphan) native.prepare("UPDATE scheduled_tasks SET run_count = ? WHERE id = ?").run(spec.runCount, schedule.id);
      inputs.push({ id: schedule.id, runCount: spec.runCount, label: spec.label });
    }
  })();
  return inputs;
}

try {
  const dbModule = await at("db/index.js");
  closeDb = dbModule.closeDb;
  // The workspace branch would bypass our owned journal. Refuse before initDb
  // can touch any database if this compiled fixture is accidentally misplaced.
  assert(!fs.existsSync(join(dbModule.getWorkspaceRoot(), "packages", "api", "drizzle")));
  assert.equal(fs.realpathSync(resolve(packageDir, "dist", "db", "..", "..", "drizzle")), migrationDir);
  tracking = true;
  await dbModule.initDb(databaseFile);
  tracking = false;
  assert(readsAreOwned(), "actual initDb migration reads must come only from the owned directory");
  const db = dbModule.getDb();
  const native = db.$client;
  let inputs = JSON.parse(inputsJson);
  let results = [];
  if (mode === "legacy") {
    assert.equal(native.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='scheduled_occurrence_history'").get().n, 0);
    inputs = await seedLegacy(native);
  } else {
    const { getOnceEntitlementWithClient } = await at("repositories/scheduledTaskEntitlement.js");
    results = inputs.map((input) => ({ ...input, verdict: getOnceEntitlementWithClient(db, input) }));
  }
  const result = { type: "RESULT", pid: process.pid, inputs, results, backfillExecutions,
    selectedMigrationDir: migrationDir, allMigrationReadsOwned: readsAreOwned(),
    migrationReadCount: migrationReads.length, node: process.version,
    sqlite: native.prepare("SELECT sqlite_version() AS version").get().version,
    journalMode: native.pragma("journal_mode", { simple: true }),
    busyTimeout: native.pragma("busy_timeout", { simple: true }) };
  closeDb(); closeDb = undefined;
  emit(result);
} catch (error) {
  try { closeDb?.(); } catch {}
  emit({ type: "ERROR", pid: process.pid, message: error?.stack ?? String(error), cause: error?.cause?.stack });
  process.exitCode = 1;
} finally {
  Database.prototype.prepare = originalPrepare;
  fs.readFileSync = rawReadFile;
  syncBuiltinESMExports();
}
// Imported application modules may own background timers. All database work,
// synchronous protocol delivery and public-seam restoration are complete here.
process.exit(process.exitCode ?? 0);
