/**
 * mission_dependencies source-side foreign key (migration 0086) — two
 * independent proofs:
 *
 * 1. CASCADE (default test DB, built through the real migration journal):
 *    deleting a Mission removes the dependency edges it OWNS (source-side
 *    cascade — the new FK) and the edges POINTING AT it (destination-side
 *    cascade — pre-existing, now also proven), and the table declares both
 *    foreign keys.
 *
 * 2. ARCHIVE-THEN-MIRROR REBUILD (real better-sqlite3, dirty pre-0086
 *    database): a database built from 0000_schema carrying a dangling
 *    source-side edge (only possible with foreign-key enforcement off —
 *    the historical deleteMission gap) upgrades through the 0086 file
 *    itself: the dangling row lands in the archive table, clean rows are
 *    copied, and the rebuilt table enforces the new key (a fresh dangling
 *    insert is rejected).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { missions } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as dependencyRepo from "../repositories/dependency.js";

const DRIZZLE_DIR = join(import.meta.dirname, "..", "..", "drizzle");

function applyMigrationSql(db: Database.Database, sqlText: string): void {
  for (const stmt of sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    db.exec(stmt);
  }
}

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  habitatId = habitatRepo.createHabitat({ name: "mdfk-habitat" }).id;
  columnId = columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false }).id;
});

afterEach(() => {
  closeDb();
});

function seedMission(title: string): string {
  return missionRepo.createMission({ habitatId, columnId, title, createdBy: "mdfk-seed" }).id;
}

function rawMissionRows(db: Database.Database, table: string): { mission_id: string; depends_on_id: string }[] {
  return db.prepare(`SELECT mission_id, depends_on_id FROM ${table}`).all() as {
    mission_id: string;
    depends_on_id: string;
  }[];
}

describe("mission_dependencies source FK — cascade on the migration-built test schema", () => {
  it("declares both foreign keys with ON DELETE cascade", () => {
    const fks = getDb().all(
      sql`PRAGMA foreign_key_list(mission_dependencies)`,
    ) as unknown as { from: string; to: string; on_delete: string }[];
    const byColumn = new Map(fks.map((f) => [f.from, f]));
    expect(byColumn.get("mission_id")?.on_delete).toBe("CASCADE");
    expect(byColumn.get("depends_on_id")?.on_delete).toBe("CASCADE");
  });

  it("deleting a mission cascades away the edges it owns and the edges pointing at it", () => {
    const a = seedMission("A");
    const b = seedMission("B");
    const c = seedMission("C");
    dependencyRepo.addMissionDependency(a, b); // A depends on B
    dependencyRepo.addMissionDependency(c, b); // C depends on B

    // Source-side cascade (the 0086 FK): deleting A removes the edge A→B
    // but touches nothing else.
    getDb().delete(missions).where(eq(missions.id, a)).run();
    let edges = dependencyRepo.getMissionDependencyEdgeIds(b);
    expect(edges.incoming).toEqual([c]);

    // Destination-side cascade (pre-existing FK, now also proven): deleting
    // B removes the remaining edge pointing at it.
    getDb().delete(missions).where(eq(missions.id, b)).run();
    edges = dependencyRepo.getMissionDependencyEdgeIds(c);
    expect(edges.incoming).toEqual([]);
    expect(edges.outgoing).toEqual([]);
  });
});

describe("mission_dependencies source FK — archive-then-mirror rebuild (0086)", () => {
  it("archives dangling rows, copies clean rows, and enforces the new key", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, "0000_schema.sql"), "utf-8"));

    const insertMission = db.prepare(`
      INSERT INTO missions (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by)
      VALUES (?, 'h', 'c', ?, '[]', '[]', '[]', 'mdfk')
    `);
    // The fixture missions reference placeholder habitat/column ids; seed
    // with enforcement off and re-enable before the rebuild so 0086 runs
    // under the same enforcement the production driver uses.
    db.pragma("foreign_keys = OFF");
    insertMission.run("m-live", "Live Mission");
    insertMission.run("m-dep", "Depended-On Mission");

    // The historical gap: a source-side edge whose source Mission was
    // deleted while the row survived (only representable with enforcement
    // off) plus a clean edge that must survive the rebuild.
    db.prepare("INSERT INTO mission_dependencies (mission_id, depends_on_id) VALUES (?, ?)").run(
      "m-deleted-source",
      "m-dep",
    );
    db.prepare("INSERT INTO mission_dependencies (mission_id, depends_on_id) VALUES (?, ?)").run(
      "m-live",
      "m-dep",
    );
    db.pragma("foreign_keys = ON");

    applyMigrationSql(db, readFileSync(join(DRIZZLE_DIR, "0086_mission_dependencies_source_fk.sql"), "utf-8"));

    const archived = rawMissionRows(db, "mission_dependencies_orphans_0086");
    expect(archived).toEqual([{ mission_id: "m-deleted-source", depends_on_id: "m-dep" }]);

    const rebuilt = rawMissionRows(db, "mission_dependencies");
    expect(rebuilt).toEqual([{ mission_id: "m-live", depends_on_id: "m-dep" }]);

    // The rebuilt table enforces the replacement key in both directions.
    expect(() =>
      db
        .prepare("INSERT INTO mission_dependencies (mission_id, depends_on_id) VALUES (?, ?)")
        .run("m-never-existed", "m-dep"),
    ).toThrow(/FOREIGN KEY/i);
    expect(() =>
      db
        .prepare("INSERT INTO mission_dependencies (mission_id, depends_on_id) VALUES (?, ?)")
        .run("m-live", "m-also-gone"),
    ).toThrow(/FOREIGN KEY/i);

    // And the source-side cascade is live on the rebuilt table.
    db.prepare("DELETE FROM missions WHERE id = ?").run("m-live");
    expect(rawMissionRows(db, "mission_dependencies")).toEqual([]);

    db.close();
  });
});
