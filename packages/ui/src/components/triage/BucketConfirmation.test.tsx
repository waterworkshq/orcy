import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import type { FindingTriageView } from "../../types/index.js";

const mockMutate = vi.fn();

vi.mock("../../hooks/useTriage.js", () => ({
  useTransitionFinding: () => ({
    mutate: mockMutate,
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
    triageMissionId: null,
    corroboratingPulseIds: [],
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

describe("BucketConfirmation — targetReleaseType selector (AC-DEFER-2 UI)", () => {
  const origConfirm = window.confirm;
  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn(() => true);
  });
  afterEach(() => {
    cleanup();
    window.confirm = origConfirm;
  });

  it("renders the targetReleaseType radio group only when a deferred bucket is selected", () => {
    // Default finding has bucket=null → not deferred → no release-type selector.
    const { rerender } = renderWithQC(
      <BucketConfirmation finding={makeFinding()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("radio", { name: "Minor" })).toBeNull();

    // Switch the recommendation to defer_to_release → deferred bucket selector appears.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <BucketConfirmation
          finding={makeFinding({ bucket: "defer_to_release" })}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // Three release-type radios visible (Patch / Minor / Major).
    expect(screen.getByRole("radio", { name: /Patch/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Minor/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Major/ })).toBeInTheDocument();
  });

  it("selecting Minor and confirming fires the mutation with targetReleaseType:'minor' in the body", async () => {
    renderWithQC(
      <BucketConfirmation
        finding={makeFinding({ bucket: "defer_to_release" })}
        onClose={vi.fn()}
      />,
    );

    // Pick the agent-recommended deferred bucket to surface the type selector.
    const deferRadio = screen.getByRole("radio", { name: /Defer to release/ });
    fireEvent.click(deferRadio);

    // Select "Minor" as the target release type.
    fireEvent.click(screen.getByRole("radio", { name: /Minor/ }));

    // Confirm.
    fireEvent.click(screen.getByRole("button", { name: /Confirm bucket/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));

    const call = mockMutate.mock.calls[0][0];
    expect(call.id).toBe("finding-1");
    expect(call.body.bucket).toBe("defer_to_release");
    expect(call.body.status).toBe("triaged");
    expect(call.body.targetReleaseType).toBe("minor");
  });

  it("selecting Patch fires the mutation with targetReleaseType:'patch'", async () => {
    renderWithQC(
      <BucketConfirmation finding={makeFinding({ bucket: "defer_to_patch" })} onClose={vi.fn()} />,
    );

    // defer_to_patch is already deferred — selector visible without picking another bucket.
    fireEvent.click(screen.getByRole("radio", { name: /Patch/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm bucket/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    const call = mockMutate.mock.calls[0][0];
    expect(call.body.targetReleaseType).toBe("patch");
    expect(call.body.bucket).toBe("defer_to_patch");
  });

  it("confirming without picking a release type omits targetReleaseType (null)", async () => {
    renderWithQC(
      <BucketConfirmation
        finding={makeFinding({ bucket: "defer_to_release" })}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Confirm bucket/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    const call = mockMutate.mock.calls[0][0];
    // No release type picked → null is sent explicitly (clears any prior value).
    expect(call.body.targetReleaseType).toBeNull();
  });

  it("preserves an existing targetReleaseType from the finding on initial render", () => {
    renderWithQC(
      <BucketConfirmation
        finding={makeFinding({
          bucket: "defer_to_release",
          targetReleaseType: "major",
        })}
        onClose={vi.fn()}
      />,
    );

    const majorRadio = screen.getByRole("radio", { name: /Major/ }) as HTMLInputElement;
    expect(majorRadio.checked).toBe(true);
  });
});
