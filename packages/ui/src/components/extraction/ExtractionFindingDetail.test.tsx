import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExtractionFindingDetail } from "./ExtractionFindingDetail.js";
import { ApiError } from "../../api/transport.js";

const mockGetFindingDetail = vi.fn();
const mockAcceptFinding = vi.fn();
const mockRejectFinding = vi.fn();
const mockRequestRevision = vi.fn();
const mockWithdrawFinding = vi.fn();
const mockRefreshCitations = vi.fn();
const mockPromoteToWiki = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    extraction: {
      getFindingDetail: (...args: unknown[]) => mockGetFindingDetail(...args),
      acceptFinding: (...args: unknown[]) => mockAcceptFinding(...args),
      rejectFinding: (...args: unknown[]) => mockRejectFinding(...args),
      requestRevision: (...args: unknown[]) => mockRequestRevision(...args),
      withdrawFinding: (...args: unknown[]) => mockWithdrawFinding(...args),
      refreshCitations: (...args: unknown[]) => mockRefreshCitations(...args),
      promoteToWiki: (...args: unknown[]) => mockPromoteToWiki(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, disabled, loading, ...rest }: any) => (
    <button type="button" onClick={onClick} disabled={disabled || loading} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("../ui/MarkdownContent.js", () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const proposedFinding = {
  finding: {
    id: "find-1",
    habitatId: "hab-1",
    firstAttemptId: "att-1",
    lastSeenAttemptId: "att-1",
    lineageRootId: "find-1",
    supersedesFindingId: null,
    revision: 1,
    extractorKey: "builtin:pattern_v1",
    extractorVersion: 1,
    findingType: "lesson",
    subject: "Always validate inputs before processing",
    body: "## Lesson\n\nInput validation prevents cascading failures.",
    structuredPayload: null,
    confidence: 0.85,
    sampleSize: 12,
    completeness: "complete",
    visibilityCeiling: "habitat_member",
    fingerprint: "abc123",
    evidenceDigest: "def456",
    status: "proposed",
    decisionVersion: 1,
    firstSeenAt: "2026-08-01T00:00:00Z",
    lastSeenAt: "2026-08-10T00:00:00Z",
    occurrenceCount: 3,
    caveats: [],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
  },
  citations: [
    {
      id: "cit-1",
      sourceType: "task_lifecycle_audit",
      role: "supporting",
      visibilityClass: "habitat_member",
      completeness: "complete",
      resolutionState: "available",
      occurredAt: "2026-08-05T10:00:00Z",
      entityRefs: [{ type: "task", id: "task-abc12345" }],
    },
    {
      id: "cit-2",
      sourceType: "mission_lifecycle_audit",
      role: "context",
      visibilityClass: "habitat_member",
      completeness: "complete",
      resolutionState: "dangling",
      occurredAt: null,
      entityRefs: null,
    },
    {
      id: "cit-3",
      sourceType: "automation_run_audit",
      role: "supporting",
      visibilityClass: "habitat_member",
      completeness: "partial",
      resolutionState: "changed",
      occurredAt: null,
      entityRefs: null,
    },
  ],
  reviews: [],
  scopeRefs: [],
};

const aggregateFinding = {
  ...proposedFinding,
  finding: {
    ...proposedFinding.finding,
    visibilityCeiling: "aggregate_only",
    findingType: "convention",
    subject: "Team tends to skip integration tests",
  },
  citations: [
    {
      id: "cit-agg-1",
      sourceType: "experience_aggregate",
      role: "supporting",
      visibilityClass: "aggregate_only",
      completeness: "complete",
      resolutionState: "available",
      occurredAt: null,
      entityRefs: null,
    },
  ],
};

const ruleRecFinding = {
  ...proposedFinding,
  finding: {
    ...proposedFinding.finding,
    findingType: "rule_recommendation",
    subject: "Consider auto-assigning frontend tasks to domain experts",
    body: "Recommend creating an Automation Rule that assigns frontend tasks to agents with frontend domain.",
  },
};

const acceptedFinding = {
  ...proposedFinding,
  finding: {
    ...proposedFinding.finding,
    status: "accepted",
    decisionVersion: 2,
  },
  citations: [
    {
      id: "cit-ok-1",
      sourceType: "task_lifecycle_audit",
      role: "supporting",
      visibilityClass: "habitat_member",
      completeness: "complete",
      resolutionState: "available",
      occurredAt: "2026-08-05T10:00:00Z",
      entityRefs: [{ type: "task", id: "task-abc12345" }],
    },
  ],
};

describe("ExtractionFindingDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("renders finding subject, type, confidence, and completeness", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Always validate inputs before processing")).toBeInTheDocument();
    });
    expect(screen.getByText("lesson")).toBeInTheDocument();
    expect(screen.getByText("Confidence: 85%")).toBeInTheDocument();
    expect(screen.getByText("Sample size: 12")).toBeInTheDocument();
    // Completeness is in a badge
    const detail = screen.getByTestId("finding-detail");
    expect(detail.textContent).toContain("complete");
  });

  it("renders citation degradation states (dangling, changed, available)", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("citation-cit-1")).toBeInTheDocument();
    });

    // Available citation has entity refs
    expect(screen.getByTestId("citation-state-cit-1")).toHaveTextContent("available");
    expect(screen.getByTestId("citation-cit-1").textContent).toContain("task:task-abc");

    // Dangling citation shows "Source no longer exists"
    expect(screen.getByTestId("citation-state-cit-2")).toHaveTextContent("dangling");
    expect(screen.getByTestId("dangling-citation-cit-2")).toHaveTextContent("Source no longer exists");

    // Changed citation shows "modified since extraction"
    expect(screen.getByTestId("citation-state-cit-3")).toHaveTextContent("changed");
    expect(screen.getByTestId("changed-citation-cit-3")).toHaveTextContent("modified since extraction");
  });

  it("aggregate-only findings show NO drill-down, timestamps, or contributor details", async () => {
    mockGetFindingDetail.mockResolvedValue(aggregateFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("aggregate-only-badge")).toBeInTheDocument();
    });

    // Aggregate citation shows privacy notice, NOT entity refs or timestamps
    expect(screen.getByTestId("aggregate-citation-cit-agg-1")).toHaveTextContent(
      "Aggregate-only — source details withheld for privacy.",
    );

    // No entity refs rendered for aggregate citations
    const aggCitation = screen.getByTestId("citation-cit-agg-1");
    expect(aggCitation.querySelectorAll(".font-mono").length).toBe(0);
  });

  it("renders rule recommendations as prose only — no Automation Rule create/enable", async () => {
    mockGetFindingDetail.mockResolvedValue(ruleRecFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("rule-recommendation-notice")).toBeInTheDocument();
    });

    expect(screen.getByTestId("rule-recommendation-notice")).toHaveTextContent(
      /not an executable Automation Rule/i,
    );
    // Verify NO create/enable/prefill BUTTONS exist
    expect(screen.queryByRole("button", { name: /create.*rule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable.*rule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /prefill/i })).not.toBeInTheDocument();
  });

  it("surfaces 409 conflict with a visible banner — not silent overwrite", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);
    const conflictError = new ApiError("Finding decision version mismatch", 409, {
      error: "Finding decision version mismatch — another reviewer acted first",
      code: "CONFLICT",
    });
    mockAcceptFinding.mockRejectedValue(conflictError);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Always validate inputs before processing")).toBeInTheDocument();
    });

    // Enter reason — use fireEvent for proper React state update
    const reasonInput = screen.getByLabelText("Decision reason");
    fireEvent.change(reasonInput, { target: { value: "Looks good" } });

    // Click accept
    fireEvent.click(screen.getByLabelText("Accept finding"));

    await waitFor(() => {
      expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
    });

    expect(screen.getByTestId("conflict-banner")).toHaveTextContent(
      /Another reviewer acted on this finding first/,
    );
  });

  it("accept/reject disabled without a reason", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByLabelText("Accept finding")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Accept finding")).toBeDisabled();
    expect(screen.getByLabelText("Reject finding")).toBeDisabled();
  });

  it("renders immutable lineage information", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Lineage")).toBeInTheDocument();
    });

    expect(screen.getByText(/find-1/i).parentElement).toBeInTheDocument();
    expect(screen.getByText("Revision:").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Occurrences:").parentElement).toHaveTextContent("3");
  });

  it("does NOT render any Wiki publish affordance for proposed findings", async () => {
    mockGetFindingDetail.mockResolvedValue(proposedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Always validate inputs before processing")).toBeInTheDocument();
    });

    expect(screen.queryByText(/publish.*wiki/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("promote-action")).not.toBeInTheDocument();
  });

  it("shows promote-to-wiki action for accepted findings (draft only, no publish)", async () => {
    mockGetFindingDetail.mockResolvedValue(acceptedFinding);

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("promote-action")).toBeInTheDocument();
    });

    // Promote button is visible
    expect(screen.getByTestId("promote-to-wiki-btn")).toBeInTheDocument();
    expect(screen.getByLabelText("Promote to Wiki draft")).toBeInTheDocument();

    // No publish button — only the promote-to-draft action
    expect(screen.queryByRole("button", { name: /publish/i })).not.toBeInTheDocument();
  });

  it("calls promoteToWiki on button click and shows success", async () => {
    mockGetFindingDetail.mockResolvedValue(acceptedFinding);
    mockPromoteToWiki.mockResolvedValue({
      outcome: "promoted",
      promotion: { id: "promo-1", targetId: "page-1" },
      pageId: "page-1",
    });

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("promote-to-wiki-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("promote-to-wiki-btn"));

    await waitFor(() => {
      expect(mockPromoteToWiki).toHaveBeenCalledWith("hab-1", "find-1", { destinationType: "wiki_draft" });
    });

    await waitFor(() => {
      expect(mockNotifySuccess).toHaveBeenCalledWith("Wiki draft created");
    });
  });

  it("shows already-promoted notification on replay", async () => {
    mockGetFindingDetail.mockResolvedValue(acceptedFinding);
    mockPromoteToWiki.mockResolvedValue({
      outcome: "already_promoted",
      promotion: { id: "promo-1", targetId: "page-1" },
      pageId: "page-1",
    });

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("promote-to-wiki-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("promote-to-wiki-btn"));

    await waitFor(() => {
      expect(mockNotifySuccess).toHaveBeenCalledWith(
        "Finding was already promoted — existing Wiki draft found.",
      );
    });
  });

  it("shows error message when promotion fails", async () => {
    mockGetFindingDetail.mockResolvedValue(acceptedFinding);
    mockPromoteToWiki.mockRejectedValue(new Error("Finding is not eligible for promotion"));

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="find-1" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("promote-to-wiki-btn")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("promote-to-wiki-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("promote-error")).toBeInTheDocument();
    });

    expect(screen.getByTestId("promote-error")).toHaveTextContent(
      "Finding is not eligible for promotion",
    );
  });

  it("shows error state when finding is not found", async () => {
    mockGetFindingDetail.mockRejectedValue(new ApiError("Finding not found", 404));

    renderWithClient(<ExtractionFindingDetail habitatId="hab-1" findingId="missing" onBack={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Finding not found/)).toBeInTheDocument();
    });
  });
});
