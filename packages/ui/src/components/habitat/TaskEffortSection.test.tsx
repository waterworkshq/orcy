import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { TaskEffortSection } from "./TaskEffortSection.js";

const mockGetReport = vi.fn();
const mockLog = vi.fn();
const mockCorrect = vi.fn();

vi.mock("../../hooks/useEffort.js", () => ({
  useTaskEffortReport: (taskId: string) => mockGetReport(taskId),
  useLogEffort: (taskId: string) => mockLog(taskId),
  useCorrectEffortEntry: (taskId: string) => mockCorrect(taskId),
}));

vi.mock("../ui/DetailCard.js", () => ({
  DetailCard: ({ icon: Icon, title, children, className }: any) => (
    <div data-testid="detail-card" className={className}>
      <div data-testid="detail-card-title">{title}</div>
      {children}
    </div>
  ),
}));

vi.mock("../ui/Badge.js", () => ({
  Badge: ({ children, variant, className }: any) => (
    <span data-testid="badge" data-variant={variant} className={className}>
      {children}
    </span>
  ),
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, disabled, type, variant, size, className, ...props }: any) => (
    <button
      type={type || "button"}
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      className={className}
      {...props}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Clock: () => <span data-testid="icon-clock" />,
  Plus: () => <span data-testid="icon-plus" />,
  Pencil: () => <span data-testid="icon-pencil" />,
}));

const defaultReport = {
  target: { type: "task" as const, id: "task-1" },
  estimate: { plannedMinutes: 60 },
  totals: {
    loggedEffortMinutes: 30,
    inferredPresenceMinutes: 10,
    correctionAdjustmentMinutes: 0,
    totalAccountedMinutes: 40,
  },
  elapsed: { cycleTimeMinutes: null, leadTimeMinutes: null },
  accuracy: { estimationAccuracy: null, basis: "unavailable" as const },
  bySource: {},
  byActor: [],
  entries: [
    {
      id: "entry-1",
      taskId: "task-1",
      actorType: "human" as const,
      actorId: "user-1",
      actorName: "Alice",
      minutes: 30,
      source: "human_manual" as const,
      note: "Initial work",
      startedAt: null,
      endedAt: null,
      recordedAt: "2024-01-01T12:00:00Z",
      correctsEntryId: null,
      correctionReason: null,
      metadata: null,
    },
  ],
  warnings: [],
};

function returnMutation(overrides: Record<string, any> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    ...overrides,
  };
}

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("TaskEffortSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReport.mockReturnValue({ data: defaultReport, isLoading: false });
    mockLog.mockReturnValue(returnMutation());
    mockCorrect.mockReturnValue(returnMutation());
  });

  afterEach(() => {
    cleanup();
  });

  it("renders effort summary with totals", () => {
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    expect(screen.getByText(/Est: 60m/)).toBeTruthy();
    expect(screen.getByText(/Logged: 30m/)).toBeTruthy();
    expect(screen.getByText(/Inferred: 10m/)).toBeTruthy();
    expect(screen.getByText(/Total: 40m/)).toBeTruthy();
  });

  it("renders No effort logged when no entries exist", () => {
    mockGetReport.mockReturnValue({
      data: {
        ...defaultReport,
        entries: [],
        totals: {
          loggedEffortMinutes: 0,
          inferredPresenceMinutes: 0,
          correctionAdjustmentMinutes: 0,
          totalAccountedMinutes: 0,
        },
      },
      isLoading: false,
    });
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    expect(screen.getByText("No effort logged")).toBeTruthy();
  });

  it("shows add effort form when button clicked", () => {
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    const logButton = screen.getByText("Log Effort");
    fireEvent.click(logButton);
    expect(screen.getByPlaceholderText("Minutes")).toBeTruthy();
    expect(screen.getByPlaceholderText("Note (optional)")).toBeTruthy();
  });

  it("calls logEffort mutation on form submit", () => {
    const mockMutate = vi.fn();
    mockLog.mockReturnValue(returnMutation({ mutate: mockMutate }));
    renderWithQC(<TaskEffortSection taskId="task-1" />);

    fireEvent.click(screen.getByText("Log Effort"));
    const minutesInput = screen.getByPlaceholderText("Minutes");
    fireEvent.change(minutesInput, { target: { value: "45" } });
    fireEvent.submit(minutesInput.closest("form")!);

    expect(mockMutate).toHaveBeenCalledWith(
      { minutes: 45, note: undefined },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("shows correction form when correct button clicked", () => {
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    const correctButtons = screen.getAllByTitle("Correct entry");
    fireEvent.click(correctButtons[0]);
    expect(screen.getByPlaceholderText("+/- minutes")).toBeTruthy();
    expect(screen.getByPlaceholderText("Reason")).toBeTruthy();
  });

  it("shows entry history with source badges", () => {
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    const badges = screen.getAllByTestId("badge");
    const sourceBadge = badges.find((b) => b.textContent === "Manual");
    expect(sourceBadge).toBeTruthy();
    expect(screen.getByText("30m")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText(/Initial work/)).toBeTruthy();
  });

  it("renders a loading skeleton while loading", () => {
    mockGetReport.mockReturnValue({ data: undefined, isLoading: true });
    renderWithQC(<TaskEffortSection taskId="task-1" />);
    expect(screen.getByTestId("detail-card-title")).toHaveTextContent("Effort");
    expect(screen.getByLabelText("Loading effort summary")).toHaveAttribute("aria-busy", "true");
  });
});
