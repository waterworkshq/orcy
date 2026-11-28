import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
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
  remoteGovernanceSettings: null,
  automationSettings: null,
  wikiSettings: null,
  triageSettings: null,
  releaseSettings: null,
  roadmapSettings: null,
  lifecycleSettings: null,
  eventRetentionDays: null,
  createdAt: "",
  updatedAt: "",
};

const canonicalDetail = { habitat, columns, missions };

const fetchMock = vi.fn();
let recovering = false;
let availableMissions = missions;

vi.mock("../../hooks/useSSE.js", () => ({ useSSE: () => {} }));
vi.mock("../../hooks/useSSENotifications.js", () => ({ useSSENotifications: () => {} }));
vi.mock("../../hooks/usePresence.js", () => ({ usePresence: () => {} }));
let mobile = false;
vi.mock("../../hooks/useMediaQuery.js", () => ({ useIsMobile: () => mobile }));

vi.mock("./HabitatPulsePanel.js", () => ({ HabitatPulsePanel: () => null }));
vi.mock("./InsightsPanel.js", () => ({ InsightsPanel: () => null }));
vi.mock("./SkillPanel.js", () => ({ SkillPanel: () => null }));
vi.mock("./HealthScoreWidget.js", () => ({ HealthScoreWidget: () => null }));
vi.mock("./SprintSelector.js", () => ({ SprintSelector: () => null }));
vi.mock("./SprintPlanningPanel.js", () => ({ SprintPlanningPanel: () => null }));
vi.mock("./FilterBar.js", () => ({ FilterBar: () => null }));
vi.mock("./AgentPanel.js", () => ({ AgentPanel: () => null }));
vi.mock("./BulkActionBar.js", () => ({ BulkActionBar: () => null }));
vi.mock("./StatsModal.js", () => ({ StatsModal: () => null }));
vi.mock("./ColumnSettingsDialog.js", () => ({ ColumnSettingsDialog: () => null }));
vi.mock("./HabitatSettingsDialog.js", () => ({ HabitatSettingsDialog: () => null }));
vi.mock("./CreateColumnDialog.js", () => ({ CreateColumnDialog: () => null }));
vi.mock("./CreateMissionForm.js", () => ({ CreateMissionForm: () => null }));
vi.mock("./DependencyGraphModal.js", () => ({ DependencyGraphModal: () => null }));
vi.mock("./IntakeReviewPanel.js", () => ({ IntakeReviewPanel: () => null }));
vi.mock("./TaskTableView.js", () => ({ TaskTableView: () => null }));
vi.mock("../ui/RichTextEditor.js", () => ({ RichTextEditor: () => <textarea aria-label="Description" /> }));
vi.mock("../ui/HelpDrawer.js", () => ({ HelpDrawer: () => null }));
vi.mock("../ui/HelpContent.js", () => ({ HelpContent: () => null }));
vi.mock("../ui/Button.js", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../../components/layout/DrawerBridgeContext.js", () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
}));

function setupFetch() {
  fetchMock.mockImplementation((url: string | URL, options?: RequestInit) => {
    const u = url.toString();
    if (options?.method === "POST" && u === "/api/missions/m1/task-publications") {
      availableMissions = availableMissions.map((m) => m.id === "m1" ? { ...m, progress: { ...m.progress, total: 3, pending: 2 } } : m);
      return Promise.resolve(new Response(JSON.stringify({ outcome: "created", attemptId: "a1", taskId: "t1", ...(recovering ? { recovering: true, recoveringState: "published_pending_observation" } : {}) }), { status: recovering ? 202 : 201, headers: { "Content-Type": "application/json" } }));
    }
    if (u === "/api/task-creation-attempts/a1") return Promise.resolve(new Response(JSON.stringify({ state: "created", committedTaskId: "t1" }), { status: 200 }));
    if (u.includes("/templates")) return Promise.resolve(new Response(JSON.stringify({ templates: [] }), { status: 200 }));
    if (u === "/api/habitats/board-2") return Promise.resolve(new Response(JSON.stringify({ habitat: { ...habitat, id: "board-2", name: "Second Habitat" }, columns: [], missions: [{ ...missions[0], id: "m3", habitatId: "board-2", title: "Second Mission" }] }), { status: 200 }));
    if (u === "/api/habitats/board-1") {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ ...canonicalDetail, missions: availableMissions }),
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

function SwitchHabitat() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/habitats/board-2")}>Switch Habitat</button>;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  qc.setQueryData(["habitats", "detail", "board-2"], { habitat: { ...habitat, id: "board-2", name: "Second Habitat" }, columns: [], missions: [{ ...missions[0], id: "m3", habitatId: "board-2", title: "Second Mission" }] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/habitats/board-1"]}>
        <SwitchHabitat />
        <Routes>
          <Route path="/habitats/:habitatId" element={<HabitatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Habitat Add Task publication", () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); recovering = false; availableMissions = missions; localStorage.setItem("orcy_token", "fixture-token"); setupFetch(); });
  afterEach(() => { cleanup(); localStorage.removeItem("orcy_token"); });
  it.each([false, true])("publishes through the mounted %s entry", async (isMobile) => {
    mobile = isMobile;
    renderPage();
    await screen.findByText("Integration Habitat");
    expect(screen.getByText("0/2 tasks")).toBeTruthy();
    if (mobile) fireEvent.click(screen.getByRole("button", { name: "Add Task" }));
    else fireEvent.keyDown(window, { key: "n" });
    const selector = await screen.findByLabelText("Mission *");
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New Task" } });
    const submit = screen.getByRole("button", { name: "Create Task" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    fireEvent.change(selector, { target: { value: "m1" } });
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1));
    const [url, options] = fetchMock.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(url).toBe("/api/missions/m1/task-publications");
    expect(options.headers.Authorization).toBe("Bearer fixture-token");
    expect(JSON.parse(options.body)).toMatchObject({ title: "New Task", priority: "medium", attemptKey: expect.any(String) });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("0/3 tasks");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/habitats/board-1").length).toBeGreaterThanOrEqual(2);
  });
  it("explains an empty Mission list and makes no write", async () => {
    mobile = false;
    availableMissions = [];
    renderPage();
    await screen.findByText("Integration Habitat");
    fireEvent.keyDown(window, { key: "n" });
    await screen.findByText("Create a Mission in this Habitat before adding a task.");
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New Task" } });
    expect((screen.getByRole("button", { name: "Create Task" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });
  it("locks the chosen Mission while a 202 attempt settles and closes only after readback", async () => {
    mobile = true;
    recovering = true;
    renderPage();
    await screen.findByText("Integration Habitat");
    fireEvent.click(screen.getByRole("button", { name: "Add Task" }));
    const selector = await screen.findByLabelText("Mission *") as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: "m1" } });
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New Task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Checking publication status…");
    expect(selector.disabled).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4000 });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/task-creation-attempts/a1")).toBe(true);
  });

  it("keeps the Mission and attempt key after an uncertain transport failure", async () => {
    mobile = false;
    const original = fetchMock.getMockImplementation()!;
    let first = true;
    fetchMock.mockImplementation((url: string | URL, options?: RequestInit) => {
      if (options?.method === "POST" && first) { first = false; return Promise.reject(new Error("Connection lost")); }
      return original(url, options);
    });
    renderPage();
    await screen.findByText("Integration Habitat");
    fireEvent.keyDown(window, { key: "n" });
    const selector = await screen.findByLabelText("Mission *") as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: "m1" } });
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New Task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Connection lost");
    expect(selector.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const writes = fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toBe(writes[1][0]);
    expect(JSON.parse(writes[0][1].body).attemptKey).toBe(JSON.parse(writes[1][1].body).attemptKey);
  });

  it("retires an ambiguous draft when switching to a cached Habitat", async () => {
    mobile = false;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string | URL, options?: RequestInit) => {
      if (options?.method === "POST") return Promise.reject(new Error("Connection lost"));
      return original(url, options);
    });
    renderPage();
    await screen.findByText("Integration Habitat");
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.change(await screen.findByLabelText("Mission *"), { target: { value: "m1" } });
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New Task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Switch Habitat" }));
    await screen.findByText("Second Habitat");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "n" });
    const selector = await screen.findByLabelText("Mission *") as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(screen.getByRole("option", { name: "Second Mission" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Alpha Mission" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("does not let a late A response close a newly opened B dialog", async () => {
    mobile = false;
    const original = fetchMock.getMockImplementation()!;
    let settle!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { settle = resolve; });
    fetchMock.mockImplementation((url: string | URL, options?: RequestInit) => options?.method === "POST" ? pending : original(url, options));
    renderPage();
    await screen.findByText("Integration Habitat");
    fireEvent.keyDown(window, { key: "n" });
    fireEvent.change(await screen.findByLabelText("Mission *"), { target: { value: "m1" } });
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "Old Task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Switch Habitat" }));
    await screen.findByText("Second Habitat");
    fireEvent.keyDown(window, { key: "n" });
    await screen.findByRole("option", { name: "Second Mission" });
    fireEvent.change(screen.getByPlaceholderText("Task title"), { target: { value: "New draft" } });
    await act(async () => settle(new Response(JSON.stringify({ outcome: "created", attemptId: "a1", taskId: "t1" }), { status: 201 })));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByPlaceholderText("Task title") as HTMLInputElement).value).toBe("New draft");
  });

});
