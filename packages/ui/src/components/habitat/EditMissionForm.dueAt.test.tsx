import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionStateProvider, useAccountSession } from "../../lib/sessionState.js";
import type { MissionWithProgress } from "../../types/index.js";
import { CreateMissionForm } from "./CreateMissionForm.js";
import { EditMissionForm } from "./EditMissionForm.js";
import { notify } from "../../lib/toast.js";

const state = vi.hoisted(() => ({ mode: "release" as "release" | "feature", ready: true }));
vi.mock("../../lib/useHabitatData.js", async (load) => {
  const actual = await load<typeof import("../../lib/useHabitatData.js")>();
  return { ...actual,
    useTemplates: () => ({ data: { templates: [] } }),
    useHabitat: () => ({ data: state.ready ? { habitat: { id: "h1", roadmapSettings: { mode: state.mode } },
      columns: [{ id: "c1", name: "Backlog", isTerminal: false }], missions: [] } : undefined }),
  };
});
vi.mock("../../lib/toast.js", () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../ui/RichTextEditor.js", () => ({ RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) =>
  <textarea data-testid="draft-description" value={content} onChange={(event) => onChange(event.target.value)} /> }));

const base = {
  id: "m1", habitatId: "h1", columnId: "c1", title: "Original", description: "desc", acceptanceCriteria: "",
  priority: "high", labels: ["old"], status: "in_progress", displayOrder: 0, dependsOn: [], blocks: [],
  dueAt: "2026-11-30T12:00:45.000Z", slaMinutes: 90, slaDeadlineAt: null, createdBy: "u1", createdAt: "2026-01-01T00:00:00.000Z",
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

const ORIGINAL_TZ = process.env.TZ;
beforeEach(() => {
  state.mode = "release";
  state.ready = true;
  writes = [];
  failure = undefined;
  vi.clearAllMocks();
  process.env.TZ = "Asia/Kolkata";
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
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function RetireSession() {
  const session = useAccountSession();
  return <button onClick={() => session.logout()}>Retire session</button>;
}
function wrapper({ children }: { children: ReactNode }) {
  return <SessionStateProvider><RetireSession /><QueryClientProvider client={client}>{children}</QueryClientProvider></SessionStateProvider>;
}
function field(label: RegExp, root: HTMLElement = document.body): HTMLInputElement | HTMLSelectElement {
  const element = [...root.querySelectorAll("label")]
    .find((el) => label.test(el.textContent ?? ""))
    ?.parentElement?.querySelector("input, select");
  if (!element) throw new Error(`Missing visible field ${label}`);
  return element as HTMLInputElement | HTMLSelectElement;
}
const dueDateField = (root?: HTMLElement) => field(/due date/i, root);
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

describe("Mission deadline survives an unrelated edit (issue #236)", () => {
  // GROUND: issue #236 "An unrelated edit preserves the original deadline instant, including its stored precision."
  it("omits the deadline from the PATCH when the field was never touched", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Renamed" } });
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    // The stored instant (with its seconds) must survive untouched.
    expect(writes[0].data).not.toHaveProperty("dueAt");
    expect(writes[0].data).toMatchObject({ title: "Renamed", version: 3, slaMinutes: 90 });
  });

  it("shows the deadline as the browser's local wall clock", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    // 2026-11-30T12:00:45Z is 17:30 in Asia/Kolkata.
    expect((dueDateField() as HTMLInputElement).value).toBe("2026-11-30T17:30");
  });

  it("sends an explicit deadline change as the chosen wall clock", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(dueDateField(), { target: { value: "2026-12-01T09:00" } });
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data.dueAt).toBe("2026-12-01T03:30:00.000Z");
  });

  it("clears the deadline with an explicit null", async () => {
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(dueDateField(), { target: { value: "" } });
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data.dueAt).toBeNull();
  });

  it("keeps the untouched deadline out of the PATCH under UTC too", async () => {
    process.env.TZ = "UTC";
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    expect((dueDateField() as HTMLInputElement).value).toBe("2026-11-30T12:00");
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Renamed" } });
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).not.toHaveProperty("dueAt");
  });

  it("round-trips a deadline created in this zone through the edit form unchanged", async () => {
    // What Create posts for a wall clock is what Edit must read back and re-post.
    const create = render(<CreateMissionForm open onClose={vi.fn()} habitatId="h1" />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("Mission title"), { target: { value: "Fresh" } });
    fireEvent.change(dueDateField(create.container), { target: { value: "2026-12-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Mission" }));
    await waitFor(() => expect(writes.length).toBe(1));
    const created = writes[0].data.dueAt as string;
    create.unmount();

    const view = render(<EditMissionForm open onClose={vi.fn()} mission={{ ...base, dueAt: created }} />, { wrapper });
    expect((dueDateField(view.container) as HTMLInputElement).value).toBe("2026-12-01T09:00");
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Renamed" } });
    save();
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1].data).not.toHaveProperty("dueAt");
    view.unmount();
  });

  it("sends an explicit deadline change under UTC as the same wall clock", async () => {
    process.env.TZ = "UTC";
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(dueDateField(), { target: { value: "2026-12-01T09:00" } });
    save();
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data.dueAt).toBe("2026-12-01T09:00:00.000Z");
  });

  it("preserves the version and the conflict message on an unrelated edit", async () => {
    failure = { code: "VERSION_CONFLICT", message: "Version conflict" };
    render(<EditMissionForm open onClose={vi.fn()} mission={base} />, { wrapper });
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Renamed" } });
    save();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(
      "This mission was edited elsewhere — refresh and try again",
    ));
    expect(writes[0].data.version).toBe(3);
    expect(writes[0].data).not.toHaveProperty("dueAt");
  });

  it("leaves the Create contract alone: no deadline omits, a chosen deadline posts an instant", async () => {
    render(<CreateMissionForm open onClose={vi.fn()} habitatId="h1" />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("Mission title"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Mission" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data).not.toHaveProperty("dueAt");
    expect(writes[0]).toMatchObject({ url: "/api/habitats/h1/missions", method: "POST" });
  });

  it("posts a chosen Create deadline as the chosen wall clock", async () => {
    render(<CreateMissionForm open onClose={vi.fn()} habitatId="h1" />, { wrapper });
    fireEvent.change(screen.getByPlaceholderText("Mission title"), { target: { value: "Fresh" } });
    fireEvent.change(dueDateField(), { target: { value: "2026-12-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Mission" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0].data.dueAt).toBe("2026-12-01T03:30:00.000Z");
  });
});
