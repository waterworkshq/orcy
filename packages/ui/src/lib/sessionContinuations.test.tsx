import React, { useState, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { HabitatListPage } from "../components/habitat/HabitatListPage.js";
import { AuditExportModal } from "../components/habitat/AuditExportModal.js";
import { ExportHabitatDialog } from "../components/habitat/ExportHabitatDialog.js";
import { AttachmentSection } from "../components/habitat/AttachmentSection.js";
import { CreateTaskForm } from "../components/habitat/CreateTaskForm.js";
import { CloneTaskForm } from "../components/habitat/CloneTaskForm.js";
import { HabitatSettingsDialog } from "../components/habitat/HabitatSettingsDialog.js";
import { IntegrationsTab } from "../components/habitat/settings/IntegrationsTab.js";
import { NotificationsTab, type NotificationsTabHandle } from "../components/habitat/settings/NotificationsTab.js";
import type { PublicHabitat, ClonePreparationView, TaskCreationAttemptView } from "../types/index.js";
import { SessionStateProvider, useAccountSession } from "./sessionState.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }); }
function AccountControls() {
  const session = useAccountSession();
  const navigate = useNavigate();
  return <><Link to="/list">Habitats</Link><button onClick={() => {
    session.logout();
    session.completeAuthentication(session.beginAuthentication(), "bob-token");
    navigate("/bob");
  }}>Sign in as Bob</button></>;
}
const habitat: PublicHabitat = {
  id: "h", name: "Alice habitat", description: "", columns: [], teamId: null,
  retrySettings: null, anomalySettings: null, autoAssignSettings: null,
  prioritizationSettings: null, remoteGovernanceSettings: null, automationSettings: null,
  codeReviewSettings: null, ciCdSettings: null, gitWorktreeSettings: null,
  wikiSettings: null, triageSettings: null, releaseSettings: null, roadmapSettings: null,
  lifecycleSettings: null, eventRetentionDays: null, createdAt: "2024-01-01", updatedAt: "2024-01-01",
};
function SettingsRoute() {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  // Match HabitatPage's actual caller: deletion navigates through the persistent router.
  return <HabitatSettingsDialog habitat={habitat} open={open} onClose={() => setOpen(false)}
    onUpdate={() => {}} onDelete={() => navigate("/")} />;
}
function DownloadForm({ kind }: { kind: "audit" | "habitat" | "attachment" }) {
  const [open, setOpen] = useState(true);
  if (kind === "audit") return <AuditExportModal habitatId="h" open={open} onClose={() => setOpen(false)} />;
  if (kind === "habitat") return <ExportHabitatDialog habitatId="h" boardName="Alice habitat" open={open} onClose={() => setOpen(false)} />;
  return <AttachmentSection taskId="t" attachments={[{ id: "attachment", taskId: "t", filename: "file.txt", originalName: "Alice-private.txt", mimeType: "text/plain", sizeBytes: 7, uploadedBy: "alice", createdAt: "2026-10-17" }]} />;
}
function PublicationForm({ clone = false }: { clone?: boolean }) {
  const [open, setOpen] = useState(true);
  return clone ? <CloneTaskForm open={open} onClose={() => setOpen(false)} sourceTask={{ id: "source", title: "Alice source" }} habitatId="h" />
    : <CreateTaskForm open={open} onClose={() => setOpen(false)} habitatId="h" missionId="m" />;
}
function NotificationSettings() {
  const ref = useRef<NotificationsTabHandle>(null);
  return <><NotificationsTab ref={ref} habitatId="h" /><button onClick={() => void ref.current?.save()}>Save preferences</button></>;
}
function renderWorkspace(initialPath = "/list") {
  return render(<MemoryRouter initialEntries={[initialPath]}><SessionStateProvider><AccountControls /><Routes>
    <Route path="/" element={<p>Home workspace</p>} /><Route path="/settings" element={<SettingsRoute />} />
    <Route path="/download-audit" element={<DownloadForm kind="audit" />} /><Route path="/download-habitat" element={<DownloadForm kind="habitat" />} /><Route path="/download-attachment" element={<DownloadForm kind="attachment" />} />
    <Route path="/create-task" element={<PublicationForm />} /><Route path="/clone-task" element={<PublicationForm clone />} />
    <Route path="/integrations" element={<IntegrationsTab habitatId="h" />} />
    <Route path="/preferences" element={<NotificationSettings />} />
    <Route path="/list" element={<HabitatListPage />} />
    <Route path="/bob" element={<p>Bob workspace</p>} />
  </Routes></SessionStateProvider></MemoryRouter>);
}
beforeEach(() => { localStorage.clear(); localStorage.setItem("orcy_token", "alice-token"); localStorage.setItem("orcy_onboarding_completed", "true"); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([true, false])("keeps a deferred team Habitat create in its originating account (retire=%s)", async (retire) => {
  const ledger = deferred<Response>();
  const writes: { credential: string | null; body: unknown }[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/roles?")) return ledger.promise;
    if (path === "/api/habitats" && init?.method === "POST") {
      writes.push({ credential: new Headers(init.headers).get("Authorization"), body: JSON.parse(String(init.body)) });
      return json({ habitat: { id: "new", name: "Alice draft" }, columns: [] });
    }
    if (path === "/api/habitats") return json({ habitats: [] });
    if (path === "/api/users/me/teams") return json({ teams: [{ id: "shared-team", name: "Shared team" }] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "New Habitat" }));
  fireEvent.change(screen.getByPlaceholderText("Sprint 24"), { target: { value: "Alice draft" } });
  fireEvent.change(await screen.findByRole("combobox"), { target: { value: "shared-team" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.startsWith("/api/roles?"))).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { ledger.resolve(json({ incarnation: 1, version: 3 })); });
  expect(writes).toEqual(retire ? [] : [{ credential: "Bearer alice-token", body: { name: "Alice draft", description: "", teamId: "shared-team", expectedTeamVersion: 3, teamScopeIncarnation: 1 } }]);
  expect(localStorage.getItem("orcy_token")).toBe(retire ? "bob-token" : "alice-token");
});

it.each([true, false])("keeps Habitat deletion navigation in its originating account (retire=%s)", async (retire) => {
  const deletion = deferred<Response>();
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/habitats/h" && init?.method === "DELETE") return deletion.promise;
    // Unrelated settings queries fail at the HTTP boundary; their components remain real.
    return new Response(JSON.stringify({ error: "Unavailable in this fixture" }), { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/settings");
  fireEvent.click(screen.getByRole("button", { name: "Delete Habitat" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Habitat" })).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/habitats/h" && init?.method === "DELETE")).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { deletion.resolve(json({ success: true })); });
  expect(screen.queryByText(retire ? "Home workspace" : "Bob workspace")).toBeNull();
  expect(screen.getByText(retire ? "Bob workspace" : "Home workspace")).toBeTruthy();
});

it.each([true, false])("keeps sequential preference writes in their originating account (retire=%s)", async (retire) => {
  const email = deferred<Response>();
  const prefsWrites: string[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/users/me/email") return email.promise;
    if (init?.method === "PUT") {
      prefsWrites.push(new Headers(init.headers).get("Authorization") ?? "");
      return json({ preferences: { taskAssigned: false } });
    }
    return json({ email: "alice@example.test", preferences: { taskAssigned: true } });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/preferences");
  await screen.findByDisplayValue("alice@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path === "/api/users/me/email")).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { email.resolve(json({ success: true, email: "alice@example.test" })); });
  expect(prefsWrites).toEqual(retire ? [] : ["Bearer alice-token"]);
});

it("does not start Alice's OAuth polling with Bob's credential after the start response", async () => {
  const start = deferred<Response>();
  const polls: string[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/oauth/device/start")) return start.promise;
    if (path.endsWith("/oauth/device/poll")) {
      polls.push(new Headers(init?.headers).get("Authorization") ?? "");
      return json({ status: "pending" });
    }
    return json({ integrations: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/integrations");
  fireEvent.click((await screen.findAllByRole("button", { name: "Connect with GitHub" }))[0]);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith("/oauth/device/start"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
  await screen.findByText("Bob workspace");
  vi.useFakeTimers();
  await act(async () => { start.resolve(json({ deviceCode: "alice-device", userCode: "ALICE", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(polls).toEqual([]);
});

it.each(["queued", "pending"])("stops Alice's %s OAuth poll after switching accounts", async (phase) => {
  const response = deferred<Response>();
  const polls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/oauth/device/start")) return json({ deviceCode: "alice-device", userCode: "ALICE", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 });
    if (path.endsWith("/oauth/device/poll")) {
      polls.push(new Headers(init?.headers).get("Authorization") ?? "");
      return response.promise;
    }
    return json({ integrations: [] });
  }));
  renderWorkspace("/integrations");
  const connect = (await screen.findAllByRole("button", { name: "Connect with GitHub" }))[0];
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(connect); });
  expect(screen.getByText("ALICE")).toBeTruthy();
  if (phase === "pending") {
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(polls).toEqual(["Bearer alice-token"]);
  }
  fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
  expect(screen.getByText("Bob workspace")).toBeTruthy();
  await act(async () => { response.resolve(json({ status: "pending" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(polls).toEqual(phase === "pending" ? ["Bearer alice-token"] : []);
});

const clonePreparation: ClonePreparationView = {
  source: { taskId: "source", missionId: "m", habitatId: "h" }, defaultTargetMissionId: "m", title: "Alice draft",
  description: "", priority: "medium", requiredDomain: null, requiredCapabilities: [], estimatedMinutes: null,
  subtasks: [], dependencySuggestions: [], labels: [],
};
function publicationFetch(response: Promise<Response>, writes: string[]) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/task-publications") || path.endsWith("/clone-publications")) return response;
    if (init?.method === "POST") {
      writes.push(`${path}:${new Headers(init.headers).get("Authorization")}`);
      return json({ task: { id: "created", title: "Alice draft", missionId: "m" } });
    }
    if (path.endsWith("/clone-preparation")) return json(clonePreparation);
    if (path === "/api/agents") return json({ agents: [] });
    if (path.endsWith("/templates")) return json({ templates: [] });
    throw new Error(`Unexpected request ${path}`);
  });
}
async function submitPublication(clone: boolean) {
  renderWorkspace(clone ? "/clone-task" : "/create-task");
  const title = await screen.findByPlaceholderText("Task title");
  fireEvent.change(title, { target: { value: "Alice draft" } });
  const submit = screen.getByRole("button", { name: clone ? "Publish clone" : "Create Task" });
  await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
}
it.each([[false, true], [true, true], [false, false], [true, false]])("keeps publication fallback in its originating account (clone=%s, retire=%s)", async (clone, retire) => {
  const publication = deferred<Response>();
  const writes: string[] = [];
  const fetchMock = publicationFetch(publication.promise, writes);
  vi.stubGlobal("fetch", fetchMock);
  await submitPublication(clone);
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith(clone ? "/clone-publications" : "/task-publications"))).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { publication.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 })); });
  expect(writes).toEqual(retire ? [] : [`/api/${clone ? "tasks/source/clone" : "missions/m/tasks"}:Bearer alice-token`]);
});

const pendingAttempt: TaskCreationAttemptView = {
  attemptId: "alice-attempt", state: "published_pending_assignment", habitatId: "h",
  reservedAt: "2026-10-17T10:00:00.000Z", publishedAt: "2026-10-17T10:00:00.000Z", completedAt: null,
  committedTaskId: "created", committedMissionId: "m", envelopeEventId: "event", reservationId: "reservation",
  terminalOutcome: null, terminalResult: null, leaseOwner: null, leaseExpiresAt: null,
};
it.each([[false, "publish"], [true, "publish"], [false, "poll"], [true, "poll"]] as const)(
  "stops Alice's late %s publication %s response from starting Bob-authenticated recovery reads", async (clone, phase) => {
  const publication = deferred<Response>();
  const status = deferred<Response>();
  const reads: string[] = [];
  const writes: string[] = [];
  const baseFetch = publicationFetch(publication.promise, writes);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/task-creation-attempts/")) {
      reads.push(new Headers(init?.headers).get("Authorization") ?? "");
      return status.promise;
    }
    return baseFetch(path, init);
  }));
  await submitPublication(clone);
  vi.useFakeTimers();
  if (phase === "poll") {
    await act(async () => { publication.resolve(json({ outcome: "created", recovering: true, attemptId: "alice-attempt", taskId: "created" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(reads).toEqual(["Bearer alice-token"]);
  }
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
  expect(screen.getByText("Bob workspace")).toBeTruthy();
  await act(async () => {
    publication.resolve(json({ outcome: "created", recovering: true, attemptId: "alice-attempt", taskId: "created" }));
    status.resolve(json(pendingAttempt));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(reads).toEqual(phase === "poll" ? ["Bearer alice-token"] : []);
});

it.each([true, false])("keeps template usage after task creation in its originating account (retire=%s)", async (retire) => {
  const creation = deferred<Response>();
  const usage: string[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/task-publications")) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    if (path === "/api/missions/m/tasks" && init?.method === "POST") return creation.promise;
    if (path.endsWith("/usage")) { usage.push(new Headers(init?.headers).get("Authorization") ?? ""); return json({ success: true }); }
    if (path.endsWith("/templates")) return json({ templates: [{ id: "template", name: "Alice template", habitatId: "h", titlePattern: "Alice task", descriptionPattern: "", priority: "medium", labels: [], requiredDomain: null, requiredCapabilities: [] }] });
    if (path === "/api/agents") return json({ agents: [] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace("/create-task");
  const template = await screen.findByRole("option", { name: "Alice template (board)" });
  fireEvent.change(template.parentElement!, { target: { value: "template" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/missions/m/tasks" && init?.method === "POST")).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { creation.resolve(json({ task: { id: "created", missionId: "m", title: "Alice task" } })); });
  expect(usage).toEqual(retire ? [] : ["Bearer alice-token"]);
});

it.each([["audit", true], ["habitat", true], ["attachment", true], ["audit", false], ["habitat", false], ["attachment", false]] as const)("keeps a %s download in its originating account (retire=%s)", async (kind, retire) => {
  const response = deferred<Response>();
  const objectUrl = vi.fn(() => "blob:private");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = objectUrl; static revokeObjectURL = revoke; });
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const fetchMock = vi.fn((_path: string, _init?: RequestInit) => response.promise);
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace(`/download-${kind}`);
  const button = kind === "attachment"
    ? within(screen.getByText("Alice-private.txt").parentElement!).getAllByRole("button")[0]
    : screen.getByRole("button", { name: kind === "audit" ? "Export" : "Download JSON" });
  fireEvent.click(button);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer alice-token");
  if (retire) {
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { response.resolve(kind === "attachment" ? new Response("private", { headers: { "Content-Disposition": 'attachment; filename="Alice-private.txt"' } }) : json(kind === "audit" ? "Alice private audit" : { name: "Alice private habitat" })); });
  expect(objectUrl).toHaveBeenCalledTimes(retire ? 0 : 1);
  expect(download).toHaveBeenCalledTimes(retire ? 0 : 1);
  expect(revoke).toHaveBeenCalledTimes(retire ? 0 : 1);
});

it("continues OAuth device polling while the originating account is active", async () => {
  const credentials: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/oauth/device/start")) return json({ deviceCode: "alice-device", userCode: "ALICE", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 });
    if (path.endsWith("/oauth/device/poll")) {
      credentials.push(new Headers(init?.headers).get("Authorization") ?? "");
      return json(credentials.length === 1 ? { status: "pending" } : { integration: { id: "connected" } });
    }
    return json({ integrations: [] });
  }));
  renderWorkspace("/integrations");
  const connect = (await screen.findAllByRole("button", { name: "Connect with GitHub" }))[0];
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(connect); });
  expect(screen.getByText("ALICE")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(credentials).toEqual(["Bearer alice-token", "Bearer alice-token"]);
  expect(screen.queryByText("ALICE")).toBeNull();
});

it.each([false, true])("continues publication recovery while its account is active (clone=%s)", async (clone) => {
  const publication = deferred<Response>();
  const writes: string[] = [];
  const credentials: string[] = [];
  const baseFetch = publicationFetch(publication.promise, writes);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/task-creation-attempts/")) {
      credentials.push(new Headers(init?.headers).get("Authorization") ?? "");
      return json(credentials.length === 1 ? pendingAttempt : { ...pendingAttempt, state: "created", terminalOutcome: "created" });
    }
    return baseFetch(path, init);
  }));
  await submitPublication(clone);
  vi.useFakeTimers();
  await act(async () => { publication.resolve(json({ outcome: "created", recovering: true, attemptId: "alice-attempt", taskId: "created" })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(credentials).toEqual(["Bearer alice-token", "Bearer alice-token"]);
  expect(screen.queryByRole("dialog")).toBeNull();
});


it.each([[true, false], [true, true], [false, false], [false, true]] as const)(
  "keeps Habitat create completion notifications in their originating account (retire=%s, fail=%s)", async (retire, fail) => {
  const creation = deferred<Response>();
  const success = vi.spyOn(sonnerToast, "success");
  const error = vi.spyOn(sonnerToast, "error");
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/habitats" && init?.method === "POST") return creation.promise;
    if (path === "/api/habitats") return json({ habitats: [] });
    if (path === "/api/users/me/teams") return json({ teams: [] });
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace();
  fireEvent.click(screen.getByRole("button", { name: "New Habitat" }));
  fireEvent.change(screen.getByPlaceholderText("Sprint 24"), { target: { value: "Alice private draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => path === "/api/habitats" && init?.method === "POST")).toBe(true));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { creation.resolve(fail
    ? new Response(JSON.stringify({ error: "Alice private create refusal" }), { status: 409 })
    : json({ habitat: { id: "created", name: "Alice private draft" }, columns: [] })); });
  expect(success).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
  expect(error).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
  if (!retire && fail) expect(error.mock.calls[0][0]).toBe("Alice private create refusal");
  if (!retire && !fail) expect(success.mock.calls[0][0]).toBe('Habitat "Alice private draft" created');
  sonnerToast.dismiss();
});


it.each([[true, false], [true, true], [false, false], [false, true]] as const)(
  "keeps preference completion notifications in their originating account (retire=%s, fail=%s)", async (retire, fail) => {
  const preference = deferred<Response>();
  const success = vi.spyOn(sonnerToast, "success");
  const error = vi.spyOn(sonnerToast, "error");
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/users/me/email" && init?.method === "PUT") return json({ email: "alice@example.test", success: true });
    if (init?.method === "PUT") {
      writes.push(new Headers(init.headers).get("Authorization") ?? "");
      return preference.promise;
    }
    return json({ email: "alice@example.test", preferences: { taskAssigned: true } });
  }));
  renderWorkspace("/preferences");
  await screen.findByDisplayValue("alice@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  await waitFor(() => expect(writes).toEqual(["Bearer alice-token"]));
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { preference.resolve(fail
    ? new Response(JSON.stringify({ error: "Alice private preference refusal" }), { status: 409 })
    : json({ preferences: { taskAssigned: true } })); });
  expect(writes).toEqual(["Bearer alice-token"]);
  expect(success).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
  expect(error).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
  if (!retire && fail) expect(error.mock.calls[0][0]).toBe("Alice private preference refusal");
  if (!retire && !fail) expect(success.mock.calls[0][0]).toBe("Notification settings saved");
  sonnerToast.dismiss();
});

const publicationNotificationCases = [false, true].flatMap((clone) => ["legacy", "submit", "poll", "retry"].flatMap((phase) =>
  [true, false].flatMap((retire) => (phase === "legacy" || phase === "retry" ? [true, false] : [true]).map((fail) => ({ clone, phase, retire, fail })))))
  .filter(({ clone, phase, fail }) => clone || phase !== "legacy" || !fail);
it.each(publicationNotificationCases)("keeps publication notifications account-bound ($phase clone=$clone retire=$retire fail=$fail)", async ({ clone, phase, retire, fail }) => {
  const publication = deferred<Response>();
  const completion = deferred<Response>();
  const success = vi.spyOn(sonnerToast, "success");
  const error = vi.spyOn(sonnerToast, "error");
  const writes: string[] = [];
  const baseFetch = publicationFetch(publication.promise, writes);
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/assignment-attempts") || path.includes("/task-creation-attempts/") ||
      ((path === "/api/missions/m/tasks" || path === "/api/tasks/source/clone") && init?.method === "POST")) return completion.promise;
    if (path === "/api/agents") return json({ agents: [{ id: "alice-agent", name: "Alice Agent" }] });
    return baseFetch(path, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  await submitPublication(clone);
  if (phase === "legacy") {
    await act(async () => { publication.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 })); });
  } else if (phase === "poll") {
    vi.useFakeTimers();
    await act(async () => { publication.resolve(json({ outcome: "created", recovering: true, attemptId: "alice-attempt", taskId: "created" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  } else if (phase === "retry") {
    await act(async () => { publication.resolve(json({ outcome: "replayed", taskId: "created", assignmentFailure: { reason: "capacity" } })); });
    fireEvent.change(screen.getByLabelText("Agent for assignment retry"), { target: { value: "alice-agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry assignment" }));
  }
  success.mockClear(); error.mockClear(); sonnerToast.dismiss();
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    expect(screen.getByText("Bob workspace")).toBeTruthy();
  }
  const refusal = new Response(JSON.stringify({ error: `Alice private ${phase} refusal` }), { status: 409 });
  await act(async () => {
    if (phase === "submit") publication.resolve(refusal);
    else completion.resolve(fail ? refusal : json(phase === "retry" ? { outcome: "assigned", taskId: "created", assigneeId: "alice-agent" } : { task: { id: "created", missionId: "m", title: "Alice draft" } }));
  });
  expect(success).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
  expect(error).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
  if (!retire && fail) expect(error.mock.calls[0][0]).toBe(`Alice private ${phase} refusal`);
  if (!retire && !fail && phase === "retry") expect(success.mock.calls[0][0]).toBe('Task "Alice draft" assigned');
  if (!retire && !fail && phase === "legacy") expect(success.mock.calls[0][0]).toBe(clone ? "Task cloned" : 'Task "Alice draft" created');
  sonnerToast.dismiss();
});

it.each(["audit", "habitat", "attachment", "delete"] .flatMap((kind) => [true, false].map((retire) => ({ kind, retire }))))(
  "keeps private settings/download errors account-bound ($kind retire=$retire)", async ({ kind, retire }) => {
  const completion = deferred<Response>();
  const error = vi.spyOn(sonnerToast, "error");
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (kind !== "delete" || (path === "/api/habitats/h" && init?.method === "DELETE")) return completion.promise;
    return new Response(JSON.stringify({ error: "Unavailable in fixture" }), { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderWorkspace(kind === "delete" ? "/settings" : `/download-${kind}`);
  if (kind === "delete") {
    fireEvent.click(screen.getByRole("button", { name: "Delete Habitat" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Habitat" })).getByRole("button", { name: "Delete" }));
  } else {
    fireEvent.click(kind === "attachment" ? within(screen.getByText("Alice-private.txt").parentElement!).getAllByRole("button")[0]
      : screen.getByRole("button", { name: kind === "audit" ? "Export" : "Download JSON" }));
  }
  expect(fetchMock.mock.calls.some(([, init]) => new Headers(init?.headers).get("Authorization") === "Bearer alice-token")).toBe(true);
  error.mockClear();
  if (retire) {
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { completion.resolve(new Response(JSON.stringify({ error: `Alice private ${kind} refusal` }), { status: 409 })); });
  expect(error).toHaveBeenCalledTimes(retire ? 0 : 1);
  if (!retire) expect(error.mock.calls[0][0]).toBe(`Alice private ${kind} refusal`);
  sonnerToast.dismiss();
});

const integrationNotificationCases = ["sync", "enabled", "autoImport", "disconnect", "pat", "jira", "linear"].flatMap((action) =>
  [true, false].flatMap((retire) => (action === "enabled" || action === "autoImport" ? [true] : [true, false]).map((fail) => ({ action, retire, fail }))));
it.each(integrationNotificationCases)("keeps integration notifications account-bound ($action retire=$retire fail=$fail)", async ({ action, retire, fail }) => {
  const completion = deferred<Response>();
  const success = vi.spyOn(sonnerToast, "success");
  const error = vi.spyOn(sonnerToast, "error");
  const mutations: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      mutations.push(new Headers(init.headers).get("Authorization") ?? "");
      return completion.promise;
    }
    return json({ integrations: [{
      id: "conn", habitatId: "h", provider: "github", name: "Alice private integration", authMethod: "pat",
      hasAccessToken: true, hasRefreshToken: false, hasWebhookSecret: true, repositoryOwner: "alice", repositoryName: "private",
      enabled: true, pullEnabled: true, autoImport: false, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
    }] });
  }));
  renderWorkspace("/integrations");
  const card = (await screen.findByText("Alice private integration")).closest(".border")! as HTMLElement;
  if (action === "sync") fireEvent.click(within(card).getByRole("button", { name: "Sync Now" }));
  else if (action === "enabled" || action === "autoImport") fireEvent.click(within(card).getAllByRole("switch")[action === "enabled" ? 0 : 1]);
  else if (action === "disconnect") {
    fireEvent.click(within(card).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(card).getByRole("button", { name: "Confirm" }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: action === "pat" ? "Use a personal access token instead" : action === "jira" ? "Connect Jira via API Token" : "Connect Linear via API Key" }));
    const form = document.querySelector("form")!;
    for (const input of form.querySelectorAll<HTMLInputElement>("input[required]")) {
      fireEvent.change(input, { target: { value: input.type === "email" ? "alice@example.test" : input.type === "url" ? "https://example.test" : "Alice-private-fixture" } });
    }
    fireEvent.submit(form);
  }
  expect(mutations).toEqual(["Bearer alice-token"]);
  if (retire) {
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => { completion.resolve(fail
    ? new Response(JSON.stringify({ error: `Alice private ${action} integration refusal` }), { status: 409 })
    : json({ created: 17, updated: 23, skipped: 2, failed: 0, integration: { id: "new" } })); });
  expect(success).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
  expect(error).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
  if (!retire && fail) expect(error.mock.calls[0][0]).toBe(`Alice private ${action} integration refusal`);
  if (!retire && !fail && action === "sync") expect(success.mock.calls[0][0]).toBe("Synced: 17 created, 23 updated, 2 skipped");
  sonnerToast.dismiss();
});

it.each(["upload", "delete"].flatMap((action) => [true, false].flatMap((retire) => [true, false].map((fail) => ({ action, retire, fail }))))) (
  "keeps attachment mutation notifications account-bound ($action retire=$retire fail=$fail)", async ({ action, retire, fail }) => {
  const response = deferred<Response>();
  const success = vi.spyOn(sonnerToast, "success");
  const error = vi.spyOn(sonnerToast, "error");
  let finishUpload: (fail: boolean) => void = (_fail) => { throw new Error("Upload was not sent"); };
  let uploadCredential = "";
  // XMLHttpRequest is the external upload boundary; exercise the real uploadFile transport and FormData.
  vi.stubGlobal("XMLHttpRequest", class {
    status = 0;
    responseText = "";
    upload = { addEventListener: () => {} };
    handlers: Record<string, () => void> = {};
    open() {}
    setRequestHeader(name: string, value: string) { if (name === "Authorization") uploadCredential = value; }
    addEventListener(name: string, callback: () => void) { this.handlers[name] = callback; }
    send(body: FormData) {
      expect(body.get("file")).toBeInstanceOf(File);
      finishUpload = (failed) => {
        this.status = failed ? 409 : 200;
        this.responseText = JSON.stringify(failed ? { error: "Alice private upload refusal" } : { attachment: { id: "uploaded", originalName: "Alice-private.txt", mimeType: "text/plain", sizeBytes: 7 } });
        this.handlers.load();
      };
    }
  });
  const fetchMock = vi.fn((_path: string, _init?: RequestInit) => response.promise);
  vi.stubGlobal("fetch", fetchMock);
  const view = renderWorkspace("/download-attachment");
  if (action === "upload") {
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["private"], "Alice-private.txt", { type: "text/plain" })] } });
    expect(uploadCredential).toBe("Bearer alice-token");
  } else {
    fireEvent.click(within(screen.getByText("Alice-private.txt").parentElement!).getAllByRole("button")[1]);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete Attachment?" })).getByRole("button", { name: "Delete" }));
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer alice-token");
  }
  if (retire) {
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Bob" }));
    await screen.findByText("Bob workspace");
  }
  await act(async () => {
    if (action === "upload") finishUpload(fail);
    else response.resolve(fail ? new Response(JSON.stringify({ error: "Alice private delete refusal" }), { status: 409 }) : json({ success: true }));
  });
  expect(success).toHaveBeenCalledTimes(!retire && !fail ? 1 : 0);
  expect(error).toHaveBeenCalledTimes(!retire && fail ? 1 : 0);
  if (!retire && fail) expect(error.mock.calls[0][0]).toBe(`Alice private ${action} refusal`);
  if (!retire && !fail) expect(success.mock.calls[0][0]).toBe(action === "upload" ? "Uploaded Alice-private.txt" : "Attachment deleted");
  sonnerToast.dismiss();
});
