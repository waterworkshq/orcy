/** Test-only native process. Every product import comes from this suite's fresh compiled dist. */
import { writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, databasePath, action, encodedOptions] = process.argv.slice(2);
const options = JSON.parse(encodedOptions);
const load = (relative) => import(pathToFileURL(join(dist, relative)).href);
const writeRecord = (path, record) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
  renameSync(`${path}.tmp`, path);
};
let closeDb;
try {
  const database = await load("db/index.js");
  closeDb = database.closeDb;
  await database.initDb(databasePath);
  const db = database.getDb();
  const sqlite = db.$client;
  if (!sqlite || typeof sqlite.prepare !== "function") throw new Error("Expected a native better-sqlite3 client");
  const recovery = await load("services/scheduledOccurrenceRecovery.js");
  const workerId = recovery.createRecoveryWorkerId();
  const proof = {
    pid: process.pid, workerId, dist, databasePath,
    journalMode: sqlite.pragma("journal_mode", { simple: true }),
    busyTimeout: sqlite.pragma("busy_timeout", { simple: true }),
    sqliteVersion: sqlite.prepare("SELECT sqlite_version() AS version").get().version,
  };
  const originalPrepare = sqlite.prepare.bind(sqlite);
  const occurrence = () => originalPrepare("SELECT * FROM scheduled_occurrences WHERE scheduled_task_id = ?").get(options.scheduleId);
  let paused = false;
  function pause(phase, extra = {}) {
    if (paused) return;
    paused = true;
    writeRecord(options.marker, { ...proof, phase, inTransaction: sqlite.inTransaction, occurrence: occurrence(), ...extra });
    const deadline = Date.now() + 20_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(options.release)) {
      if (Date.now() > deadline) throw new Error(`Timed out at native barrier ${phase}`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }

  // Actual native read/claim return boundaries. Execute the real statement
  // first and preserve its real return value; never substitute candidate rows.
  sqlite.prepare = function (source) {
    const statement = originalPrepare(source);
    if (options.barrier === "scan" && /^\s*select\b/i.test(source) && source.includes('"scheduled_occurrences"') &&
        source.includes(" is null") && source.includes("order by")) {
      const all = statement.all.bind(statement);
      statement.all = function (...bindings) {
        const rows = all(...bindings);
        if (rows.length > 0) pause("native_reserved_scan_returned", { sql: source, bindings, nativeRowCount: rows.length });
        return rows;
      };
    }
    if (options.barrier === "claim" && /^\s*update\s+"scheduled_occurrences"/i.test(source)) {
      const run = statement.run.bind(statement);
      statement.run = function (...bindings) {
        const result = run(...bindings);
        const row = occurrence();
        if (result.changes === 1 && row?.state === "publishing" && row.lease_owner === workerId) {
          pause("native_initial_claim_committed", { sql: source, bindings, nativeChanges: result.changes });
        }
        return result;
      };
    }
    return statement;
  };
  if (options.barrier === "commit") {
    const run = db.run.bind(db);
    db.run = function (query, ...rest) {
      const text = db.dialect.sqlToQuery(query.getSQL?.() ?? query).sql;
      const result = run(query, ...rest);
      if (/^\s*COMMIT\s*;?\s*$/i.test(text) && occurrence()?.state === "reserved") {
        pause("reservation_COMMIT_returned", { sql: text });
      }
      return result;
    };
  }

  const registry = await load("repositories/scheduledHandlerRegistry.js");
  const handlerKey = "reserved-native-counter-handler";
  registry.registerScheduledTaskHandler(handlerKey, (schedule) => {
    sqlite.prepare("INSERT INTO fixture_handler_invocations (schedule_id, worker_pid) VALUES (?, ?)").run(schedule.id, process.pid);
    return { success: true };
  });

  let result;
  if (action === "seed") {
    const habitats = await load("repositories/habitat.js");
    const columns = await load("repositories/column.js");
    const schedules = await load("repositories/scheduledTask.js");
    const templates = await load("repositories/template.js");
    const habitat = habitats.createHabitat({ name: `Native recovery ${options.caseName}` });
    columns.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
    sqlite.exec("CREATE TABLE fixture_handler_invocations (id INTEGER PRIMARY KEY, schedule_id TEXT NOT NULL, worker_pid INTEGER NOT NULL)");
    const task = { title: "Native recovery task", description: "native proof", priority: "medium", order: 0 };
    const template = options.shape === "template" ? templates.createTemplate({
      habitatId: habitat.id, name: `Native template ${options.caseName}`, titlePattern: "Native recovered mission",
      descriptionPattern: "Native proof", priority: "medium", tasksTemplate: [task], createdBy: "native-test",
    }) : undefined;
    const schedule = schedules.createScheduledTask({ habitatId: habitat.id, name: `Native schedule ${options.caseName}`,
      scheduleType: options.scheduleType, scheduledAt: options.scheduleType === "once" ? "2000-01-01T00:00:00.000Z" : null,
      intervalMinutes: options.scheduleType === "interval" ? 60 : null, nextRunAt: "2000-01-01T00:00:00.000Z",
      missionTitle: "Native recovered mission", missionDescription: "Native proof", createdBy: "native-test",
      templateId: template?.id, handlerKey: options.shape === "handler" ? handlerKey : null,
      tasksTemplate: options.shape === "inline" ? [task] : [],
    });
    result = { scheduleId: schedule.id, habitatId: habitat.id };
  } else if (action === "publish" || action === "replay") {
    const service = await load("services/scheduledTaskService.js");
    // Explicit service-seam authorization stub: this is a liveness/race proof,
    // not HTTP authentication or authorization evidence.
    result = options.entry === "poll" && action !== "replay"
      ? service.executeScheduledTask(options.scheduleId)
      : service.runScheduledTaskNow(options.scheduleId, () => {}, {
        actorId: "native-manual-actor", expectedScheduledFor: "2000-01-01T00:00:00.000Z",
      });
  } else if (action === "recover") {
    result = recovery.recoverReservedOccurrences({ leaseOwner: workerId, ...options.recoveryOptions });
  } else if (action === "expired") {
    result = recovery.recoverExpiredOccurrenceLeases({ leaseOwner: workerId, ...options.recoveryOptions });
  } else {
    throw new Error(`Unsupported native action: ${action}`);
  }
  closeDb();
  closeDb = undefined;
  writeRecord(options.output, { ...proof, result });
} catch (error) {
  try { closeDb?.(); } catch { /* Preserve the original failure. */ }
  writeRecord(options.output, { pid: process.pid, error: error?.stack ?? String(error) });
  process.exitCode = 1;
}

// Product imports can retain background timers. Results are synchronously
// persisted and the database is closed before this fixture-owned exit.
process.exit(process.exitCode ?? 0);
