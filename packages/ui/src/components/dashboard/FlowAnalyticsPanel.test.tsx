import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { FlowAnalyticsData } from "./FlowAnalyticsPanel.js";
import type { BottleneckResponse, CumulativeFlowResponse } from "../../types/index.js";

afterEach(() => {
  cleanup();
});

const flow: CumulativeFlowResponse = {
  habitatId: "habitat-1",
  days: 30,
  generatedAt: "2026-06-05T00:00:00.000Z",
  columns: [
    { columnId: "todo", name: "Todo", order: 0 },
    { columnId: "doing", name: "Doing", order: 1 },
  ],
  data: [
    {
      date: "2026-06-05",
      countsByColumn: { todo: 2, doing: 5 },
      countsByStatus: { pending: 2, in_progress: 5 },
    },
  ],
  warnings: [
    { code: "partial_history", message: "Some days lack durable snapshots.", severity: "warning" },
  ],
};

const bottlenecks: BottleneckResponse = {
  habitatId: "habitat-1",
  days: 30,
  generatedAt: "2026-06-05T00:00:00.000Z",
  findings: [
    {
      columnId: "doing",
      columnName: "Doing",
      severity: "high",
      signal: "wip_exceeded",
      confidence: "high",
      summary: "Doing is above WIP limit.",
      evidence: { currentCount: 5, wipLimit: 2 },
      recommendation: "Review active work before starting more.",
    },
  ],
  warnings: [],
};

describe("FlowAnalyticsData", () => {
  it("renders cumulative flow counts, warnings, and bottleneck recommendations", () => {
    render(<FlowAnalyticsData flow={flow} bottlenecks={bottlenecks} />);

    expect(screen.getByText("Cumulative Flow")).toBeInTheDocument();
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("Doing")).toBeInTheDocument();
    expect(screen.getByText(/Some days lack durable snapshots/)).toBeInTheDocument();
    expect(screen.getByText("Doing is above WIP limit.")).toBeInTheDocument();
    expect(screen.getByText("Review active work before starting more.")).toBeInTheDocument();
  });

  it("renders empty states when no flow samples or findings exist", () => {
    render(
      <FlowAnalyticsData
        flow={{ ...flow, data: [], warnings: [] }}
        bottlenecks={{ ...bottlenecks, findings: [] }}
      />,
    );

    expect(screen.getByText("No cumulative-flow samples yet.")).toBeInTheDocument();
    expect(screen.getByText("No bottleneck findings in this window.")).toBeInTheDocument();
  });
});
