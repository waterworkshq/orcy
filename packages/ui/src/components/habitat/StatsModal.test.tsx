import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { StatsModal } from "./StatsModal.js";

const mockStats = vi.fn();
const mockTimeMetrics = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: { stats: (...args: any[]) => mockStats(...args) },
    timeTracking: { getHabitatMetrics: (...args: any[]) => mockTimeMetrics(...args) },
  },
}));

vi.mock("../ui/Card.js", () => ({
  Card: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardHeader: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardTitle: ({ children, className }: any) => <div className={className}>{children}</div>,
  CardContent: ({ children, className }: any) => <div className={className}>{children}</div>,
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

const baseStats = {
  cycleTime: { averageMinutes: 120, medianMinutes: 90, count: 10 },
  throughput: { today: 2, thisWeek: 8, thisMonth: 25 },
  wipHealth: [
    { columnId: "col-1", columnName: "In Progress", current: 3, limit: 5, health: "ok" as const },
  ],
  missionSummary: {
    total: 2,
    completed: 1,
    blocked: 0,
    byStatus: { not_started: 0, in_progress: 1, review: 0, done: 1, failed: 0 },
  },
};

function renderWithQueryClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("StatsModal", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockStats.mockResolvedValue(baseStats);
    mockTimeMetrics.mockResolvedValue({
      averageCycleTime: 100,
      averageLeadTime: 200,
      averageEstimationAccuracy: 0.85,
      totalPlannedMinutes: 500,
      totalActualMinutes: 450,
      overdueTasks: 0,
      onTimeCompletionRate: 0.9,
      agentMetrics: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("uses backdrop-blur-2xl for frosted glass effect", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    const allElements = document.querySelectorAll("*");
    const withBlur = Array.from(allElements).filter(
      (el) =>
        el.className &&
        typeof el.className === "string" &&
        el.className.includes("backdrop-blur-2xl"),
    );
    expect(withBlur.length).toBeGreaterThan(0);
  });

  it("uses bg-surface-container/85 for modal background", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    const dialog = document.querySelector(".bg-surface-container\\/85");
    expect(dialog).toBeTruthy();
  });

  it("renders board statistics header", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    expect(await screen.findByText("Habitat Statistics")).toBeTruthy();
  });

  it("renders feature count after loading", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    const elements = await screen.findAllByText("2");
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading spinner initially", () => {
    mockStats.mockReturnValue(new Promise(() => {}));

    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    const spinner = document.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();
  });

  it("renders close button", async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={onClose} />);

    const closeBtn = await screen.findByRole("button");
    expect(closeBtn).toBeTruthy();
  });

  it("modal overlay has z-50", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    const overlay = document.querySelector(".z-50");
    expect(overlay).toBeTruthy();
  });

  it("renders WIP health section after loading", async () => {
    renderWithQueryClient(<StatsModal habitatId="board-1" onClose={vi.fn()} />);

    expect(await screen.findByText("WIP Health")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
  });
});
