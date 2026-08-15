import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditMissionForm } from "./EditMissionForm.js";
import { ApiError } from "../../api/transport.js";
import { notify } from "../../lib/toast.js";
import type { MissionWithProgress } from "../../types/index.js";

const mockMutateAsync = vi.fn();

vi.mock("../../lib/useHabitatData.js", () => ({
  useHabitat: () => ({
    data: {
      board: {
        id: "b1",
        name: "B",
        roadmapSettings: { scoringAlgorithm: "fanout", mode: "release" },
      },
    },
  }),
  useUpdateMission: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// RichTextEditor pulls in TipTap; stub it to keep the test DOM-light.
vi.mock("../ui/RichTextEditor.js", () => ({
  RichTextEditor: ({ content }: { content: string }) => (
    <textarea data-testid="description" value={content} readOnly />
  ),
}));

const baseMission = {
  id: "m1",
  habitatId: "b1",
  columnId: "c1",
  title: "Original title",
  description: "desc",
  acceptanceCriteria: "",
  priority: "high" as const,
  labels: ["x", "y"],
  status: "in_progress" as const,
  displayOrder: 0,
  dependsOn: [],
  blocks: [],
  dueAt: null,
  slaMinutes: null,
  slaDeadlineAt: null,
  createdBy: "u1",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  version: 3,
  actualMinutes: null,
  plannedMinutes: null,
  planningAccuracy: null,
  completedAt: null,
  isArchived: false,
  sprintId: null,
  releaseGateType: "minor" as const,
  releaseGateVersion: "v0.25",
  releaseDeadlineType: null,
  releaseDeadlineVersion: null,
  progress: {
    total: 0,
    pending: 0,
    claimed: 0,
    inProgress: 0,
    submitted: 0,
    approved: 0,
    done: 0,
    failed: 0,
    rejected: 0,
    percentage: 0,
  },
};

function renderForm(overrides: Partial<MissionWithProgress> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EditMissionForm open onClose={vi.fn()} mission={{ ...baseMission, ...overrides }} />
    </QueryClientProvider>,
  );
}

describe("EditMissionForm (RM-13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders pre-filled from the mission and shows release-gate authoring in release mode", () => {
    renderForm();
    // Title pre-filled from the mission.
    expect(screen.getByDisplayValue("Original title")).toBeInTheDocument();
    // Body fields render (priority + labels pre-filled).
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByDisplayValue("x, y")).toBeInTheDocument();
    // Release mode renders the gate + deadline selector labels (RM-6 authoring gate).
    expect(screen.getByText("Release Gate")).toBeInTheDocument();
    expect(screen.getByText("Release Deadline")).toBeInTheDocument();
  });

  it.each([
    [
      "MISSION_GATE_CLEAR_BLOCKED",
      "Cannot clear the release gate while linked findings are non-terminal; activate the corrective Mission first.",
    ],
    [
      "MISSION_GATE_CHANGE_BLOCKED",
      "Cannot add or replace a release gate while linked findings are in progress.",
    ],
  ])(
    "surfaces the SERVER message for a %s guard 409 — never the version-conflict path",
    async (code, serverMessage) => {
      mockMutateAsync.mockRejectedValue(
        new ApiError(serverMessage, 409, { error: serverMessage, code }),
      );
      renderForm();

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(notify.error).toHaveBeenCalledWith(serverMessage);
      });
      // The misleading "edited elsewhere" reconcile message must NOT appear.
      const errorCalls = vi.mocked(notify.error).mock.calls.map((c) => String(c[0]));
      expect(errorCalls.some((m) => m.includes("edited elsewhere"))).toBe(false);
    },
  );

  it("still renders the reconcile flow for a genuine VERSION_CONFLICT 409", async () => {
    mockMutateAsync.mockRejectedValue(
      new ApiError("Version conflict", 409, {
        error: "Version conflict",
        code: "VERSION_CONFLICT",
      }),
    );
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith(
        "This mission was edited elsewhere — refresh and try again",
      );
    });
  });
});
