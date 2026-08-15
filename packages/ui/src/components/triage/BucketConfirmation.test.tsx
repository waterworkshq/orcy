import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import type { FindingTriageView } from "../../types/index.js";

const mockRouteMutate = vi.fn();
const mockWontfixMutate = vi.fn();

vi.mock("../../hooks/useTriage.js", () => ({
  useRouteFinding: () => ({
    mutate: mockRouteMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useWontfixFinding: () => ({
    mutate: mockWontfixMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { BucketConfirmation } from "./BucketConfirmation.js";

function makeFinding(overrides: Partial<FindingTriageView> = {}): FindingTriageView {
  return {
    id: "finding-1",
    habitatId: "hab-1",
    pulseId: "pulse-1",
    clusterKey: "cluster-key",
    findingKind: "bug",
    status: "open",
    bucket: null,
    targetRelease: null,
    targetReleaseType: null,
    correctiveMissionId: null,
    triageMissionId: null,
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
    triagedByType: null,
    triagedById: null,
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

describe("BucketConfirmation — lifecycle route commands (restored lifecycle T8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("confirming a no-work bucket fires the route command with a bare payload — no status, no target-release", async () => {
    renderWithQC(
      <BucketConfirmation
        finding={makeFinding({ bucket: "document_as_known_limitation" })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Confirm bucket/i }));

    await waitFor(() => expect(mockRouteMutate).toHaveBeenCalledTimes(1));
    const call = mockRouteMutate.mock.calls[0][0];
    expect(call.id).toBe("finding-1");
    expect(call.route).toEqual({ bucket: "document_as_known_limitation" });
    // Discriminator: no state-shaped fields survive the cutover.
    expect(call.route.status).toBeUndefined();
    expect(call.route.targetRelease).toBeUndefined();
    expect(call.route.targetReleaseType).toBeUndefined();
  });

  it("fix_now sends the complete Mission placement (title + description)", async () => {
    renderWithQC(
      <BucketConfirmation finding={makeFinding({ bucket: "fix_now" })} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Corrective mission title/i), {
      target: { value: "Corrective: hot cache bug" },
    });
    fireEvent.change(screen.getByLabelText(/Corrective mission description/i), {
      target: { value: "Fix the cache invalidation race." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm bucket/i }));

    await waitFor(() => expect(mockRouteMutate).toHaveBeenCalledTimes(1));
    const call = mockRouteMutate.mock.calls[0][0];
    expect(call.route).toEqual({
      bucket: "fix_now",
      missionTitle: "Corrective: hot cache bug",
      missionDescription: "Fix the cache invalidation race.",
    });
  });

  it("defer_to_patch requires a gate version before confirm; sends complete defer payload", async () => {
    renderWithQC(
      <BucketConfirmation finding={makeFinding({ bucket: "defer_to_patch" })} onClose={vi.fn()} />,
    );

    const confirm = screen.getByRole("button", { name: /Confirm bucket/i });
    // Placement defaults exist, but the gate version is empty → disabled.
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Gate version/i), {
      target: { value: "v0.40.0" },
    });
    expect(confirm).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/Corrective mission title/i), {
      target: { value: "Corrective: cluster-key" },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(mockRouteMutate).toHaveBeenCalledTimes(1));
    const call = mockRouteMutate.mock.calls[0][0];
    expect(call.route).toEqual({
      bucket: "defer_to_patch",
      missionTitle: "Corrective: cluster-key",
      missionDescription: "Address the bug finding in cluster cluster-key.",
      releaseGateType: "patch",
      releaseGateVersion: "v0.40.0",
    });
  });

  it("wontfix requires a reason and fires the wontfix command — never {status:'wontfix'}", async () => {
    renderWithQC(<BucketConfirmation finding={makeFinding()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByText(/Mark as won't fix/i));
    const recordBtn = screen.getByRole("button", { name: /Record won't fix/i });
    expect(recordBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Won't fix reason/i), {
      target: { value: "accepted trade-off" },
    });
    expect(recordBtn).toBeEnabled();
    fireEvent.click(recordBtn);

    await waitFor(() => expect(mockWontfixMutate).toHaveBeenCalledTimes(1));
    const call = mockWontfixMutate.mock.calls[0][0];
    expect(call).toEqual({ id: "finding-1", reason: "accepted trade-off" });
    expect(call.status).toBeUndefined();
    expect(mockRouteMutate).not.toHaveBeenCalled();
  });
});
