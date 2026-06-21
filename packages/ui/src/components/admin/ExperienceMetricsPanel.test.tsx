import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExperienceMetricsResult } from "../../types/index.js";

const mockMetricsExperience = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    metrics: {
      experience: (...args: unknown[]) => mockMetricsExperience(...args),
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

import { ExperienceMetricsPanel } from "./ExperienceMetricsPanel.js";

function renderPanel(days = 30) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ExperienceMetricsPanel habitatId="hab-1" days={days} />
    </QueryClientProvider>,
  );
}

const emptyResult: ExperienceMetricsResult = {
  agents: [],
  medianSignalsTaskRatio: 0,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const resultWithOutliers: ExperienceMetricsResult = {
  agents: [
    {
      agentId: "agent-high",
      agentName: "High Reporter",
      agentType: "claude-code",
      agentDomain: "general",
      signalCount: 20,
      tasksWorked: 2,
      signalsTaskRatio: 10,
      categoryDistribution: { stuck: 15, confused: 5 },
      midTaskCount: 18,
      completionCount: 2,
      midTaskCompletionRatio: 9,
      outlierFlag: "high_reporter",
    },
    {
      agentId: "agent-normal",
      agentName: "Normal Agent",
      agentType: "codex",
      agentDomain: "backend",
      signalCount: 4,
      tasksWorked: 2,
      signalsTaskRatio: 2,
      categoryDistribution: { smooth: 2, stuck: 1, surprised: 1 },
      midTaskCount: 2,
      completionCount: 2,
      midTaskCompletionRatio: 1,
      outlierFlag: null,
    },
    {
      agentId: "agent-low",
      agentName: "Low Reporter",
      agentType: "gemini",
      agentDomain: "frontend",
      signalCount: 1,
      tasksWorked: 2,
      signalsTaskRatio: 0.5,
      categoryDistribution: { ambiguous: 1 },
      midTaskCount: 1,
      completionCount: 0,
      midTaskCompletionRatio: 1,
      outlierFlag: "low_reporter",
    },
  ],
  medianSignalsTaskRatio: 2,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ExperienceMetricsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state initially", () => {
    mockMetricsExperience.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByTestId("experience-metrics-loading")).toBeTruthy();
  });

  it("shows error state on failure", async () => {
    mockMetricsExperience.mockRejectedValue(new Error("fail"));
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("experience-metrics-error")).toBeTruthy();
    });
  });

  it("shows empty state when no agents", async () => {
    mockMetricsExperience.mockResolvedValue(emptyResult);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("experience-metrics-empty")).toBeTruthy();
    });
  });

  it("renders agent rows sorted by ratio descending", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("experience-agent-agent-high")).toBeTruthy();
    });
    const rows = screen.getAllByTestId(/^experience-agent-/);
    expect(rows[0]?.getAttribute("data-testid")).toBe("experience-agent-agent-high");
    expect(rows[1]?.getAttribute("data-testid")).toBe("experience-agent-agent-normal");
    expect(rows[2]?.getAttribute("data-testid")).toBe("experience-agent-agent-low");
  });

  it("shows outlier flags with correct styling", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("flag-agent-high").textContent).toContain("High reporter");
    });
    expect(screen.getByTestId("flag-agent-low").textContent).toContain("Low reporter");
  });

  it("shows em-dash for agents with no outlier flag", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("experience-agent-agent-normal")).toBeTruthy();
    });
    const normalRow = screen.getByTestId("experience-agent-agent-normal");
    const flagCell = normalRow.querySelectorAll("td")[4];
    expect(flagCell?.textContent).toContain("—");
  });

  it("displays the habitat median in the header", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/habitat median: 2\.00/)).toBeTruthy();
    });
  });

  it("renders category distribution bars for non-zero categories", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("cat-bar-agent-high-stuck")).toBeTruthy();
    });
    expect(screen.getByTestId("cat-bar-agent-high-confused")).toBeTruthy();
    // Normal agent has stuck, smooth, surprised
    expect(screen.getByTestId("cat-bar-agent-normal-stuck")).toBeTruthy();
    expect(screen.getByTestId("cat-bar-agent-normal-smooth")).toBeTruthy();
  });

  it("does not render bars for zero-count categories", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("experience-agent-agent-high")).toBeTruthy();
    });
    expect(screen.queryByTestId("cat-bar-agent-high-smooth")).toBeNull();
    expect(screen.queryByTestId("cat-bar-agent-high-surprised")).toBeNull();
  });

  it("shows signal count and tasks worked per agent", async () => {
    mockMetricsExperience.mockResolvedValue(resultWithOutliers);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId("ratio-agent-high").textContent).toBe("10.00");
    });
    const highRow = screen.getByTestId("experience-agent-agent-high");
    expect(highRow.textContent).toContain("(20/2)");
  });
});
