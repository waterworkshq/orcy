// Fixture tests for the read-only zod 4 stored-data audit script:
// - classifies stored timestamps accepted by zod 3 and rejected by zod 4
//   (missing seconds, colonless offset) and non-RFC 4122 UUID-shaped strings
// - operates via an online-backup snapshot on a live WAL-mode database without
//   modifying the source database and removes its temp snapshot afterward
// - prints counts only: never leaks stored values, row IDs, or identifiers in
//   human-readable or JSON output
// Run: node --test scripts/audit-zod4-stored-data.test.mjs (or pnpm test:scripts).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  auditDatabase,
  formatReport,
  isZod3Datetime,
} from "./audit-zod4-stored-data.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  fileURLToPath(new URL("./audit-zod4-stored-data.mjs", import.meta.url)),
);

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "orcy-zod4-audit-test-"));
}

test("isZod3Datetime matches zod 3 datetime and offset acceptance boundaries", () => {
  assert.equal(isZod3Datetime("2026-12-31T00:00Z"), true);
  assert.equal(isZod3Datetime("2026-12-31T00:00:00Z"), true);
  assert.equal(isZod3Datetime("2026-12-31T00:00:00.500Z"), true);
  assert.equal(isZod3Datetime("2026-12-31T00:00:00+0530"), false);
  assert.equal(isZod3Datetime("2026-12-31T00:00:00+0530", { offset: true }), true);
  assert.equal(isZod3Datetime("2026-12-31T00:00:00+05", { offset: true }), true);
  assert.equal(isZod3Datetime("2026-12-31T00:00+05:30", { offset: true }), true);
  assert.equal(isZod3Datetime("2026-02-29T00:00Z"), false);
  assert.equal(isZod3Datetime("2024-02-29T00:00Z"), true);
  assert.equal(isZod3Datetime("2026-05-01 00:00:00Z"), false);
  assert.equal(isZod3Datetime("2026-05-01"), false);
});

test("audits fixture DB counts accurately, reads live WAL commits, cleans snapshots, and never leaks values", async () => {
  const dir = makeTempDir();
  const snapTmp = join(dir, "snaps");
  const dbPath = join(dir, "fixture.db");
  const sentinelSecret = "TOP_SECRET_NOTE_987654";
  const badUuidA = "12345678-1234-1234-1234-123456789012";
  const badUuidB = "00000000-0000-0000-0000-000000000001";
  const goodUuid = "00000000-0000-4000-8000-000000000001";
  const nilUuid = "00000000-0000-0000-0000-000000000000";
  const secondslessUtc = "2026-12-31T00:00Z";
  const colonlessOffset = "2026-05-01T00:00:00+0530";
  const hourOnlyOffset = "2026-05-01T00:00:00+05";

  let liveWriter;
  try {
    liveWriter = new DatabaseSync(dbPath);
    liveWriter.exec("PRAGMA journal_mode = WAL;");
    liveWriter.exec(`
      CREATE TABLE remote_grants (
        id TEXT PRIMARY KEY,
        expires_at TEXT,
        note TEXT
      );
      CREATE TABLE habitat_events (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        payload_count INTEGER
      );
    `);

    const insertGrant = liveWriter.prepare(
      "INSERT INTO remote_grants (id, expires_at, note) VALUES (?, ?, ?)",
    );
    insertGrant.run(goodUuid, "2026-12-31T00:00:00Z", sentinelSecret);
    insertGrant.run(nilUuid, secondslessUtc, "ok");
    insertGrant.run(badUuidA, "not-a-timestamp", "bad id");

    // Leave writer connection open with freshly committed WAL rows (no manual checkpoint)
    const insertEvent = liveWriter.prepare(
      "INSERT INTO habitat_events (id, created_at, payload_count) VALUES (?, ?, ?)",
    );
    insertEvent.run(badUuidB, colonlessOffset, 42);
    insertEvent.run("00000000-0000-4000-8000-000000000002", hourOnlyOffset, 7);
    insertEvent.run("00000000-0000-4000-8000-000000000003", "2026-05-01T00:00:00+05:30", 9);

    const beforeVersion = liveWriter.prepare("PRAGMA data_version").get().data_version;

    // Provide a dedicated temp root so we can prove the snapshot directory is deleted
    const { mkdirSync } = await import("node:fs");
    mkdirSync(snapTmp, { recursive: true });

    const report = await auditDatabase(dbPath, { tempRoot: snapTmp });

    assert.equal(readdirSync(snapTmp).length, 0, "temporary snapshot directory must be deleted");
    assert.equal(report.snapshotCleaned, true);
    assert.equal(report.summary.tables, 2);
    assert.equal(report.summary.rowsScanned, 6);
    assert.equal(report.summary.timestampAtRiskColumns, 2);
    assert.equal(report.summary.timestampAtRiskTotal, 3);
    assert.deepEqual(report.summary.timestampAtRiskByShape, {
      noSeconds: 1,
      offsetWithoutColon: 2,
      other: 0,
    });
    assert.equal(report.summary.uuidAtRiskColumns, 2);
    assert.equal(report.summary.uuidAtRiskTotal, 2);

    const grantFinding = report.datetimeFindings.find(
      (f) => f.table === "remote_grants" && f.column === "expires_at",
    );
    assert.deepEqual(grantFinding, {
      table: "remote_grants",
      column: "expires_at",
      rows: 3,
      isoStored: 2,
      acceptedByV3: 2,
      rejectedByV4: 1,
      byShape: { noSeconds: 1, offsetWithoutColon: 0, other: 0 },
    });

    const eventFinding = report.datetimeFindings.find(
      (f) => f.table === "habitat_events" && f.column === "created_at",
    );
    assert.deepEqual(eventFinding, {
      table: "habitat_events",
      column: "created_at",
      rows: 3,
      isoStored: 3,
      acceptedByV3: 3,
      rejectedByV4: 2,
      byShape: { noSeconds: 0, offsetWithoutColon: 2, other: 0 },
    });

    const textOut = formatReport(report);
    assert.match(textOut, /remote_grants\.expires_at/);
    assert.match(textOut, /normalized on read by evaluateGrantTime/);

    // CLI text + JSON output must never leak any stored value or identifier
    const cliText = await execFileAsync(process.execPath, [scriptPath, dbPath]);
    const cliJson = await execFileAsync(process.execPath, [scriptPath, dbPath, "--json"]);
    const parsedJson = JSON.parse(cliJson.stdout);
    assert.equal(parsedJson.summary.uuidAtRiskTotal, 2);
    assert.equal(parsedJson.summary.timestampAtRiskTotal, 3);

    for (const output of [textOut, cliText.stdout, cliText.stderr, cliJson.stdout, cliJson.stderr]) {
      for (const forbidden of [
        sentinelSecret,
        badUuidA,
        badUuidB,
        goodUuid,
        nilUuid,
        secondslessUtc,
        colonlessOffset,
        hourOnlyOffset,
      ]) {
        assert.equal(
          output.includes(forbidden),
          false,
          `audit output must not contain stored value or identifier: ${forbidden}`,
        );
      }
    }

    // Source database remains unmodified by the read-only snapshot audit
    const afterVersion = liveWriter.prepare("PRAGMA data_version").get().data_version;
    assert.equal(afterVersion, beforeVersion);
    const grantCount = liveWriter.prepare("SELECT COUNT(*) AS n FROM remote_grants").get().n;
    const eventCount = liveWriter.prepare("SELECT COUNT(*) AS n FROM habitat_events").get().n;
    assert.equal(grantCount, 3);
    assert.equal(eventCount, 3);
  } finally {
    liveWriter?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handles a clean database with zero at-risk counts", async () => {
  const dir = makeTempDir();
  const dbPath = join(dir, "clean.db");
  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE items (id TEXT, updated_at TEXT);");
    db.prepare("INSERT INTO items VALUES (?, ?)").run(
      "00000000-0000-4000-8000-000000000001",
      "2026-05-01T12:34:56Z",
    );
    db.close();
    db = undefined;

    const report = await auditDatabase(dbPath);
    assert.equal(report.summary.timestampAtRiskTotal, 0);
    assert.equal(report.summary.uuidAtRiskTotal, 0);
    assert.equal(report.datetimeFindings.length, 0);
    assert.equal(report.uuidFindings.length, 0);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exits non-zero without creating a file when the database path is missing", async () => {
  const dir = makeTempDir();
  const missingPath = join(dir, "does-not-exist.db");
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [scriptPath, missingPath]),
      (err) => err.code === 2 && /not found/i.test(err.stderr),
    );
    assert.equal(readdirSync(dir).length, 0, "must not create a missing database file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
