import { describe, it, expect, vi } from "vitest";

let _allResult: Array<Record<string, unknown>> = [];
let _getResults: Array<Record<string, unknown> | undefined> = [];

function createMockDb() {
  let getCall = 0;
  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      all: () => _allResult,
      get: () => _getResults[getCall++],
    };
    return chain;
  };
  return { select: () => doSelect() };
}

vi.mock("../db/index.js", () => ({ getDb: () => createMockDb() }));
vi.mock("../db/schema/index.js", () => ({
  columns: {
    id: "id",
    name: "name",
    habitatId: "habitat_id",
    isTerminal: "is_terminal",
    order: "order",
  },
}));
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    asc: vi.fn((_c) => ({ _type: "asc" })),
  };
});

import { resolveImportColumn } from "../services/integrations/columnResolver.js";

describe("columnResolver", () => {
  it("returns Todo column by exact name", () => {
    _getResults = [{ id: "col-todo", name: "Todo" }];
    const r = resolveImportColumn("h1")!;
    expect(r.columnId).toBe("col-todo");
    expect(r.warning).toBeUndefined();
  });

  it("returns case-insensitive match", () => {
    _getResults = [undefined];
    _allResult = [{ id: "col-2", name: "TODO" }];
    const r = resolveImportColumn("h1")!;
    expect(r.columnId).toBe("col-2");
  });

  it("returns first non-terminal when no Todo", () => {
    _getResults = [undefined, { id: "col-1", name: "Backlog", isTerminal: false, order: 0 }];
    _allResult = [];
    const r = resolveImportColumn("h1")!;
    expect(r.columnId).toBe("col-1");
    expect(r.warning).toContain("No 'Todo' column");
  });

  it("returns null when nothing matches", () => {
    _getResults = [undefined, undefined, undefined];
    _allResult = [];
    expect(resolveImportColumn("h1")).toBeNull();
  });
});
