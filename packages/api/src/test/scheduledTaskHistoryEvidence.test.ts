import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb, initDb, initTestDb } from "../db/index.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import { originalOnceEntitlement } from "./fixtures/scheduled-task-entitlement-original.js";

interface Counters {
  total_count: number;
  duplicate_ordinal_rows: number;
  once_count: number;
  unknown_count: number;
}
interface History extends Counters { scheduled_task_id: string; trusted: number }
const interval = '{"scheduleType":"interval"}';
const once = '{"scheduleType":"once"}';
const cron = '{"scheduleType":"cron"}';

function insert(id: string, schedule: string, ordinal: number, revision: string | null = interval, due = id) {
  getDb().run(sql`INSERT INTO scheduled_occurrences
    (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision, state)
    VALUES (${id}, ${schedule}, ${due}, ${ordinal}, ${revision}, 'reserved')`);
}
function history(schedule: string) {
  return getDb().all<History>(sql`SELECT * FROM scheduled_occurrence_history WHERE scheduled_task_id = ${schedule}`)[0];
}
function entitlement(id: string, runCount: number) {
  return getOnceEntitlementWithClient(getDb(), { id, runCount });
}
function forget(schedule: string) {
  getDb().run(sql`DELETE FROM scheduled_occurrence_history WHERE scheduled_task_id = ${schedule}`);
}
function counterOracle(schedule: string) {
  // Independently aggregate retained rows, so consumed precedence cannot hide
  // incorrect counters until some later snapshot mutation removes the once.
  return getDb().get<Counters>(sql`SELECT count(*) AS total_count,
    count(*) - count(DISTINCT ordinal) AS duplicate_ordinal_rows,
    coalesce(sum(CASE WHEN json_valid(schedule_revision)
      THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
      ELSE 0 END), 0) AS once_count,
    coalesce(sum(CASE WHEN json_valid(schedule_revision)
      THEN CASE WHEN json_extract(schedule_revision, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
      ELSE 1 END), 0) AS unknown_count
    FROM scheduled_occurrences WHERE scheduled_task_id = ${schedule}`)!;
}
function matchesOriginal(schedule: string, label: string) {
  const expected = counterOracle(schedule);
  const actual = history(schedule);
  if (actual) expect(actual, label).toMatchObject({ ...expected, trusted: 1 });
  else expect(expected.total_count, label).toBe(0);
  for (const runCount of new Set([0, 1, 2, 3, 4, 7, expected.total_count, expected.total_count + 1])) {
    expect(entitlement(schedule, runCount), `${label}: ${schedule}, runCount=${runCount}`)
      .toBe(originalOnceEntitlement(getDb(), { id: schedule, runCount }));
  }
}
function staysUntrusted(schedules: string[]) {
  for (const schedule of schedules) {
    expect(history(schedule), `${schedule}: invalidation must materialize a tombstone`).toMatchObject({ trusted: 0 });
    for (const runCount of [0, 1, 2, 4]) expect(entitlement(schedule, runCount)).toBe("unknown");
    // Emptying the old history and reinserting must never reset sticky trust.
    getDb().run(sql`DELETE FROM scheduled_occurrences WHERE scheduled_task_id = ${schedule}`);
    expect(entitlement(schedule, 0)).toBe("unknown");
    insert(`later-${schedule}`, schedule, 0);
    expect(history(schedule)).toMatchObject({ trusted: 0 });
    expect(entitlement(schedule, 1)).toBe("unknown");
  }
}

describe.each(["native", "sql.js"] as const)("scheduled history evidence through %s", (driver) => {
  beforeEach(async () => {
    if (driver === "native") await initDb(":memory:");
    else await initTestDb();
    getDb().run(sql`PRAGMA recursive_triggers = OFF`);
  });
  afterEach(() => { closeDb(); });

  it("matches the independent history oracle after every supported mutation", () => {
    const db = getDb();
    const schedules = ["a", "b", "odd"];
    const check = (label: string) => { for (const schedule of schedules) matchesOriginal(schedule, label); };
    const mutate = (label: string, action: () => void) => { action(); check(label); };
    check("empty histories");
    mutate("first recurring row", () => insert("a0", "a", 0));
    mutate("first duplicate", () => insert("a1", "a", 0, cron));
    mutate("second duplicate", () => insert("a2", "a", 0));
    mutate("third duplicate", () => insert("a3", "a", 0));
    mutate("move a duplicate ordinal", () => db.run(sql`UPDATE scheduled_occurrences SET ordinal = 1 WHERE id = 'a1'`));
    mutate("remove one of several duplicates", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'a2'`));
    mutate("remove the last duplicate", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'a3'`));
    mutate("gap", () => insert("a4", "a", 4));
    mutate("close the gap", () => db.run(sql`UPDATE scheduled_occurrences SET ordinal = 2 WHERE id = 'a4'`));
    mutate("a once snapshot", () => db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${once} WHERE id = 'a4'`));
    for (const state of ["reserved", "publishing", "published", "rejected"]) {
      mutate(`once remains consumed in ${state}`, () => db.run(sql`UPDATE scheduled_occurrences SET state = ${state} WHERE id = 'a4'`));
      expect(entitlement("a", 0)).toBe("consumed");
    }
    mutate("another once masks unknown evidence", () => db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${once} WHERE id = 'a0'`));
    for (const revision of ["{", null, "null", "[]", "42", '"once"', "{}", '{"scheduleType":null}',
      '{"scheduleType":"Once"}', '{"scheduleType":1}', '{"scheduleType":true}',
      '{"scheduleType":[]}', '{"scheduleType":{}}', interval, cron, once]) {
      mutate(`snapshot ${String(revision)}`, () => db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${revision} WHERE id = 'a4'`));
    }
    mutate("remove first once", () => db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${interval} WHERE id = 'a0'`));
    mutate("remove final once", () => db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${cron} WHERE id = 'a4'`));
    mutate("combined ID schedule ordinal and snapshot move", () => db.run(sql`UPDATE scheduled_occurrences
      SET id = 'moved', scheduled_task_id = 'b', ordinal = 0, schedule_revision = ${once} WHERE id = 'a4'`));
    mutate("ID-only change", () => db.run(sql`UPDATE scheduled_occurrences SET id = 'moved-new' WHERE id = 'moved'`));
    mutate("due-only change", () => db.run(sql`UPDATE scheduled_occurrences SET scheduled_for = 'new-due' WHERE id = 'moved-new'`));
    mutate("duplicate on destination", () => insert("b1", "b", 0));
    mutate("move duplicate to another schedule", () => db.run(sql`UPDATE scheduled_occurrences SET scheduled_task_id = 'a', ordinal = 5 WHERE id = 'b1'`));
    mutate("multirow ordinal and snapshot update", () => db.run(sql`UPDATE scheduled_occurrences SET ordinal = ordinal + 1, schedule_revision = ${interval} WHERE scheduled_task_id = 'a'`));
    mutate("multirow schedule move", () => db.run(sql`UPDATE scheduled_occurrences SET scheduled_task_id = 'b' WHERE scheduled_task_id = 'a'`));
    mutate("multirow deletion", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE scheduled_task_id = 'b' AND ordinal > 0`));

    const beforeRollback = db.all(sql`SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id`);
    db.run(sql`BEGIN IMMEDIATE`);
    mutate("uncommitted insert", () => insert("rollback", "a", 0, once));
    mutate("uncommitted deletion", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'moved-new'`));
    db.run(sql`ROLLBACK`);
    expect(db.all(sql`SELECT * FROM scheduled_occurrence_history ORDER BY scheduled_task_id`)).toEqual(beforeRollback);
    check("rollback restores history and counters");

    expect(() => insert("moved-new", "a", 9)).toThrow();
    check("ordinary INSERT ABORT rolls back conflict invalidation");
    mutate("another row for UPDATE conflict", () => insert("b2", "b", 1));
    expect(() => db.run(sql`UPDATE scheduled_occurrences SET id = 'moved-new' WHERE id = 'b2'`)).toThrow();
    check("ordinary UPDATE ABORT rolls back conflict invalidation");

    mutate("odd first ordinal", () => insert("odd0", "odd", 0));
    mutate("SQLite real affinity in INTEGER column", () => insert("odd-half", "odd", 0.5));
    mutate("odd endpoint", () => insert("odd2", "odd", 2));
    expect(entitlement("odd", 3)).toBe("unconsumed");
    mutate("delete first endpoint", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'odd0'`));
    mutate("delete final endpoint", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'odd2'`));
    mutate("delete remaining row", () => db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'odd-half'`));
  });

  it("invalidates every REPLACE victim and retains missing-summary tombstones through reinsertion", () => {
    const db = getDb();
    insert("replace-id", "id-old", 0, once);
    forget("id-old");
    db.run(sql`INSERT OR REPLACE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('replace-id', 'id-new', 'id-new-due', 0, ${interval})`);
    expect(counterOracle("id-old").total_count).toBe(0);
    staysUntrusted(["id-old", "id-new"]);

    insert("due-victim", "due-owner", 0, once, "same-due");
    db.run(sql`INSERT OR REPLACE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('due-replacement', 'due-owner', 'same-due', 0, ${interval})`);
    staysUntrusted(["due-owner"]);

    insert("two-id", "two-a", 0, once);
    insert("two-due", "two-b", 0, interval, "two-target-due");
    forget("two-a"); forget("two-b");
    db.run(sql`INSERT OR REPLACE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('two-id', 'two-b', 'two-target-due', 0, ${interval})`);
    expect(counterOracle("two-a").total_count).toBe(0);
    expect(counterOracle("two-b").total_count).toBe(1);
    staysUntrusted(["two-a", "two-b"]);

    insert("update-source", "update-old", 0);
    insert("update-id", "update-id-owner", 0, once);
    insert("update-due", "update-new", 0, interval, "update-target-due");
    for (const id of ["update-old", "update-id-owner", "update-new"]) forget(id);
    db.run(sql`UPDATE OR REPLACE scheduled_occurrences SET id = 'update-id', scheduled_task_id = 'update-new',
      scheduled_for = 'update-target-due', ordinal = 1 WHERE id = 'update-source'`);
    expect(counterOracle("update-old").total_count).toBe(0);
    expect(counterOracle("update-id-owner").total_count).toBe(0);
    staysUntrusted(["update-old", "update-id-owner", "update-new"]);

    insert("gap0", "replace-gap", 0); insert("gap1", "replace-gap", 1); insert("gap3", "replace-gap", 3);
    expect(originalOnceEntitlement(db, { id: "replace-gap", runCount: 4 })).toBe("unknown");
    db.run(sql`INSERT OR REPLACE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('gap1', 'replace-gap', 'replacement-gap', 2, ${interval})`);
    // Without the BEFORE invalidation, the suppressed delete makes total=4
    // and endpoints 0/3 falsely look like a complete recurring history.
    expect(originalOnceEntitlement(db, { id: "replace-gap", runCount: 4 })).toBe("unknown");
    expect(entitlement("replace-gap", 4)).toBe("unknown");
    expect(history("replace-gap")).toMatchObject({ trusted: 0 });

    insert("positive-once", "once-trust", 0, once);
    db.run(sql`INSERT OR REPLACE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('positive-once', 'once-trust', 'positive-once', 0, ${interval})`);
    expect(history("once-trust")).toMatchObject({ once_count: 1, trusted: 0 });
    expect(entitlement("once-trust", 1)).toBe("unknown");
  });

  it("conservatively invalidates ignored and upserted conflicts without trusting stale counters", () => {
    const db = getDb();
    insert("ignored", "ignore-owner", 0);
    const before = db.all(sql`SELECT * FROM scheduled_occurrences WHERE id = 'ignored'`);
    db.run(sql`INSERT OR IGNORE INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('ignored', 'ignore-new', 'ignored-new-due', 1, ${once})`);
    expect(db.all(sql`SELECT * FROM scheduled_occurrences WHERE id = 'ignored'`)).toEqual(before);
    expect(originalOnceEntitlement(db, { id: "ignore-owner", runCount: 1 })).toBe("unconsumed");
    expect(originalOnceEntitlement(db, { id: "ignore-new", runCount: 0 })).toBe("unconsumed");
    staysUntrusted(["ignore-owner", "ignore-new"]);

    insert("upserted", "upsert-owner", 0, once);
    db.run(sql`INSERT INTO scheduled_occurrences (id, scheduled_task_id, scheduled_for, ordinal, schedule_revision)
      VALUES ('upserted', 'upsert-new', 'upsert-new-due', 0, ${interval})
      ON CONFLICT(id) DO UPDATE SET schedule_revision = excluded.schedule_revision`);
    expect(originalOnceEntitlement(db, { id: "upsert-owner", runCount: 1 })).toBe("unconsumed");
    expect(originalOnceEntitlement(db, { id: "upsert-new", runCount: 0 })).toBe("unconsumed");
    staysUntrusted(["upsert-owner", "upsert-new"]);
  });

  it("reconstructs missing evidence only from a provably sole surviving row", () => {
    const db = getDb();
    expect(entitlement("never-seen", 0)).toBe("unconsumed");
    expect(entitlement("never-seen", 1)).toBe("unknown");
    insert("missing-once", "missing", 0, once);
    forget("missing");
    expect(entitlement("missing", 0)).toBe("unknown");
    insert("missing-second", "missing", 1);
    expect(history("missing")).toBeUndefined();
    db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${cron} WHERE id = 'missing-second'`);
    expect(history("missing")).toBeUndefined();
    db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'missing-second'`);
    expect(history("missing")).toBeUndefined();
    expect(entitlement("missing", 0)).toBe("unknown");
    db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = schedule_revision WHERE id = 'missing-once'`);
    expect(history("missing")).toBeUndefined();
    db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${interval} WHERE id = 'missing-once'`);
    matchesOriginal("missing", "sole surviving NEW row reconstructs exactly");
    expect(entitlement("missing", 1)).toBe("unconsumed");

    insert("missing-move", "missing", 1);
    forget("missing");
    db.run(sql`UPDATE scheduled_occurrences SET scheduled_task_id = 'new-destination', ordinal = 0 WHERE id = 'missing-move'`);
    expect(history("missing")).toBeUndefined();
    expect(entitlement("missing", 1)).toBe("unknown");
    matchesOriginal("new-destination", "sole row on new destination");
    db.run(sql`DELETE FROM scheduled_occurrences WHERE id = 'missing-once'`);
    expect(entitlement("missing", 0)).toBe("unconsumed");
    insert("new-first", "missing", 0, cron);
    matchesOriginal("missing", "first row after genuinely empty history");
  });

  it("does not rewrite evidence on state lease or result changes and preserves outer CAS counts", () => {
    const db = getDb();
    insert("operational", "operational-owner", 0, once);
    const before = history("operational-owner");
    db.run(sql.raw(`CREATE TRIGGER history_test_no_update BEFORE UPDATE ON scheduled_occurrence_history
      BEGIN SELECT RAISE(ABORT, 'operational mutation rewrote history evidence'); END;`));
    expect(() => db.run(sql`UPDATE scheduled_occurrences SET scheduled_task_id = scheduled_task_id,
      ordinal = ordinal, schedule_revision = schedule_revision WHERE id = 'operational'`)).not.toThrow();
    for (const state of ["publishing", "published", "rejected", "reserved"]) {
      expect(() => db.run(sql`UPDATE scheduled_occurrences SET state = ${state}, lease_owner = 'worker',
        lease_expires_at = '2090-01-01', result = '{"reason":"test"}', updated_at = '2090-01-01' WHERE id = 'operational'`)).not.toThrow();
      expect(history("operational-owner")).toEqual(before);
      expect(entitlement("operational-owner", 1)).toBe("consumed");
    }
    db.run(sql`DROP TRIGGER history_test_no_update`);
    db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${cron}
      WHERE id = 'operational' AND state = 'reserved'`);
    expect(db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n).toBe(1);
    matchesOriginal("operational-owner", "winning CAS with multiple summary writes");
    const after = history("operational-owner");
    db.run(sql`UPDATE scheduled_occurrences SET schedule_revision = ${once}
      WHERE id = 'operational' AND state = 'published'`);
    expect(db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n).toBe(0);
    expect(history("operational-owner")).toEqual(after);
    matchesOriginal("operational-owner", "losing CAS cannot mutate evidence");
  });
});
