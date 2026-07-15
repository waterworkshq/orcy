import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { HabitatPage } from "./HabitatPage.js";
import { useHabitatStore } from "../../store/habitatStore.js";
import type { MissionWithProgress, Column, PublicHabitat } from "../../types/index.js";

const columns: Column[] = [
  {
    id: "col-todo",
    name: "Todo",
    order: 0,
    habitatId: "board-1",
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: false,
    nextColumnId: null,
    isTerminal: false,
  },
  {
    id: "col-done",
    name: "Done",
    order: 1,
    habitatId: "board-1",
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: false,
    nextColumnId: null,
    isTerminal: true,
  },
];

const missions: MissionWithProgress[] = [
  {
    id: "m1",
    title: "Alpha Mission",
    description: "First",
    acceptanceCriteria: "",
    priority: "high",
    status: "in_progress",
    habitatId: "board-1",
    columnId: "col-todo",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    releaseDeadlineType: null,
    releaseDeadlineVersion: null,
    progress: {
      total: 2,
      pending: 1,
      claimed: 0,
      inProgress: 1,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
  },
  {
    id: "m2",
    title: "Beta Mission",
    description: "Second",
    acceptanceCriteria: "",
    priority: "medium",
    status: "done",
    habitatId: "board-1",
    columnId: "col-done",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 3,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    releaseDeadlineType: null,
    releaseDeadlineVersion: null,
    progress: {
      total: 1,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0,
      percentage: 100,
    },
  },
];

const habitat: PublicHabitat = {
  id: "board-1",
  name: "Integration Habitat",
  description: "Test",
  columns,
  teamId: null,
  retrySettings: null,
  anomalySettings: null,
  autoAssignSettings: null,
  codeReviewSettings: null,
  ciCdSettings: null,
  gitWorktreeSettings: null,
  prioritizationSettings: null,
  automationSettings: null,
  wikiSettings: null,
  triageSettings: null,
  releaseSettings: null,
  roadmapSettings: null,
  eventRetentionDays: null,
  createdAt: "",
  updatedAt: "",
};

const canonicalDetail = { habitat, columns, missions };

const fetchMock = vi.fn();

vi.mock("../../hooks/useSSE.js", () => ({ useSSE: () => {} }));
vi.mock("../../hooks/useSSENotifications.js", () => ({ useSSENotifications: () => {} }));
vi.mock("../../hooks/usePresence.js", () => ({ usePresence: () => {} }));
vi.mock("../../hooks/useMediaQuery.js", () => ({ useIsMobile: () => false }));

vi.mock("./HabitatPulsePanel.js", () => ({ HabitatPulsePanel: () => null }));
vi.mock("./InsightsPanel.js", () => ({ InsightsPanel: () => null }));
vi.mock("./SkillPanel.js", () => ({ SkillPanel: () => null }));
vi.mock("./HealthScoreWidget.js", () => ({ HealthScoreWidget: () => null }));
vi.mock("./SprintSelector.js", () => ({ SprintSelector: () => null }));
vi.mock("./SprintPlanningPanel.js", () => ({ SprintPlanningPanel: () => null }));
vi.mock("./FilterBar.js", () => ({ FilterBar: () => null }));
vi.mock("./AgentPanel.js", () => ({ AgentPanel: () => null }));
vi.mock("./BulkActionBar.js", () => ({ BulkActionBar: () => null }));
vi.mock("./MobileNav.js", () => ({ MobileNav: () => null }));
vi.mock("./StatsModal.js", () => ({ StatsModal: () => null }));
vi.mock("./ColumnSettingsDialog.js", () => ({ ColumnSettingsDialog: () => null }));
vi.mock("./HabitatSettingsDialog.js", () => ({ HabitatSettingsDialog: () => null }));
vi.mock("./CreateColumnDialog.js", () => ({ CreateColumnDialog: () => null }));
vi.mock("./CreateTaskForm.js", () => ({ CreateTaskForm: () => null }));
vi.mock("./CreateMissionForm.js", () => ({ CreateMissionForm: () => null }));
vi.mock("./DependencyGraphModal.js", () => ({ DependencyGraphModal: () => null }));
vi.mock("./IntakeReviewPanel.js", () => ({ IntakeReviewPanel: () => null }));
vi.mock("./TaskTableView.js", () => ({ TaskTableView: () => null }));
vi.mock("../ui/HelpDrawer.js", () => ({ HelpDrawer: () => null }));
vi.mock("../ui/HelpContent.js", () => ({ HelpContent: () => null }));
vi.mock("../ui/Button.js", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../../components/layout/DrawerBridgeContext.js", () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
}));

function setupFetch() {
  fetchMock.mockImplementation((url: string | URL) => {
    const u = url.toString();
    if (u === "/api/habitats/board-1") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(canonicalDetail),
      });
    }
    if (u.includes("/missions")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ missions: [], total: 0 }),
      });
    }
    if (u.includes("/agents")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ agents: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({}),
    });
  });
  global.fetch = fetchMock as any;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/habitats/board-1"]}>
        <Routes>
          <Route path="/habitats/:habitatId" element={<HabitatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HabitatPage → Habitat Query ownership integration", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    setupFetch();
    useHabitatStore.setState({
      board: null,
      columns: [],
      features: [],
      columnPagination: {},
      allFeaturesLoaded: false,
      habitatEvents: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders canonical habitat name from Query with empty Zustand server-entity store", async () => {
    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(screen.getByText("Integration Habitat")).toBeTruthy();
    });

    const state = useHabitatStore.getState();
    expect(state.board).toBeNull();
    expect(state.features).toEqual([]);
    expect(state.columnPagination).toEqual({});
  });

  it("renders columns from Query data", async () => {
    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(screen.getByText("Todo")).toBeTruthy();
      expect(screen.getByText("Done")).toBeTruthy();
    });
  });

  it("renders missions from Query data", async () => {
    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Mission")).toBeTruthy();
      expect(screen.getByText("Beta Mission")).toBeTruthy();
    });
  });

  it("fetches habitat detail via real HTTP transport", async () => {
    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/habitats/board-1",
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });
});
