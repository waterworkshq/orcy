import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DrizzleQueryError } from "drizzle-orm";
import * as schema from "../db/schema/index.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";

let native: Database.Database;
const missingSummary = "no such table: scheduled_occurrence_history";
beforeEach(() => {
  native = new Database(":memory:");
  native.exec(`CREATE TABLE scheduled_occurrence_history (
    scheduled_task_id TEXT PRIMARY KEY, total_count INTEGER, duplicate_ordinal_rows INTEGER,
    once_count INTEGER, unknown_count INTEGER, trusted INTEGER
  )`);
});
afterEach(() => { native.close(); });

describe("scheduled history storage error boundary", () => {
  it.each([
    ["busy storage", () => new Database.SqliteError("database is locked", "SQLITE_BUSY")],
    ["another missing table", () => new Database.SqliteError("no such table: unrelated_history", "SQLITE_ERROR")],
    ["same message with another native code", () => new Database.SqliteError(missingSummary, "SQLITE_CORRUPT")],
    ["generic error with the same text", () => new Error(missingSummary)],
    ["unrecognized wrapper", () => new Error("logger failed", { cause: new Database.SqliteError(missingSummary, "SQLITE_ERROR") })],
    ["wrapped busy storage", () => new DrizzleQueryError("select history", [], new Database.SqliteError("database is locked", "SQLITE_BUSY"))],
  ] as const)("propagates %s unchanged", (_label, makeError) => {
    const failure = makeError();
    // Error-injection exception: the public driver logger rejects a real
    // prepared SELECT. This avoids corrupting a database or fabricating lock
    // timing merely to discriminate the helper's narrow unavailable-table case.
    const db = drizzle(native, { schema, logger: { logQuery() { throw failure; } } });
    let observed: unknown;
    try { getOnceEntitlementWithClient(db, { id: "schedule", runCount: 0 }); }
    catch (error) { observed = error; }
    expect(observed).toBe(failure);
  });

  it("recognizes the exact native missing-summary error through the public Drizzle wrapper", () => {
    const failure = new DrizzleQueryError("select history", [], new Database.SqliteError(missingSummary, "SQLITE_ERROR"));
    let queries = 0;
    const db = drizzle(native, { schema, logger: { logQuery() { queries++; throw failure; } } });
    expect(getOnceEntitlementWithClient(db, { id: "schedule", runCount: 0 })).toBe("unknown");
    expect(queries).toBe(1);
  });

  it("propagates a real missing occurrence table after the summary read", () => {
    native.prepare(`INSERT INTO scheduled_occurrence_history VALUES ('schedule',1,0,0,0,1)`).run();
    const db = drizzle(native, { schema });
    expect(() => getOnceEntitlementWithClient(db, { id: "schedule", runCount: 1 }))
      .toThrow("no such table: scheduled_occurrences");
  });
});
