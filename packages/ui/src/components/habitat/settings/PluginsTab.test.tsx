import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginsTab } from "./PluginsTab.js";

const mockListEnrollments = vi.fn();
const mockListLoaded = vi.fn();
const mockListRuns = vi.fn();
const mockUpdateEnrollment = vi.fn();
const mockDeleteEnrollment = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();

vi.mock("../../../api/index.js", () => ({
  api: {
    plugins: {
      listEnrollments: (...args: unknown[]) => mockListEnrollments(...args),
      listLoaded: (...args: unknown[]) => mockListLoaded(...args),
      listRuns: (...args: unknown[]) => mockListRuns(...args),
      updateEnrollment: (...args: unknown[]) => mockUpdateEnrollment(...args),
      deleteEnrollment: (...args: unknown[]) => mockDeleteEnrollment(...args),
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
  ToggleSwitch: ({ checked, onChange }: any) => (
    <button
      data-testid={`toggle-${checked}`}
      onClick={() => onChange(!checked)}
      aria-label="toggle-enabled"
    />
  ),
}));

vi.mock("../../ui/Button.js", () => ({
  Button: ({ children, onClick, loading, variant }: any) => (
    <button data-testid={`btn-${variant}`} onClick={onClick} disabled={loading}>
      {children}
    </button>
  ),
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("PluginsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListEnrollments.mockResolvedValue({ enrollments: [] });
    mockListLoaded.mockResolvedValue({ plugins: [] });
    mockListRuns.mockResolvedValue({ runs: [] });
  });

  afterEach(() => cleanup());

  it("renders three sections", async () => {
    renderWithQC(<PluginsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText("Available Plugins")).toBeTruthy();
      expect(screen.getByText("Enrolled Plugins")).toBeTruthy();
      expect(screen.getByText("Recent Plugin Runs")).toBeTruthy();
    });
  });

  it("renders enrollment rows with toggle and delete controls", async () => {
    mockListEnrollments.mockResolvedValue({
      enrollments: [
        {
          id: "e1",
          pluginId: "p1",
          contributionId: "c1",
          enabled: true,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithQC(<PluginsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText("p1")).toBeTruthy();
      expect(screen.getByTestId("toggle-true")).toBeTruthy();
      expect(screen.getByLabelText("Remove enrollment")).toBeTruthy();
    });
  });

  it("toggles enrollment enabled via the API", async () => {
    mockListEnrollments.mockResolvedValue({
      enrollments: [
        { id: "e1", pluginId: "p1", contributionId: "c1", enabled: true, createdAt: "" },
      ],
    });
    mockUpdateEnrollment.mockResolvedValue({ enrollment: { id: "e1" } });

    renderWithQC(<PluginsTab habitatId="h1" />);

    await waitFor(() => expect(screen.getByTestId("toggle-true")).toBeTruthy());

    fireEvent.click(screen.getByTestId("toggle-true"));

    await waitFor(() => {
      expect(mockUpdateEnrollment).toHaveBeenCalledWith("h1", "e1", { enabled: false });
      expect(mockNotifySuccess).toHaveBeenCalledWith("Enrollment updated");
    });
  });

  it("confirms and deletes an enrollment", async () => {
    mockListEnrollments.mockResolvedValue({
      enrollments: [
        { id: "e1", pluginId: "p1", contributionId: "c1", enabled: true, createdAt: "" },
      ],
    });
    mockDeleteEnrollment.mockResolvedValue({ success: true });

    renderWithQC(<PluginsTab habitatId="h1" />);

    await waitFor(() => expect(screen.getByLabelText("Remove enrollment")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Remove enrollment"));

    await waitFor(() => expect(screen.getByText("Confirm")).toBeTruthy());

    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(mockDeleteEnrollment).toHaveBeenCalledWith("h1", "e1");
      expect(mockNotifySuccess).toHaveBeenCalledWith("Enrollment removed");
    });
  });

  it("renders recent runs table rows", async () => {
    mockListRuns.mockResolvedValue({
      runs: [
        {
          id: "r1",
          pluginId: "p1",
          status: "completed",
          signalsEmitted: 3,
          error: null,
          startedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });

    renderWithQC(<PluginsTab habitatId="h1" />);

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeTruthy();
      expect(screen.getByText("3")).toBeTruthy();
    });
  });
});
