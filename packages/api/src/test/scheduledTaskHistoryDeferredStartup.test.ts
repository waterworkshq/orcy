import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { closeDb, getDb, initDb } from "../db/index.js";
import { ADDITIVE_WATERMARK_TAG, ENFORCEMENT_MIGRATION_TAG, TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE } from "../db/stagedMigrations.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import * as schedules from "../repositories/scheduledTask.js";
import { editScheduledTask } from "../services/scheduledTaskEditing.js";
import { originalOnceEntitlement } from "./fixtures/scheduled-task-entitlement-original.js";

vi.setConfig({ testTimeout: 60_000 });
const DRIZZLE_DIR = join(import.meta.dirname, "..", "..", "drizzle");
let ownedDirectory: string | undefined;

function preparePreWatermarkDirtyDatabase(file: string) {
  // Same production-ledger fixture idiom as stagedEnforcementMigration: the
  // actual initDb runner must encounter a blocking preflight, not a dropped
  // summary table or a stubbed migration response on an otherwise fresh DB.
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const through = journal.entries.findIndex(({ tag }) => tag === "0063_learning_loop_ledger");
  expect(through).toBeGreaterThan(0);
  const native = new Database(file);
  try {
    native.pragma("journal_mode = WAL");
    native.pragma("foreign_keys = ON");
    native.pragma("busy_timeout = 5000");
    native.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)");
    const record = native.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
    for (const entry of journal.entries.slice(0, through + 1)) {
      const text = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
      for (const statement of text.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) native.exec(statement);
      record.run(createHash("sha256").update(text).digest("hex"), entry.when);
    }
    native.transaction(() => {
      native.prepare("INSERT INTO habitats (id,name) VALUES ('deferred-history-hab','Deferred history')").run();
      for (const id of ["deferred-duplicate-1", "deferred-duplicate-2"]) {
        native.prepare(`INSERT INTO pulses (id,habitat_id,from_type,from_id,signal_type,subject,metadata)
          VALUES (?, 'deferred-history-hab', 'agent', 'system', 'finding', ?, '{}')`).run(`pulse-${id}`, id);
        native.prepare(`INSERT INTO finding_triage
          (id,habitat_id,pulse_id,cluster_key,finding_kind,status,created_at,updated_at)
          VALUES (?, 'deferred-history-hab', ?, 'duplicate-active-cluster', 'bug', 'open', '2000-01-01', '2000-01-01')`)
          .run(id, `pulse-${id}`);
      }
      native.prepare(`INSERT INTO scheduled_tasks
        (id,habitat_id,name,schedule_type,scheduled_at,next_run_at,mission_title,mission_labels,tasks_template,created_by,enabled,run_count)
        VALUES ('deferred-once','deferred-history-hab','Before','once','2090-01-01T00:00:00.000Z',
          '2090-01-01T00:00:00.000Z','Deferred once','[]','[]','deferred-test',0,1)`).run();
      native.prepare(`INSERT INTO scheduled_occurrences
        (id,scheduled_task_id,scheduled_for,ordinal,schedule_revision,state)
        VALUES ('deferred-old-once','deferred-once','2000-01-01T00:00:00.000Z',0,'{"scheduleType":"once"}','rejected')`).run();
    })();
  } finally { native.close(); }
}

afterEach(() => {
  closeDb();
  if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
  ownedDirectory = undefined;
});

describe("scheduled history during deferred production migration", () => {
  it("keeps unavailable summary storage unknown while permitting metadata and refusing one-shot rearming", async () => {
    ownedDirectory = mkdtempSync(join(tmpdir(), "orcy-history-deferred-"));
    const file = join(ownedDirectory, "deferred.db");
    preparePreWatermarkDirtyDatabase(file);
    await initDb(file);
    const db = getDb();
    const native = (db as typeof db & { $client: Database.Database }).$client;
    const attestation = native.prepare(`SELECT clean, anomaly_report FROM migration_preflight_attestations
      WHERE enforcement_migration_id = ?`).get(ENFORCEMENT_MIGRATION_TAG) as { clean: number; anomaly_report: string };
    expect(attestation.clean).toBe(0);
    const report = JSON.parse(attestation.anomaly_report);
    expect(report.code).toBe(TRIAGE_ENFORCEMENT_PREFLIGHT_DIRTY_CODE);
    expect(report.blockingAnomalies).toEqual(expect.arrayContaining([expect.objectContaining({ code: "active_identity_duplicate" })]));
    const ledger = native.prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all();
    const watermarkHash = createHash("sha256").update(readFileSync(join(DRIZZLE_DIR, `${ADDITIVE_WATERMARK_TAG}.sql`))).digest("hex");
    expect(ledger.at(-1)).toMatchObject({ hash: watermarkHash });
    expect(native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_occurrences'").get()).toBeDefined();
    expect(native.prepare("SELECT name FROM sqlite_master WHERE name='scheduled_occurrence_history'").get()).toBeUndefined();
    const current = schedules.getScheduledTaskById("deferred-once")!;
    expect(current).toMatchObject({ enabled: false, runCount: 1, scheduleType: "once" });
    expect(originalOnceEntitlement(db, current)).toBe("consumed");
    const occurrences = native.prepare("SELECT * FROM scheduled_occurrences ORDER BY id").all();
    let snapshotParses = 0;
    native.function("json_valid", { deterministic: true }, (_snapshot: unknown) => {
      snapshotParses++;
      throw new Error("deferred summary storage must not fall back to a historical JSON scan");
    });
    const authorize = vi.fn();
    const saved = editScheduledTask(current.id, { name: "Authorized metadata" }, authorize);
    expect(authorize).toHaveBeenCalledExactlyOnceWith(current);
    expect(saved).toMatchObject({ name: "Authorized metadata", enabled: false, runCount: 1, nextRunAt: current.nextRunAt });
    if (process.env.ORCY_NATIVE_EVIDENCE_DIR) {
      mkdirSync(process.env.ORCY_NATIVE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.ORCY_NATIVE_EVIDENCE_DIR, `history-deferred-startup-${process.pid}.json`),
        `${JSON.stringify({ pid: process.pid, attestation, ledger, occurrences, saved,
          summaryStoragePresent: false, originalVerdict: "consumed", snapshotParses }, null, 2)}\n`);
    }

    let verdict: ReturnType<typeof getOnceEntitlementWithClient> | undefined;
    expect(() => { verdict = getOnceEntitlementWithClient(db, saved); }).not.toThrow();
    expect(verdict).toBe("unknown");
    for (const input of [{ scheduledAt: "2091-01-01T00:00:00.000Z" }, { enabled: true }]) {
      let failure: unknown;
      try { editScheduledTask(current.id, input, () => {}); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ statusCode: 409, code: "ONCE_SCHEDULE_HISTORY_UNKNOWN" });
      expect(schedules.getScheduledTaskById(current.id)).toEqual(saved);
    }
    expect(native.prepare("SELECT * FROM scheduled_occurrences ORDER BY id").all()).toEqual(occurrences);
    expect(native.prepare("SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at").all()).toEqual(ledger);
    expect(snapshotParses).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
