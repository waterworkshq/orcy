import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import { originalOnceEntitlement } from "./fixtures/scheduled-task-entitlement-original.js";

beforeEach(async () => { await initDb(":memory:"); });
afterEach(() => { closeDb(); });

describe("native entitlement query work", () => {
  it("uses only summary and bounded covering-index reads after snapshot classification", () => {
    const db = getDb();
    for (let ordinal = 0; ordinal < 128; ordinal++) {
      db.run(sql`INSERT INTO scheduled_occurrences
        (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
        VALUES (${`recurring-${ordinal}`}, 'recurring', ${`due-${ordinal}`}, ${ordinal}, '{"scheduleType":"interval"}')`);
    }
    for (const [id, revision] of [["consumed", '{"scheduleType":"once"}'], ["malformed", "{"], ["missing", '{"scheduleType":"once"}']]) {
      db.run(sql`INSERT INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
        VALUES (${id}, ${id}, ${id}, 0, ${revision})`);
    }
    expect(originalOnceEntitlement(db, { id: "recurring", runCount: 128 })).toBe("unconsumed");
    expect(originalOnceEntitlement(db, { id: "consumed", runCount: 0 })).toBe("consumed");
    expect(originalOnceEntitlement(db, { id: "malformed", runCount: 1 })).toBe("unknown");
    db.run(sql`DELETE FROM scheduled_occurrence_history WHERE scheduled_task_id = 'missing'`);

    const native = (db as typeof db & { $client: Database.Database }).$client;
    let snapshotParses = 0;
    native.function("json_valid", { deterministic: true }, (_snapshot: unknown) => {
      snapshotParses++;
      throw new Error("bounded evidence read reparsed historical JSON");
    });
    const summaries = db.all(sql`SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id`);
    // Also make snapshot parsing unavailable during ordinary occurrence state,
    // lease and result changes. The shared driver test separately rejects any
    // summary UPDATE, even an assignment that would leave counters unchanged.
    expect(() => db.run(sql`UPDATE scheduled_occurrences SET state = 'rejected', lease_owner = 'worker',
      lease_expires_at = '2090-01-01', result = '{"reason":"test"}' WHERE id = 'consumed'`)).not.toThrow();
    expect(db.all(sql`SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id`)).toEqual(summaries);

    const queries: { text: string; params: unknown[] }[] = [];
    const traced = drizzle(native, { schema, logger: {
      logQuery(text: string, params: unknown[]) { queries.push({ text, params: [...params] }); },
    } });
    const cases = [
      { id: "recurring", runCount: 128, expected: "unconsumed" },
      { id: "consumed", runCount: 0, expected: "consumed" },
      { id: "malformed", runCount: 1, expected: "unknown" },
      { id: "missing", runCount: 0, expected: "unknown" },
      { id: "empty", runCount: 0, expected: "unconsumed" },
    ] as const;
    for (const item of cases) {
      queries.length = 0;
      db.run(sql`BEGIN IMMEDIATE`);
      try {
        expect(getOnceEntitlementWithClient(traced, item), item.id).toBe(item.expected);
      } finally {
        db.run(sql`ROLLBACK`);
      }
      const reads = queries.filter(({ text }) => /^\s*select\b/i.test(text));
      expect(reads.length, item.id).toBeGreaterThan(0);
      expect(reads.length, item.id).toBeLessThanOrEqual(3);
      const plans = reads.flatMap(({ text, params }) => {
        expect(text, item.id).not.toMatch(/\b(?:json_valid|json_extract|count|sum|min|max)\s*\(/i);
        return (native.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[])
          .map(({ detail }) => detail);
      });
      expect(plans.some((detail) => /SEARCH scheduled_occurrence_history .*INDEX/i.test(detail)), item.id).toBe(true);
      expect(plans.some((detail) => /\bSCAN\b|TEMP B-TREE/i.test(detail)), `${item.id}: ${plans.join("; ")}`).toBe(false);
      if (item.id === "recurring") {
        const endpoints = plans.filter((detail) => /SEARCH scheduled_occurrences USING COVERING INDEX idx_scheduled_occurrences_schedule_ordinal/i.test(detail));
        expect(endpoints, "each endpoint is a covering schedule/ordinal seek").toHaveLength(2);
        for (const { text } of reads.filter(({ text }) => /\bFROM\s+"scheduled_occurrences"/i.test(text))) {
          expect(text).toMatch(/\bLIMIT\b/i);
        }
      }
    }
    expect(snapshotParses).toBe(0);
  });
});
