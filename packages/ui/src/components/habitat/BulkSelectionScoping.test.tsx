import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { HabitatPage } from "./HabitatPage.js";
import { BulkActionBar } from "./BulkActionBar.js";
import { useHabitatStore } from "../../store/habitatStore.js";
import type { PublicHabitat, Column, MissionWithProgress } from "../../types/index.js";

vi.mock("../../lib/toast.js", () => ({
  notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

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

function makeHabitat(id: string, name: string): PublicHabitat {
  return {
    id,
    name,
    description: "Test",
    columns: [],
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
}

const columnsA: Column[] = [
  {
    id: "col-a1",
    name: "Todo",
    order: 0,
    habitatId: "hab-a",
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: false,
    nextColumnId: null,
    isTerminal: false,
  },
];

const columnsB: Column[] = [
  {
    id: "col-b1",
    name: "Todo",
    order: 0,
    habitatId: "hab-b",
    wipLimit: null,
    autoAdvance: false,
    requiresClaim: false,
    nextColumnId: null,
    isTerminal: false,
  },
];

function makeMission(id: string, title: string, habitatId: string): MissionWithProgress {
  return {
    id,
    title,
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    status: "in_progress",
    habitatId,
    columnId: habitatId === "hab-a" ? "col-a1" : "col-b1",
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
}

const habitatA = makeHabitat("hab-a", "Habitat A");
const habitatB = makeHabitat("hab-b", "Habitat B");
const missionsA = [
  makeMission("m-a1", "Alpha Mission", "hab-a"),
  makeMission("m-a2", "Beta Mission", "hab-a"),
];
const missionsB = [
  makeMission("m-b1", "Gamma Mission", "hab-b"),
  makeMission("m-b2", "Delta Mission", "hab-b"),
];
const detailA = { habitat: habitatA, columns: columnsA, missions: missionsA };
const detailB = { habitat: habitatB, columns: columnsB, missions: missionsB };

const deletedIds: string[] = [];
const updatedIds: string[] = [];

const fetchMock = vi.fn();

function setupFetch() {
  deletedIds.length = 0;
  updatedIds.length = 0;
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (u === "/api/habitats/hab-a" && method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(detailA),
      });
    }
    if (u === "/api/habitats/hab-b" && method === "GET") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(detailB),
      });
    }
    if (method === "DELETE" && u.match(/\/api\/missions\/[\w-]+$/)) {
      const id = u.split("/").pop()!;
      deletedIds.push(id);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(undefined),
      });
    }
    if (method === "PATCH" && u.match(/\/api\/missions\/[\w-]+$/)) {
      const id = u.split("/").pop()!;
      updatedIds.push(id);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ mission: { id, version: 2, priority: "high" } }),
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

function renderApp(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/habitats/:habitatId" element={<HabitatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Cross-habitat bulk selection scoping (B1 regression)", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    setupFetch();
    useHabitatStore.setState({
      selectedMissionIds: [],
      isBulkSelectMode: false,
      selectedMissionId: null,
      selectionHabitatId: null,
      presence: [],
      wipAlerts: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("clears selection when navigating from habitat A to habitat B", async () => {
    await act(async () => {
      renderApp("/habitats/hab-a");
    });

    await waitFor(() => {
      expect(screen.getByText("Habitat A")).toBeTruthy();
    });

    act(() => {
      useHabitatStore.getState().setBulkSelectMode(true, "hab-a");
      useHabitatStore.getState().selectMissionIds(["m-a1", "m-a2"]);
    });

    expect(useHabitatStore.getState().selectedMissionIds).toEqual(["m-a1", "m-a2"]);
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(true);

    cleanup();

    await act(async () => {
      renderApp("/habitats/hab-b");
    });

    await waitFor(() => {
      expect(screen.getByText("Habitat B")).toBeTruthy();
    });

    const state = useHabitatStore.getState();
    expect(state.selectedMissionIds).toEqual([]);
    expect(state.isBulkSelectMode).toBe(false);
    expect(state.selectionHabitatId).toBeNull();
  });

  it("BulkActionBar scoping: operations from B ignore A's mission IDs", async () => {
    useHabitatStore.setState({
      selectedMissionIds: ["m-a1", "m-a2"],
      isBulkSelectMode: true,
      selectionHabitatId: "hab-a",
    });

    await act(async () => {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
        >
          <MemoryRouter initialEntries={["/habitats/hab-b"]}>
            <Routes>
              <Route path="/habitats/:habitatId" element={<BulkActionBar habitatId="hab-b" />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("0 features selected")).toBeTruthy();
    });

    const buttons = screen.getAllByRole("button");
    const applyButton = buttons.find((b) => b.textContent?.includes("Apply"));
    expect((applyButton as HTMLButtonElement)?.disabled).toBe(true);
  });

  it("BulkActionBar scoping: only operates on missions belonging to current habitat", async () => {
    useHabitatStore.setState({
      selectedMissionIds: ["m-a1", "m-a2", "m-b1"],
      isBulkSelectMode: true,
      selectionHabitatId: "hab-b",
    });

    await act(async () => {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })}
        >
          <MemoryRouter initialEntries={["/habitats/hab-b"]}>
            <Routes>
              <Route path="/habitats/:habitatId" element={<BulkActionBar habitatId="hab-b" />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("1 feature selected")).toBeTruthy();
    });

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "delete" } });

    const buttons = screen.getAllByRole("button");
    const deleteButton = buttons.find((b) => b.textContent?.includes("Delete"));
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(deletedIds).toEqual(["m-b1"]);
    });

    expect(deletedIds).not.toContain("m-a1");
    expect(deletedIds).not.toContain("m-a2");
  });

  it("returns to sane state when navigating back to habitat A", async () => {
    await act(async () => {
      renderApp("/habitats/hab-a");
    });

    await waitFor(() => {
      expect(screen.getByText("Habitat A")).toBeTruthy();
    });

    act(() => {
      useHabitatStore.getState().setBulkSelectMode(true, "hab-a");
      useHabitatStore.getState().selectMissionIds(["m-a1"]);
    });

    expect(useHabitatStore.getState().selectedMissionIds).toEqual(["m-a1"]);

    cleanup();

    await act(async () => {
      renderApp("/habitats/hab-b");
    });

    await waitFor(() => {
      expect(screen.getByText("Habitat B")).toBeTruthy();
    });

    expect(useHabitatStore.getState().selectedMissionIds).toEqual([]);
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);

    cleanup();

    await act(async () => {
      renderApp("/habitats/hab-a");
    });

    await waitFor(() => {
      expect(screen.getByText("Habitat A")).toBeTruthy();
    });

    const state = useHabitatStore.getState();
    expect(state.selectedMissionIds).toEqual([]);
    expect(state.isBulkSelectMode).toBe(false);
    expect(state.selectionHabitatId).toBeNull();
  });
});
