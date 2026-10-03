import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEvidenceResponse } from "../../types/index.js";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  getTaskEvidence: vi.fn(),
  getMissionEvidence: vi.fn(),
  linkTaskCode: vi.fn(),
  markTaskNotApplicable: vi.fn(),
  reportTaskGap: vi.fn(),
  clearTaskNotApplicable: vi.fn(),
  clearMissionNotApplicable: vi.fn(),
}));

/** Real mutation configs captured from useMutation so tests can invoke the
 *  actual mutationFn and observe onSuccess/onError wiring. */
const mutationRuns: Array<{
  mutationFn: (...args: unknown[]) => Promise<unknown>;
  onSuccess?: () => void;
  onError?: (e: Error) => void;
}> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.useQuery,
  useMutation: mocks.useMutation,
  useQueryClient: mocks.useQueryClient,
}));


vi.mock("../../api/index.js", () => ({
  api: {
    codeEvidence: {
      getTaskEvidence: mocks.getTaskEvidence,
      getMissionEvidence: mocks.getMissionEvidence,
      linkTaskCode: mocks.linkTaskCode,
      markTaskNotApplicable: mocks.markTaskNotApplicable,
      reportTaskGap: mocks.reportTaskGap,
      clearTaskNotApplicable: mocks.clearTaskNotApplicable,
      clearMissionNotApplicable: mocks.clearMissionNotApplicable,
    },
  },
}));

import { CodeEvidencePanel } from "./CodeEvidencePanel.js";

function mutationStub() {
  return {
    mutate: vi.fn(),
    isPending: false,
  };
}

function baseResponse(): CodeEvidenceResponse {
  return {
    target: { type: "task", id: "task-1", habitatId: "habitat-1" },
    repository: null,
    completeness: { status: "partial" },
    summary: {
      totalLinks: 2,
      activeLinks: 2,
      historyCount: 0,
      correctedCount: 0,
      byType: { commit: 2 },
      byVerificationState: { unverified: 2 },
      hasExternalRepositoryEvidence: false,
      activeGapCount: 1,
    },
    groups: [
      {
        evidenceType: "commit",
        items: [
          {
            linkId: "link-canonical-1",
            evidenceType: "commit",
            evidenceId: "ev-1",
            title: "canonical commit",
            url: "https://example.com/c1",
            verificationState: "unverified",
            linkSources: ["agent_reported"],
            confidence: 0.7,
            linkedBy: { type: "agent", id: "agent-1" },
            linkedAt: "2026-06-01T00:00:00.000Z",
            status: "active",
            correctionReason: null,
            replacementLinkId: null,
          },
        ],
      },
    ],
    activeGaps: [
      {
        id: "gap-canonical-1",
        targetType: "task",
        targetId: "task-1",
        reasonCode: "provider_webhook_missing",
        reasonNote: null,
        status: "active",
        reportedBy: { type: "agent", id: "agent-1" },
        reportedAt: "2026-06-01T00:00:00.000Z",
        resolvedBy: null,
        resolvedAt: null,
        resolutionReason: null,
      },
    ],
    warnings: [],
  };
}

beforeEach(() => {
  mocks.useQuery.mockReset();
  mutationRuns.length = 0;
  // Default: every mutation gets a working handle; individual tests that need
  // to invoke a specific mutationFn capture configs through mutationRuns.
  mocks.useMutation.mockReset().mockImplementation((opts: any) => {
    mutationRuns.push(opts);
    return {
      // Invokes the REAL mutationFn and then the component's own
      // onSuccess/onError, so invalidation and error feedback are observed
      // rather than stubbed away.
      mutate: (...args: unknown[]) => {
        Promise.resolve()
          .then(() => (opts.mutationFn as (...a: unknown[]) => Promise<unknown>)(...args))
          .then(
            (data) => opts.onSuccess?.(data, undefined, undefined),
            (err: Error) => opts.onError?.(err, undefined, undefined),
          )
          .catch(() => undefined);
      },
      isPending: false,
    };
  });
  mocks.getTaskEvidence.mockReset();
  mocks.clearTaskNotApplicable.mockReset().mockResolvedValue({ success: true });
  mocks.clearMissionNotApplicable.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
});

function overrideConflictResponse(): CodeEvidenceResponse {
  const response = baseResponse();
  response.groups = [];
  response.activeGaps = [];
  response.summary.totalLinks = 0;
  response.summary.activeLinks = 0;
  response.summary.activeGapCount = 0;
  response.completeness = { status: "unknown" };
  response.warnings = [
    "Multiple not-applicable overrides exist across canonical and verified legacy targets; no winner is applied.",
  ];
  response.compatibility = {
    overrides: [
      {
        storedTarget: { type: "task", id: "task-1" },
        classification: "canonical",
        value: {
          status: "not_applicable",
          reasonCode: "research_only",
          actor: { type: "human", id: "user-1" },
        },
      },
      {
        storedTarget: { type: "task", id: "feat-task-1" },
        classification: "verified_legacy",
        value: {
          status: "not_applicable",
          reasonCode: "review_only",
          actor: { type: "agent", id: "agent-9" },
        },
      },
    ],
    effectiveCompleteness: { status: "unknown" },
    truncation: {},
  };
  return response;
}
describe("CodeEvidencePanel compatibility rendering", () => {
  it("renders the labelled verified legacy section with independent counts", async () => {
    const response = baseResponse();
    response.compatibility = {
      legacy: {
        label: "Verified legacy evidence",
        storedTarget: { type: "task", id: "feat-task-1" },
        groups: [
          {
            evidenceType: "commit",
            items: [
              {
                linkId: "link-legacy-1",
                evidenceType: "commit",
                evidenceId: null,
                title: "legacy commit",
                url: null,
                verificationState: "unverified",
                linkSources: ["agent_reported"],
                confidence: 0.6,
                linkedBy: { type: "agent", id: "agent-1" },
                linkedAt: "2026-05-01T00:00:00.000Z",
                status: "active",
                correctionReason: null,
                replacementLinkId: null,
              },
            ],
          },
        ],
        activeGaps: [],
        summary: {
          totalLinks: 1,
          activeLinks: 1,
          historyCount: 0,
          correctedCount: 0,
          byType: { commit: 1 },
          byVerificationState: { unverified: 1 },
          hasExternalRepositoryEvidence: false,
          activeGapCount: 0,
        },
      },
      overrides: [],
      effectiveCompleteness: { status: "partial" },
      truncation: {},
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });

    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);

    expect(await screen.findByText("canonical commit")).toBeInTheDocument();
    expect(screen.getByText(/Verified legacy evidence/i)).toBeInTheDocument();
    expect(screen.getByText("legacy commit")).toBeInTheDocument();
    // The legacy section's stored target id is visible for provenance.
    expect(screen.getByText(/feat-task-1/)).toBeInTheDocument();
  });

  it("does not render legacy-only evidence as an empty state", async () => {
    const response = baseResponse();
    response.groups = [];
    response.activeGaps = [];
    response.summary.totalLinks = 0;
    response.summary.activeLinks = 0;
    response.completeness = { status: "unknown" };
    response.compatibility = {
      legacy: {
        label: "Verified legacy evidence",
        storedTarget: { type: "task", id: "feat-task-1" },
        groups: [
          {
            evidenceType: "branch",
            items: [
              {
                linkId: "link-legacy-only",
                evidenceType: "branch",
                evidenceId: null,
                title: "legacy branch",
                url: null,
                verificationState: "unverified",
                linkSources: ["human_manual"],
                confidence: 0.8,
                linkedBy: { type: "human", id: "user-1" },
                linkedAt: "2026-05-01T00:00:00.000Z",
                status: "active",
                correctionReason: null,
                replacementLinkId: null,
              },
            ],
          },
        ],
        activeGaps: [],
        summary: {
          totalLinks: 1,
          activeLinks: 1,
          historyCount: 0,
          correctedCount: 0,
          byType: { branch: 1 },
          byVerificationState: { unverified: 1 },
          hasExternalRepositoryEvidence: false,
          activeGapCount: 0,
        },
      },
      overrides: [],
      effectiveCompleteness: { status: "partial" },
      truncation: {},
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });

    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);

    expect(await screen.findByText("legacy branch")).toBeInTheDocument();
    expect(screen.queryByText("No code evidence linked")).not.toBeInTheDocument();
    // The effective badge (not canonical-only unknown) is shown.
    expect(screen.getByText("Partial")).toBeInTheDocument();
  });

  it("shows every override with an explicit conflict badge and never a canonical winner", async () => {
    const response = baseResponse();
    response.compatibility = {
      overrides: [
        {
          storedTarget: { type: "task", id: "task-1" },
          classification: "canonical",
          value: { status: "not_applicable", reasonCode: "research_only" },
        },
        {
          storedTarget: { type: "task", id: "feat-task-1" },
          classification: "verified_legacy",
          value: { status: "not_applicable", reasonCode: "review_only" },
        },
      ],
      effectiveCompleteness: { status: "unknown" },
      truncation: {},
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });

    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);

    expect(await screen.findByText(/Not-Applicable Overrides \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Override conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/research only/i)).toBeInTheDocument();
    expect(screen.getByText(/review only/i)).toBeInTheDocument();
    // Effective status in a two-override conflict is the explicit unknown.
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("surfaces truncation warnings from the top-level response", async () => {
    const response = baseResponse();
    response.warnings = [
      "One or more code evidence collections were truncated at 100 items; exact counts are in the summaries.",
    ];
    response.compatibility = {
      overrides: [],
      effectiveCompleteness: { status: "partial" },
      truncation: { canonicalActiveLinks: true },
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });

    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);

    expect(await screen.findByText(/collections were truncated at 100 items/i)).toBeInTheDocument();
  });
});

describe("CodeEvidencePanel clear-all recovery", () => {

  it("keeps a zero-active-row conflict nonempty, showing every owner, reason and warning", async () => {
    mocks.useQuery.mockReturnValue({
      data: overrideConflictResponse(),
      isLoading: false,
      error: null,
    });
    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);

    expect(await screen.findByText(/Not-Applicable Overrides \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Override conflict/i)).toBeInTheDocument();
    expect(screen.getByText(/research only/i)).toBeInTheDocument();
    expect(screen.getByText(/review only/i)).toBeInTheDocument();
    // Actor provenance is part of the same row text node.
    const panelText = document.body.textContent ?? "";
    expect(panelText).toContain("by human user-1");
    expect(panelText).toContain("by agent agent-9");
    expect(screen.getByText(/Multiple not-applicable overrides/)).toBeInTheDocument();
    expect(screen.queryByText("No code evidence linked")).not.toBeInTheDocument();
  });

  it("wires clear-all through the panel's own mutation config (persisted id) and invalidates", async () => {
    mocks.useQuery.mockReturnValue({
      data: overrideConflictResponse(),
      isLoading: false,
      error: null,
    });
    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);
    const clearButton = await screen.findByRole("button", { name: /clear not applicable/i });
    fireEvent.click(clearButton);
    await waitFor(() => expect(mocks.clearTaskNotApplicable).toHaveBeenCalledTimes(1));
    expect(mocks.clearTaskNotApplicable).toHaveBeenCalledWith("task-1");
  });

  it("surfaces a clear-all failure through the mutation error path without crashing the view", async () => {
    mocks.clearTaskNotApplicable.mockRejectedValue(new Error("clear refused"));
    mocks.useQuery.mockReturnValue({
      data: overrideConflictResponse(),
      isLoading: false,
      error: null,
    });
    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);
    const clearButton = await screen.findByRole("button", { name: /clear not applicable/i });
    fireEvent.click(clearButton);
    await waitFor(() => expect(mocks.clearTaskNotApplicable).toHaveBeenCalled());
    // onError ran; the override rows stay visible (no false clear).
    expect(screen.getByText(/Not-Applicable Overrides \(2\)/)).toBeInTheDocument();
  });

  it("offers clear-all on a legacy-only override without a conflict badge", async () => {
    const response = baseResponse();
    response.groups = [];
    response.activeGaps = [];
    response.completeness = { status: "unknown" };
    response.compatibility = {
      overrides: [
        {
          storedTarget: { type: "task", id: "feat-task-1" },
          classification: "verified_legacy",
          value: { status: "not_applicable", reasonCode: "review_only" },
        },
      ],
      effectiveCompleteness: { status: "not_applicable" },
      truncation: {},
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });
    render(<CodeEvidencePanel targetType="task" targetId="task-1" />);
    expect(await screen.findByText(/Not-Applicable Overrides \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Override conflict/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /clear not applicable/i })).toBeInTheDocument();
  });

  it("uses the Mission clear call for a mission target (mission input unchanged)", async () => {
    const response = overrideConflictResponse();
    response.target = { type: "mission", id: "mission-1", habitatId: "habitat-1" };
    response.compatibility = {
      overrides: [
        {
          storedTarget: { type: "mission", id: "mission-1" },
          classification: "canonical",
          value: { status: "not_applicable", reasonCode: "research_only" },
        },
      ],
      effectiveCompleteness: { status: "not_applicable" },
      truncation: {},
    };
    mocks.useQuery.mockReturnValue({ data: response, isLoading: false, error: null });
    render(<CodeEvidencePanel targetType="mission" targetId="mission-1" />);
    const clearButton = await screen.findByRole("button", { name: /clear not applicable/i });
    fireEvent.click(clearButton);
    await waitFor(() => expect(mocks.clearMissionNotApplicable).toHaveBeenCalledWith("mission-1"));
    expect(mocks.clearTaskNotApplicable).not.toHaveBeenCalled();
  });
});
