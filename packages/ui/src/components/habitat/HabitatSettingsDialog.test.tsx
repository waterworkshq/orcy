import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HabitatSettingsDialog } from "./HabitatSettingsDialog.js";
import type { Habitat } from "../../types/index.js";

const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockGetGlobalPrefs = vi.fn();
const mockGetHabitatPrefs = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    boards: {
      update: (...args: unknown[]) => mockUpdate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
    },
    notifications: {
      getGlobalPrefs: (...args: unknown[]) => mockGetGlobalPrefs(...args),
      getHabitatPrefs: (...args: unknown[]) => mockGetHabitatPrefs(...args),
      updateEmail: vi.fn(),
      updateGlobalPrefs: vi.fn(),
      updateHabitatPrefs: vi.fn(),
    },
    chatIntegrations: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      test: vi.fn(),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("../ui/Dialog.js", () => ({
  Dialog: ({ open, children }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
  DialogFooter: ({ children }: any) => <div data-testid="dialog-footer">{children}</div>,
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, disabled, loading, variant }: any) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant} data-loading={loading}>
      {loading ? "Loading..." : children}
    </button>
  ),
}));

vi.mock("../ui/ConfirmDialog.js", () => ({
  ConfirmDialog: ({ open, title }: any) =>
    open ? <div data-testid="confirm-dialog">{title}</div> : null,
}));

vi.mock("./ExportHabitatDialog.js", () => ({
  ExportHabitatDialog: ({ open }: any) => (open ? <div data-testid="export-dialog" /> : null),
}));

vi.mock("./ImportHabitatDialog.js", () => ({
  ImportHabitatDialog: ({ open }: any) => (open ? <div data-testid="import-dialog" /> : null),
}));

vi.mock("./settings/GeneralTab.js", () => ({
  GeneralTab: React.forwardRef(function GeneralTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {
        props.onUpdate({ id: "b1", name: "Saved" });
        props.onClose();
      },
    }));
    return (
      <div data-testid="general-tab">
        <span>GeneralTab</span>
        <button onClick={() => props.onExportOpen()}>ExportTrigger</button>
        <button onClick={() => props.onDeleteOpen()}>DeleteTrigger</button>
      </div>
    );
  }),
}));

vi.mock("./settings/NotificationsTab.js", () => ({
  NotificationsTab: React.forwardRef(function NotificationsTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="notifications-tab">NotificationsTab</div>;
  }),
}));

vi.mock("./settings/ChatIntegrationsTab.js", () => ({
  ChatIntegrationsTab: () => <div data-testid="chat-tab">ChatIntegrationsTab</div>,
}));

vi.mock("./settings/RetryPolicyTab.js", () => ({
  RetryPolicyTab: React.forwardRef(function RetryPolicyTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="retry-tab">RetryPolicyTab</div>;
  }),
}));

vi.mock("./settings/AnomalyDetectionTab.js", () => ({
  AnomalyDetectionTab: React.forwardRef(function AnomalyDetectionTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="anomaly-tab">AnomalyDetectionTab</div>;
  }),
}));

vi.mock("./settings/AutoAssignTab.js", () => ({
  AutoAssignTab: React.forwardRef(function AutoAssignTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="auto-assign-tab">AutoAssignTab</div>;
  }),
}));

vi.mock("./settings/PrioritizationTab.js", () => ({
  PrioritizationTab: React.forwardRef(function PrioritizationTab(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({
      save: async () => {},
    }));
    return <div data-testid="prioritization-tab">PrioritizationTab</div>;
  }),
}));

vi.mock("./settings/ScheduledTasksTab.js", () => ({
  ScheduledTasksTab: () => <div data-testid="scheduled-tasks-tab">ScheduledTasksTab</div>,
}));

vi.mock("./settings/IntegrationsTab.js", () => ({
  IntegrationsTab: () => <div data-testid="integrations-tab">IntegrationsTab</div>,
}));

const mockHabitat: Habitat = {
  id: "b1",
  name: "Test Habitat",
  description: "A test board",
  columns: [],
  teamId: null,
  retrySettings: null,
  anomalySettings: null,
  autoAssignSettings: null,
  prioritizationSettings: null,
  automationSettings: null,
  codeReviewSettings: null,
  ciCdSettings: null,
  gitWorktreeSettings: null,
  eventRetentionDays: null,
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
};

const mockOnUpdate = vi.fn();
const mockOnDelete = vi.fn();
const mockOnClose = vi.fn();

function renderDialog(props: { open?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HabitatSettingsDialog
        board={mockHabitat}
        open={props.open ?? true}
        onClose={mockOnClose}
        onUpdate={mockOnUpdate}
        onDelete={mockOnDelete}
      />
    </QueryClientProvider>,
  );
}

describe("HabitatSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders dialog title", () => {
    renderDialog();
    expect(screen.getByText("Habitat Settings")).toBeTruthy();
  });

  it("renders all tab buttons", () => {
    renderDialog();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.getByText("Chat Integrations")).toBeTruthy();
    expect(screen.getByText("Retry Policy")).toBeTruthy();
    expect(screen.getByText("Anomaly Detection")).toBeTruthy();
    expect(screen.getByText("Auto-Assign")).toBeTruthy();
    expect(screen.getByText("Prioritization")).toBeTruthy();
    expect(screen.getByText("Scheduled Tasks")).toBeTruthy();
    expect(screen.getByText("Integrations")).toBeTruthy();
  });

  it("shows GeneralTab by default", () => {
    renderDialog();
    expect(screen.getByTestId("general-tab")).toBeTruthy();
  });

  it("switches to NotificationsTab on tab click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Notifications"));
    expect(screen.getByTestId("notifications-tab")).toBeTruthy();
    expect(screen.getByTestId("general-tab")).toBeTruthy();
  });

  it("switches to ChatIntegrationsTab on tab click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Chat Integrations"));
    expect(screen.getByTestId("chat-tab")).toBeTruthy();
  });

  it("switches to RetryPolicyTab on tab click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Retry Policy"));
    expect(screen.getByTestId("retry-tab")).toBeTruthy();
  });

  it("switches to AnomalyDetectionTab on tab click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Anomaly Detection"));
    expect(screen.getByTestId("anomaly-tab")).toBeTruthy();
  });

  it("switches to AutoAssignTab on tab click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Auto-Assign"));
    expect(screen.getByTestId("auto-assign-tab")).toBeTruthy();
  });

  it("renders Cancel button", () => {
    renderDialog();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("renders Save button for general tab", () => {
    renderDialog();
    expect(screen.getByText("Save")).toBeTruthy();
  });

  it("renders correct save button for each tab", () => {
    renderDialog();

    expect(screen.getByText("Save")).toBeTruthy();

    fireEvent.click(screen.getByText("Retry Policy"));
    expect(screen.getByText("Save Retry Policy")).toBeTruthy();

    fireEvent.click(screen.getByText("Anomaly Detection"));
    expect(screen.getByText("Save Anomaly Settings")).toBeTruthy();

    fireEvent.click(screen.getByText("Auto-Assign"));
    expect(screen.getByText("Save Auto-Assign Settings")).toBeTruthy();
  });

  it("renders no save button for chat tab", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Chat Integrations"));
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("renders no save button for integrations tab", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Integrations"));
    expect(screen.queryByText("Save")).toBeNull();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("renders Integrations tab content on click", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Integrations"));
    expect(screen.getByTestId("integrations-tab")).toBeTruthy();
  });

  it("does not render when open=false", () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("renders 9 tab buttons", () => {
    renderDialog();
    const tabButtons = screen
      .getAllByRole("button")
      .filter((btn) =>
        [
          "General",
          "Notifications",
          "Chat Integrations",
          "Retry Policy",
          "Anomaly Detection",
          "Auto-Assign",
          "Prioritization",
          "Scheduled Tasks",
          "Integrations",
        ].includes(btn.textContent || ""),
      );
    expect(tabButtons.length).toBe(9);
  });
});
