import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

/** Build the starting state in memory, then create the case's private database in one write. */
export function writeSqliteFixture(path: string, populate: (db: Database.Database) => void): void {
  const db = new Database(":memory:");
  try {
    populate(db);
    writeFileSync(path, db.serialize(), { flag: "wx" });
  } finally {
    db.close();
  }
}
