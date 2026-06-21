import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowMetricsResult } from "../../types/index.js";

const mockMetricsWorkflow = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    metrics: {
      workflow: (...args: unknown[]) => mockMetricsWorkflow(...args),
    },
  },
}));

vi.mock("../ui/Card.js", () => ({
  Card: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

import { WorkflowMetricsPanel } from "./WorkflowMetricsPanel.js";

function renderPanel(days = 30) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkflowMetricsPanel habitatId="hab-1" days={days} />
    </QueryClientProvider>,
  );
}

const emptyResult: WorkflowMetricsResult = {
  activeWorkflowsCount: 0,
  failureRate: 0,
  recoverySuccessRate: 0,
  recoveryAttemptsByDepth: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const sampleResult: WorkflowMetricsResult = {
  activeWorkflowsCount: 5,
  failureRate: 0.3,
  recoverySuccessRate: 0.67,
  recoveryAttemptsByDepth: [
    { recoveryDepth: 0, total: 10 },
    { recoveryDepth: 1, total: 4 },
    { recoveryDepth: 2, total: 1 },
  ],
  generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("WorkflowMetricsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state initially", () => {
    mockMetricsWorkflow.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByTestId("workflow-metrics-loading")).toBeTruthy();
  });

  it("shows error state on failure", async () => {
    mockMetricsWorkflow.mockRejectedValue(new Error("fail"));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("workflow-metrics-error")).toBeTruthy();
    });
  });

  it("shows empty state when no active workflows or recovery data", async () => {
    mockMetricsWorkflow.mockResolvedValue(emptyResult);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("workflow-metrics-empty")).toBeTruthy();
    });
  });

  it("renders metric cards with correct values", async () => {
    mockMetricsWorkflow.mockResolvedValue(sampleResult);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("metric-active-workflows").textContent).toContain("5");
    });
    expect(screen.getByTestId("metric-failure-rate").textContent).toContain("30%");
    expect(screen.getByTestId("metric-recovery-rate").textContent).toContain("67%");
  });

  it("renders recovery depth distribution", async () => {
    mockMetricsWorkflow.mockResolvedValue(sampleResult);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("recovery-depth-0")).toBeTruthy();
    });
    expect(screen.getByTestId("recovery-depth-0").textContent).toContain("10");
    expect(screen.getByTestId("recovery-depth-1").textContent).toContain("4");
    expect(screen.getByTestId("recovery-depth-2").textContent).toContain("1");
  });

  it("labels depth levels with descriptive names", async () => {
    mockMetricsWorkflow.mockResolvedValue(sampleResult);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("recovery-depth-0").textContent).toContain("original");
    });
    expect(screen.getByTestId("recovery-depth-1").textContent).toContain("first recovery");
    expect(screen.getByTestId("recovery-depth-2").textContent).toContain("deep recovery");
  });
});
