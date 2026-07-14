/**
 * F2 — Migration completeness guard.
 *
 * Ensures no production SQL migration file numbered 0027 or higher (the
 * post-consolidation range after commit 09d24f4) is left outside the active
 * Drizzle journal. The pre-F2 defect was exactly this: migrations 0027–0053
 * existed as SQL files but were absent from `meta/_journal.json`, making them
 * invisible to production `migrate()`.
 *
 * Pre-consolidation orphans (0001–0026 originals folded into 0000_schema at
 * the consolidation boundary) are allowed: their changes are already
 * represented in the baseline and re-running them would be incorrect.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DRIZZLE_DIR = join(import.meta.dirname, "..", "..", "drizzle");

describe("F2: migration completeness guard", () => {
  it("every post-consolidation SQL file (0027+) is registered in the journal", () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));
    const journalTags = new Set<string>(journal.entries.map((e: { tag: string }) => e.tag));

    const sqlFiles = readdirSync(DRIZZLE_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => f.replace(/\.sql$/, ""));

    // Post-consolidation files (0027+) must all be journaled.
    const postConsolidation = sqlFiles.filter((tag) => {
      const num = parseInt(tag.slice(0, 4), 10);
      return num >= 27;
    });

    expect(postConsolidation.length).toBeGreaterThan(0);

    const unjournaled = postConsolidation.filter((tag) => !journalTags.has(tag));
    if (unjournaled.length > 0) {
      throw new Error(
        `Post-consolidation SQL files are not registered in the Drizzle journal:\n` +
          unjournaled.map((t) => `  - ${t}.sql`).join("\n") +
          `\nAdd them to meta/_journal.json or they will be invisible to production migrate().`,
      );
    }
  });

  it("every journal entry has a corresponding SQL file on disk", () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));

    for (const entry of journal.entries) {
      const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
      const content = readFileSync(sqlPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("journal entries have strictly increasing when timestamps", () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"));

    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1].when;
      const curr = journal.entries[i].when;
      expect(curr).toBeGreaterThan(prev);
    }
  });
});
