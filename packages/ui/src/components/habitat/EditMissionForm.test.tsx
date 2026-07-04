import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EditMissionForm } from "./EditMissionForm.js";
import type { MissionWithProgress } from "../../types/index.js";

vi.mock("../../lib/useHabitatData.js", () => ({
  useBoard: () => ({
    data: {
      board: {
        id: "b1",
        name: "B",
        roadmapSettings: { scoringAlgorithm: "fanout", mode: "release" },
      },
    },
  }),
  useUpdateMission: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
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
});
