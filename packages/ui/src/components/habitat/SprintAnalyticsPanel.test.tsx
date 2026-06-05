import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BurndownResponse,
  SprintCarryOverReport,
  SprintMetricsV2,
} from "../../types/index.js";

const mocks = vi.hoisted(() => ({
  useSprintMetrics: vi.fn(),
  useSprintBurndown: vi.fn(),
  useSprintCarryOver: vi.fn(),
}));

vi.mock("../../lib/useHabitatData.js", () => mocks);

vi.mock("../dashboard/BurndownChart.js", () => ({
  BurndownChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="sprint-burndown-chart">Burndown:{data.length}</div>
  ),
}));

import { SprintAnalyticsPanel } from "./SprintAnalyticsPanel.js";

const metrics: SprintMetricsV2 = {
  sprintId: "sprint-1",
  totalMissions: 2,
  completedMissions: 1,
  completionPercentage: 50,
  totalTasks: 4,
  completedTasks: 2,
  velocity: 3,
  remainingDays: 5,
  isOnTrack: false,
  plannedMinutes: 180,
  loggedEffortMinutes: 90,
  inferredPresenceMinutes: 20,
  carryOverCount: 1,
  forecast: null,
  warnings: [
    {
      code: "insufficient_forecast_data",
      message: "Sprint forecast has insufficient sample history.",
      severity: "warning",
    },
  ],
};

const burndown: BurndownResponse = {
  data: [
    { date: "2026-06-01", completed: 0, remaining: 4, idealRemaining: 4, totalTasks: 4 },
    { date: "2026-06-02", completed: 1, remaining: 3, idealRemaining: 3.5, totalTasks: 4 },
  ],
  startDate: "2026-06-01T00:00:00.000Z",
  endDate: "2026-06-14T00:00:00.000Z",
  totalTasks: 4,
  completedTasks: 1,
  remainingTasks: 3,
  averageDailyVelocity: 0.5,
  estimatedCompletionDate: null,
};

const carryOver: SprintCarryOverReport = {
  sprintId: "sprint-1",
  generatedAt: "2026-06-05T00:00:00.000Z",
  policy: "backlog",
  carriedOverMissions: [
    {
      missionId: "mission-1",
      title: "Unfinished mission",
      status: "in_progress",
      reasons: [
        { code: "incomplete_tasks", message: "2 tasks are incomplete.", severity: "warning" },
      ],
    },
  ],
  warnings: [],
};

beforeEach(() => {
  mocks.useSprintMetrics.mockReturnValue({ data: metrics, isLoading: false, error: null });
  mocks.useSprintBurndown.mockReturnValue({ data: burndown, isLoading: false, error: null });
  mocks.useSprintCarryOver.mockReturnValue({ data: carryOver, isLoading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SprintAnalyticsPanel", () => {
  it("renders metrics, burndown, warnings, and carry-over reasons", () => {
    render(<SprintAnalyticsPanel sprintId="sprint-1" />);

    expect(screen.getByText("Sprint Analytics")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(
      screen.getByText("Sprint forecast has insufficient sample history."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sprint-burndown-chart")).toHaveTextContent("Burndown:2");
    expect(screen.getByText("Unfinished mission")).toBeInTheDocument();
    expect(screen.getByText("2 tasks are incomplete.")).toBeInTheDocument();
  });

  it("renders loading state", () => {
    mocks.useSprintMetrics.mockReturnValue({ data: null, isLoading: true, error: null });

    render(<SprintAnalyticsPanel sprintId="sprint-1" />);

    expect(screen.getByText("Loading sprint analytics...")).toBeInTheDocument();
  });

  it("renders carry-over empty state", () => {
    mocks.useSprintCarryOver.mockReturnValue({
      data: { ...carryOver, carriedOverMissions: [] },
      isLoading: false,
      error: null,
    });

    render(<SprintAnalyticsPanel sprintId="sprint-1" />);

    expect(screen.getByText("No carry-over candidates right now.")).toBeInTheDocument();
  });
});
