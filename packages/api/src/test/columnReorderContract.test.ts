import { describe, it, expect, vi, beforeEach } from "vitest";

// Contract proof for columnRepo.reorderColumns. Uses a hand-rolled drizzle
// chain mock that records every read/write call so we can prove:
//   - all-or-nothing commit on match
//   - versionConflict with ZERO writes on stale expectedOrder
//   - validation rejects length mismatch, non-unique arrays, foreign columns,
//     and incomplete expectedOrder
//   - SSE publish happens only after commit (verified at the route layer in
//     columnRoutesContract.test.ts)

type Row = { id: string; habitat_id: string; name: string; order: number };

let currentRows: Row[] = [];
let updateCalls: { set: Record<string, unknown>; where: unknown }[] = [];
let rawSqlCalls: string[] = [];
let txCommits = 0;
let txRollbacks = 0;
let txThrew: unknown = null;

function resetState() {
  currentRows = [];
  updateCalls = [];
  rawSqlCalls = [];
  txCommits = 0;
  txRollbacks = 0;
  txThrew = null;
}

function seed(rows: Row[]) {
  currentRows = rows;
}

function buildChain() {
  const chain: Record<string, unknown> = {};
  const finalize = (): Row[] => currentRows;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => chain;
  chain.all = finalize;
  chain.get = () => currentRows[0];
  return chain;
}

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    select: () => buildChain(),
    run: (sql: { toQuery?: () => { sql: string } }) => {
      let stmt = "";
      try {
        if (sql && typeof sql === "object" && "toQuery" in sql) {
          stmt = (sql as { toQuery: () => { sql: string } }).toQuery().sql;
        }
      } catch {
        // ignore — non-query
      }
      rawSqlCalls.push(stmt);
      return undefined;
    },
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updateCalls.push({ set, where });
          return { run: () => undefined };
        },
      }),
    }),
    transaction: (cb: (tx: unknown) => unknown) => {
      const tx = {
        select: () => buildChain(),
        update: () => ({
          set: (set: Record<string, unknown>) => ({
            where: (where: unknown) => {
              updateCalls.push({ set, where });
              return { run: () => undefined };
            },
          }),
        }),
        run: (sql: { toQuery?: () => { sql: string } }) => {
          let stmt = "";
          try {
            if (sql && typeof sql === "object" && "toQuery" in sql) {
              stmt = (sql as { toQuery: () => { sql: string } }).toQuery().sql;
            }
          } catch {
            // ignore
          }
          rawSqlCalls.push(stmt);
          return undefined;
        },
      };
      try {
        cb(tx);
        txCommits++;
      } catch (err) {
        txRollbacks++;
        txThrew = err;
        throw err;
      }
    },
  }),
}));

vi.mock("../db/schema/index.js", () => ({
  columns: {
    id: "id",
    habitatId: "habitat_id",
    name: "name",
    order: "order",
    isTerminal: "is_terminal",
  },
  missions: { id: "id", columnId: "column_id" },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    asc: vi.fn((_c) => ({ _type: "asc" })),
    inArray: vi.fn((_c, _v) => ({ _type: "inArray" })),
  };
});

import { reorderColumns } from "../repositories/column.js";

function row(id: string, habitatId: string, order: number): Row {
  return { id, habitat_id: habitatId, name: id.toUpperCase(), order };
}

describe("columnRepo.reorderColumns — atomic OCC contract (mocked drizzle)", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns invalid for length mismatch without opening a transaction", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c2"], ["c3", "c2", "c1"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalid" in result).toBe(true);
    expect(txCommits).toBe(0);
    expect(updateCalls).toHaveLength(0);
    expect(rawSqlCalls).toHaveLength(0);
  });

  it("returns invalid for non-unique expectedOrder", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c1", "c3"], ["c3", "c2", "c1"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalid" in result).toBe(true);
    expect(txCommits).toBe(0);
  });

  it("returns invalid for set mismatch (foreign column in desiredOrder)", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c2", "c3"], ["c1", "c2", "foreign"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalid" in result).toBe(true);
    expect(txCommits).toBe(0);
  });

  it("returns invalid when expectedOrder omits a real column", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c2"], ["c1", "c2"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalid" in result).toBe(true);
    expect(txCommits).toBe(0);
  });

  it("returns notFound when habitat has no columns", () => {
    seed([]);
    const result = reorderColumns("empty-h", ["c1"], ["c1"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("notFound" in result).toBe(true);
    expect(txCommits).toBe(0);
  });

  it("returns versionConflict and rolls back WITHOUT writes on stale expectedOrder", () => {
    // Real on-disk order is [c1, c2, c3]; caller claims it is [c1, c3, c2].
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c3", "c2"], ["c3", "c2", "c1"]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect("versionConflict" in result).toBe(true);
    if ("versionConflict" in result) {
      expect(result.currentOrder).toEqual(["c1", "c2", "c3"]);
    }
    // The transaction threw the conflict sentinel → rolled back, no commit.
    expect(txCommits).toBe(0);
    expect(txRollbacks).toBe(1);
    // No UPDATE may have been issued before the mismatch was detected.
    expect(updateCalls).toHaveLength(0);
    expect(rawSqlCalls).toHaveLength(0);
  });

  it("commits and runs both phases (shift + final) when expectedOrder matches", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    const result = reorderColumns("h1", ["c1", "c2", "c3"], ["c3", "c2", "c1"]);
    expect(result.success).toBe(true);
    expect(txCommits).toBe(1);
    expect(txRollbacks).toBe(0);
    // Phase 1 (shift via .update().set().where()) + Phase 2 (raw UPDATE) ran.
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(rawSqlCalls.length).toBeGreaterThanOrEqual(1);
    if (!result.success) return;
    // Result columns are returned in the same order as currentRows order-by.
    expect(result.columns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("validates membership before opening the transaction (foreign column rejected even with matching length)", () => {
    seed([row("c1", "h1", 0), row("c2", "h1", 1), row("c3", "h1", 2)]);
    // Same length & unique, but 'c4' is not in habitat — caught by membership check.
    const result = reorderColumns("h1", ["c1", "c2", "c4"], ["c4", "c2", "c1"]);
    expect(result.success).toBe(false);
    if (!result.success) expect("invalid" in result).toBe(true);
    expect(txCommits).toBe(0);
  });
});
