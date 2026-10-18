import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
const [dist, file, id, coordinate, mode, release] = process.argv.slice(2);
const moduleAt = (path) => import(pathToFileURL(join(dist, path)).href);
const { initDb, getDb, closeDb } = await moduleAt("db/index.js");
const { runScheduledTaskNow, executeScheduledTask } = await moduleAt("services/scheduledTaskService.js");
const { reserveScheduledOccurrenceWithClient } = await moduleAt("repositories/scheduledOccurrenceReservation.js");
const { publishInlineScheduledOccurrence } = await moduleAt("services/inlineScheduledOccurrencePublication.js");
const { sql } = await import("drizzle-orm");
// Parent has migrated; startup is sequential READY-before-next-worker, never
// concurrent migration noise in the actual reservation contention window.
await initDb(file);
let holding = false;
let occurrence;
function finish(result) {
  closeDb();
  process.send?.({ type: "RESULT", ...result }, () => { process.disconnect(); process.exit(0); });
}
function publishPoll() {
  const result = publishInlineScheduledOccurrence({ occurrenceId: occurrence.id, leaseOwner: "native-poll", leaseExpiresAt: new Date(Date.now() + 300000).toISOString() });
  finish({ outcome: result.outcome });
}
process.on("message", (message) => {
  try {
    if (message.type === "COMMIT" && holding) {
      getDb().run(sql`COMMIT`); holding = false; publishPoll(); return;
    }
    if (message.type !== "GO") return;
    process.send?.({ type: "ATTEMPT" });
    if (mode === "poll-hold") {
      getDb().run(sql`BEGIN IMMEDIATE`); holding = true;
      const reservation = reserveScheduledOccurrenceWithClient(getDb(), { scheduleId: id, nextRunAt: "9999-12-31T23:59:59.000Z" });
      if (reservation.outcome !== "created") throw new Error(`Poll fixture reservation: ${reservation.outcome}`);
      occurrence = reservation.occurrence;
      process.send?.({ type: "HELD", outcome: reservation.outcome });
    } else if (mode === "poll") {
      finish({ result: executeScheduledTask(id) });
    } else {
      const result = runScheduledTaskNow(id, () => {
        if (mode !== "manual-hold") return;
        process.send?.({ type: "HELD" });
        const end = Date.now() + 15000;
        const cell = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(release)) {
          if (Date.now() > end) throw new Error("Manual holder release timeout");
          Atomics.wait(cell, 0, 0, 10);
        }
      }, { expectedScheduledFor: coordinate, actorId: mode === "manual-hold" ? "native-first-human" : "native-second-human" });
      finish({ result });
    }
  } catch (error) {
    if (holding) { try { getDb().run(sql`ROLLBACK`); } catch {} holding = false; }
    finish({ status: error.statusCode ?? 500, code: error.code, error: error.message, cause: error.cause?.message });
  }
});
process.send?.({ type: "READY", pid: process.pid, journalMode: getDb().get(sql`PRAGMA journal_mode`)?.journal_mode, busyTimeout: getDb().get(sql`PRAGMA busy_timeout`)?.timeout });
