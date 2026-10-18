import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, file] = process.argv.slice(2);
const database = await import(pathToFileURL(join(installed, "dist/db/index.js")).href);
try {
  await database.initDb(file);
  const native = database.getDb().$client;
  assert.equal(native.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(native.pragma("busy_timeout", { simple: true }), 5000);
  assert.equal(native.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('task_review_requirements','role_definitions','scheduled_occurrence_history')").get().n, 0);
  database.closeDb();
  process.exit(0);
} catch (error) {
  database.closeDb();
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}
