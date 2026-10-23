import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { and, desc, eq, getTableColumns } from "drizzle-orm";

const [installed, databasePath, reportPath, mode] = process.argv.slice(2);
const load = relative => import(pathToFileURL(join(installed, "dist", relative)).href);
const report = { mode, currentError: null, originalError: null };
let database;
const habitatId = "native-startup-habitat";
const at = "2026-01-01T00:00:00.000Z";
const indexNames = ["idx_notification_attempts_created_order",
  "idx_notification_attempts_channel_created_order", "idx_notification_deliveries_scope_lookup"];

function seedNotifications(sqlite) {
  sqlite.prepare("INSERT OR IGNORE INTO habitats(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(habitatId, "Native startup", at, at);
  sqlite.prepare(`INSERT INTO notification_events
    (id,habitat_id,event_type,source_type,severity,title,body,payload,created_by_type,created_at)
    VALUES('startup-event',?,'task.assigned','task','info','Startup','Stored event','{}','system',?)`)
    .run(habitatId, at);
  sqlite.prepare(`INSERT INTO notification_deliveries
    (id,event_id,habitat_id,recipient_type,recipient_id,channels,created_at,updated_at)
    VALUES('startup-delivery','startup-event',?,'human','fixture-human','["slack"]',?,?)`)
    .run(habitatId, at, at);
  for (const id of ["startup-a", "startup-z"]) {
    sqlite.prepare(`INSERT INTO notification_delivery_attempts
      (id,delivery_id,channel,status,attempt,status_code,error,response_body,created_at)
      VALUES(?,'startup-delivery','slack','failed',2,503,'Stored failure','Stored response',?)`).run(id, at);
  }
}
function seedBlockingDuplicates(sqlite) {
  sqlite.prepare("INSERT INTO habitats(id,name,created_at,updated_at) VALUES(?,?,?,?)")
    .run(habitatId, "Deferred native startup", at, at);
  for (const id of ["startup-duplicate-a", "startup-duplicate-b"]) {
    sqlite.prepare(`INSERT INTO pulses(id,habitat_id,from_type,from_id,signal_type,subject,metadata)
      VALUES(?,?,'agent','system','finding',?,'{}')`).run(`${id}-pulse`, habitatId, id);
    sqlite.prepare(`INSERT INTO finding_triage
      (id,habitat_id,pulse_id,cluster_key,finding_kind,status,created_at,updated_at)
      VALUES(?,?,?,'startup-duplicate','bug','open',?,?)`).run(id, habitatId, `${id}-pulse`, at, at);
  }
}

try {
  database = await load("db/index.js");
  const journalPath = join(installed, "drizzle", "meta", "_journal.json");
  const fullJournal = JSON.parse(readFileSync(journalPath, "utf-8"));
  const indexWatermark = fullJournal.entries.find(entry => entry.tag === "0085_notification_monitor_query_indexes");
  if (mode === "post-push-before-indexes" || mode === "upgrade-indexes") {
    if (!indexWatermark) throw new Error("Missing index migration watermark in fixture journal");
    // An install from before the index migration also predates every later
    // journal entry — strip the whole tail (any count), not just 0085.
    writeFileSync(journalPath, JSON.stringify({ ...fullJournal,
      entries: fullJournal.entries.filter(entry => entry.when < indexWatermark.when) }));
  } else if (mode === "dirty-additive-startup") {
    const watermark = fullJournal.entries.find(entry => entry.tag === "0067_release_projection_epochs");
    if (!watermark) throw new Error("Missing additive watermark in fixture journal");
    writeFileSync(journalPath, JSON.stringify({ ...fullJournal,
      entries: fullJournal.entries.filter(entry => entry.when <= watermark.when) }));
    await database.initDb(databasePath);
    seedBlockingDuplicates(database.getDb().$client);
    database.closeDb();
    writeFileSync(journalPath, JSON.stringify(fullJournal));
  } else throw new Error(`Unknown startup fixture mode ${mode}`);

  await database.initDb(databasePath);
  const db = database.getDb();
  const sqlite = db.$client;
  report.journalMode = sqlite.pragma("journal_mode", { simple: true });
  report.indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN (?,?,?)")
    .all(...indexNames).map(row => row.name);
  report.attemptColumns = sqlite.prepare("PRAGMA table_info(notification_delivery_attempts)").all().map(row => row.name);
  if (mode === "dirty-additive-startup") {
    report.attestation = sqlite.prepare("SELECT clean,anomaly_report FROM migration_preflight_attestations WHERE enforcement_migration_id='0068_finding_triage_lifecycle_enforcement'").get();
  }
  seedNotifications(sqlite);
  const schema = await load("db/schema/index.js");
  // Exact pre-optimization projection as a compatibility control, not a work measurement.
  try {
    report.originalRows = db.select(getTableColumns(schema.notificationDeliveryAttempts))
      .from(schema.notificationDeliveryAttempts)
      .innerJoin(schema.notificationDeliveries, eq(schema.notificationDeliveryAttempts.deliveryId, schema.notificationDeliveries.id))
      .where(and(eq(schema.notificationDeliveries.habitatId, habitatId), eq(schema.notificationDeliveryAttempts.channel, "slack")))
      .orderBy(desc(schema.notificationDeliveryAttempts.createdAt), desc(schema.notificationDeliveryAttempts.id))
      .limit(2).all();
  } catch (error) { report.originalError = error.message; }
  const reader = await load("repositories/notificationDeliveryAttempt.js");
  try { report.currentRows = reader.getDeliveryAttemptsByHabitat(habitatId, { channel: "slack", limit: 2 }); }
  catch (error) { report.currentError = error.message; }
  if (mode === "upgrade-indexes") {
    if (!indexWatermark) throw new Error("Missing index migration in full fixture journal");
    const ledger = connection => connection.prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
    const attempts = connection => connection.prepare("SELECT * FROM notification_delivery_attempts ORDER BY id").all();
    // Every journal entry at or after the watermark upgrades in one reopen —
    // derived from the journal, so later migrations join the tail without a
    // fixture edit.
    const expectedLedger = fullJournal.entries
      .filter(entry => entry.when >= indexWatermark.when)
      .map(entry => ({ hash: createHash("sha256").update(readFileSync(join(installed, "drizzle", `${entry.tag}.sql`))).digest("hex"), created_at: entry.when }));
    const upgrade = report.upgrade = {
      beforeRows: attempts(sqlite), beforeLedger: ledger(sqlite),
      expectedLedger,
    };
    database.closeDb();
    writeFileSync(journalPath, JSON.stringify(fullJournal));
    await database.initDb(databasePath);
    const upgraded = database.getDb().$client;
    upgrade.afterRows = attempts(upgraded);
    upgrade.afterLedger = ledger(upgraded);
    upgrade.indexes = Object.fromEntries(indexNames.map(name => [name,
      upgraded.prepare(`PRAGMA index_info('${name}')`).all().map(row => row.name)]));
    upgrade.upgradedRows = reader.getDeliveryAttemptsByHabitat(habitatId, { channel: "slack", limit: 2 });
    database.closeDb();
    await database.initDb(databasePath);
    upgrade.reopenedLedger = ledger(database.getDb().$client);
    upgrade.reopenedRows = reader.getDeliveryAttemptsByHabitat(habitatId, { channel: "slack", limit: 2 });
  }
  database.closeDb();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.exit(0);
} catch (error) {
  database?.closeDb();
  report.fixtureError = { message: error.message, stack: error.stack };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(error);
  process.exit(1);
}
