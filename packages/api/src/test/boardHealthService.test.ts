import { beforeEach, describe, expect, it, vi } from "vitest";

let insertRows: Array<Record<string, unknown>> = [];
let selectRows: Array<Record<string, unknown>> = [];
let selectRow: Record<string, unknown> | undefined;
let insertShouldThrow = false;

const timeTrackingMocks = vi.hoisted(() => ({ getHabitatMetrics: vi.fn() }));
const dashboardMocks = vi.hoisted(() => ({ getDashboardStats: vi.fn() }));
const predictionMocks = vi.hoisted(() => ({ getPredictions: vi.fn() }));
const capacityMocks = vi.hoisted(() => ({ getCapacityReport: vi.fn() }));
const anomalyMocks = vi.hoisted(() => ({ scanHabitat: vi.fn() }));
const trendMocks = vi.hoisted(() => ({ getHabitatTrends: vi.fn() }));

vi.mock("../repositories/timeTracking.js", () => timeTrackingMocks);
vi.mock("../repositories/events/event-dashboard.js", () => dashboardMocks);
vi.mock("../services/predictionService.js", () => predictionMocks);
vi.mock("../services/capacityService.js", () => capacityMocks);
vi.mock("../services/anomalyService.js", () => anomalyMocks);
vi.mock("../services/trendService.js", () => trendMocks);
vi.mock("uuid", () => ({ v4: vi.fn(() => "health-id") }));

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        run: () => {
          if (insertShouldThrow) throw new Error("insert failed");
          insertRows.push(row);
        },
      }),
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        get: () => selectRow,
        all: () => selectRows,
      };
      return chain;
    },
  }),
}));

vi.mock("../db/schema/index.js", () => ({
  habitatHealthSnapshots: {
    habitatId: "habitat_id",
    snapshotAt: "snapshot_at",
  },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    desc: vi.fn((value) => ({ type: "desc", value })),
    eq: vi.fn((left, right) => ({ type: "eq", left, right })),
    sql: vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => ({ type: "sql" })),
  };
});

import {
  calculateHealth,
  getCurrentHealth,
  getHealthHistory,
} from "../services/boardHealthService.js";

function healthyMetrics(overrides: Record<string, unknown> = {}) {
  return {
    averageEstimationAccuracy: 1,
    onTimeCompletionRate: 1,
    overdueTasks: 0,
    ...overrides,
  };
}

describe("boardHealthService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertRows = [];
    selectRows = [];
    selectRow = undefined;
    insertShouldThrow = false;
    timeTrackingMocks.getHabitatMetrics.mockReturnValue(healthyMetrics());
    dashboardMocks.getDashboardStats.mockReturnValue({
      wipHealth: { todo: "ok", doing: "ok" },
      rejectionRate: 0,
    });
    predictionMocks.getPredictions.mockReturnValue({ atRiskTasks: [] });
    trendMocks.getHabitatTrends.mockReturnValue({
      trends: [
        {
          metric: "cycle_time",
          percentDelta: 0,
          confidence: "insufficient_data",
        },
        {
          metric: "throughput",
          percentDelta: 0,
          confidence: "insufficient_data",
        },
      ],
    });
    capacityMocks.getCapacityReport.mockReturnValue({
      summary: { averageUtilization: 0.7, totalAvailable: 2 },
    });
    anomalyMocks.scanHabitat.mockReturnValue([]);
  });

  it("calculates and stores a healthy habitat snapshot", () => {
    const report = calculateHealth("habitat-1");

    expect(report.habitatId).toBe("habitat-1");
    expect(report.grade).toBe("A");
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.recommendations).toEqual(["Habitat is healthy — keep up the good work!"]);
    expect(insertRows).toHaveLength(1);
    expect(insertRows[0]).toMatchObject({ id: "health-id", habitatId: "habitat-1", grade: "A" });
    expect(JSON.parse(insertRows[0].dimensions as string).capacity.agentAvailability).toBe(2);
  });

  it("surfaces degraded signals as lower scores and targeted recommendations", () => {
    timeTrackingMocks.getHabitatMetrics.mockReturnValue(
      healthyMetrics({
        averageEstimationAccuracy: 0.4,
        onTimeCompletionRate: 0.4,
        overdueTasks: 4,
      }),
    );
    dashboardMocks.getDashboardStats.mockReturnValue({
      wipHealth: { todo: "exceeded", doing: "warning" },
      rejectionRate: 0.2,
    });
    predictionMocks.getPredictions.mockReturnValue({ atRiskTasks: ["t1", "t2", "t3"] });
    capacityMocks.getCapacityReport.mockReturnValue({
      summary: { averageUtilization: 0.95, totalAvailable: 0 },
    });
    anomalyMocks.scanHabitat.mockReturnValue([
      { severity: "critical", type: "blocked" },
      { severity: "warning", type: "stale_in_progress" },
      { severity: "warning", type: "stale_in_progress" },
      { severity: "warning", type: "stale_in_progress" },
    ]);

    const report = calculateHealth("habitat-1");

    expect(report.grade).not.toBe("A");
    expect(report.dimensions.flow.wipUtilization).toBe(0.75);
    expect(report.dimensions.quality.rejectionRate).toBe(0.2);
    expect(report.dimensions.delivery).toMatchObject({ overdueTasks: 4, atRiskTasks: 3 });
    expect(report.dimensions.capacity).toMatchObject({
      agentUtilization: 0.95,
      agentAvailability: 0,
    });
    expect(report.dimensions.stability).toMatchObject({
      anomalyCount: 4,
      criticalAnomalies: 1,
      staleTaskCount: 3,
    });
    expect(report.recommendations).toEqual(
      expect.arrayContaining([
        "High rejection rate — review task descriptions for clarity and check agent domain matching",
        "Multiple overdue tasks — consider reducing sprint scope or reassigning tasks",
        "Several at-risk tasks detected — check for blockers or stalled work",
        "All agents are busy — consider adding more agents or reducing workload",
        "Agent utilization is very high — risk of burnout, consider redistributing tasks",
        "WIP limits are exceeded — finish current work before starting new tasks",
        "Critical anomalies detected — review and address immediately",
        "Multiple stale tasks — agents may have gone offline without releasing claims",
        "Poor estimation accuracy — tasks are taking 2x+ longer than estimated",
      ]),
    );
  });

  it("derives formerly stubbed health fields from real metric inputs", () => {
    timeTrackingMocks.getHabitatMetrics.mockReturnValue(
      healthyMetrics({ onTimeCompletionRate: 0.6 }),
    );
    dashboardMocks.getDashboardStats.mockImplementation((_habitatId: string, period?: string) => {
      if (period === "30d") {
        return {
          throughput: [{ count: 30 }],
          summary: { averageCycleTimeMinutes: 100 },
          wipHealth: [{ health: "ok" }, { health: "ok" }],
          taskByStatus: { pending: 0 },
        };
      }
      return {
        throughput: [{ count: 14 }],
        summary: { averageCycleTimeMinutes: 150 },
        wipHealth: [{ health: "warning" }, { health: "exceeded" }],
        taskByStatus: { pending: 9 },
      };
    });
    trendMocks.getHabitatTrends.mockReturnValue({
      trends: [
        {
          metric: "cycle_time",
          percentDelta: 0.5,
          confidence: "low",
        },
        {
          metric: "throughput",
          percentDelta: 1,
          confidence: "low",
        },
      ],
    });
    capacityMocks.getCapacityReport.mockReturnValue({
      summary: { averageUtilization: 0.7, totalAvailable: 3 },
    });

    const report = calculateHealth("habitat-1");

    expect(report.dimensions.flow).toMatchObject({
      cycleTimeTrend: 0.5,
      throughputTrend: 1,
      wipUtilization: 0.75,
    });
    expect(report.dimensions.delivery.slaCompliance).toBe(0.6);
    expect(report.dimensions.capacity.backlogToAgentRatio).toBe(3);
  });

  it("does not surface numeric flow trends when trend samples are insufficient", () => {
    trendMocks.getHabitatTrends.mockReturnValue({
      trends: [
        {
          metric: "cycle_time",
          percentDelta: 0.5,
          confidence: "insufficient_data",
        },
        {
          metric: "throughput",
          percentDelta: 1,
          confidence: "insufficient_data",
        },
      ],
    });

    const report = calculateHealth("habitat-1");

    expect(report.dimensions.flow).toMatchObject({
      cycleTimeTrend: 0,
      throughputTrend: 0,
    });
  });

  it("still returns a report when snapshot insertion fails", () => {
    insertShouldThrow = true;

    const report = calculateHealth("habitat-1");

    expect(report.habitatId).toBe("habitat-1");
    expect(insertRows).toEqual([]);
  });

  it("reads the current health snapshot", () => {
    selectRow = {
      habitatId: "habitat-1",
      score: 75,
      grade: "B",
      dimensions: JSON.stringify({ flow: { score: 80 } }),
      recommendations: JSON.stringify(["Keep going"]),
      snapshotAt: "2026-05-28T10:00:00.000Z",
    };

    expect(getCurrentHealth("habitat-1")).toEqual({
      habitatId: "habitat-1",
      score: 75,
      grade: "B",
      dimensions: { flow: { score: 80 } },
      recommendations: ["Keep going"],
      snapshotAt: "2026-05-28T10:00:00.000Z",
    });
  });

  it("returns null when there is no current snapshot", () => {
    selectRow = undefined;

    expect(getCurrentHealth("habitat-1")).toBeNull();
  });

  it("reads health history rows newest first as returned by the database", () => {
    selectRows = [
      {
        habitatId: "habitat-1",
        score: 90,
        grade: "A",
        dimensions: JSON.stringify({ flow: { score: 100 } }),
        recommendations: JSON.stringify([]),
        snapshotAt: "2026-05-28T10:00:00.000Z",
      },
      {
        habitatId: "habitat-1",
        score: 70,
        grade: "C",
        dimensions: JSON.stringify({ flow: { score: 60 } }),
        recommendations: JSON.stringify(["Fix WIP"]),
        snapshotAt: "2026-05-27T10:00:00.000Z",
      },
    ];

    expect(getHealthHistory("habitat-1", 7)).toEqual([
      expect.objectContaining({
        score: 90,
        dimensions: { flow: { score: 100 } },
        recommendations: [],
      }),
      expect.objectContaining({
        score: 70,
        dimensions: { flow: { score: 60 } },
        recommendations: ["Fix WIP"],
      }),
    ]);
  });
});
