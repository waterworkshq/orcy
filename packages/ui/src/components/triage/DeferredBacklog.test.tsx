import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import type { FindingTriageView } from "../../types/index.js";

const mockActivate = {
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as Error | null,
};
let mockFindings: FindingTriageView[] = [];
let mockMissionVersion = 3;

vi.mock("../../hooks/useTriage.js", () => ({
  useFindingTriage: (_habitatId: string, filters?: { bucket?: string }) => ({
    data: mockFindings.filter((f) => f.bucket === filters?.bucket),
    isLoading: false,
  }),
  useActivateFinding: () => mockActivate,
}));

vi.mock("../../api/index.js", () => ({
  api: {
    missions: {
      get: async (id: string) => ({
        mission: { id, version: mockMissionVersion, releaseGateType: "patch" },
      }),
    },
  },
}));

import { DeferredBacklog } from "./DeferredBacklog.js";

function makeFinding(overrides: Partial<FindingTriageView> = {}): FindingTriageView {
  return {
    id: "finding-1",
    habitatId: "hab-1",
    pulseId: "pulse-1",
    clusterKey: "cluster-key",
    findingKind: "bug",
    status: "triaged",
    bucket: "defer_to_patch",
    targetRelease: null,
    targetReleaseType: null,
    correctiveMissionId: "mission-1",
    triageMissionId: "mission-1",
    corroboratingPulseIds: [],
    triagedByType: "human",
    triagedById: "user-1",
    triagedAt: null,
    resolvedByType: null,
    resolvedById: null,
    resolvedAt: null,
    resolutionNote: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("DeferredBacklog — manual activation of the EXISTING corrective Mission (T8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindings = [makeFinding()];
    mockMissionVersion = 3;
    mockActivate.isPending = false;
    mockActivate.isError = false;
    mockActivate.error = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("Activate supplies the OBSERVED mission version to the lifecycle command", async () => {
    renderWithQC(<DeferredBacklog habitatId="hab-1" />);

    const btn = await screen.findByRole("button", { name: /^Activate$/i });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(mockActivate.mutate).toHaveBeenCalledTimes(1));
    const call = mockActivate.mutate.mock.calls[0][0];
    expect(call).toEqual({ id: "finding-1", expectedMissionVersion: 3 });
  });

  it("renders the conflict outcome inline with a refresh path — never a replacement Mission", async () => {
    mockActivate.isError = true;
    mockActivate.error = new Error(
      "Corrective Mission version mismatch (current 4); reload and retry.",
    );
    renderWithQC(<DeferredBacklog habitatId="hab-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("version mismatch (current 4)");
    expect(alert.textContent).toContain("Refresh mission version");
  });

  it("disables Activate for findings with no corrective Mission (route first)", async () => {
    mockFindings = [makeFinding({ correctiveMissionId: null, triageMissionId: null })];
    renderWithQC(<DeferredBacklog habitatId="hab-1" />);

    await screen.findByText(/no corrective mission \(route first\)/i);
    const btn = screen.getByRole("button", { name: /^Activate$/i });
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn);
    expect(mockActivate.mutate).not.toHaveBeenCalled();
  });
});
