import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExtractionReviewQueue } from "./ExtractionReviewQueue.js";

const mockGetReviewQueue = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    extraction: {
      getReviewQueue: (...args: unknown[]) => mockGetReviewQueue(...args),
    },
  },
}));

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ExtractionReviewQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReviewQueue.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("shows empty state when no findings", async () => {
    renderWithClient(
      <ExtractionReviewQueue habitatId="hab-1" onSelectFinding={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("empty-review-queue")).toBeInTheDocument();
    });
  });

  it("renders findings with confidence, sample, and completeness", async () => {
    mockGetReviewQueue.mockResolvedValue([
      {
        id: "find-1",
        findingType: "lesson",
        subject: "Always validate inputs",
        confidence: 0.9,
        sampleSize: 10,
        completeness: "complete",
        visibilityCeiling: "habitat_member",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 2,
      },
    ]);

    renderWithClient(
      <ExtractionReviewQueue habitatId="hab-1" onSelectFinding={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Always validate inputs")).toBeInTheDocument();
    });
    expect(screen.getByText("Confidence: 90%")).toBeInTheDocument();
    expect(screen.getByText("Sample: 10")).toBeInTheDocument();
    expect(screen.getByText("2 occurrences")).toBeInTheDocument();
  });

  it("shows aggregate-only badge for aggregate findings", async () => {
    mockGetReviewQueue.mockResolvedValue([
      {
        id: "find-agg",
        findingType: "convention",
        subject: "Team skips integration tests",
        confidence: 0.7,
        sampleSize: 5,
        completeness: "partial",
        visibilityCeiling: "aggregate_only",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 1,
      },
    ]);

    renderWithClient(
      <ExtractionReviewQueue habitatId="hab-1" onSelectFinding={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("aggregate-badge-find-agg")).toBeInTheDocument();
    });
    expect(screen.getByTestId("aggregate-badge-find-agg")).toHaveTextContent("aggregate-only");
  });

  it("renders completeness as visually distinguishable states", async () => {
    mockGetReviewQueue.mockResolvedValue([
      {
        id: "f1",
        findingType: "lesson",
        subject: "Complete finding",
        confidence: 0.9,
        sampleSize: 10,
        completeness: "complete",
        visibilityCeiling: "habitat_member",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 1,
      },
      {
        id: "f2",
        findingType: "lesson",
        subject: "Partial finding",
        confidence: 0.6,
        sampleSize: 3,
        completeness: "partial",
        visibilityCeiling: "habitat_member",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 1,
      },
      {
        id: "f3",
        findingType: "lesson",
        subject: "Stale finding",
        confidence: 0.3,
        sampleSize: 1,
        completeness: "stale",
        visibilityCeiling: "habitat_member",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 1,
      },
    ]);

    renderWithClient(
      <ExtractionReviewQueue habitatId="hab-1" onSelectFinding={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Complete finding")).toBeInTheDocument();
    });

    const completeBadge = screen.getByText("Complete finding").parentElement!.querySelector("[data-completeness]");
    expect(completeBadge).toHaveAttribute("data-completeness", "complete");

    const partialBadge = screen.getByText("Partial finding").parentElement!.querySelector("[data-completeness]");
    expect(partialBadge).toHaveAttribute("data-completeness", "partial");

    const staleBadge = screen.getByText("Stale finding").parentElement!.querySelector("[data-completeness]");
    expect(staleBadge).toHaveAttribute("data-completeness", "stale");
  });

  it("calls onSelectFinding when a queue item is clicked", async () => {
    const onSelect = vi.fn();
    mockGetReviewQueue.mockResolvedValue([
      {
        id: "find-1",
        findingType: "lesson",
        subject: "Test finding",
        confidence: 0.8,
        sampleSize: 5,
        completeness: "complete",
        visibilityCeiling: "habitat_member",
        decisionVersion: 1,
        firstSeenAt: "2026-08-01T00:00:00Z",
        lastSeenAt: "2026-08-10T00:00:00Z",
        occurrenceCount: 1,
      },
    ]);

    renderWithClient(
      <ExtractionReviewQueue habitatId="hab-1" onSelectFinding={onSelect} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Test finding")).toBeInTheDocument();
    });

    screen.getByText("Test finding").click();
    expect(onSelect).toHaveBeenCalledWith("find-1");
  });
});
