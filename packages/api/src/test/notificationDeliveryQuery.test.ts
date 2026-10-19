import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { sql } from "drizzle-orm";
import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import { habitats, notificationEvents, notificationDeliveries, notificationDeliveryAttempts } from "../db/schema/index.js";
import { getDeliveryAttemptById, getDeliveryAttemptsByHabitat } from "../repositories/notificationDeliveryAttempt.js";

const TARGET = "query-target";
const OTHER = "query-other";
const TARGET_DELIVERY = "query-target-delivery";
const OTHER_DELIVERY = "query-other-delivery";
const BASE = Date.UTC(2026, 0, 1);
const at = (offset: number) => new Date(BASE + offset * 1000).toISOString();
interface AttemptInput { id: string; deliveryId?: string; channel?: string; time?: number; }
function seedParents() {
  const db = getDb();
  for (const [id, deliveryId] of [[TARGET, TARGET_DELIVERY], [OTHER, OTHER_DELIVERY]]) {
    db.insert(habitats).values({ id, name: id }).run();
    db.insert(notificationEvents).values({ id: `${id}-event`, habitatId: id,
      eventType: "task.assigned", sourceType: "task", severity: "info", title: "Query fixture",
      body: "Stored event", payload: {}, createdByType: "system" }).run();
    db.insert(notificationDeliveries).values({ id: deliveryId, habitatId: id, eventId: `${id}-event`,
      recipientType: "human", recipientId: "fixture-human", channels: ["webhook"] }).run();
  }
}
function seedAttempts(rows: AttemptInput[]) {
  for (let offset = 0; offset < rows.length; offset += 50) {
    getDb().insert(notificationDeliveryAttempts).values(rows.slice(offset, offset + 50).map(row => ({
      id: row.id, deliveryId: row.deliveryId ?? TARGET_DELIVERY, channel: row.channel ?? "slack",
      destinationId: null, status: "failed", attempt: 2, statusCode: 503, error: "Stored failure",
      responseBody: "Stored response", nextRetryAt: null, finishedAt: null, createdAt: at(row.time ?? 0),
    }))).run();
  }
}
function expected(ids: string[]) { return ids.map(id => getDeliveryAttemptById(id)!); }

interface Captured { sql: string; bindings: unknown[]; }
function captureNativeRead<T>(read: () => T): { result: T; calls: Captured[]; plans: string[][] } {
  const sqlite = (getDb() as unknown as { $client: BetterSqlite3.Database }).$client;
  const prepare = sqlite.prepare;
  const calls: Captured[] = [];
  sqlite.prepare = ((source: string) => {
    const statement = prepare.call(sqlite, source) as BetterSqlite3.Statement;
    const all = statement.all;
    const get = statement.get;
    statement.all = ((...bindings: unknown[]) => {
      calls.push({ sql: statement.source, bindings });
      return all.apply(statement, bindings);
    }) as typeof statement.all;
    statement.get = ((...bindings: unknown[]) => {
      calls.push({ sql: statement.source, bindings });
      return get.apply(statement, bindings);
    }) as typeof statement.get;
    return statement;
  }) as typeof sqlite.prepare;
  try {
    const result = read();
    const plans = calls.map(call => ((prepare.call(sqlite, `EXPLAIN QUERY PLAN ${call.sql}`) as BetterSqlite3.Statement)
      .all(...call.bindings) as { detail: string }[]).map(row => row.detail));
    return { result, calls, plans };
  } finally { sqlite.prepare = prepare; }
}

describe.each(["sql.js", "native"] as const)("delivery query on %s", driver => {
  let ownedDirectory = "";
  beforeEach(async () => {
    if (driver === "native") {
      ownedDirectory = mkdtempSync(join(tmpdir(), "orcy-notification-query-"));
      await initDb(join(ownedDirectory, "query.sqlite"));
    } else await initTestDb();
    seedParents();
  });
  afterEach(() => {
    closeDb();
    if (ownedDirectory) rmSync(ownedDirectory, { recursive: true, force: true });
    ownedDirectory = "";
  });

  it("returns full decoded attempts with global descending timestamp and ID ties", () => {
    seedAttempts([{ id: "target-a", time: 10 }, { id: "target-z", time: 10 },
      { id: "target-new", time: 11 }, { id: "foreign-newest", deliveryId: OTHER_DELIVERY, time: 12 }]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 2 })).toEqual(expected(["target-new", "target-z"]));
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 2 })[0]).toMatchObject({
      statusCode: 503, attempt: 2, error: "Stored failure", responseBody: "Stored response", destinationId: null,
    });
  });

  it.each([255, 256])("finds the target after %i foreign attempts tied at the cutoff timestamp", newer => {
    seedAttempts([{ id: "a-target", time: 0 }, ...Array.from({ length: newer }, (_, n) => ({
      id: `z-foreign-${String(n).padStart(4, "0")}`, deliveryId: OTHER_DELIVERY, time: 0,
    }))]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 1 })).toEqual(expected(["a-target"]));
  });

  it("discards a partial prefix and returns a complete fallback without duplicate rows", () => {
    seedAttempts([{ id: "target-latest", time: 10000 }, { id: "target-old-a" }, { id: "target-old-z" },
      ...Array.from({ length: 255 }, (_, n) => ({ id: `foreign-${n}`, deliveryId: OTHER_DELIVERY, time: n + 1 }))]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 2 })).toEqual(expected(["target-latest", "target-old-z"]));
  });

  it("filters exact channels before choosing the prefix and preserves plugin history", () => {
    seedAttempts([{ id: "target-plugin", channel: "retired-plugin" },
      { id: "other-plugin", channel: "retired-plugin", deliveryId: OTHER_DELIVERY, time: 1 },
      ...Array.from({ length: 300 }, (_, n) => ({ id: `foreign-webhook-${n}`, channel: "webhook", deliveryId: OTHER_DELIVERY, time: n + 2 }))]);
    const wanted = expected(["target-plugin"]);
    if (driver === "native") {
      const observed = captureNativeRead(() => getDeliveryAttemptsByHabitat(TARGET, { channel: "retired-plugin", limit: 1 }));
      expect(observed.result).toEqual(wanted);
      expect(observed.calls).toHaveLength(2);
      expect(observed.calls[0].sql).toContain("sqlite_master");
      expect(observed.plans.flat().some(detail => /USING COVERING INDEX idx_notification_attempts_channel_created_order/.test(detail))).toBe(true);
    } else expect(getDeliveryAttemptsByHabitat(TARGET, { channel: "retired-plugin", limit: 1 })).toEqual(wanted);
  });

  it("returns every target match from an exhausted prefix without an unnecessary fallback", () => {
    seedAttempts([{ id: "target-a" }, { id: "target-z" },
      ...Array.from({ length: 40 }, (_, n) => ({ id: `foreign-${n}`, deliveryId: OTHER_DELIVERY, time: n + 1 }))]);
    const wanted = expected(["target-z", "target-a"]);
    if (driver === "native") {
      const observed = captureNativeRead(() => getDeliveryAttemptsByHabitat(TARGET, { limit: 100 }));
      expect(observed.result).toEqual(wanted);
      expect(observed.calls).toHaveLength(2);
      expect(observed.calls[0].sql).toContain("sqlite_master");
    } else expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 100 })).toEqual(wanted);
  });

  it("returns no attempt objects for empty Habitats and absent channels", () => {
    seedAttempts([{ id: "foreign", deliveryId: OTHER_DELIVERY }]);
    expect(getDeliveryAttemptsByHabitat(TARGET)).toEqual([]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { channel: "absent-plugin" })).toEqual([]);
  });

  it("represents a globally empty prefix as an empty attempt array", () => {
    expect(getDeliveryAttemptsByHabitat(TARGET)).toEqual([]);
  });

  it("retains the repository's zero and unlimited limit semantics", () => {
    seedAttempts([{ id: "a" }, { id: "z" }]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 0 })).toEqual([]);
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: -1 })).toEqual(expected(["z", "a"]));
  });

  it.each(["idx_notification_attempts_created_order", "idx_notification_attempts_channel_created_order",
    "idx_notification_deliveries_scope_lookup"])("keeps the full query available without %s", index => {
    seedAttempts([{ id: "a" }, { id: "z" }, { id: "foreign", deliveryId: OTHER_DELIVERY, time: 1 }]);
    const wanted = expected(["z", "a"]);
    getDb().run(sql.raw(`DROP INDEX ${index}`));
    expect(getDeliveryAttemptsByHabitat(TARGET, { limit: 2 })).toEqual(wanted);
    expect(getDeliveryAttemptsByHabitat(TARGET, { channel: "slack", limit: 2 })).toEqual(wanted);
  });

  it.skipIf(driver !== "native")("uses recent rows as the outer loop with covered parent point lookups", () => {
    seedAttempts(Array.from({ length: 500 }, (_, n) => ({ id: `target-${String(n).padStart(4, "0")}`, time: n })));
    const observed = captureNativeRead(() => getDeliveryAttemptsByHabitat(TARGET, { limit: 1 }));
    expect(observed.result.map(row => row.id)).toEqual(["target-0499"]);
    expect(observed.calls).toHaveLength(2);
    expect(observed.calls[0].sql).toContain("sqlite_master");
    const plan = observed.plans[1];
    const recent = plan.findIndex(detail => /\bSCAN r\b/.test(detail));
    const parent = plan.findIndex(detail => /SEARCH d USING COVERING INDEX idx_notification_deliveries_scope_lookup \(id=\? AND habitat_id=\?\)/.test(detail));
    expect(recent, JSON.stringify(plan)).toBeGreaterThanOrEqual(0);
    expect(parent, JSON.stringify(plan)).toBeGreaterThan(recent);
    expect(plan.some(detail => /\bSCAN d\b/.test(detail)), JSON.stringify(plan)).toBe(false);
  });

  it.skipIf(driver !== "native")("propagates a data-read failure instead of silently retrying the full query", () => {
    seedAttempts([{ id: "target" }]);
    const sqlite = (getDb() as unknown as { $client: BetterSqlite3.Database }).$client;
    const prepare = sqlite.prepare;
    const failure = Object.assign(new Error("Injected SQLite read contention"), { code: "SQLITE_BUSY" });
    let injected = false;
    sqlite.prepare = ((source: string) => {
      const statement = prepare.call(sqlite, source) as BetterSqlite3.Statement;
      const all = statement.all;
      statement.all = ((...bindings: unknown[]) => {
        if (!injected) { injected = true; throw failure; }
        return all.apply(statement, bindings);
      }) as typeof statement.all;
      return statement;
    }) as typeof sqlite.prepare;
    try {
      expect(() => getDeliveryAttemptsByHabitat(TARGET)).toThrow(failure);
      expect(injected).toBe(true);
    } finally { sqlite.prepare = prepare; }
  });
});
