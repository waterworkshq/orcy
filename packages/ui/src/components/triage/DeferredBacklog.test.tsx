import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import type { FindingTriageView, TriageActivationView } from "../../types/index.js";

const mockActivate = {
  mutate: vi.fn(),
  isPending: false,
  isError: false,
  error: null as Error | null,
};
let mockFindings: FindingTriageView[] = [];
let mockMissionVersion = 3;
let mockBucketQueryError: Error | null = null;
const mockFindingsRefetch = vi.fn();

vi.mock("../../hooks/useTriage.js", () => ({
  useFindingTriage: (_habitatId: string, filters?: { bucket?: string }) => ({
    data: mockFindings.filter((f) => f.bucket === filters?.bucket),
    isLoading: false,
    isError: mockBucketQueryError !== null,
    error: mockBucketQueryError,
    refetch: mockFindingsRefetch,
  }),
  useActivateFinding: () => mockActivate,
}));

let mockMissionGetError: Error | null = null;

vi.mock("../../api/index.js", () => ({
  api: {
    missions: {
      get: async (id: string) => {
        if (mockMissionGetError) throw mockMissionGetError;
        return { mission: { id, version: mockMissionVersion, releaseGateType: "patch" } };
      },
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
    admittedByTriageMissionId: null,
    admittedByInvestigationTaskId: null,
    recurrenceOfId: null,
    legacyLineageRepairRequired: false,
    routeFingerprint: null,
    activatedAt: null,
    activatedByType: null,
    activatedById: null,
    activationCause: null,
    activationReleaseId: null,
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
    mockBucketQueryError = null;
    mockMissionGetError = null;
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

  it("renders a bucket-query error with a retry path — never the empty backlog", async () => {
    mockBucketQueryError = new Error("Internal server error");
    renderWithQC(<DeferredBacklog habitatId="hab-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Failed to load the deferred backlog");
    expect(alert.textContent).toContain("Internal server error");
    // The empty state must NOT mask a failed query.
    expect(screen.queryByText(/No deferred findings/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Retry$/i }));
    expect(mockFindingsRefetch).toHaveBeenCalled();
  });

  it("renders a failed corrective-mission read with retry guidance — Activate is not left waiting forever", async () => {
    mockMissionGetError = new Error("Mission not found");
    renderWithQC(<DeferredBacklog habitatId="hab-1" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load the corrective mission");
    expect(alert.textContent).toContain("Mission not found");
    expect(alert.textContent).toContain("Retry mission load");

    const btn = screen.getByRole("button", { name: /^Activate$/i });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn.getAttribute("title")).toContain("Could not load the corrective mission");
  });

  it("onActivated receives the post-activation result — never the stale pre-activation row", async () => {
    const onActivated = vi.fn();
    // Post-activation group state parsed from the activate response: the
    // Mission (gate cleared, version bumped) plus every member now in_progress.
    const activationResult = {
      mission: { id: "mission-1", version: 4 },
      findings: [makeFinding({ status: "in_progress", activatedAt: "2026-08-15T00:00:00Z" })],
    } as unknown as TriageActivationView;
    mockActivate.mutate.mockImplementationOnce((_input: unknown, opts?: { onSuccess?: (a: TriageActivationView) => void }) => {
      opts?.onSuccess?.(activationResult);
    });

    renderWithQC(<DeferredBacklog habitatId="hab-1" onActivated={onActivated} />);

    const btn = await screen.findByRole("button", { name: /^Activate$/i });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => expect(onActivated).toHaveBeenCalledTimes(1));
    expect(onActivated).toHaveBeenCalledWith(activationResult);
    // The activated members arrive post-activation, not as the cached triaged row.
    expect(activationResult.findings[0].status).toBe("in_progress");
  });
});
