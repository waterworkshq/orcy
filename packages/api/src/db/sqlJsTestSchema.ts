import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database, SqlJsStatic } from "sql.js";
import { ENFORCEMENT_MIGRATION_TAGS } from "./enforcementMigrationTags.js";

export const TEST_SCHEMA_PATH_ENV = "ORCY_TEST_SQLJS_SCHEMA";

// Guarded migrations require production preflight checks and are tested with better-sqlite3.
const enforcementTags = new Set<string>(ENFORCEMENT_MIGRATION_TAGS);

export function createSqlJsTestSchema(SQL: SqlJsStatic, migrationFolder: string): Database {
  const db = new SQL.Database();
  try {
    db.run("PRAGMA foreign_keys = ON");
    applyMigrations(db, migrationFolder);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function applyMigrations(testSqlite: Database, migrationFolder: string): void {
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(join(migrationFolder, "meta", "_journal.json"), "utf-8"),
  );
  for (const { tag } of journal.entries) {
    if (enforcementTags.has(tag)) continue;
    runMigrationSql(testSqlite, readFileSync(join(migrationFolder, `${tag}.sql`), "utf-8"));
  }
}

function runMigrationSql(testSqlite: Database, sqlText: string): void {
  let fts5Available = true;
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (!fts5Available && stmt.includes("wiki_pages_fts")) {
      continue;
    }
    try {
      testSqlite.run(stmt);
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");
      if (/no such module.*fts5/i.test(msg)) {
        // Some SQLite builds, including sql.js in tests, omit FTS5. Base wiki tables still
        // migrate successfully; FTS-dependent statements are skipped and search uses LIKE.
        fts5Available = false;
        continue;
      }
      if (
        !msg.includes("already exists") &&
        !msg.includes("no such table") &&
        !msg.includes("no such column") &&
        !msg.includes("no such index") &&
        !msg.includes("duplicate column name")
      )
        throw err;
    }
  }
}
