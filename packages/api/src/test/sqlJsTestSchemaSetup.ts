import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSqlJsTestSchema } from "../db/sqlJsTestSchema.js";

// A hint for focused runs: migration-only suites mention initTestDb in comments.
const importsTestDb = /^\s*import\s*\{[^}]*\binitTestDb\b[^}]*\}\s*from\s*["'][^"']*\/db\/index\.js["']/m;

/** Vitest owns tmpDir and removes it when the project closes. */
export async function prepareSqlJsTestSchema(files: readonly string[], migrationFolder: string, tmpDir: string) {
  // Indirect consumers still build locally when a focused selection has no explicit consumer.
  if (files.length < 2 || !files.some((file) => importsTestDb.test(readFileSync(file, "utf8")))) {
    return "";
  }

  const { default: initSqlJs } = await import("sql.js");
  const schema = createSqlJsTestSchema(await initSqlJs(), migrationFolder);
  try {
    mkdirSync(tmpDir, { recursive: true });
    const path = join(tmpDir, "orcy-test-schema.sqlite");
    writeFileSync(path, schema.export());
    return path;
  } finally {
    schema.close();
  }
}
