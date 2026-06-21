import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExperienceMetricsResult, WorkflowMetricsResult } from "../types/index.js";

const mockAuthMe = vi.fn();
const mockMetricsExperience = vi.fn();
const mockMetricsWorkflow = vi.fn();

vi.mock("../api/index.js", () => ({
  api: {
    auth: {
      me: (...args: unknown[]) => mockAuthMe(...args),
    },
    metrics: {
      experience: (...args: unknown[]) => mockMetricsExperience(...args),
      workflow: (...args: unknown[]) => mockMetricsWorkflow(...args),
    },
  },
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span data-testid="arrow-left">←</span>,
}));

vi.mock("../components/ui/Card.js", () => ({
  Card: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

import { AdminWorkflowsPage } from "./AdminWorkflowsPage.js";

const adminUser = {
  user: { id: "admin-1", username: "admin", role: "admin", displayName: "Admin" },
};

const viewerUser = {
  user: { id: "viewer-1", username: "viewer", role: "viewer", displayName: "Viewer" },
};

const emptyExperience: ExperienceMetricsResult = {
  agents: [],
  medianSignalsTaskRatio: 0,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const sampleExperience: ExperienceMetricsResult = {
  agents: [
    {
      agentId: "agent-1",
      agentName: "Agent Alpha",
      agentType: "claude-code",
      agentDomain: "general",
      signalCount: 5,
      tasksWorked: 2,
      signalsTaskRatio: 2.5,
      categoryDistribution: { stuck: 3, smooth: 2 },
      midTaskCount: 4,
      completionCount: 1,
      midTaskCompletionRatio: 4,
      outlierFlag: null,
    },
  ],
  medianSignalsTaskRatio: 2.5,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const emptyWorkflow: WorkflowMetricsResult = {
  activeWorkflowsCount: 0,
  failureRate: 0,
  recoverySuccessRate: 0,
  recoveryAttemptsByDepth: [],
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const sampleWorkflow: WorkflowMetricsResult = {
  activeWorkflowsCount: 3,
  failureRate: 0.25,
  recoverySuccessRate: 0.8,
  recoveryAttemptsByDepth: [
    { recoveryDepth: 0, total: 5 },
    { recoveryDepth: 1, total: 2 },
  ],
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function renderPage(habitatId = "hab-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/habitats/${habitatId}/admin/workflows`]}>
        <Routes>
          <Route path="/habitats/:habitatId/admin/workflows" element={<AdminWorkflowsPage />} />
          <Route path="/" element={<div>Home Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AdminWorkflowsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthMe.mockResolvedValue(adminUser);
    mockMetricsExperience.mockResolvedValue(emptyExperience);
    mockMetricsWorkflow.mockResolvedValue(emptyWorkflow);
  });

  afterEach(() => {
    cleanup();
  });

  it("redirects non-admin users to home", async () => {
    mockAuthMe.mockResolvedValue(viewerUser);
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Home Page")).toBeTruthy();
    });
  });

  it("renders the page title and both panels for admins", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("admin-workflows-page")).toBeTruthy();
    });
    expect(screen.getByTestId("admin-workflows-title").textContent).toContain(
      "Workflow & Experience Metrics",
    );
    expect(screen.getByTestId("workflow-metrics-panel")).toBeTruthy();
    expect(screen.getByTestId("experience-metrics-panel")).toBeTruthy();
  });

  it("renders the time range selector with 7/30/all options", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("time-range-select")).toBeTruthy();
    });
    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    expect(select.value).toBe("30");
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(3);
  });

  it("changes the days parameter when the time range changes", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("time-range-select")).toBeTruthy();
    });

    mockMetricsExperience.mockClear();
    mockMetricsWorkflow.mockClear();

    const select = screen.getByTestId("time-range-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "7" } });

    await waitFor(() => {
      expect(mockMetricsExperience).toHaveBeenCalledWith("hab-1", 7);
      expect(mockMetricsWorkflow).toHaveBeenCalledWith("hab-1", 7);
    });
  });

  it("shows the back to habitat link", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("admin-workflows-back")).toBeTruthy();
    });
  });

  it("renders workflow metrics data from the API", async () => {
    mockMetricsWorkflow.mockResolvedValue(sampleWorkflow);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("metric-active-workflows").textContent).toContain("3");
    });
    expect(screen.getByTestId("metric-failure-rate").textContent).toContain("25%");
    expect(screen.getByTestId("metric-recovery-rate").textContent).toContain("80%");
  });

  it("renders experience metrics data from the API", async () => {
    mockMetricsExperience.mockResolvedValue(sampleExperience);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("experience-agent-agent-1")).toBeTruthy();
    });
    expect(screen.getByText("Agent Alpha")).toBeTruthy();
    expect(screen.getByTestId("ratio-agent-1").textContent).toBe("2.50");
  });

  it("renders empty states when no data", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("workflow-metrics-empty")).toBeTruthy();
      expect(screen.getByTestId("experience-metrics-empty")).toBeTruthy();
    });
  });
});
