import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LearningLoopTab } from "./LearningLoopTab.js";

const mockListPolicies = vi.fn();
const mockGetRunHistory = vi.fn();
const mockUpdatePolicy = vi.fn();
const mockEnsureRun = vi.fn();
const mockFreshRerun = vi.fn();
const mockDryRun = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../../api/index.js", () => ({
  api: {
    extraction: {
      listPolicies: (...args: unknown[]) => mockListPolicies(...args),
      getRunHistory: (...args: unknown[]) => mockGetRunHistory(...args),
      updatePolicy: (...args: unknown[]) => mockUpdatePolicy(...args),
      ensureRun: (...args: unknown[]) => mockEnsureRun(...args),
      freshRerun: (...args: unknown[]) => mockFreshRerun(...args),
      dryRun: (...args: unknown[]) => mockDryRun(...args),
    },
  },
}));

vi.mock("../../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../../ui/ToggleSwitch.js", () => ({
  ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel }: any) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      data-checked={checked}
    >
      toggle
    </button>
  ),
}));

vi.mock("../../ui/NumberField.js", () => ({
  NumberField: ({ label, value, onChange, id }: any) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input
        data-testid={`field-${id}`}
        id={id}
        value={value}
        onChange={(e: any) => onChange(e.target.value)}
      />
    </div>
  ),
}));

vi.mock("../../ui/Button.js", () => ({
  Button: (props: any) => {
    const { children, loading, variant, size, ...buttonProps } = props;
    return (
      <button type="button" {...buttonProps} disabled={buttonProps.disabled || loading}>
        {children}
      </button>
    );
  },
}));

vi.mock("../../ui/ConfirmDialog.js", () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title, children, confirmLabel }: any) => {
    if (!open) return null;
    return (
      <div role="dialog" aria-label={title} data-testid="confirm-dialog">
        {children}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  },
}));

vi.mock("../../ui/Dialog.js", () => ({
  Dialog: ({ open, onClose, children }: any) => {
    if (!open) return null;
    return <div data-testid="dialog">{children}</div>;
  },
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const disabledPolicy = {
  id: "pol-1",
  habitatId: "hab-1",
  extractorKey: "builtin:pattern_v1",
  enabled: false,
  sourceTypes: ["task_lifecycle_audit"],
  schedule: "*/5 * * * *",
  windowSeconds: 3600,
  lookbackSeconds: 86400,
  minConfidence: null,
  minSampleSize: null,
  config: {},
  version: 1,
  createdByType: "human" as const,
  createdById: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
};

const enabledPolicy = { ...disabledPolicy, id: "pol-2", enabled: true, version: 2 };

describe("LearningLoopTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPolicies.mockResolvedValue([]);
    mockGetRunHistory.mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("shows disabled state honestly when no policies are enabled", async () => {
    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Disabled \(off by default\)/)).toBeInTheDocument();
    });
    expect(screen.getByText(/No extraction runs occur/)).toBeInTheDocument();
  });

  it("shows enabled state when a policy is enabled", async () => {
    mockListPolicies.mockResolvedValue([enabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Learning Loop: Enabled/)).toBeInTheDocument();
    });
  });

  it("shows empty state when no policies exist", async () => {
    mockListPolicies.mockResolvedValue([]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No extraction policies configured/)).toBeInTheDocument();
    });
  });

  it("renders policy with extractor key and schedule", async () => {
    mockListPolicies.mockResolvedValue([disabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });
    expect(screen.getByText(/Schedule: \*\/5 \* \* \* \*/)).toBeInTheDocument();
  });

  it("fresh rerun available when policy is disabled (supersedes existing work)", async () => {
    mockListPolicies.mockResolvedValue([disabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    // Fresh Rerun button should be present and functional
    const freshRerunBtn = screen.getByLabelText("Fresh rerun for builtin:pattern_v1");
    expect(freshRerunBtn).toBeInTheDocument();
    // Fresh Rerun is NOT guarded by policy.enabled — it always works
    fireEvent.click(freshRerunBtn);
    await waitFor(() => {
      expect(screen.getByLabelText("Fresh rerun reason")).toBeInTheDocument();
    });
  });

  it("toggles policy enabled via API", async () => {
    mockListPolicies.mockResolvedValue([disabledPolicy]);
    mockUpdatePolicy.mockResolvedValue({ outcome: "updated", policy: enabledPolicy });

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", { name: "Toggle policy builtin:pattern_v1" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockUpdatePolicy).toHaveBeenCalledWith(
        "hab-1",
        "pol-1",
        expect.objectContaining({ enabled: true, expectedVersion: 1 }),
      );
    });
  });

  it("fresh rerun cannot submit without a reason", async () => {
    mockListPolicies.mockResolvedValue([enabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    // Click Fresh Rerun
    screen.getByLabelText("Fresh rerun for builtin:pattern_v1").click();

    await waitFor(() => {
      expect(screen.getByText("Fresh Rerun — Reason Required")).toBeInTheDocument();
    });

    // Confirm button should show "Reason required" and clicking it should NOT call the API
    const confirmBtn = screen.getByText("Reason required");
    expect(confirmBtn).toBeDisabled();

    expect(mockFreshRerun).not.toHaveBeenCalled();
  });

  it("fresh rerun submits when reason is provided", async () => {
    mockListPolicies.mockResolvedValue([enabledPolicy]);
    mockFreshRerun.mockResolvedValue({ kind: "executed" });

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Fresh rerun for builtin:pattern_v1"));

    await waitFor(() => {
      expect(screen.getByLabelText("Fresh rerun reason")).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText("Fresh rerun reason");
    fireEvent.change(textarea, { target: { value: "Data was stale after migration" } });

    await waitFor(() => {
      const runBtn = screen.getByText("Run Fresh Rerun");
      expect(runBtn).not.toBeDisabled();
    });

    fireEvent.click(screen.getByText("Run Fresh Rerun"));

    await waitFor(() => {
      expect(mockFreshRerun).toHaveBeenCalledWith("hab-1", "pol-2", "Data was stale after migration");
    });
  });

  it("renders run history with visually distinguishable states", async () => {
    mockGetRunHistory.mockResolvedValue([
      {
        id: "run-1",
        workItemId: "wi-1",
        status: "succeeded",
        deliveryMode: "scheduled",
        extractorKey: "builtin:pattern_v1",
        candidateCount: 5,
        persistedCount: 3,
        deduplicatedCount: 2,
        error: null,
        startedAt: "2026-08-10T00:00:00Z",
        completedAt: "2026-08-10T00:01:00Z",
        createdAt: "2026-08-10T00:00:00Z",
      },
      {
        id: "run-2",
        workItemId: "wi-2",
        status: "failed",
        deliveryMode: "manual",
        extractorKey: "builtin:pattern_v1",
        candidateCount: 0,
        persistedCount: 0,
        deduplicatedCount: 0,
        error: "Adapter timeout",
        startedAt: "2026-08-11T00:00:00Z",
        completedAt: "2026-08-11T00:00:30Z",
        createdAt: "2026-08-11T00:00:00Z",
      },
      {
        id: "run-3",
        workItemId: "wi-3",
        status: "partial",
        deliveryMode: "scheduled",
        extractorKey: "builtin:pattern_v1",
        candidateCount: 4,
        persistedCount: 2,
        deduplicatedCount: 0,
        error: null,
        startedAt: "2026-08-12T00:00:00Z",
        completedAt: "2026-08-12T00:00:45Z",
        createdAt: "2026-08-12T00:00:00Z",
      },
    ]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("run-run-1")).toBeInTheDocument();
    });

    // Visually distinguishable: failed has error text
    expect(screen.getByTestId("run-error-run-2")).toHaveTextContent("Adapter timeout");

    // Statuses are rendered
    expect(screen.getByTestId("run-run-1")).toHaveAttribute("data-run-status", "succeeded");
    expect(screen.getByTestId("run-run-2")).toHaveAttribute("data-run-status", "failed");
    expect(screen.getByTestId("run-run-3")).toHaveAttribute("data-run-status", "partial");
  });

  it("shows empty run history when no runs exist", async () => {
    mockGetRunHistory.mockResolvedValue([]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("No extraction runs recorded.")).toBeInTheDocument();
    });
  });

  it("does NOT render any Wiki publish affordance", async () => {
    mockListPolicies.mockResolvedValue([enabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/promote to wiki/i)).not.toBeInTheDocument();
  });

  it("does NOT render any Automation Rule create/enable affordance", async () => {
    mockListPolicies.mockResolvedValue([enabledPolicy]);

    renderWithClient(<LearningLoopTab habitatId="hab-1" />);

    await waitFor(() => {
      expect(screen.getByText("builtin:pattern_v1")).toBeInTheDocument();
    });

    expect(screen.queryByText(/create.*automation.*rule/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable.*automation.*rule/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/prefill.*rule/i)).not.toBeInTheDocument();
  });
});
