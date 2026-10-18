import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [dist, file, id, mode, payload] = process.argv.slice(2);
const schema = await import(pathToFileURL(join(dist, "db/schema/index.js")).href);
const { sql } = await import("drizzle-orm");
const { editScheduledTask } = await import(pathToFileURL(join(dist, "services/scheduledTaskEditing.js")).href);
const { reserveScheduledOccurrenceWithClient } = await import(pathToFileURL(join(dist, "repositories/scheduledOccurrenceReservation.js")).href);
const sqlite = new Database(file);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");
const db = drizzle(sqlite, { schema });
let holding = false;
function finish(result) {
  sqlite.close();
  process.send?.({ type: "RESULT", ...result }, () => { process.disconnect(); process.exit(0); });
}
process.on("message", (message) => {
  try {
    if (message.type === "COMMIT" && holding) {
      db.run(sql`COMMIT`); holding = false; finish({ outcome: "committed" }); return;
    }
    if (message.type !== "GO") return;
    if (mode === "reserve") {
      db.run(sql`BEGIN IMMEDIATE`); holding = true;
      const result = reserveScheduledOccurrenceWithClient(db, {
        scheduleId: id, nextRunAt: "9999-12-31T23:59:59.000Z", now: "2026-10-18T12:00:00.000Z",
      });
      process.send?.({ type: "HELD", outcome: result.outcome });
    } else {
      process.send?.({ type: "ATTEMPT" });
      try {
        const saved = editScheduledTask(id, JSON.parse(payload), () => {}, db);
        finish({ status: 200, enabled: saved.enabled, nextRunAt: saved.nextRunAt });
      } catch (error) {
        finish({ status: error.statusCode ?? 500, code: error.code, error: error.message });
      }
    }
  } catch (error) {
    if (holding) { try { db.run(sql`ROLLBACK`); } catch {} holding = false; }
    finish({ status: 500, error: error.message });
  }
});
process.send?.({ type: "READY" });
