import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import initSqlJs, { type Database } from "sql.js";
import { expect, it, vi } from "vitest";
import { ENFORCEMENT_MIGRATION_TAGS } from "../db/enforcementMigrationTags.js";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { createSqlJsTestSchema, TEST_SCHEMA_PATH_ENV } from "../db/sqlJsTestSchema.js";
import { prepareSqlJsTestSchema } from "./sqlJsTestSchemaSetup.js";

const drizzleDir = join(import.meta.dirname, "../../drizzle");

function expectMissionEventsSchema(db: Database): void {
  const metadata = db.exec(
    "SELECT [notnull], dflt_value FROM pragma_table_info('mission_events') WHERE name = 'metadata'",
  );
  expect.soft(metadata).toMatchObject([{ values: [[1, null]] }]);
  const indexes = db.exec(`
    SELECT name FROM pragma_index_list('mission_events')
    WHERE name IN ('idx_mission_events_mission', 'idx_mission_events_feature')
  `);
  expect.soft(indexes).toMatchObject([{ values: [["idx_mission_events_mission"]] }]);
}

it("builds the production mission event schema in the local fallback", async () => {
  const db = createSqlJsTestSchema(await initSqlJs(), drizzleDir);
  try {
    expectMissionEventsSchema(db);
  } finally {
    db.close();
  }
});

it("replays only journaled migrations in entry order, excluding production enforcement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orcy-test-migrations-"));
  try {
    const tags = ["0002_first", ...ENFORCEMENT_MIGRATION_TAGS, "0001_second"];
    const entries = tags.map((tag, idx) => ({ idx, version: "6", when: idx + 1, tag, breakpoints: true }));
    mkdirSync(join(dir, "meta"));
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
    for (const tag of [...tags, "0000_schema", "0003_unjournaled"]) {
      writeFileSync(join(dir, `${tag}.sql`), `
        CREATE TABLE IF NOT EXISTS migration_probe (tag TEXT);
        --> statement-breakpoint
        INSERT INTO migration_probe VALUES ('${tag}');
      `);
    }

    const db = createSqlJsTestSchema(await initSqlJs(), dir);
    try {
      expect(db.exec("SELECT tag FROM migration_probe ORDER BY rowid")).toMatchObject([
        { values: [["0002_first"], ["0001_second"]] },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("seeds a private copy of the run schema and resets to that file's seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orcy-test-schema-"));
  try {
    const path = await prepareSqlJsTestSchema(
      [import.meta.filename, join(import.meta.dirname, "seedGlobalTemplates.test.ts")],
      drizzleDir,
      dir,
    );
    const SQL = await initSqlJs();
    const schema = new SQL.Database(new Uint8Array(readFileSync(path)));
    try {
      expectMissionEventsSchema(schema);
      expect(schema.exec("SELECT count(*) FROM users WHERE username = 'admin'")[0])
        .toMatchObject({ values: [[0]] });
      expect(schema.exec("SELECT count(*) FROM mission_templates")[0])
        .toMatchObject({ values: [[0]] });
      // Only the template has this table. Replaying repository migrations would lose it.
      schema.run("CREATE TABLE schema_probe (value INTEGER)");
      writeFileSync(path, schema.export());
    } finally {
      schema.close();
    }
    const original = readFileSync(path);
    vi.stubEnv(TEST_SCHEMA_PATH_ENV, path);
    await initTestDb();
    const first = getDb();
    const admin = sql`SELECT id FROM users WHERE username = 'admin'`;
    const id = first.get<{ id: string }>(admin)?.id;
    expect(id).toEqual(expect.any(String));
    expect(first.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 0 });
    first.run(sql`INSERT INTO schema_probe VALUES (1)`);
    closeDb();

    await initTestDb();
    const reset = getDb();
    expect(reset.get(admin)).toEqual({ id });
    expect(reset.get(sql`SELECT count(*) AS n FROM schema_probe`)).toEqual({ n: 0 });
    expect(reset.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 });
    expect(readFileSync(path).equals(original)).toBe(true);
  } finally {
    closeDb();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
