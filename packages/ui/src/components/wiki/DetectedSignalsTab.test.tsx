import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DetectedSignalsTab } from "./DetectedSignalsTab.js";

const mockGetSignalSurface = vi.fn();

vi.mock("../../api/domains/wiki.js", () => ({
  wikiApi: {
    getSignalSurface: (...args: unknown[]) => mockGetSignalSurface(...args),
  },
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("DetectedSignalsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSignalSurface.mockResolvedValue({ detectedSignals: [] });
  });

  afterEach(() => cleanup());

  it("requests the detected signal class", async () => {
    renderWithQC(<DetectedSignalsTab habitatId="h1" />);

    await waitFor(() => {
      expect(mockGetSignalSurface).toHaveBeenCalledWith("h1", { signalClass: "detected" });
    });
  });

  it("renders empty state when no detected signals", async () => {
    renderWithQC(<DetectedSignalsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText(/No detected signals/i)).toBeTruthy();
    });
  });

  it("renders detected signal rows with detector attribution", async () => {
    mockGetSignalSurface.mockResolvedValue({
      detectedSignals: [
        {
          id: "ds1",
          subject: "Stale dependency detected",
          body: "package foo has not been updated in 90 days",
          createdAt: "2024-01-01T00:00:00.000Z",
          metadata: {
            signalKind: "stale-dependency",
            detector: "dep-tracker-plugin",
          },
        },
      ],
    });

    renderWithQC(<DetectedSignalsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText("Stale dependency detected")).toBeTruthy();
      expect(screen.getByText("stale-dependency", { exact: false })).toBeTruthy();
      expect(screen.getByText("dep-tracker-plugin")).toBeTruthy();
    });
  });

  it("renders error state when the surface load fails", async () => {
    mockGetSignalSurface.mockRejectedValue(new Error("boom"));

    renderWithQC(<DetectedSignalsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load detected signals.")).toBeTruthy();
    });
  });
});
