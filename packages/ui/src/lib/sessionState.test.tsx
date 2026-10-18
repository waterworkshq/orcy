import React from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, Link } from "react-router-dom";
import { useHabitatStore } from "../store/habitatStore.js";
import { useModalStore } from "../store/modalStore.js";
import { TaskDetailModal } from "../components/habitat/TaskDetailModal.js";
import { BulkActionBar } from "../components/habitat/BulkActionBar.js";
import { TaskBulkActionBar } from "../components/habitat/TaskBulkActionBar.js";
import { AuthPage } from "../components/auth/AuthPage.js";
import { TopAppBar } from "../components/layout/TopAppBar.js";
import { queryKeys } from "./queryKeys.js";
import { useSSE } from "../hooks/useSSE.js";
import { useSSENotifications } from "../hooks/useSSENotifications.js";
import { SessionStateProvider, useAccountSession } from "./sessionState.js";
import { useHabitats, useUpdateMission } from "./useHabitatData.js";
const apiMock = vi.hoisted(() => ({ list: vi.fn(), login: vi.fn(), register: vi.fn(), logout: vi.fn(), update: vi.fn(), setupStatus: vi.fn(), batch: vi.fn(), habitat: vi.fn(), details: vi.fn() }));
vi.mock("../api/index.js", () => ({ api: {
  auth: { setupStatus: apiMock.setupStatus, login: apiMock.login, register: apiMock.register, logout: apiMock.logout },
  habitats: { list: apiMock.list, get: apiMock.habitat }, missions: { update: apiMock.update }, tasks: { batch: apiMock.batch, details: apiMock.details }, agents: { list: vi.fn(async () => []) },
} }));
let showMissionBulk = false;
let showStream = false;
let showModal = false;
let deliverDuringBoundary = () => {};
function BoundaryProbe() {
  const session = useAccountSession();
  return <button onClick={() => { session.logout(); deliverDuringBoundary(); }}>Retire and deliver queued event</button>;
}
let activeClient: QueryClient;
let pendingMutation: Promise<unknown>;
function ClientProbe() { activeClient = useQueryClient(); return null; }
function Stream() { useSSE("h"); useSSENotifications(); return null; }
function MutationTrigger() {
  const mutation = useUpdateMission("m", "h");
  return <button onClick={() => { pendingMutation = mutation.mutateAsync({ title: "Alice edit" }); }}>Update mission</button>;
}
function Home() {
  const { data } = useHabitats();
  return <>{showModal && <TaskDetailModal />}{showStream && <Stream />}<MutationTrigger /><TopAppBar /><TaskBulkActionBar habitatId="h" />{showMissionBulk && <section data-testid="mission-bulk"><BulkActionBar habitatId="h" /></section>}<div>{data?.map((h) => h.name).join(",")}</div><Link to="/login">Change account</Link></>;
}
function renderSession() {
  return render(<MemoryRouter><Link to="/">Workspace</Link><SessionStateProvider><ClientProbe /><BoundaryProbe /><Routes>
    <Route path="/" element={<Home />} /><Route path="/login" element={<AuthPage />} />
  </Routes></SessionStateProvider></MemoryRouter>);
}
async function signIn() {
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "bob" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
}
async function logout() {
  fireEvent.click(screen.getByRole("button", { name: "User menu" }));
  fireEvent.click(screen.getByTestId("user-menu-logout"));
  await screen.findByLabelText("Username");
}
beforeEach(() => {
  vi.resetAllMocks(); showMissionBulk = false; showStream = false; showModal = false;
  useHabitatStore.setState(useHabitatStore.getInitialState(), true);
  useModalStore.getState().closeModal();
  apiMock.habitat.mockResolvedValue({ habitat: { id: "h" }, columns: [], missions: [{ id: "m", title: "Mission", version: 1, progress: 0 }] });
  localStorage.clear(); localStorage.setItem("orcy_token", "alice-token");
  apiMock.setupStatus.mockResolvedValue({ needsSetup: false });
  apiMock.logout.mockResolvedValue({ success: true });
  apiMock.login.mockResolvedValue({ token: "bob-token" });
  apiMock.list.mockImplementation(async () => [{ id: "h", name: `${localStorage.getItem("orcy_token")} habitat` }]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("fetches Bob's habitats after actual logout and login without rendering Alice's fresh cache", async () => {
  renderSession(); await screen.findByText("alice-token habitat"); await logout(); await signIn();
  await screen.findByText("bob-token habitat");
  expect(screen.queryByText("alice-token habitat")).toBeNull();
  expect(apiMock.list).toHaveBeenCalledTimes(2);
});

it("retires account projections and modal while retaining theme", async () => {
  useHabitatStore.setState({
    theme: "dark", selectedMissionId: "alice-mission", selectedMissionIds: ["alice-mission"],
    selectedTaskIds: ["alice-task"], selectionHabitatId: "h", isBulkSelectMode: true,
    isTaskBulkSelectMode: true, isLoading: true, error: "Alice error", collapsedColumns: { alice: true },
    presence: [{ sessionId: "alice" }] as never, wipAlerts: { alice: { limit: 1, timestamp: 1 } },
    notifications: [{ id: "alice" }] as never, recentSSEEvents: [{ type: "alice" }] as never,
  });
  useModalStore.getState().openModal("alice-task");
  renderSession(); await screen.findByText("alice-token habitat"); await logout();
  const data = (state: object) => Object.fromEntries(Object.entries(state).filter(([, value]) => typeof value !== "function"));
  expect(data(useHabitatStore.getState())).toEqual({ ...data(useHabitatStore.getInitialState()), theme: "dark" });
  expect(useModalStore.getState().isOpen).toBe(false);
  expect(useModalStore.getState().selectedTaskId).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
it("completes local logout immediately and an old server failure cannot remove Bob's credential", async () => {
  const request = deferred<{ success: boolean }>();
  let logoutCredential: string | null = null;
  apiMock.logout.mockImplementation(() => { logoutCredential = localStorage.getItem("orcy_token"); return request.promise; });
  renderSession(); await screen.findByText("alice-token habitat");
  await logout();
  expect(localStorage.getItem("orcy_token")).toBeNull();
  expect(logoutCredential).toBe("alice-token");
  await signIn(); await screen.findByText("bob-token habitat");
  await act(async () => { request.reject(new Error("server unavailable")); });
  expect(localStorage.getItem("orcy_token")).toBe("bob-token");
  expect(screen.getByText("bob-token habitat")).toBeTruthy();
});
it("ignores an older login after logout and a newer successful login", async () => {
  const oldLogin = deferred<{ token: string }>();
  apiMock.login.mockReturnValueOnce(oldLogin.promise).mockResolvedValueOnce({ token: "charlie-token" });
  renderSession(); await screen.findByText("alice-token habitat");
  fireEvent.click(screen.getByText("Change account")); await signIn();
  await waitFor(() => expect(apiMock.login).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("Workspace"));
  await screen.findByText("alice-token habitat"); await logout(); await signIn();
  await screen.findByText("charlie-token habitat");
  await act(async () => { oldLogin.resolve({ token: "bob-token" }); });
  expect(localStorage.getItem("orcy_token")).toBe("charlie-token");
  expect(screen.getByText("charlie-token habitat")).toBeTruthy();
});
it("does not let Alice's late batch callback clear Bob's task selection", async () => {
  const batch = deferred<{ successCount: number; failureCount: number }>();
  apiMock.batch.mockReturnValue(batch.promise);
  useHabitatStore.setState({ selectedTaskIds: ["alice-task"], isTaskBulkSelectMode: true });
  renderSession(); await screen.findByText("alice-token habitat");
  fireEvent.click(screen.getByTestId("bulk-apply"));
  expect(apiMock.batch).toHaveBeenCalledWith("h", { taskIds: ["alice-task"], operation: "priority", payload: { priority: "medium" } });
  await logout(); await signIn(); await screen.findByText("bob-token habitat");
  act(() => { useHabitatStore.setState({ selectedTaskIds: ["bob-task"], isTaskBulkSelectMode: true }); });
  await act(async () => { batch.resolve({ successCount: 1, failureCount: 0 }); });
  expect(useHabitatStore.getState().selectedTaskIds).toEqual(["bob-task"]);
  expect(useHabitatStore.getState().isTaskBulkSelectMode).toBe(true);
});
it("does not let Alice's late mission batch callback clear Bob's mission selection", async () => {
  const update = deferred<{ mission: { id: string; title: string; version: number } }>();
  apiMock.update.mockReturnValue(update.promise); showMissionBulk = true;
  useHabitatStore.setState({ selectedMissionIds: ["m"], selectionHabitatId: "h", isBulkSelectMode: true });
  renderSession(); await screen.findByText("alice-token habitat");
  const button = within(screen.getByTestId("mission-bulk")).getByRole("button", { name: "Apply" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); await waitFor(() => expect(apiMock.update).toHaveBeenCalledTimes(1));
  await logout(); await signIn(); await screen.findByText("bob-token habitat");
  act(() => { useHabitatStore.setState({ selectedMissionIds: ["m"], selectionHabitatId: "h", isBulkSelectMode: true }); });
  await act(async () => { update.resolve({ mission: { id: "m", title: "Alice update", version: 2 } }); });
  expect(useHabitatStore.getState().selectedMissionIds).toEqual(["m"]);
  expect(useHabitatStore.getState().isBulkSelectMode).toBe(true);
});

it.each([false, true])("retires a delayed Alice query (abort-aware=%s) before Bob loads", async (abortAware) => {
  const oldResponse = deferred<{ id: string; name: string }[]>();
  let oldSignal: AbortSignal | undefined;
  apiMock.list.mockImplementationOnce((signal: AbortSignal) => {
    oldSignal = signal;
    if (abortAware) signal.addEventListener("abort", () => oldResponse.reject(new DOMException("Aborted", "AbortError")));
    return oldResponse.promise;
  });
  renderSession(); await waitFor(() => expect(apiMock.list).toHaveBeenCalledTimes(1));
  await logout(); expect(oldSignal?.aborted).toBe(true);
  await signIn(); await screen.findByText("bob-token habitat");
  await act(async () => { oldResponse.resolve([{ id: "h", name: "Alice delayed" }]); });
  expect(activeClient.getQueryData(queryKeys.habitats.list())).toEqual([{ id: "h", name: "bob-token habitat" }]);
  expect(screen.queryByText("Alice delayed")).toBeNull();
  expect(apiMock.list).toHaveBeenCalledTimes(2);
});

it("keeps an actual late useUpdateMission callback attached to Alice's retired cache", async () => {
  const response = deferred<{ mission: { id: string; title: string; version: number } }>();
  apiMock.update.mockReturnValue(response.promise);
  renderSession(); await screen.findByText("alice-token habitat");
  const aliceClient = activeClient;
  fireEvent.click(screen.getByRole("button", { name: "Update mission" }));
  await waitFor(() => expect(apiMock.update).toHaveBeenCalledTimes(1));
  await logout(); await signIn(); await screen.findByText("bob-token habitat");
  const bobClient = activeClient;
  const bobDetail = { habitat: { id: "h" }, columns: [], missions: [{ id: "m", title: "Bob loaded", version: 1, progress: 0 }] };
  act(() => { bobClient.setQueryData(queryKeys.habitats.detail("h"), bobDetail); });
  await act(async () => { response.resolve({ mission: { id: "m", title: "Alice late response", version: 2 } }); await pendingMutation; });
  expect(bobClient).not.toBe(aliceClient);
  expect(bobClient.getQueryData(queryKeys.habitats.detail("h"))).toEqual(bobDetail);
  expect(aliceClient.getQueryData(queryKeys.habitats.detail("h"))).toBeUndefined();
});

it("retires profile, team, reviewer and detail keys on direct account replacement", async () => {
  renderSession(); await screen.findByText("alice-token habitat");
  const aliceClient = activeClient;
  const keys = [queryKeys.user.profile(), queryKeys.teams.myTeams(), queryKeys.tasks.reviewers("t"), queryKeys.tasks.details("t")];
  act(() => { keys.forEach((key) => aliceClient.setQueryData(key, "Alice private data")); });
  fireEvent.click(screen.getByText("Change account")); await signIn(); await screen.findByText("bob-token habitat");
  keys.forEach((key) => {
    expect(activeClient.getQueryData(key)).toBeUndefined();
    expect(aliceClient.getQueryData(key)).toBeUndefined();
  });
  expect(apiMock.list).toHaveBeenCalledTimes(2);
});

it("retires the previous account on successful registration", async () => {
  apiMock.setupStatus.mockResolvedValue({ needsSetup: true });
  apiMock.register.mockResolvedValue({ token: "new-account-token" });
  renderSession(); await screen.findByText("alice-token habitat");
  fireEvent.click(screen.getByText("Change account"));
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "new-user" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
  await screen.findByText("new-account-token habitat");
  expect(apiMock.register).toHaveBeenCalledWith({ username: "new-user", password: "password123", displayName: undefined });
  expect(apiMock.list).toHaveBeenCalledTimes(2);
});

it("aborts a pending SSE token fetch at logout and ignores its late response", async () => {
  showStream = true;
  const tokenResponse = deferred<{ ok: boolean; json: () => Promise<{ token: string }> }>();
  const fetchMock = vi.fn().mockReturnValue(tokenResponse.promise);
  const source = vi.fn(); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("EventSource", source);
  renderSession(); await screen.findByText("alice-token habitat");
  const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
  await logout(); expect(signal.aborted).toBe(true);
  await act(async () => { tokenResponse.resolve({ ok: true, json: async () => ({ token: "alice-stream" }) }); });
  expect(source).not.toHaveBeenCalled();
  expect(useHabitatStore.getState().recentSSEEvents).toEqual([]);
  expect(useHabitatStore.getState().notifications).toEqual([]);
});

it("closes an active SSE stream on account replacement and ignores queued old messages", async () => {
  showStream = true;
  const sources: { close: ReturnType<typeof vi.fn>; deliver: (data: string) => void }[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ token: "stream" }) })));
  vi.stubGlobal("EventSource", class {
    handlers: Record<string, (event: { data: string }) => void> = {};
    close = vi.fn();
    constructor() { sources.push(this); }
    addEventListener(type: string, callback: (event: { data: string }) => void) { this.handlers[type] = callback; }
    deliver(data: string) { this.handlers.message?.({ data }); }
  });
  renderSession(); await screen.findByText("alice-token habitat");
  await waitFor(() => expect(sources).toHaveLength(1));
  const oldSource = sources[0];
  fireEvent.click(screen.getByText("Change account")); await signIn(); await screen.findByText("bob-token habitat");
  await waitFor(() => expect(sources).toHaveLength(2));
  expect(oldSource.close).toHaveBeenCalled();
  act(() => { oldSource.deliver(JSON.stringify({ type: "mission.progress", data: { missionId: "m", completed: 1, total: 2 } })); });
  expect(useHabitatStore.getState().recentSSEEvents).toEqual([]);
  expect(useHabitatStore.getState().notifications).toEqual([]);
});
it("rejects queued SSE effects immediately when the account retires before React cleanup", async () => {
  showStream = true;
  let deliver = (_data: string) => {};
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ token: "stream" }) })));
  vi.stubGlobal("EventSource", class {
    close = vi.fn();
    addEventListener(type: string, callback: (event: { data: string }) => void) {
      if (type === "message") deliver = (data) => callback({ data });
    }
  });
  renderSession(); await screen.findByText("alice-token habitat");
  const oldDeliver = deliver;
  deliverDuringBoundary = () => oldDeliver(JSON.stringify({ type: "mission.progress", data: { missionId: "m", completed: 1, total: 2 } }));
  fireEvent.click(screen.getByRole("button", { name: "Retire and deliver queued event" }));
  expect(useHabitatStore.getState().recentSSEEvents).toEqual([]);
  expect(useHabitatStore.getState().notifications).toEqual([]);
});

it("does not let Alice's pending modal-close animation close Bob's modal", async () => {
  showModal = true;
  apiMock.details.mockReturnValue(new Promise(() => {}));
  useModalStore.getState().openModal("alice-task");
  renderSession(); await screen.findByText("alice-token habitat");
  let finishAnimation!: () => void;
  const schedule = globalThis.setTimeout;
  // Control only the system animation timer; API promises and rendering stay real.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 200) { finishAnimation = callback; return 0; }
    return schedule(callback, delay, ...args);
  }) as typeof setTimeout);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(finishAnimation).toBeTypeOf("function");
  await logout(); await signIn(); await screen.findByText("bob-token habitat");
  act(() => { useModalStore.getState().openModal("bob-task"); });
  act(() => { finishAnimation(); });
  expect(useModalStore.getState().isOpen).toBe(true);
  expect(useModalStore.getState().selectedTaskId).toBe("bob-task");
});
