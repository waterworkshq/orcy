/**
 * Notification V2 push restoration — upgrade epoch boundary (migration 0077).
 *
 * Binding user decision 2026-09-05: the upgrade sends ONLY new notifications.
 * The migration is the atomic cutover: `push_epoch` lands with a column-level
 * DEFAULT 'restored', every pre-existing row is backfilled to 'legacy' in the
 * same migration, and non-terminal legacy deliveries get a terminal
 * `backlog_not_attempted` unit recording that push was deliberately not
 * attempted — without touching statuses, timestamps, or attempt history.
 *
 * Built on a raw better-sqlite3 database (production driver) with every
 * journal migration up to 0076 applied, legacy notification rows seeded, then
 * 0077 applied — the upgrade itself is the behavior under test. The 0068
 * enforcement migration is excluded by TAG (the documented raw-harness rule:
 * no preflight attestation is seeded here).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const DRIZZLE_DIR = join(PACKAGE_ROOT, "drizzle");
const JOURNAL_PATH = join(DRIZZLE_DIR, "meta", "_journal.json");
const ENFORCEMENT_TAG = "0068_finding_triage_lifecycle_enforcement";
const EPOCH_TAG_PREFIX = "0077_";

const LEGACY_DISPOSITION =
  "pre-restoration backlog; push not attempted by user decision 2026-09-05";

interface JournalEntry {
  tag: string;
  when: number;
}

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(readFileSync(JOURNAL_PATH, "utf-8"));
}

function epochMigrationPath(tag: string): string {
  return join(DRIZZLE_DIR, `${tag}.sql`);
}

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.exec(stmt);
  }
}

/** Applies every journal migration BEFORE the 0077 epoch boundary, in order —
 * the enforcement (0068) migration is excluded by tag (raw harnesses must
 * exclude it or seed an attestation first), 0077 itself is applied separately
 * after seeding, and migrations AFTER 0077 are never applied: they postdate
 * the upgrade under test and cannot affect it. */
function applyPreEpochJournal(db: Database.Database): void {
  const journal = readJournal();
  expect(journal.entries.length).toBeGreaterThan(0);
  for (const entry of journal.entries) {
    if (entry.tag.startsWith(EPOCH_TAG_PREFIX)) break;
    if (entry.tag.startsWith(ENFORCEMENT_TAG)) continue;
    const sqlPath = join(DRIZZLE_DIR, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) continue; // pre-consolidation tags live in 0000
    applyMigrationSql(db, readFileSync(sqlPath, "utf-8"));
  }
}

function findJournalTag(prefix: string): string {
  const journal = readJournal();
  const match = journal.entries.find((e) => e.tag.startsWith(prefix));
  return match?.tag ?? "";
}

interface SeededLegacy {
  habitatId: string;
  eventId: string;
  deliveryIds: Record<string, string>;
  attemptId: string;
}

function seedLegacyNotifications(db: Database.Database): SeededLegacy {
  db.exec(`INSERT INTO habitats (id, name, created_at, updated_at)
    VALUES ('legacy-habitat', 'Legacy Habitat', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`);
  db.exec(`INSERT INTO notification_events (id, habitat_id, event_type, source_type, severity, title, body, payload, created_by_type, created_at)
    VALUES ('legacy-event', 'legacy-habitat', 'task.assigned', 'task', 'info', 'Legacy task', 'Legacy body', '{}', 'system', '2026-01-02 00:00:00')`);

  const deliveryIds: Record<string, string> = {};
  const statuses = [
    "pending",
    "snoozed",
    "muted",
    "delivered",
    "failed",
    "acknowledged",
    "cleared",
  ];
  for (const status of statuses) {
    const id = `legacy-${status}`;
    deliveryIds[status] = id;
    db.exec(`INSERT INTO notification_deliveries (id, event_id, habitat_id, recipient_type, recipient_id, status, required, channels, created_at, updated_at)
      VALUES ('${id}', 'legacy-event', 'legacy-habitat', 'human', 'human-1', '${status}', 0, '["in_app"]', '2026-01-03 00:00:00', '2026-01-03 00:00:01')`);
  }

  // Historical retry evidence on the pending legacy row — must survive the
  // upgrade byte-for-byte and be consumed by nothing.
  db.exec(`INSERT INTO notification_delivery_attempts (id, delivery_id, channel, status, attempt, error, next_retry_at, created_at)
    VALUES ('legacy-attempt', 'legacy-pending', 'slack', 'retry_scheduled', 2, 'HTTP 503', '2026-01-04 00:00:00', '2026-01-03 00:05:00')`);

  return { habitatId: "legacy-habitat", eventId: "legacy-event", deliveryIds, attemptId: "legacy-attempt" };
}

function deliveryColumns(db: Database.Database): string[] {
  const rows = db
    .prepare("PRAGMA table_info(notification_deliveries)")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function selectDelivery(db: Database.Database, id: string): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM notification_deliveries WHERE id = ?")
    .get(id) as Record<string, unknown>;
}

const TEMP_ROOT = join(
  tmpdir(),
  `orcy-epoch-${process.pid}-${Date.now()}`,
);

function buildUpgradedDb(): {
  db: Database.Database;
  seeded: SeededLegacy;
  before: Record<string, Record<string, unknown>>;
} {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const db = new Database(join(TEMP_ROOT, "epoch.db"));
  try {
    applyPreEpochJournal(db);
    const seeded = seedLegacyNotifications(db);

    const before: Record<string, Record<string, unknown>> = {};
    for (const status of Object.keys(seeded.deliveryIds)) {
      before[status] = selectDelivery(db, seeded.deliveryIds[status]);
    }
    const beforeAttempt = db
      .prepare("SELECT * FROM notification_delivery_attempts WHERE id = ?")
      .get(seeded.attemptId) as Record<string, unknown>;

    const epochTag = findJournalTag(EPOCH_TAG_PREFIX);
    expect(epochTag, "journal must contain a 0077_* epoch migration entry").toBeTruthy();
    applyMigrationSql(db, readFileSync(epochMigrationPath(epochTag), "utf-8"));

    return { db, seeded, before: { ...before, __attempt: beforeAttempt } as never };
  } catch (err) {
    // Failed setup must not leak the already-open handle; a close failure
    // must not mask the original setup failure.
    try {
      db.close();
    } catch {
      /* keep the original error */
    }
    throw err;
  }
}

/**
 * The full pre-0077 journal replay is deterministic and byte-identical for
 * every test, so the upgraded DB is built ONCE per suite instead of once per
 * test (per-test rebuilds were pure redundant cost under the canonical
 * file-parallel run). Isolation is preserved with a SAVEPOINT per test,
 * rolled back after it, so no test's writes (e.g. the post-epoch default
 * probe) can leak into another test's rows or ordering.
 */
let shared: ReturnType<typeof buildUpgradedDb> | undefined;

beforeAll(() => {
  shared = buildUpgradedDb();
});

beforeEach(() => {
  shared!.db.exec("SAVEPOINT test_isolation");
});

afterEach(() => {
  shared!.db.exec("ROLLBACK TO test_isolation");
  shared!.db.exec("RELEASE test_isolation");
});

afterAll(() => {
  // Close the raw handle BEFORE rmSync — an open better-sqlite3 connection
  // keeps the file alive (and leaks the handle) on some platforms.
  shared?.db.close();
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("notification push epoch migration (0077)", () => {
  it("backfills every pre-existing delivery to 'legacy' and defaults new inserts to 'restored'", () => {
    const { db } = shared!;

    expect(deliveryColumns(db)).toContain("push_epoch");
    const epochs = db
      .prepare("SELECT push_epoch, COUNT(*) AS n FROM notification_deliveries WHERE id LIKE 'legacy-%' GROUP BY push_epoch")
      .all() as { push_epoch: string; n: number }[];
    expect(epochs).toEqual([{ push_epoch: "legacy", n: 7 }]);

    // Storage-default proof: an insert that names NO push_epoch gets the
    // column default — every producer path, including future direct-repo
    // inserts, receives the marker automatically.
    db.exec(`INSERT INTO notification_deliveries (id, event_id, habitat_id, recipient_type, recipient_id, status, channels)
      VALUES ('post-epoch', 'legacy-event', 'legacy-habitat', 'human', 'human-1', 'pending', '[]')`);
    const fresh = selectDelivery(db, "post-epoch");
    expect(fresh.push_epoch).toBe("restored");
  });

  it("creates backlog_not_attempted units for non-terminal legacy deliveries only, with the fixed disposition", () => {
    const { db, seeded } = shared!;

    const units = db
      .prepare("SELECT delivery_id, channel_key, state, disposition FROM notification_delivery_channel_states ORDER BY delivery_id")
      .all() as { delivery_id: string; channel_key: string; state: string; disposition: string }[];

    const backlogIds = units.map((u) => u.delivery_id).sort();
    expect(backlogIds).toEqual(
      [seeded.deliveryIds.pending, seeded.deliveryIds.snoozed, seeded.deliveryIds.muted].sort(),
    );
    for (const unit of units) {
      expect(unit.state).toBe("backlog_not_attempted");
      expect(unit.channel_key).toBe("backlog");
      expect(unit.disposition).toBe(LEGACY_DISPOSITION);
    }
  });

  it("preserves legacy statuses, timestamps, and attempt history byte-for-byte", () => {
    const { db, before, seeded } = shared!;

    for (const [status, beforeRow] of Object.entries(before)) {
      if (status === "__attempt") continue;
      const after = selectDelivery(db, seeded.deliveryIds[status]);
      for (const [col, value] of Object.entries(beforeRow)) {
        expect(after[col], `${status}.${col}`).toBe(value);
      }
      expect(after.push_epoch).toBe("legacy");
    }

    const afterAttempt = db
      .prepare("SELECT * FROM notification_delivery_attempts WHERE id = ?")
      .get(seeded.attemptId) as Record<string, unknown>;
    for (const [col, value] of Object.entries(before.__attempt)) {
      expect(afterAttempt[col], `legacy-attempt.${col}`).toBe(value);
    }
    // The 0077 destination linkage is additive-only: legacy attempts get NULL.
    expect(afterAttempt.destination_id).toBeNull();
  });
});
