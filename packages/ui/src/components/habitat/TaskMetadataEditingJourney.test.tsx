import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { SessionStateProvider, useAccountSession } from "../../lib/sessionState.js";
import { useHabitatStore } from "../../store/habitatStore.js";
import { useModalStore } from "../../store/modalStore.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { useHabitatTasks, useMissionDetails } from "../../lib/useHabitatData.js";
import { notify } from "../../lib/toast.js";
import type { TaskDetailsData } from "../../lib/useTaskData.js";
import type { Task } from "../../types/index.js";
import { TaskDetailModal } from "./TaskDetailModal.js";
import { HabitatPage } from "./HabitatPage.js";

// The real HabitatPage is mounted for the Bulk Select journeys; only its heavy,
// fetch-heavy children and browser-only hooks are stubbed. The Bulk Select
// buttons themselves live in HabitatPage's own JSX and stay real.
const env = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../hooks/useSSE.js", () => ({ useSSE: vi.fn() }));
vi.mock("../../hooks/useSSENotifications.js", () => ({ useSSENotifications: vi.fn() }));
vi.mock("../../hooks/usePresence.js", () => ({ usePresence: vi.fn() }));
vi.mock("../../hooks/useMediaQuery.js", () => ({ useIsMobile: () => env.mobile }));
vi.mock("../../lib/toast.js", () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("./Habitat.js", () => ({ Habitat: () => <div data-testid="habitat" /> }));
vi.mock("./FilterBar.js", () => ({ FilterBar: () => <div data-testid="filter-bar" /> }));
vi.mock("./HabitatPulsePanel.js", () => ({ HabitatPulsePanel: () => null }));
vi.mock("./InsightsPanel.js", () => ({ InsightsPanel: () => null }));
vi.mock("./SkillPanel.js", () => ({ SkillPanel: () => null }));
vi.mock("./HealthScoreWidget.js", () => ({ HealthScoreWidget: () => null }));
vi.mock("./SprintSelector.js", () => ({ SprintSelector: () => null }));
vi.mock("./SprintPlanningPanel.js", () => ({ SprintPlanningPanel: () => null }));
vi.mock("./IntakeReviewPanel.js", () => ({ IntakeReviewPanel: () => null }));
vi.mock("./TaskTableView.js", () => ({ TaskTableView: () => null }));
vi.mock("./StatsModal.js", () => ({ StatsModal: () => null }));
vi.mock("./AgentPanel.js", () => ({ AgentPanel: () => null }));
vi.mock("./HabitatPresence.js", () => ({ HabitatPresence: () => null }));
vi.mock("./BulkActionBar.js", () => ({ BulkActionBar: () => null }));
vi.mock("./MobileNav.js", () => ({ MobileNav: () => null }));
vi.mock("../ui/HelpDrawer.js", () => ({
  HelpDrawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/HelpContent.js", () => ({ HelpContent: () => null }));
vi.mock("../layout/DrawerBridgeContext.js", () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
  DrawerBridgeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const IDENTITY_A = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const IDENTITY_OTHER = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";

type DetailsEnvelope = TaskDetailsData & {
  canEditMetadata?: boolean;
  metadataEditIdentity?: string;
};

/** T5's numbered-request store surface (requestClose/pending/requestSeq) is
 * absent from the pre-T5 store. Access it through this cast so the file
 * typechecks in RED while exercising the new contract; after T5 lands the
 * cast is still assignable. */
type NumberedModalStore = ReturnType<typeof useModalStore.getState> & {
  requestSeq: number;
  pending: { seq: number } | null;
  requestClose: () => Promise<boolean>;
};
function modalStore(): NumberedModalStore {
  return useModalStore.getState() as unknown as NumberedModalStore;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    missionId: "m-1",
    title: "Original title",
    description: "original description",
    priority: "medium",
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: "frontend",
    requiredCapabilities: [],
    status: "pending",
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: null,
    version: 7,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    labels: [],
    ...overrides,
  };
}

const taskA = makeTask();
const taskB = makeTask({ id: "t-2", title: "Task B", version: 3 });

function envelope(overrides: Partial<DetailsEnvelope> & { task?: Task } = {}): DetailsEnvelope {
  return {
    task: taskA,
    mission: {
      id: "m-1",
      title: "Mission One",
      description: "",
      acceptanceCriteria: "",
      priority: "medium",
      status: "in_progress",
      dueAt: null,
      slaMinutes: null,
    },
    siblingTasks: [],
    subtasks: [],
    pullRequests: [],
    pipelineEvents: [],
    events: [],
    comments: [],
    totalComments: 0,
    attachments: [],
    watchers: [],
    isWatching: false,
    dependencies: [],
    crossHabitatDependsOn: [],
    blockedBy: [],
    blocking: [],
    habitatContext: { name: "H2", columns: [] },
    canEditMetadata: true,
    metadataEditIdentity: IDENTITY_A,
    ...overrides,
  };
}

const envelopeB = envelope({ task: taskB, metadataEditIdentity: IDENTITY_OTHER });
const missionComposite = {
  mission: { id: "m-1", title: "Mission One", version: 1, progress: 0 },
  tasks: [taskA],
  events: [],
  progress: { completed: 0, total: 1, percentage: 0, byStatus: {} },
  dependencies: { dependsOn: [], blocks: [] },
};
const missionCompositeOther = {
  ...missionComposite,
  mission: { ...missionComposite.mission, id: "m-9", title: "Unrelated" },
};

type Call = { url: string; method: string; body: Record<string, unknown> | undefined; signal?: AbortSignal };
const calls: Call[] = [];
const fetchMock = vi.fn<typeof fetch>();
let detailsForA: DetailsEnvelope = envelope();
let detailsForB: DetailsEnvelope = envelopeB;
let patchResponse: () => Response = () => jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" });

interface Override {
  method: string;
  prefix: string;
  deliver: () => Promise<Response>;
  sticky?: boolean;
}
let overrides: Override[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function deferOnce(method: string, prefix: string) {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((yes) => {
    resolve = yes;
  });
  overrides.push({ method, prefix, deliver: () => promise });
  return { promise, resolve };
}
function holdRoute(method: string, prefix: string) {
  overrides.push({ method, prefix, deliver: () => new Promise<Response>(() => {}), sticky: true });
}
function failOnce(method: string, prefix: string, status: number, body: unknown) {
  overrides.push({ method, prefix, deliver: () => Promise.resolve(jsonResponse(body, status)) });
}
function rejectOnce(method: string, prefix: string) {
  overrides.push({ method, prefix, deliver: () => Promise.reject(new TypeError("network failed")) });
}
function patchCalls(): Call[] {
  return calls.filter((c) => c.method === "PATCH" && c.url === "/api/tasks/t-1/metadata");
}
function getCalls(urlPrefix: string): Call[] {
  return calls.filter((c) => c.method === "GET" && c.url.startsWith(urlPrefix));
}

function RetireSession() {
  const session = useAccountSession();
  return <button onClick={() => session.logout()}>Retire session</button>;
}
let activeClient: ReturnType<typeof useQueryClient> = undefined as never;
function ClientProbe() {
  activeClient = useQueryClient();
  return null;
}
/** Observers for the invalidation-set journey: the owning habitat's filtered
 * task list and the Mission composite must refetch after a save; the
 * unrelated habitat/mission families must not. */
function InvalidationObservers() {
  useHabitatTasks("h-2", { status: "pending" });
  useHabitatTasks("h-9");
  useMissionDetails("m-1");
  useMissionDetails("m-9");
  return null;
}
function wrapper(children: React.ReactNode, extra?: React.ReactNode) {
  return (
    <SessionStateProvider>
      <RetireSession />
      <ClientProbe />
      {extra}
      {children}
    </SessionStateProvider>
  );
}
let modalMounted = false;
function renderModal(extra?: React.ReactNode) {
  modalMounted = true;
  return render(wrapper(<TaskDetailModal />, extra));
}
async function openTaskA() {
  if (!modalMounted) renderModal();
  act(() => useModalStore.getState().openModal("t-1"));
  await screen.findByText("Original title");
}
async function enterEdit() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByLabelText("Description");
}
function descriptionField(): HTMLTextAreaElement {
  return screen.getByLabelText("Description") as HTMLTextAreaElement;
}
function titleField(): HTMLInputElement {
  return screen.getByLabelText("Title") as HTMLInputElement;
}
function priorityField(): HTMLSelectElement {
  return screen.getByLabelText("Priority") as HTMLSelectElement;
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}
/** Bulk Select stand-in mirroring the HabitatPage handler contract:
 * only mutate bulk mode when the close request was acknowledged. */
function bulkStandIn(): { bulk: { enabled: boolean }; run: () => Promise<void> } {
  const state = { enabled: false };
  return {
    bulk: state,
    run: async () => {
      const accepted = await modalStore().requestClose();
      if (!accepted) return;
      state.enabled = true;
    },
  };
}

beforeEach(() => {
  env.mobile = false;
  modalMounted = false;
  calls.length = 0;
  overrides = [];
  detailsForA = envelope();
  detailsForB = envelopeB;
  patchResponse = () => jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" });
  vi.clearAllMocks();
  useHabitatStore.setState(useHabitatStore.getInitialState(), true);
  useModalStore.getState().closeModal();
  localStorage.clear();
  localStorage.setItem("orcy_token", "alice-token");
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body, signal: init?.signal as AbortSignal | undefined });
    const overrideIndex = overrides.findIndex((o) => o.method === method && url.startsWith(o.prefix));
    if (overrideIndex >= 0) {
      const override = overrides[overrideIndex];
      if (!override.sticky) overrides.splice(overrideIndex, 1);
      return override.deliver();
    }
    if (method === "GET") {
      if (url.startsWith("/api/tasks/t-1/details")) return jsonResponse(detailsForA);
      if (url.startsWith("/api/tasks/t-2/details")) return jsonResponse(detailsForB);
      if (url.startsWith("/api/missions/m-1/tasks")) return jsonResponse({ tasks: [taskA], total: 1 });
      if (url.startsWith("/api/missions/m-9/tasks")) return jsonResponse({ tasks: [], total: 0 });
      if (url.startsWith("/api/missions/m-1/details")) return jsonResponse(missionComposite);
      if (url.startsWith("/api/missions/m-9/details")) return jsonResponse(missionCompositeOther);
      if (url.startsWith("/api/agents")) return jsonResponse({ agents: [] });
      if (url.startsWith("/api/habitats/h-2/tasks")) return jsonResponse({ tasks: [taskA], total: 1 });
      if (url.startsWith("/api/habitats/h-9/tasks")) return jsonResponse({ tasks: [], total: 0 });
      if (url.startsWith("/api/habitats/h-2"))
        return jsonResponse({ habitat: { id: "h-2", name: "H2", columns: [] }, columns: [], missions: [] });
    }
    if (method === "PATCH" && url === "/api/tasks/t-1/metadata") return patchResponse();
    return jsonResponse({ error: `no route for ${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Task metadata editing real modal/store/transport journeys", () => {
  // GROUND: T5 Step 1 read-mode default; PRD journey 1 + E9 (read-only by
  // default, no Edit without hint+token, Close instead of the placeholder Save).
  it("read mode shows Close with no Save and no Edit when the hint is absent", async () => {
    detailsForA = envelope({ canEditMetadata: false, metadataEditIdentity: undefined });
    await openTaskA();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep editing" })).toBeNull();
  });

  // GROUND: T5 Step 1 exact payload; PRD E5/E9 (diff-only save against the
  // captured baseline; expectedPriority only when priority is edited).
  it("description-only save sends exactly one PATCH with the diff-only payload", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    expect(patchCalls()[0].body).toEqual({
      expectedVersion: 7,
      expectedTaskIdentity: IDENTITY_A,
      description: "",
    });
  });

  // GROUND: T5 Step 1 priority variant; PRD E5 (expectedPriority required iff priority).
  it("priority edit carries priority plus expectedPriority, nothing else", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(priorityField(), { target: { value: "low" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    expect(patchCalls()[0].body).toEqual({
      expectedVersion: 7,
      expectedTaskIdentity: IDENTITY_A,
      priority: "low",
      expectedPriority: "medium",
    });
  });

  // GROUND: T5 Step 1 version-8 read mode; PRD E9/E10 (the save path alone
  // drives the read-mode return: the save response updates the presented Task
  // immediately — held details refetches cannot regress it). useSSE is mocked
  // in this file, so this journey pins the no-SSE-required save path, not
  // EventSource behavior itself.
  it("successful save returns the modal to version-8 read mode from the save path alone", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "changed" } });
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await screen.findByText("v8");
    expect(screen.queryByLabelText("Description")).toBeNull();
  });

  // GROUND: T5 Step 1 wrong-habitat owner invalidation; PRD E10 (filtered
  // habitat list + Mission composite refetched from the response's habitatId;
  // unrelated families untouched — asserted via the fetch call log).
  it("save invalidates the owning habitat list and Mission composite but not unrelated families", async () => {
    renderModal(<InvalidationObservers />);
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "changed" } });
    holdRoute("GET", "/api/tasks/t-1/details");
    const patchIndex = calls.length;
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    // Wait until the invalidation-driven refetch wave settles.
    await waitFor(() => {
      const after = calls.slice(patchIndex);
      expect(after.filter((c) => c.url.startsWith("/api/habitats/h-2/tasks")).length).toBeGreaterThan(0);
      expect(after.filter((c) => c.url.startsWith("/api/missions/m-1/details")).length).toBeGreaterThan(0);
      expect(after.filter((c) => c.url.startsWith("/api/missions/m-1/tasks")).length).toBeGreaterThan(0);
    });
    const after = calls.slice(patchIndex);
    expect(after.filter((c) => c.url.startsWith("/api/habitats/h-9")).length).toBe(0);
    expect(after.filter((c) => c.url.startsWith("/api/missions/m-9")).length).toBe(0);
  });

  // GROUND: T5 Step 4 disabled-when-unchanged; PRD E9 (synchronous latch gates Save).
  it("Save is disabled while the draft is unchanged and enabled once edited", async () => {
    await openTaskA();
    await enterEdit();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    fireEvent.change(descriptionField(), { target: { value: "changed" } });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  // GROUND: T5 Step 1 Cancel journey; PRD journey 3 (Cancel discards immediately, never writes).
  it("Cancel restores the read view with no mutation", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "draft text" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("original description");
    expect(screen.queryByLabelText("Description")).toBeNull();
    expect(patchCalls().length).toBe(0);
  });

  // GROUND: T5 Step 1 confirmation matrix; PRD journey 3 (every close path with
  // a dirty draft goes through one confirmation; Discard never writes).
  it("Escape, backdrop, and header Close each confirm while dirty; Keep editing preserves the draft", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    for (const trigger of [
      () => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("dialog")),
      () => fireEvent.click(screen.getByLabelText("Close modal")),
    ]) {
      trigger();
      fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
      expect(descriptionField().value).toBe("dirty draft");
      expect(useModalStore.getState().isOpen).toBe(true);
    }
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useModalStore.getState().isOpen).toBe(false));
    expect(patchCalls().length).toBe(0);
  });

  // GROUND: T5 Step 1 switch journey; PRD E9 (a dirty switch retains the
  // presented selection until acknowledged; B's async load cannot unmount A's
  // dirty draft during the confirmation; Discard applies once).
  it("openModal(B) with a dirty draft confirms first; Keep keeps A dirty, Discard presents B once", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    const bLoad = deferOnce("GET", "/api/tasks/t-2/details");
    act(() => useModalStore.getState().openModal("t-2"));
    // B's load is in flight; A's dirty draft must still be presented.
    expect(descriptionField().value).toBe("dirty draft");
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(useModalStore.getState().selectedTaskId).toBe("t-1");
    expect(descriptionField().value).toBe("dirty draft");
    act(() => useModalStore.getState().openModal("t-2"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await act(async () => {
      bLoad.resolve(jsonResponse(detailsForB));
    });
    await screen.findByText("Task B");
    expect(useModalStore.getState().selectedTaskId).toBe("t-2");
    expect(useModalStore.getState().isOpen).toBe(true);
    expect(patchCalls().length).toBe(0);
  });

  // GROUND: T5 Step 6 desktop Bulk Select; PRD E9 (external close callers are
  // gated by the acknowledged requestClose; bulk mode changes only after it).
  it("desktop Bulk Select changes bulk mode only after the dirty draft is acknowledged", async () => {
    render(
      wrapper(
        <>
          <MemoryRouter initialEntries={["/habitats/h-2"]}>
            <Routes>
              <Route path="/habitats/:habitatId" element={<HabitatPage />} />
            </Routes>
          </MemoryRouter>
          <TaskDetailModal />
        </>,
      ),
    );
    await screen.findByRole("button", { name: "Bulk Select" });
    modalMounted = true;
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Bulk Select" }));
    await screen.findByRole("button", { name: "Keep editing" });
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);
    expect(descriptionField().value).toBe("dirty draft");
    fireEvent.click(screen.getByRole("button", { name: "Bulk Select" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useHabitatStore.getState().isBulkSelectMode).toBe(true));
    expect(useHabitatStore.getState().selectionHabitatId).toBe("h-2");
    await waitFor(() => expect(useModalStore.getState().isOpen).toBe(false));
  });

  // GROUND: T5 Step 6 mobile Bulk Select; PRD E9 (mobile menu and bulk mode
  // change only after acknowledgement).
  it("mobile Bulk Select keeps the menu open on Keep editing and engages after Discard", async () => {
    env.mobile = true;
    render(
      wrapper(
        <>
          <MemoryRouter initialEntries={["/habitats/h-2"]}>
            <Routes>
              <Route path="/habitats/:habitatId" element={<HabitatPage />} />
            </Routes>
          </MemoryRouter>
          <TaskDetailModal />
        </>,
      ),
    );
    const menuButton = await waitFor(() => {
      const button = screen
        .getAllByRole("button")
        .find((b) => b.querySelector(".lucide-menu")) as HTMLButtonElement;
      expect(button).toBeTruthy();
      return button;
    });
    modalMounted = true;
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    fireEvent.click(menuButton);
    fireEvent.click(await screen.findByRole("button", { name: "Bulk Select" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(useHabitatStore.getState().isBulkSelectMode).toBe(false);
    expect(screen.getByRole("button", { name: "Bulk Select" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bulk Select" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useHabitatStore.getState().isBulkSelectMode).toBe(true));
  });

  // GROUND: T5 Step 1 refetch-with-dirty-draft; PRD E9 (refetches never replace
  // the draft or advance the opening baseline).
  it("a dirty draft keeps its version-7 baseline across a details refetch", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(titleField(), { target: { value: "Edited title" } });
    detailsForA = envelope({ task: makeTask({ version: 9, title: "Server title" }) });
    await act(async () => {
      await activeClient.invalidateQueries({ queryKey: queryKeys.tasks.details("t-1") });
    });
    expect(titleField().value).toBe("Edited title");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    expect(patchCalls()[0].body).toEqual({
      expectedVersion: 7,
      expectedTaskIdentity: IDENTITY_A,
      title: "Edited title",
    });
  });

  // GROUND: T5 Step 4 structured 409 branch a; PRD E10 (VERSION_CONFLICT shows
  // a distinct discard-and-reload outcome).
  it("VERSION_CONFLICT offers Discard and reload with the draft still copyable", async () => {
    failOnce("PATCH", "/api/tasks/t-1/metadata", 409, {
      error: "Version conflict",
      code: "VERSION_CONFLICT",
      currentVersion: 8,
    });
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "conflicted draft" } });
    save();
    await screen.findByRole("button", { name: "Discard and reload" });
    expect(descriptionField().value).toBe("conflicted draft");
    // GROUND: PRD E10/TASKS T5 Step 1 — no retry without an explicit reload:
    // Save stays blocked until the user discards and reloads a fresh baseline.
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  // GROUND: T5 Step 4 structured 409 branch b; PRD E10 (TASK_METADATA_NOT_EDITABLE
  // is a distinct outcome from VERSION_CONFLICT: blocked save, no reload offer).
  it("TASK_METADATA_NOT_EDITABLE blocks Save with distinct copy, not the reload offer", async () => {
    failOnce("PATCH", "/api/tasks/t-1/metadata", 409, {
      error: "Task metadata is no longer editable",
      code: "TASK_METADATA_NOT_EDITABLE",
    });
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "blocked draft" } });
    save();
    await screen.findByText(/no longer editable/i);
    expect(screen.queryByRole("button", { name: "Discard and reload" })).toBeNull();
    expect(descriptionField().value).toBe("blocked draft");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  // GROUND: T5 Step 1 unknown transport outcome; PRD E10 (refresh-and-compare
  // before another attempt; original baseline kept; no auto-retry).
  it("an unknown transport outcome gates retry behind a refresh and keeps the version-7 baseline", async () => {
    rejectOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "transport draft" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await screen.findByText(/refresh/i);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    save();
    await act(async () => {
      await Promise.resolve();
    });
    expect(patchCalls().length).toBe(1);
    // The editor itself must trigger the fresh read (PRD E10: "a transport
    // error of unknown outcome refreshes before allowing another attempt") —
    // no external actor invalidates the query, and staleTime alone would
    // never produce the required fresh dataUpdatedAt.
    detailsForA = envelope({ task: makeTask({ version: 8, description: "server state" }) });
    await waitFor(() => expect(getCalls("/api/tasks/t-1/details").length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
    save();
    await waitFor(() => expect(patchCalls().length).toBe(2));
    expect(patchCalls()[1].body).toEqual({
      expectedVersion: 7,
      expectedTaskIdentity: IDENTITY_A,
      description: "transport draft",
    });
  });

  // GROUND: review round 2 — the unknown-outcome gate must also open when the
  // editor-driven refetch returns DEEP-EQUAL data: structural sharing keeps the
  // same data reference, so no observer notification re-renders the editor and
  // the non-reactive refreshReady read would stay frozen without an explicit
  // re-evaluation once the fresh read settles.
  it("an unknown outcome re-enables Save even when the editor refetch returns equal data", async () => {
    rejectOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "transport draft" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await screen.findByText(/refresh/i);
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    // detailsForA is NOT swapped: the refetch returns the identical envelope.
    await waitFor(() => expect(getCalls("/api/tasks/t-1/details").length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled());
    save();
    await waitFor(() => expect(patchCalls().length).toBe(2));
    expect(patchCalls()[1].body).toEqual({
      expectedVersion: 7,
      expectedTaskIdentity: IDENTITY_A,
      description: "transport draft",
    });
  });

  // GROUND: T5 Step 1 refusal codes; PRD E10/Step 4 (401/403/404 block Save with
  // the draft left copyable).
  it.each([401, 403, 404])("a %d metadata failure blocks Save and keeps the draft copyable", async (status) => {
    failOnce("PATCH", "/api/tasks/t-1/metadata", status, { error: `HTTP ${status}` });
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "refused draft" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(descriptionField().value).toBe("refused draft");
  });

  // GROUND: review round 1 — PRD E9 ("Discard applies the intended
  // close/replacement once", discarding the draft): a same-ID switch
  // confirmation resolved as Discard must exit Edit mode even though the
  // presented Task ID never changed, so no selectedTaskId effect can clear it.
  it("Discard on a same-ID switch confirmation exits edit mode", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    act(() => useModalStore.getState().openModal("t-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByLabelText("Description")).toBeNull());
    expect(screen.getByText("Original title")).toBeTruthy();
  });

  // GROUND: T5 Step 4 synchronous in-flight latch; PRD E9 (double-Save issues one request).
  it("double-Save issues exactly one PATCH", async () => {
    const held = deferOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "once only" } });
    save();
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await act(async () => {
      held.resolve(jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" }));
    });
    await waitFor(() => expect(patchCalls().length).toBe(1));
  });

  // GROUND: T5 Step 5 delayed-close fence; PRD E9 (a stale 200 ms timer cannot
  // close a replacement presentation opened inside the delay).
  it("a delayed close timer cannot close a reopened presentation", async () => {
    await openTaskA();
    let finishAnimation!: () => void;
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 200) {
        finishAnimation = callback;
        return 0;
      }
      return schedule(callback, delay, ...args);
    }) as typeof setTimeout);
    fireEvent.click(screen.getByLabelText("Close modal"));
    expect(finishAnimation).toBeTypeOf("function");
    act(() => {
      useModalStore.getState().openModal("t-2");
      useModalStore.getState().openModal("t-1");
    });
    act(() => finishAnimation());
    expect(useModalStore.getState().isOpen).toBe(true);
    expect(useModalStore.getState().selectedTaskId).toBe("t-1");
  });

  // GROUND: T5 Step 4 retirement fence; PRD E9 (a save settling after account
  // retirement touches no toast, cache work, or close of a later account).
  // The later account's own remount bootstrap (e.g. the agents list) is not
  // the save continuation; only task-detail traffic and PATCHes prove leakage.
  it("retirement during save performs no toast, cache work, or close afterwards", async () => {
    renderModal();
    const held = deferOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "retired draft" } });
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    const aliceClient = activeClient;
    const callsAtRetirement = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retire session" }));
    await waitFor(() => expect(useModalStore.getState().isOpen).toBe(false));
    await act(async () => {
      held.resolve(jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" }));
    });
    expect(notify.success).not.toHaveBeenCalled();
    const afterRetirement = calls.slice(callsAtRetirement);
    expect(afterRetirement.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(afterRetirement.filter((c) => c.url.includes("/api/tasks/t-1"))).toEqual([]);
    expect(aliceClient.getQueryData(queryKeys.tasks.details("t-1"))).toBeUndefined();
    expect(activeClient).not.toBe(aliceClient);
    expect(activeClient.getQueryData(queryKeys.tasks.details("t-1"))).toBeUndefined();
  });

  // GROUND: T5 Step 4 cancelQueries + Step 7 signal forward; PRD E10/ADR-0040
  // (a delayed old read is aborted on success and cannot regress the UI).
  it("aborts in-flight detail reads on save and ignores the delayed old read", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "patched" } });
    const staleRead = deferOnce("GET", "/api/tasks/t-1/details");
    act(() => {
      void activeClient.invalidateQueries({ queryKey: queryKeys.tasks.details("t-1") });
    });
    await waitFor(() => expect(getCalls("/api/tasks/t-1/details").length).toBeGreaterThan(1));
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await waitFor(() => {
      const signals = getCalls("/api/tasks/t-1/details").map((c) => c.signal);
      expect(signals.some((signal) => signal?.aborted)).toBe(true);
    });
    await act(async () => {
      staleRead.resolve(jsonResponse(envelope({ task: makeTask({ version: 6 }) })));
    });
    await screen.findByText("v8");
    const cached = activeClient.getQueryData<DetailsEnvelope>(queryKeys.tasks.details("t-1"));
    expect(cached?.task.version).toBe(8);
  });

  // GROUND: T5 Step 4 cache patch rule (strictly older, same identity);
  // PRD E10 (matching older envelopes are patched and their hint cleared).
  it("patches a matching older envelope and clears its hint", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "patched" } });
    const older = envelope({ task: makeTask({ version: 6 }) });
    act(() => {
      activeClient.setQueryData(queryKeys.tasks.details("t-1"), older);
    });
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => {
      const cached = activeClient.getQueryData<DetailsEnvelope>(queryKeys.tasks.details("t-1"));
      expect(cached?.task.version).toBe(8);
      expect(cached?.canEditMetadata).toBeFalsy();
      expect(cached?.metadataEditIdentity).toBeUndefined();
    });
  });

  // GROUND: T5 Step 4 cache patch rule; PRD E10 (cached newer-version envelopes preserved).
  it("preserves a cached newer-version envelope", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "stale edit" } });
    const newer = envelope({ task: makeTask({ version: 9 }) });
    act(() => {
      activeClient.setQueryData(queryKeys.tasks.details("t-1"), newer);
    });
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    const cached = activeClient.getQueryData<DetailsEnvelope>(queryKeys.tasks.details("t-1"));
    expect(cached?.task.version).toBe(9);
  });

  // GROUND: T5 Step 4 cache patch rule; PRD E10 (same-version envelopes with
  // different values preserved — prioritization can refetch at the same version).
  it("preserves a same-version envelope whose priority differs", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "same version" } });
    const sameVersion = envelope({ task: makeTask({ version: 8, priority: "low" }) });
    act(() => {
      activeClient.setQueryData(queryKeys.tasks.details("t-1"), sameVersion);
    });
    holdRoute("GET", "/api/tasks/t-1/details");
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await act(async () => {
      await Promise.resolve();
    });
    const cached = activeClient.getQueryData<DetailsEnvelope>(queryKeys.tasks.details("t-1"));
    expect(cached?.task.version).toBe(8);
    expect(cached?.task.priority).toBe("low");
  });

  // GROUND: T5 Step 4 cache patch rule; PRD E10/journey 5 (different-identity
  // envelopes are preserved and refreshed, never patched across incarnations).
  it("preserves a different-incarnation envelope and refetches it", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "other incarnation" } });
    const otherIncarnation = envelope({ task: makeTask({ version: 7 }), metadataEditIdentity: IDENTITY_OTHER });
    act(() => {
      activeClient.setQueryData(queryKeys.tasks.details("t-1"), otherIncarnation);
    });
    holdRoute("GET", "/api/tasks/t-1/details");
    const patchIndex = calls.length;
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    await waitFor(() =>
      expect(
        calls.slice(patchIndex).some((c) => c.method === "GET" && c.url.startsWith("/api/tasks/t-1/details")),
      ).toBe(true),
    );
    const cached = activeClient.getQueryData<DetailsEnvelope>(queryKeys.tasks.details("t-1"));
    expect(cached?.metadataEditIdentity).toBe(IDENTITY_OTHER);
    expect(cached?.task.version).toBe(7);
  });

  // GROUND: T5 Step 3 requestClose semantics; PRD E9 (a superseded request
  // resolves false the moment a second request supersedes it; the newer
  // request stays the acknowledged one).
  it("a superseded requestClose resolves false and the newer request stays acknowledged", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    const standIn = bulkStandIn();
    const supersededRun = standIn.run();
    const newer = modalStore().requestClose();
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await supersededRun;
    expect(standIn.bulk.enabled).toBe(false);
    await expect(newer).resolves.toBe(true);
    await waitFor(() => expect(useModalStore.getState().isOpen).toBe(false));
  });

  // GROUND: T5 Step 3 openModal supersession; PRD E9 (a pending dirty close
  // superseded by openModal(B) resolves false, clears the pending record, and
  // its stale confirmation cannot close B).
  it("openModal(B) supersedes a pending dirty close whose stale confirmation cannot close B", async () => {
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "dirty draft" } });
    const pending = modalStore().requestClose();
    const discardButton = await screen.findByRole("button", { name: "Discard" });
    act(() => useModalStore.getState().openModal("t-2"));
    await expect(pending).resolves.toBe(false);
    expect(modalStore().pending).toBeNull();
    fireEvent.click(discardButton);
    expect(useModalStore.getState().isOpen).toBe(true);
    expect(useModalStore.getState().selectedTaskId).toBe("t-2");
  });

  // GROUND: T5 Step 5 guarded switch during save; PRD E9 (openModal(B) during
  // save is rejected synchronously; no replay after settlement; a fresh later
  // switch works).
  it("openModal(B) during save leaves A presented and does not replay B after settlement", async () => {
    const held = deferOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "saving draft" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    const seqBefore = modalStore().requestSeq;
    act(() => useModalStore.getState().openModal("t-2"));
    expect(useModalStore.getState().selectedTaskId).toBe("t-1");
    expect(useModalStore.getState().isOpen).toBe(true);
    expect(modalStore().requestSeq).toBe(seqBefore);
    holdRoute("GET", "/api/tasks/t-1/details");
    await act(async () => {
      held.resolve(jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" }));
    });
    await screen.findByText("v8");
    expect(useModalStore.getState().selectedTaskId).toBe("t-1");
    act(() => useModalStore.getState().openModal("t-2"));
    expect(useModalStore.getState().selectedTaskId).toBe("t-2");
    await screen.findByText("Task B");
  });

  // GROUND: T5 Step 5 saves-in-flight close rule; PRD E9 (a requestClose while
  // a save is in flight resolves false immediately; the awaiting external
  // handler returns without changing bulk mode; the save completes untouched).
  it("a requestClose during save resolves false immediately and the save completes untouched", async () => {
    const held = deferOnce("PATCH", "/api/tasks/t-1/metadata");
    await openTaskA();
    await enterEdit();
    fireEvent.change(descriptionField(), { target: { value: "in-flight draft" } });
    save();
    await waitFor(() => expect(patchCalls().length).toBe(1));
    const standIn = bulkStandIn();
    const run = standIn.run();
    await expect(modalStore().requestClose()).resolves.toBe(false);
    await run;
    expect(standIn.bulk.enabled).toBe(false);
    expect(modalStore().pending).toBeNull();
    holdRoute("GET", "/api/tasks/t-1/details");
    await act(async () => {
      held.resolve(jsonResponse({ task: makeTask({ version: 8 }), habitatId: "h-2" }));
    });
    await screen.findByText("v8");
    expect(useModalStore.getState().isOpen).toBe(true);
    expect(patchCalls().length).toBe(1);
  });
});

// GROUND: review round 1 — store-level request lifecycle invariants that the
// rendered journeys cannot observe directly (promise settlement and
// superseded-intent state).
describe("modal store request lifecycle", () => {
  function settled(promise: Promise<boolean>): Promise<boolean | "pending"> {
    return Promise.race([
      promise.then((value: boolean) => value),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
  }
  beforeEach(() => {
    useModalStore.getState().closeModal();
    act(() => {
      useModalStore.setState({ isOpen: true, selectedTaskId: "t-1" });
      useModalStore.getState().setDraftStatus({ dirty: true, saving: false });
    });
  });
  afterEach(() => {
    useModalStore.getState().closeModal();
    useModalStore.getState().setDraftStatus(null);
  });

  // A close request superseded by the draft becoming clean must settle false —
  // an awaiting caller (Bulk Select) can never be left hanging.
  it("settles a superseded pending close false when the draft becomes clean", async () => {
    const first = modalStore().requestClose();
    act(() => useModalStore.getState().setDraftStatus({ dirty: false, saving: false }));
    const second = modalStore().requestClose();
    expect(await settled(first)).toBe(false);
    expect(await settled(second)).toBe(true);
  });

  // A close request landing during a switch confirmation must clear the stale
  // switch intent so the dialog and the resolved action cannot diverge.
  it("clears a pending switch intent when a close request supersedes it", async () => {
    act(() => useModalStore.getState().openModal("t-2"));
    const raw = useModalStore.getState() as unknown as { switchIntent: unknown };
    expect(raw.switchIntent).toBeTruthy();
    const close = modalStore().requestClose();
    expect((useModalStore.getState() as unknown as { switchIntent: unknown }).switchIntent).toBeNull();
    expect(await settled(close)).toBe("pending"); // dirty: awaits the user's confirmation
  });
});
