import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { MissionWithProgress } from "../../types/index.js";
import { CreateMissionForm } from "./CreateMissionForm.js";
import { EditMissionForm } from "./EditMissionForm.js";
import { notify } from "../../lib/toast.js";

const state = vi.hoisted(() => ({ mode: "release" as "release" | "feature" }));
vi.mock("../../lib/useHabitatData.js", async (load) => {
  const actual = await load<typeof import("../../lib/useHabitatData.js")>();
  return { ...actual,
    useTemplates: () => ({ data: { templates: [] } }),
    useHabitat: () => ({ data: { habitat: { id: "h1", roadmapSettings: { mode: state.mode } },
      columns: [{ id: "c1", name: "Backlog", isTerminal: false }], missions: [] } }),
  };
});
vi.mock("../../lib/toast.js", () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../ui/RichTextEditor.js", () => ({ RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) =>
  <textarea data-testid="draft-description" value={content} onChange={(event) => onChange(event.target.value)} /> }));

const base = {
  id: "m1", habitatId: "h1", columnId: "c1", title: "Original", description: "desc", acceptanceCriteria: "",
  priority: "high", labels: ["old"], status: "in_progress", displayOrder: 0, dependsOn: [], blocks: [],
  dueAt: null, slaMinutes: null, slaDeadlineAt: null, createdBy: "u1", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z", version: 3, actualMinutes: null, plannedMinutes: null,
  planningAccuracy: null, completedAt: null, isArchived: false, sprintId: null,
  releaseGateType: "minor", releaseGateVersion: "v1.0", releaseDeadlineType: null, releaseDeadlineVersion: null,
  progress: { total: 0, pending: 0, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0,
    failed: 0, rejected: 0, percentage: 0 },
} as MissionWithProgress;
const fetchMock = vi.fn<typeof fetch>();
let writes: Array<{ url: string; method: string; data: Record<string, unknown> }>;
let failure: { code: string; message: string } | undefined;
let client: QueryClient;
beforeEach(() => {
  state.mode = "release";
  writes = [];
  failure = undefined;
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock.mockImplementation(async (input, init) => {
    const data = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    writes.push({ url: String(input), method: init?.method ?? "GET", data });
    if (failure) return new Response(JSON.stringify({ error: failure.message, code: failure.code }), { status: 409 });
    return new Response(JSON.stringify({ mission: { ...base, ...data, version: 4 } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function field(label: string): HTMLInputElement | HTMLSelectElement {
  const element = screen.getByText(label, { selector: "label" }).parentElement?.querySelector("input, select");
  if (!element) throw new Error(`Missing visible field ${label}`);
  return element as HTMLInputElement | HTMLSelectElement;
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

describe("Mission authoring real transport journeys", () => {
  // GROUND: T3+T4+T5 Step 1 journey 1; PRD M2 (Create undefined omission, no POST version);
  // DESIGN §2 field table (labels split/trim/filter-empty omitted when empty).
  it("Create preserves POST-only fields and omitted empty optionals", async () => {
    render(<CreateMissionForm open onClose={vi.fn()} habitatId="h1" />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("Mission title"), { target: { value: "  New Mission  " } });
    fireEvent.change(field("Labels"), { target: { value: " a, , b " } });
    fireEvent.click(screen.getByRole("button", { name: "Create Mission" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toEqual({ url: "/api/habitats/h1/missions", method: "POST",
      data: { columnId: "c1", title: "New Mission", priority: "medium", labels: ["a", "b"] } });
  });
  // GROUND: T3+T4+T5 Step 1 journey 2; PRD M4 (feature-mode hiding intact);
  // DESIGN §2 (feature mode hides release authoring; Create never submits an inapplicable version).
  it("feature-mode Create hides release authoring and omits release keys", async () => {
    state.mode = "feature";
    render(<CreateMissionForm open onClose={vi.fn()} habitatId="h1" />, { wrapper });
    expect(screen.queryByText("Release Gate")).toBeNull();
    expect(screen.queryByText("Release Deadline")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Mission title"), { target: { value: "Feature Mission" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Mission" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).not.toHaveProperty("releaseGateType");
    expect(writes[0].data).not.toHaveProperty("releaseDeadlineType");
  });
  // GROUND: T3+T4+T5 Step 1 journey 3 (expected RED: current [open, mission] reset effect);
  // PRD M5 (refetch of same open Mission keeps draft and captured baseline version);
  // DESIGN §3 (new prop object/version for same open id does not reset draft or version).
  it("Edit keeps dirty input AND opening version after same-id refetch", async () => {
    const view = render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "  Typed  " } });
    view.rerender(<EditMissionForm open onClose={vi.fn()} mission={{ ...base, title: "Server", version: 4 }} />);
    expect((screen.getByDisplayValue("Typed") as HTMLInputElement).value).toBe("  Typed  ");
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toMatchObject({ url: "/api/missions/m1", method: "PATCH", data: { title: "Typed", version: 3 } });
  });
  // GROUND: T3+T4+T5 Step 1 journey 4 (expected RED: unconditional Gate Version input, no null pair);
  // PRD M4 (version control only when type selected; clearing type clears pair at serialization);
  // DESIGN §2/§4 (clearing a type makes its version null even if stale text remains; wrap in type condition).
  it("clearing a release type hides its version control and PATCH clears the pair", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(field("Release Gate"), { target: { value: "" } });
    expect(screen.queryByText("Gate Version")).toBeNull();
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).toMatchObject({ releaseGateType: null, releaseGateVersion: null });
  });
  // GROUND: T3+T4+T5 Step 1 journey 5 (expected RED: unconditional Deadline Version input, no null pair);
  // PRD M4; DESIGN §2/§4 — same pairing rule for the deadline control.
  it("clearing a release deadline hides its version control and PATCH clears the pair", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={{ ...base, releaseDeadlineType: "patch", releaseDeadlineVersion: "v2.0" }} />, { wrapper });
    fireEvent.change(field("Release Deadline"), { target: { value: "" } });
    expect(screen.queryByText("Deadline Version")).toBeNull();
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).toMatchObject({ releaseDeadlineType: null, releaseDeadlineVersion: null });
  });
  // GROUND: T3+T4+T5 Step 1 journey 6 (expected RED: current Edit PATCHes hidden prefilled release values);
  // PRD M4 (feature-mode hiding is not permission to delete an existing hidden gate);
  // DESIGN §2 (Edit omits all release keys when release controls are hidden).
  it("feature-mode Edit does not silently clear hidden persisted release fields", async () => {
    state.mode = "feature";
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    expect(screen.queryByText("Release Gate")).toBeNull();
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).not.toHaveProperty("releaseGateType");
    expect(writes[0].data).not.toHaveProperty("releaseGateVersion");
    expect(writes[0].data).not.toHaveProperty("releaseDeadlineType");
    expect(writes[0].data).not.toHaveProperty("releaseDeadlineVersion");
  });
  // GROUND: T3+T4+T5 Step 1 journey 7; PRD M5 (close/reopen or identity change reinitializes);
  // DESIGN §3 (sessionKey = open/closed + selected id; those triggers reset, refetch does not).
  it("close/reopen and identity change capture a fresh baseline, unlike refetch", async () => {
    const close = vi.fn();
    const view = render(<EditMissionForm open onClose={close} mission={base} />, { wrapper });
    view.rerender(<EditMissionForm open={false} onClose={close} mission={{ ...base, title: "Server", version: 4 }} />);
    view.rerender(<EditMissionForm open onClose={close} mission={{ ...base, title: "Server", version: 4 }} />);
    await waitFor(() => expect(screen.getByDisplayValue("Server")).toBeTruthy());
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data.version).toBe(4);
    view.rerender(<EditMissionForm open onClose={close} mission={{ ...base, id: "m2", title: "Other", version: 8 }} />);
    await waitFor(() => expect(screen.getByDisplayValue("Other")).toBeTruthy());
    save();
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1]).toMatchObject({ url: "/api/missions/m2", data: { title: "Other", version: 8 } });
  });
  // GROUND: T3+T4+T5 Step 1 journey 8 (expected RED after conflict: current reset effect discards the draft);
  // PRD M3 (typed VERSION_CONFLICT vs other guard errors preserved) + M5 (draft survives conflict/refetch);
  // DESIGN §3/§4 (form keeps its draft/version after conflict; no generic 409 fallback).
  it.each([
    ["VERSION_CONFLICT", "Version conflict", "This mission was edited elsewhere — refresh and try again"],
    ["MISSION_GATE_CLEAR_BLOCKED", "Activate the corrective Mission first", "Activate the corrective Mission first"],
  ])("preserves typed %s feedback through the actual transport", async (code, message, expected) => {
    failure = { code, message };
    const view = render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Typed" } });
    save();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(expected));
    view.rerender(<EditMissionForm open onClose={vi.fn()} mission={{ ...base, title: "Server", version: 4 }} />);
    expect(screen.getByDisplayValue("Typed")).toBeTruthy();
    save();
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1].data.version).toBe(3);
  });
});
