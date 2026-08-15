import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockMutate = vi.fn();

vi.mock("../../hooks/useTriage.js", () => ({
  useResolveFinding: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { ResolutionRecorder } from "./ResolutionRecorder.js";

describe("ResolutionRecorder — complete resolution payload (restored lifecycle T8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("submits the COMPLETE resolution payload — text, kind, and root cause all persist", async () => {
    render(
      <ResolutionRecorder findingId="finding-1" clusterKey="cluster-key" onResolved={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText(/Root cause/i), {
      target: { value: "unsynchronized cache invalidation" },
    });
    fireEvent.change(screen.getByLabelText(/^Resolution \*/), {
      target: { value: "fixed with a lock around the cache refresh" },
    });
    fireEvent.change(screen.getByLabelText(/Resolution kind/i), {
      target: { value: "code_fix" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Record & resolve/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    const call = mockMutate.mock.calls[0][0];
    expect(call).toEqual({
      id: "finding-1",
      resolution: "fixed with a lock around the cache refresh",
      resolutionKind: "code_fix",
      rootCause: "unsynchronized cache invalidation",
    });
    // Discriminator (the documented data-loss defect): no bare status payload.
    expect(call.status).toBeUndefined();
  });

  it("omits rootCause when blank instead of sending an empty string", async () => {
    render(<ResolutionRecorder findingId="finding-1" clusterKey="cluster-key" />);

    fireEvent.change(screen.getByLabelText(/^Resolution \*/), {
      target: { value: "documented the limitation" },
    });
    fireEvent.change(screen.getByLabelText(/Resolution kind/i), {
      target: { value: "doc_clarification" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Record & resolve/i }));

    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    const call = mockMutate.mock.calls[0][0];
    expect(call.rootCause).toBeUndefined();
    expect(call.resolutionKind).toBe("doc_clarification");
  });

  it("refuses to submit without resolution text", () => {
    render(<ResolutionRecorder findingId="finding-1" clusterKey="cluster-key" />);
    expect(screen.getByRole("button", { name: /Record & resolve/i })).toBeDisabled();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
