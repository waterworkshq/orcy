import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DaemonSection } from "./DaemonSection.js";

const mockUseDaemons = vi.hoisted(() => vi.fn());
const mockStart = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());
const mockSuccess = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());

vi.mock("../../lib/useHabitatData.js", () => ({
  useDaemons: mockUseDaemons,
}));

vi.mock("../../api/index.js", () => ({
  api: {
    daemons: {
      start: mockStart,
      stop: mockStop,
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: mockSuccess,
    error: mockError,
  },
}));

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DaemonSection onSetup={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("DaemonSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDaemons.mockReturnValue({
      data: { daemons: [] },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockStart.mockResolvedValue({ status: "started" });
    mockStop.mockResolvedValue({ status: "stopped" });
  });

  it("renders an error state instead of the empty setup state", () => {
    const refetch = vi.fn();
    mockUseDaemons.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("network down"),
      refetch,
    });

    renderSection();

    expect(screen.getByText(/Failed to load daemons: network down/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText(/No daemons registered/)).not.toBeInTheDocument();
  });

  it("shows loading text while start is in flight", async () => {
    let resolveStart!: () => void;
    mockStart.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = () => resolve({ status: "started" });
      }),
    );
    mockUseDaemons.mockReturnValue({
      isLoading: false,
      error: null,
      refetch: vi.fn(),
      data: {
        daemons: [
          {
            id: "d1",
            name: "Local Daemon",
            hostname: "host",
            status: "offline",
            agentCount: 1,
            activeSessionCount: 0,
            lastHeartbeat: null,
            createdAt: "2026-01-01T00:00:00Z",
            maxConcurrent: 1,
          },
        ],
      },
    });

    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();
    resolveStart();
    await waitFor(() => expect(mockSuccess).toHaveBeenCalledWith("Daemon started"));
  });
});
