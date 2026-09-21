/**
 * Chat speaker-mapping FK semantics on the PRODUCTION driver (REC-06 first
 * ticket).
 *
 * The sql.js test database does not enforce FK constraints at runtime (the
 * pragma is accepted but inert in that build), so the delete-semantics pins
 * (user RESTRICT, integration CASCADE, composite UNIQUE) are proven HERE on
 * `better-sqlite3` with `PRAGMA foreign_keys = ON` — the exact driver and
 * boot pragma production uses (`db/index.ts` initDb) — by applying the REAL
 * journal's full migration chain to a fresh file-backed database.
 *
 * Cross-habitat association is an application-level invariant (the mapping's
 * habitat is DERIVED from the integration row inside the repository, never
 * taken from a request) — pinned by the route-level 403 and the CRUD
 * response assertions in `chatReviewDecision.test.ts`; the FK layer
 * additionally guarantees a mapping row cannot outlive its integration
 * (CASCADE below) or dangle on a missing user (RESTRICT below).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ENFORCEMENT_MIGRATION_TAG } from "../db/stagedMigrations.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const TEMP_DIR = mkdtempSync(join(tmpdir(), "chat-fk-"));

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s.length > 0) db.exec(s);
  }
}

let db: Database.Database;

beforeAll(() => {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8")) as {
    entries: { tag: string; when: number }[];
  };

  db = new Database(join(TEMP_DIR, "chat-fk.db"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC
    )
  `);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  for (const entry of journal.entries) {
    // The staged enforcement migration is deliberately excluded — it requires
    // a preflight attestation only the production staged runner writes (same
    // exclusion the sql.js test builder applies in db/index.ts).
    if (entry.tag === ENFORCEMENT_MIGRATION_TAG) continue;
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue; // pre-consolidation orphans
    const content = readFileSync(sqlPath, "utf-8");
    applyMigrationSql(db, content);
    insert.run(createHash("sha256").update(content).digest("hex"), entry.when);
  }

  // Minimal fixture rows for the mapping FK graph.
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO habitats (id, name, created_at, updated_at) VALUES ('h1', 'H1', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO habitats (id, name, created_at, updated_at) VALUES ('h2', 'H2', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at) VALUES ('u1', 'fkuser', 'x', 'FK User', 'editor', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO chat_integrations (id, habitat_id, provider, webhook_url, channel_id, provider_workspace_id, enabled, events, created_at, updated_at) VALUES ('ci1', 'h1', 'slack', 'https://hooks.slack.test/x', 'c1', 'tw1', 1, '[]', ?, ?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO chat_speaker_mappings (id, habitat_id, integration_id, provider, provider_workspace_id, provider_speaker_id, local_user_id, created_by, created_at) VALUES ('m1', 'h1', 'ci1', 'slack', 'tw1', 'sp1', 'u1', 'admin', ?)",
  ).run(now);
});

afterAll(() => {
  db.close();
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("chat_speaker_mappings FK semantics — production better-sqlite3 driver", () => {
  it("the real journal chain applied: 0081 columns/table exist and are live", () => {
    expect(
      db.prepare("SELECT provider_workspace_id FROM chat_integrations WHERE id = 'ci1'").get(),
    ).toMatchObject({ provider_workspace_id: "tw1" });
    expect(
      db
        .prepare(
          `SELECT on_delete FROM pragma_foreign_key_list('chat_speaker_mappings') WHERE "table" = 'users'`,
        )
        .get(),
    ).toMatchObject({ on_delete: "RESTRICT" });
  });

  it("local-user deletion is RESTRICTED while a mapping references the user", () => {
    expect(() => db.prepare("DELETE FROM users WHERE id = 'u1'").run()).toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_speaker_mappings").get()).toMatchObject({
      n: 1,
    });
  });

  it("integration deletion CASCADES its mappings", () => {
    db.prepare("DELETE FROM chat_integrations WHERE id = 'ci1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_speaker_mappings").get()).toMatchObject({
      n: 0,
    });
  });

  it("the composite identity (integration, workspace, speaker) is UNIQUE", () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO chat_integrations (id, habitat_id, provider, webhook_url, channel_id, provider_workspace_id, enabled, events, created_at, updated_at) VALUES ('ci2', 'h2', 'discord', 'https://discord.test/x', 'c2', 'tw2', 1, '[]', ?, ?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO chat_speaker_mappings (id, habitat_id, integration_id, provider, provider_workspace_id, provider_speaker_id, local_user_id, created_by, created_at) VALUES ('m2', 'h2', 'ci2', 'discord', 'tw2', 'sp2', 'u1', 'admin', ?)",
    ).run(now);
    expect(() =>
      db
        .prepare(
          "INSERT INTO chat_speaker_mappings (id, habitat_id, integration_id, provider, provider_workspace_id, provider_speaker_id, local_user_id, created_by, created_at) VALUES ('m3', 'h2', 'ci2', 'discord', 'tw2', 'sp2', 'u1', 'admin', ?)",
        )
        .run(now),
    ).toThrow(/UNIQUE constraint failed: .*chat_speaker_mappings/i);
  });
});
