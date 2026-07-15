import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { ActivityPanel } from "./ActivityPanel.js";

const mockBoardEvents = vi.fn();
const mockBoardAnomalies = vi.fn();
const mockOpenModal = vi.fn();
const mockApiBoardsEvents = vi.fn();

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: (selector: any) => selector({ openModal: mockOpenModal }),
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
  useHabitatEvents: (...args: unknown[]) => mockBoardEvents(...args),
  useHabitatAnomalies: (...args: unknown[]) => mockBoardAnomalies(...args),
}));

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: {
      events: (...args: unknown[]) => mockApiBoardsEvents(...args),
    },
  },
}));

vi.mock("./AuditExportModal.js", () => ({
  AuditExportModal: () => <div data-testid="audit-export-modal" />,
}));

vi.mock("lucide-react", () => ({
  CheckCircle: () => <span data-testid="icon-check" />,
  XCircle: () => <span data-testid="icon-x" />,
  User: () => <span data-testid="icon-user" />,
  Circle: () => <span data-testid="icon-circle" />,
  Clock: () => <span data-testid="icon-clock" />,
  AlertTriangle: () => <span data-testid="icon-alert" />,
  Download: () => <span data-testid="icon-download" />,
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const sampleEvents = [
  {
    id: "evt-1",
    taskId: "task-1",
    taskTitle: "Build feature",
    actorId: "agent-1",
    actorName: "Agent Alpha",
    actorType: "ai" as const,
    action: "claimed" as const,
    timestamp: new Date().toISOString(),
  },
  {
    id: "evt-2",
    taskId: "task-2",
    taskTitle: "Fix bug",
    actorId: "agent-2",
    actorName: "Agent Beta",
    actorType: "ai" as const,
    action: "submitted" as const,
    timestamp: new Date().toISOString(),
  },
];

const sampleAnomalies = [
  {
    severity: "high" as const,
    type: "stalled_task",
    message: "Task has been stalled for 24 hours",
  },
];

describe("ActivityPanel", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();

    mockBoardEvents.mockReturnValue({
      data: { events: sampleEvents, total: 2 },
      isLoading: false,
    });
    mockBoardAnomalies.mockReturnValue({
      data: { anomalies: [] },
      isLoading: false,
    });
    mockApiBoardsEvents.mockResolvedValue({ events: [], total: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders events from useHabitatEvents", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByText('"Build feature"')).toBeTruthy();
    expect(screen.getByText('"Fix bug"')).toBeTruthy();
  });

  it("renders anomalies from useHabitatAnomalies", () => {
    mockBoardAnomalies.mockReturnValue({
      data: { anomalies: sampleAnomalies },
      isLoading: false,
    });

    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByText(/Active Anomalies/)).toBeTruthy();
    expect(screen.getByText("Task has been stalled for 24 hours")).toBeTruthy();
  });

  it('shows "No activity yet" when no events or anomalies', () => {
    mockBoardEvents.mockReturnValue({
      data: { events: [], total: 0 },
      isLoading: false,
    });

    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByText("No activity yet")).toBeTruthy();
  });

  it("shows loading state while queries resolve", () => {
    mockBoardEvents.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    mockBoardAnomalies.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("calls useHabitatEvents with habitatId", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(mockBoardEvents).toHaveBeenCalledWith("board-1", expect.objectContaining({ limit: 50 }));
  });

  it("calls useHabitatAnomalies with habitatId", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(mockBoardAnomalies).toHaveBeenCalledWith("board-1");
  });

  it("has no setTimeout/setInterval polling", () => {
    const source = `import React, { useState, useCallback } from 'react';
import { Drawer } from '../ui/Drawer.js';
import { Button } from '../ui/Button.js';
import { api } from '../../api/index.js';
import { useModalStore } from '../../store/modalStore.js';
import { useHabitatEvents, useHabitatAnomalies } from '../../lib/useHabitatData.js';`;

    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
  });

  it("renders filter buttons", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByText("all")).toBeTruthy();
    expect(screen.getByText("claims")).toBeTruthy();
    expect(screen.getByText("submissions")).toBeTruthy();
    expect(screen.getByText("approvals")).toBeTruthy();
    expect(screen.getByText("rejections")).toBeTruthy();
  });

  it("changes filter and resets extra events", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("claims"));

    expect(mockBoardEvents).toHaveBeenCalledWith(
      "board-1",
      expect.objectContaining({
        action: "claimed",
      }),
    );
  });

  it("calls onClose when Close button clicked", () => {
    const onClose = vi.fn();
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={onClose} />);

    fireEvent.click(screen.getByText("Close"));

    expect(onClose).toHaveBeenCalled();
  });

  it("opens task modal on event click", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('"Build feature"').closest('[class*="cursor-pointer"]')!);

    expect(mockOpenModal).toHaveBeenCalledWith("task-1");
  });

  it("shows Load more when there are more events", () => {
    mockBoardEvents.mockReturnValue({
      data: { events: sampleEvents, total: 10 },
      isLoading: false,
    });

    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByText("Load more")).toBeTruthy();
  });

  it("loads more events on Load more click", async () => {
    const moreEvents = [
      {
        id: "evt-3",
        taskId: "task-3",
        taskTitle: "Extra task",
        actorId: "agent-3",
        actorName: "Agent Gamma",
        actorType: "ai" as const,
        action: "approved" as const,
        timestamp: new Date().toISOString(),
      },
    ];
    mockBoardEvents.mockReturnValue({
      data: { events: sampleEvents, total: 10 },
      isLoading: false,
    });
    mockApiBoardsEvents.mockResolvedValue({ events: moreEvents, total: 10 });

    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText('"Extra task"')).toBeTruthy();
    });
  });

  it("renders Export button when habitatId exists", () => {
    renderWithQC(<ActivityPanel habitatId="board-1" onClose={vi.fn()} />);

    expect(screen.getByTitle("Export Audit Log")).toBeTruthy();
  });

  it("does not render Export button when no habitatId", () => {
    renderWithQC(<ActivityPanel habitatId={undefined} onClose={vi.fn()} />);

    expect(screen.queryByTitle("Export Audit Log")).toBeNull();
  });
});
