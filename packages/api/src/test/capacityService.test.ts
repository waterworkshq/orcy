import { describe, it, expect, vi, beforeEach } from "vitest";

let _getResult: Record<string, unknown> = { count: 0 };

function createMockDb() {
  const doSelect = () => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      get: () => _getResult,
    };
    return chain;
  };
  return { select: () => doSelect() };
}

vi.mock("../db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/index.js")>();
  return { ...actual, getDb: () => createMockDb() };
});

vi.mock("../db/schema/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/schema/index.js")>();
  return { ...actual };
});

vi.mock("../db/dialect-helpers.js", () => ({
  cycleTimeMinutes: vi.fn(() => ({ _type: "cycleTimeExpr" })),
}));

vi.mock("../repositories/agent.js", () => ({ listAgents: vi.fn() }));
vi.mock("../repositories/board.js", () => ({ getHabitatById: vi.fn() }));
vi.mock("../services/autoAssignService.js", () => ({ getAutoAssignSettings: vi.fn() }));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  const sqlFn = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => ({ _type: "sql" }));
  return {
    ...actual,
    eq: vi.fn((_c, _v) => ({ _type: "eq" })),
    and: vi.fn((..._c) => ({ _type: "and" })),
    inArray: vi.fn((_c, _v) => ({ _type: "inArray" })),
    isNotNull: vi.fn((_c) => ({ _type: "isNotNull" })),
    sql: sqlFn,
  };
});

import { getCapacityReport } from "../services/capacityService.js";
import * as agentRepo from "../repositories/agent.js";
import { getHabitatById } from "../repositories/board.js";
import { getAutoAssignSettings } from "../services/autoAssignService.js";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return { id: "a1", name: "Agent 1", domain: "backend", status: "online", ...overrides };
}

describe("capacityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _getResult = { count: 0 };
  });

  it("returns null when habitat not found", () => {
    vi.mocked(getHabitatById).mockReturnValue(null);
    expect(getCapacityReport("missing")).toBeNull();
  });

  it("returns report with agent capacities", () => {
    vi.mocked(getHabitatById).mockReturnValue({ id: "h1", name: "H" } as any);
    vi.mocked(getAutoAssignSettings).mockReturnValue({ maxTasksPerAgent: 5 } as any);
    vi.mocked(agentRepo.listAgents).mockReturnValue([
      makeAgent() as any,
      makeAgent({ id: "a2", name: "B" }) as any,
    ]);

    _getResult = { count: 2 };

    const result = getCapacityReport("h1")!;

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].activeTasks).toBe(2);
    expect(result.summary.totalCapacity).toBe(10);
  });

  it("detects over-capacity", () => {
    vi.mocked(getHabitatById).mockReturnValue({ id: "h1", name: "H" } as any);
    vi.mocked(getAutoAssignSettings).mockReturnValue({ maxTasksPerAgent: 3 } as any);
    vi.mocked(agentRepo.listAgents).mockReturnValue([makeAgent() as any]);

    _getResult = { count: 5 };

    const result = getCapacityReport("h1")!;

    expect(result.agents[0].overCapacity).toBe(true);
    expect(result.summary.overCapacityCount).toBe(1);
  });

  it("handles empty agent list", () => {
    vi.mocked(getHabitatById).mockReturnValue({ id: "h1", name: "H" } as any);
    vi.mocked(getAutoAssignSettings).mockReturnValue({ maxTasksPerAgent: 3 } as any);
    vi.mocked(agentRepo.listAgents).mockReturnValue([]);

    const result = getCapacityReport("h1")!;

    expect(result.agents).toEqual([]);
    expect(result.summary.totalCapacity).toBe(0);
  });

  it("handles zero maxTasksPerAgent", () => {
    vi.mocked(getHabitatById).mockReturnValue({ id: "h1", name: "H" } as any);
    vi.mocked(getAutoAssignSettings).mockReturnValue({ maxTasksPerAgent: 0 } as any);
    vi.mocked(agentRepo.listAgents).mockReturnValue([makeAgent() as any]);

    _getResult = { count: 3 };

    const result = getCapacityReport("h1")!;

    expect(result.agents[0].maxTasks).toBe(0);
    expect(result.agents[0].utilization).toBe(0);
  });
});
