import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import initSqlJs from "sql.js";
import { expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { TEST_SCHEMA_PATH_ENV } from "../db/sqlJsTestSchema.js";
import { prepareSqlJsTestSchema } from "./sqlJsTestSchemaSetup.js";

it("seeds a private copy of the run schema and resets to that file's seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orcy-test-schema-"));
  try {
    const path = await prepareSqlJsTestSchema(
      [import.meta.filename, join(import.meta.dirname, "seedGlobalTemplates.test.ts")],
      join(import.meta.dirname, "../../drizzle"),
      dir,
    );
    const SQL = await initSqlJs();
    const schema = new SQL.Database(new Uint8Array(readFileSync(path)));
    try {
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
