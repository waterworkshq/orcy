#!/usr/bin/env node

// Read-only pre-upgrade audit of stored SQLite values against zod 4's stricter
// UUID (RFC 4122 / 9562) and ISO datetime (seconds + colon offset required)
// validators.
//
// Takes a point-in-time consistent snapshot via SQLite's online backup API so
// it can inspect a live WAL-mode instance without writing to the database file,
// classifies text columns in memory, prints COUNTS ONLY (never a value, row
// id, or identifier), and deletes the temporary snapshot in a finally block.
//
// Usage:
//   node scripts/audit-zod4-stored-data.mjs <path-to-orcy.db> [--json]
//   DB_PATH=/path/to/orcy.db node scripts/audit-zod4-stored-data.mjs [--json]

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";

const requireFromApi = createRequire(
  new URL("../packages/api/package.json", import.meta.url),
);
const zod = requireFromApi("zod");
const zodPkg = requireFromApi("zod/package.json");

const v4DatetimeUtc = zod.string().datetime();
const v4DatetimeOffset = zod.string().datetime({ offset: true });
const v4Uuid = zod.string().uuid();

const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ZOD3_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Matches the grammar zod 3.25.x accepted for `z.string().datetime()` (UTC
 * only) or `z.string().datetime({ offset: true })`: optional seconds and, with
 * offsets enabled, optional colon/minutes in the timezone offset.
 */
export function isZod3Datetime(value, { offset = false } = {}) {
  const m = ZOD3_DATETIME.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const tz = m[8];

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (tz === "Z") return true;
  if (!offset) return false;

  const offHour = Number(m[10]);
  const offMinute = m[11] === undefined ? 0 : Number(m[11]);
  return offHour <= 23 && offMinute <= 59;
}

function quoteIdent(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`;
}

function classifyDatetimeRejection(raw) {
  if (!/T\d{2}:\d{2}:\d{2}/.test(raw)) return "noSeconds";
  if (/[+-]\d{2}(?:\d{2})?$/.test(raw)) return "offsetWithoutColon";
  return "other";
}

/**
 * Take a read-only online-backup snapshot of `sourcePath`, scan all text-like
 * columns in memory, and return a counts-only report with zero raw values or
 * identifiers.
 */
export async function auditDatabase(sourcePath, { tempRoot } = {}) {
  if (!sourcePath || typeof sourcePath !== "string") {
    throw new Error("A SQLite database path is required.");
  }
  const resolvedSource = resolve(sourcePath);
  if (!existsSync(resolvedSource)) {
    throw new Error(`Database file not found: ${resolvedSource}`);
  }
  if (!statSync(resolvedSource).isFile()) {
    throw new Error(`Database path is not a regular file: ${resolvedSource}`);
  }

  const baseTmp = tempRoot ? resolve(tempRoot) : tmpdir();
  const tempDir = mkdtempSync(join(baseTmp, "orcy-zod4-audit-"));
  const snapshotPath = join(tempDir, `snapshot-${process.pid}.db`);

  let src;
  let snap;
  try {
    src = new DatabaseSync(resolvedSource, { readOnly: true });
    await backup(src, snapshotPath);
    src.close();
    src = undefined;

    snap = new DatabaseSync(snapshotPath, { readOnly: true });
    const tables = snap
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));

    let rowsScanned = 0;
    let textColumns = 0;
    let timestampColumns = 0;
    let uuidColumns = 0;
    const datetimeFindings = [];
    const uuidFindings = [];

    for (const table of tables) {
      const cols = snap.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
      const textCols = cols.filter((c) => /TEXT|CHAR|CLOB|^$/i.test(String(c.type ?? "")));
      if (textCols.length === 0) continue;

      const rowCount = Number(
        snap.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n,
      );
      rowsScanned += rowCount;

      for (const col of textCols) {
        const colName = String(col.name);
        textColumns += 1;

        const stmt = snap.prepare(
          `SELECT ${quoteIdent(colName)} AS v FROM ${quoteIdent(table)} WHERE ${quoteIdent(colName)} IS NOT NULL`,
        );

        let isoStored = 0;
        let acceptedByV3 = 0;
        let rejectedByV4 = 0;
        const byShape = { noSeconds: 0, offsetWithoutColon: 0, other: 0 };

        let uuidShaped = 0;
        let uuidRejectedByV4 = 0;

        for (const row of stmt.iterate()) {
          const raw = row.v;
          if (typeof raw !== "string") continue;

          if (UUID_SHAPE.test(raw)) {
            uuidShaped += 1;
            if (!v4Uuid.safeParse(raw).success) {
              uuidRejectedByV4 += 1;
            }
            continue;
          }

          if (!ISO_LIKE.test(raw)) continue;
          isoStored += 1;

          const ok3 = isZod3Datetime(raw) || isZod3Datetime(raw, { offset: true });
          if (ok3) acceptedByV3 += 1;

          const ok4 =
            v4DatetimeUtc.safeParse(raw).success || v4DatetimeOffset.safeParse(raw).success;
          if (ok3 && !ok4) {
            rejectedByV4 += 1;
            const shape = classifyDatetimeRejection(raw);
            byShape[shape] += 1;
          }
        }

        if (isoStored > 0) {
          timestampColumns += 1;
          if (rejectedByV4 > 0) {
            datetimeFindings.push({
              table,
              column: colName,
              rows: rowCount,
              isoStored,
              acceptedByV3,
              rejectedByV4,
              byShape,
            });
          }
        }

        if (uuidShaped > 0) {
          uuidColumns += 1;
          if (uuidRejectedByV4 > 0) {
            uuidFindings.push({
              table,
              column: colName,
              uuidShaped,
              rejectedByV4: uuidRejectedByV4,
            });
          }
        }
      }
    }

    snap.close();
    snap = undefined;

    const timestampAtRiskByShape = datetimeFindings.reduce(
      (acc, f) => {
        acc.noSeconds += f.byShape.noSeconds;
        acc.offsetWithoutColon += f.byShape.offsetWithoutColon;
        acc.other += f.byShape.other;
        return acc;
      },
      { noSeconds: 0, offsetWithoutColon: 0, other: 0 },
    );

    return {
      zodVersion: String(zodPkg.version ?? "4.x"),
      summary: {
        tables: tables.length,
        textColumns,
        rowsScanned,
        timestampColumns,
        timestampAtRiskColumns: datetimeFindings.length,
        timestampAtRiskTotal: datetimeFindings.reduce((sum, f) => sum + f.rejectedByV4, 0),
        timestampAtRiskByShape,
        uuidColumns,
        uuidAtRiskColumns: uuidFindings.length,
        uuidAtRiskTotal: uuidFindings.reduce((sum, f) => sum + f.rejectedByV4, 0),
      },
      datetimeFindings,
      uuidFindings,
      snapshotCleaned: true,
    };
  } finally {
    if (src) {
      try {
        src.close();
      } catch {
        /* ignore close error during cleanup */
      }
    }
    if (snap) {
      try {
        snap.close();
      } catch {
        /* ignore close error during cleanup */
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function formatReport(report) {
  const { summary, datetimeFindings, uuidFindings, zodVersion } = report;
  const lines = [
    `zod 4 stored-data audit (counts only; installed zod ${zodVersion})`,
    `scanned: tables=${summary.tables} textColumns=${summary.textColumns} rows=${summary.rowsScanned}`,
    `timestamps: columnsWithIso=${summary.timestampColumns} atRiskColumns=${summary.timestampAtRiskColumns} rejectedByV4=${summary.timestampAtRiskTotal} shapes=${JSON.stringify(summary.timestampAtRiskByShape)}`,
  ];

  for (const f of datetimeFindings) {
    lines.push(
      `  AT RISK datetime ${f.table}.${f.column}: rejectedByV4=${f.rejectedByV4} acceptedByV3=${f.acceptedByV3} isoStored=${f.isoStored} rows=${f.rows} shapes=${JSON.stringify(f.byShape)}`,
    );
  }

  lines.push(
    `uuids: columnsWithUuid=${summary.uuidColumns} atRiskColumns=${summary.uuidAtRiskColumns} rejectedByV4=${summary.uuidAtRiskTotal}`,
  );

  for (const f of uuidFindings) {
    lines.push(
      `  AT RISK uuid ${f.table}.${f.column}: rejectedByV4=${f.rejectedByV4} uuidShaped=${f.uuidShaped}`,
    );
  }

  const hasGrantSecondsless = datetimeFindings.some(
    (f) =>
      f.table === "remote_grants" && f.column === "expires_at" && f.byShape.noSeconds > 0,
  );
  if (hasGrantSecondsless) {
    lines.push(
      "note: stored UTC minute-precision remote_grants.expires_at values are normalized on read by evaluateGrantTime; new API requests require seconds.",
    );
  }

  lines.push(`snapshot cleaned: ${report.snapshotCleaned ? "yes" : "no"}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  let dbPath = null;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--db") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("--db requires a path argument.");
      }
      dbPath = next;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (dbPath === null) {
      dbPath = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!dbPath && process.env.DB_PATH) {
    dbPath = process.env.DB_PATH;
  }

  return { dbPath, json, help };
}

function usage() {
  return [
    "Usage: node scripts/audit-zod4-stored-data.mjs <path-to-orcy.db> [--json]",
    "",
    "Read-only snapshot audit of stored SQLite values against zod 4's stricter",
    "UUID (RFC 4122 / 9562) and ISO datetime validators. Prints counts only;",
    "never outputs row values or identifiers.",
    "",
    "Options:",
    "  --db <path>  Path to SQLite database (or pass as first positional arg, or set DB_PATH)",
    "  --json       Output machine-readable JSON counts",
    "  -h, --help   Show this help message",
  ].join("\n");
}

async function main() {
  const { dbPath, json, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(usage());
    return;
  }
  if (!dbPath) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const report = await auditDatabase(dbPath);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`audit-zod4-stored-data: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  });
}
