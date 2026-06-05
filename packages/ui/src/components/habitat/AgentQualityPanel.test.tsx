import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQualityResponse } from "../../types/index.js";

const mocks = vi.hoisted(() => ({ useAgentQuality: vi.fn() }));

vi.mock("../../lib/useHabitatData.js", () => mocks);

import { AgentQualityPanel } from "./AgentQualityPanel.js";

const response: AgentQualityResponse = {
  habitatId: "habitat-1",
  generatedAt: "2026-06-05T00:00:00.000Z",
  signals: [
    {
      agentId: "agent-1",
      agentName: "Careful Capybara",
      score: null,
      confidence: "insufficient_data",
      sampleSize: 1,
      dimensions: {
        approval: 1,
        rejection: 1,
        consistency: null,
        cycleReliability: 1,
        estimateAccuracy: null,
        evidenceCompleteness: 0.5,
      },
      warnings: ["Low confidence: not enough completed work yet."],
    },
    {
      agentId: "agent-2",
      agentName: "Signal Salamander",
      score: 0.82,
      confidence: "low",
      sampleSize: 4,
      dimensions: {
        approval: 0.75,
        rejection: 0.75,
        consistency: 0.9,
        cycleReliability: 1,
        estimateAccuracy: 0.8,
        evidenceCompleteness: 0.7,
      },
      warnings: ["High rejection rate in recent sample."],
    },
  ],
};

beforeEach(() => {
  mocks.useAgentQuality.mockReturnValue({ data: response, isLoading: false, error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentQualityPanel", () => {
  it("renders informational quality signals and non-punitive caveats", () => {
    render(<AgentQualityPanel habitatId="habitat-1" />);

    expect(screen.getByText("Agent quality signals")).toBeInTheDocument();
    expect(screen.getByText(/Informational only/)).toBeInTheDocument();
    expect(screen.getByText("Careful Capybara")).toBeInTheDocument();
    expect(screen.getByText("Low confidence: not enough completed work yet.")).toBeInTheDocument();
    expect(screen.getByText("Signal Salamander")).toBeInTheDocument();
    expect(screen.getByText("High rejection rate in recent sample.")).toBeInTheDocument();
    expect(screen.queryByText(/bad agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/low performer/i)).not.toBeInTheDocument();
  });

  it("renders empty state", () => {
    mocks.useAgentQuality.mockReturnValue({
      data: { ...response, signals: [] },
      isLoading: false,
      error: null,
    });

    render(<AgentQualityPanel habitatId="habitat-1" />);

    expect(screen.getByText("No agent quality signals are available yet.")).toBeInTheDocument();
  });

  it("renders loading state", () => {
    mocks.useAgentQuality.mockReturnValue({ data: null, isLoading: true, error: null });

    render(<AgentQualityPanel habitatId="habitat-1" />);

    expect(screen.getByText("Loading quality signals...")).toBeInTheDocument();
  });
});
