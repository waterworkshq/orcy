// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../App.js";
import { useHabitatStore } from "../store/habitatStore.js";
import { useModalStore } from "../store/modalStore.js";
import type { EnrichedHabitatEvent, PublicHabitat } from "../types/index.js";

interface ControlledEventSource {
  url: string;
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  deliver: (event: { type: string; data: unknown }) => void;
}

function makeJwt(username: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub: `user-${username}`, username }));
  const sig = btoa("sig");
  return `${header}.${payload}.${sig}`;
}

function makeHabitat(id: string, name: string): PublicHabitat {
  return {
    id,
    name,
    description: "",
    columns: [],
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
    createdAt: "2026-11-28T00:00:00Z",
    updatedAt: "2026-11-28T00:00:00Z",
  };
}

function makeEvent(
  overrides: Partial<EnrichedHabitatEvent> & { id: string; habitatId?: string },
): EnrichedHabitatEvent {
  return {
    taskId: `task-${overrides.id}`,
    taskTitle: `Task ${overrides.id}`,
    habitatId: overrides.habitatId ?? "h1",
    actorType: "agent",
    actorId: "agent-1",
    actorName: "Scout",
    action: "created",
    fromColumnId: null,
    toColumnId: null,
    fromColumnName: null,
    toColumnName: null,
    fromStatus: null,
    toStatus: "pending",
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  } as Response;
}

function createServerHarness() {
  const habitats = new Map<string, PublicHabitat>([
    ["h1", makeHabitat("h1", "Alpha Habitat")],
    ["h2", makeHabitat("h2", "Beta Habitat")],
  ]);
  const eventsByHabitat = new Map<string, EnrichedHabitatEvent[]>([
    ["h1", []],
    ["h2", []],
  ]);
  const fetchCalls: string[] = [];
  const sources: ControlledEventSource[] = [];
  let mobileViewport = false;
  let tokenCounter = 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    fetchCalls.push(rawUrl);

    if (init?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const url = new URL(rawUrl, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/api/auth/setup-status") {
      return jsonResponse({ needsSetup: false });
    }
    if (pathname === "/api/auth/login") {
      const parsed = init?.body ? JSON.parse(String(init.body)) : {};
      return jsonResponse({ token: makeJwt(parsed.username ?? "bob") });
    }
    if (pathname === "/api/auth/logout") {
      return jsonResponse({ success: true });
    }
    if (pathname === "/api/auth/stream-token") {
      tokenCounter += 1;
      return jsonResponse({ token: `stream-token-${tokenCounter}` });
    }
    if (pathname === "/api/agents") {
      return jsonResponse({ agents: [] });
    }
    if (pathname === "/api/users/me/teams") {
      return jsonResponse({ teams: [] });
    }
    if (pathname === "/api/habitats") {
      return jsonResponse({ habitats: Array.from(habitats.values()) });
    }

    const eventsMatch = pathname.match(/^\/api\/habitats\/([^/]+)\/events$/);
    if (eventsMatch) {
      const habitatId = eventsMatch[1];
      const allEvents = eventsByHabitat.get(habitatId) ?? [];
      const action = url.searchParams.get("action");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const filtered = action ? allEvents.filter((e) => e.action === action) : allEvents;
      const slice = filtered.slice(offset, offset + limit);
      return jsonResponse({ events: slice, total: filtered.length });
    }

    const anomaliesMatch = pathname.match(/^\/api\/habitats\/([^/]+)\/anomalies$/);
    if (anomaliesMatch) {
      return jsonResponse({ anomalies: [] });
    }

    const detailMatch = pathname.match(/^\/api\/habitats\/([^/]+)$/);
    if (detailMatch) {
      const habitatId = detailMatch[1];
      const habitat = habitats.get(habitatId) ?? makeHabitat(habitatId, `Habitat ${habitatId}`);
      return jsonResponse({ habitat, columns: [], missions: [] });
    }

    if (pathname.endsWith("/sprints/active")) {
      return jsonResponse({ sprint: null });
    }
    if (pathname.endsWith("/insights")) {
      return jsonResponse({ insights: [] });
    }
    if (pathname.endsWith("/pulse")) {
      return jsonResponse({ pulses: [], total: 0 });
    }
    if (pathname.endsWith("/skill")) {
      return jsonResponse({ skill: null });
    }
    if (pathname.endsWith("/skill/signals")) {
      return jsonResponse({ signals: [], total: 0 });
    }
    if (pathname.endsWith("/saved-filters")) {
      return jsonResponse({ savedFilters: [] });
    }
    if (pathname.endsWith("/missions")) {
      return jsonResponse({ missions: [], total: 0 });
    }
    if (pathname.endsWith("/health")) {
      return jsonResponse({ score: 100, status: "healthy", factors: {} });
    }
    if (pathname.startsWith("/api/presence/")) {
      return jsonResponse({ ok: true });
    }

    return jsonResponse({});
  });

  function installGlobals() {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        url: string;
        closed = false;
        private listeners: Record<string, ((e: { data: string }) => void) | undefined> = {};
        close = vi.fn(() => {
          this.closed = true;
          this.listeners = {};
        });
        addEventListener = vi.fn((type: string, fn: (e: { data: string }) => void) => {
          this.listeners[type] = fn;
        });
        deliver = (event: { type: string; data: unknown }) => {
          if (this.closed) return;
          this.listeners["message"]?.({ data: JSON.stringify(event) });
        };
        constructor(url: string) {
          this.url = url;
          sources.push(this as unknown as ControlledEventSource);
        }
      },
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: mobileViewport && query === "(max-width: 767px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  }

  return {
    eventsByHabitat,
    fetchCalls,
    fetchMock,
    sources,
    setMobileViewport: (mobile: boolean) => {
      mobileViewport = mobile;
    },
    installGlobals,
  };
}

describe("Mounted App Habitat Activity live updates", () => {
  let harness: ReturnType<typeof createServerHarness>;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("orcy_token", makeJwt("alice"));
    localStorage.setItem("orcy_onboarding_completed", "true");
    useHabitatStore.setState(useHabitatStore.getInitialState(), true);
    useModalStore.getState().closeModal();
    harness = createServerHarness();
    harness.installGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, "", "/");
  });

  it("keeps mounted Activity current after navigating from Habitat board via mobile nav without focus/filter/network transitions", async () => {
    harness.setMobileViewport(true);
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-initial", taskTitle: "Initial Task", action: "created" }),
    ]);

    window.history.pushState({}, "", "/habitats/h1");
    render(<App />);

    await screen.findByText("Alpha Habitat");
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );

    const boardSource = harness.sources.find((s) => !s.closed)!;
    const boardFetchesBefore = harness.fetchCalls.filter((u) => u.endsWith("/api/habitats/h1")).length;

    // Board SSE continues to refresh board queries
    act(() => {
      boardSource.deliver({ type: "task.created", data: { id: "t-board", missionId: "m1" } });
    });
    await waitFor(() =>
      expect(harness.fetchCalls.filter((u) => u.endsWith("/api/habitats/h1")).length).toBeGreaterThan(
        boardFetchesBefore,
      ),
    );

    // Navigate from board to Activity via real MobileNav link
    const activityLink = screen
      .getAllByRole("link")
      .find((el) => el.getAttribute("href") === "/habitats/h1/activity");
    expect(activityLink).toBeTruthy();
    fireEvent.click(activityLink!);

    await screen.findByText('"Initial Task"');
    expect(boardSource.close).toHaveBeenCalled();

    // Activity must open its own active habitat stream
    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed),
      ).toHaveLength(1),
    );
    const activitySource = harness.sources.find((s) => !s.closed)!;
    expect(activitySource).not.toBe(boardSource);

    // Deliver a new qualifying Task event while remaining on Activity
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-live", taskTitle: "Live Task Appeared", action: "created" }),
      ...(harness.eventsByHabitat.get("h1") ?? []),
    ]);

    act(() => {
      activitySource.deliver({ type: "task.created", data: { id: "t-live", missionId: "m1" } });
    });

    await screen.findByText('"Live Task Appeared"');
    expect(screen.getByText('"Initial Task"')).toBeInTheDocument();
  });

  it("handles matching and nonmatching action filters cleanly on live updates", async () => {
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-claim-1", taskTitle: "Claimed One", action: "claimed" }),
      makeEvent({ id: "e-approve-0", taskTitle: "Approved Zero", action: "approved" }),
    ]);

    window.history.pushState({}, "", "/habitats/h1/activity");
    render(<App />);

    await screen.findByText('"Claimed One"');

    // Switch to Claims filter
    fireEvent.click(screen.getByTestId("filter-claims"));
    await waitFor(() => {
      expect(screen.getByText('"Claimed One"')).toBeInTheDocument();
      expect(screen.queryByText('"Approved Zero"')).toBeNull();
    });

    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const activitySource = harness.sources.find((s) => !s.closed)!;

    // 1. Nonmatching event (approved) arrives while Claims filter is active
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-approve-live", taskTitle: "Approved Live Nonmatching", action: "approved" }),
      ...(harness.eventsByHabitat.get("h1") ?? []),
    ]);
    const claimFetchesBefore = harness.fetchCalls.filter((u) => u.includes("action=claimed")).length;
    act(() => {
      activitySource.deliver({ type: "task.approved", data: { taskId: "t-app", reviewerId: "u1" } });
      activitySource.deliver({
        type: "task.updated",
        data: { id: "t-app", missionId: "m1", status: "approved" },
      });
    });

    await waitFor(() =>
      expect(harness.fetchCalls.filter((u) => u.includes("action=claimed")).length).toBeGreaterThan(
        claimFetchesBefore,
      ),
    );
    expect(screen.queryByText('"Approved Live Nonmatching"')).toBeNull();
    expect(screen.getByText('"Claimed One"')).toBeInTheDocument();

    // 2. Matching event (claimed) arrives while Claims filter is active
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-claim-live", taskTitle: "Claimed Live Matching", action: "claimed" }),
      ...(harness.eventsByHabitat.get("h1") ?? []),
    ]);
    act(() => {
      activitySource.deliver({ type: "task.claimed", data: { taskId: "t-clm", agentId: "a1" } });
      activitySource.deliver({
        type: "task.updated",
        data: { id: "t-clm", missionId: "m1", status: "claimed" },
      });
    });

    await screen.findByText('"Claimed Live Matching"');
    expect(screen.queryByText('"Approved Live Nonmatching"')).toBeNull();

    // 3. Switching back to All shows both new events (inactive query was also reset)
    fireEvent.click(screen.getByTestId("filter-all"));
    await screen.findByText('"Approved Live Nonmatching"');
    expect(screen.getByText('"Claimed Live Matching"')).toBeInTheDocument();
  });

  it("refreshes paginated results without duplicate event rows", async () => {
    const seeded = Array.from({ length: 60 }, (_, idx) =>
      makeEvent({ id: `e-${idx + 1}`, taskTitle: `Paginated Task ${idx + 1}`, action: "created" }),
    );
    harness.eventsByHabitat.set("h1", seeded);

    window.history.pushState({}, "", "/habitats/h1/activity");
    render(<App />);

    await screen.findByText('"Paginated Task 1"');
    expect(screen.getByTestId("load-more")).toBeInTheDocument();

    // Load second page (60 total unique rows)
    fireEvent.click(screen.getByTestId("load-more"));
    await screen.findByText('"Paginated Task 60"');

    const rowsBefore = screen.getAllByTestId(/^event-row-/);
    expect(rowsBefore).toHaveLength(60);

    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const activitySource = harness.sources.find((s) => !s.closed)!;

    // New event arrives at top (total -> 61)
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "e-0", taskTitle: "Paginated Task 0", action: "created" }),
      ...seeded,
    ]);
    act(() => {
      activitySource.deliver({ type: "task.created", data: { id: "t-0", missionId: "m1" } });
    });

    await screen.findByText('"Paginated Task 0"');
    expect(screen.getByText("61 events")).toBeInTheDocument();

    // Load page 2 again after reset and verify 61 unique rows with zero duplicates
    fireEvent.click(screen.getByTestId("load-more"));
    await screen.findByText('"Paginated Task 60"');

    const rowsAfter = screen.getAllByTestId(/^event-row-/);
    const idsAfter = rowsAfter.map((el) => el.getAttribute("data-testid"));
    expect(rowsAfter).toHaveLength(61);
    expect(new Set(idsAfter).size).toBe(61);
  });

  it("cleans up on Habitat navigation, ignores stale streams, and preserves board SSE on Back", async () => {
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "h1-e1", habitatId: "h1", taskTitle: "H1 Event", action: "created" }),
    ]);
    harness.eventsByHabitat.set("h2", [
      makeEvent({ id: "h2-e1", habitatId: "h2", taskTitle: "H2 Event", action: "created" }),
    ]);

    window.history.pushState({}, "", "/habitats/h1/activity");
    render(<App />);

    await screen.findByText('"H1 Event"');
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const h1Source = harness.sources.find((s) => s.url.includes("/sse/habitats/h1/stream"))!;

    // Navigate through Echo Base -> Beta Habitat -> Wake (Activity for h2)
    fireEvent.click(screen.getByTestId("nav-item-echo-base"));
    await screen.findByText("Beta Habitat");
    expect(h1Source.close).toHaveBeenCalled();

    // Delivering to stale h1 stream does nothing
    const h1EventsCallsBefore = harness.fetchCalls.filter((u) =>
      u.includes("/api/habitats/h1/events"),
    ).length;
    act(() => {
      h1Source.deliver({ type: "task.created", data: { id: "t-stale", missionId: "m1" } });
    });
    expect(
      harness.fetchCalls.filter((u) => u.includes("/api/habitats/h1/events")).length,
    ).toBe(h1EventsCallsBefore);

    // Open Beta Habitat board, then its Activity page
    fireEvent.click(screen.getByText("Beta Habitat"));
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const h2BoardSource = harness.sources.find(
      (s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed,
    )!;

    fireEvent.click(screen.getByTestId("nav-item-wake"));
    await screen.findByText('"H2 Event"');
    expect(h2BoardSource.close).toHaveBeenCalled();

    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed),
      ).toHaveLength(1),
    );
    const h2ActivitySource = harness.sources.find(
      (s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed,
    )!;
    expect(h2ActivitySource).not.toBe(h2BoardSource);

    // Live event on h2 Activity updates h2 Activity
    harness.eventsByHabitat.set("h2", [
      makeEvent({ id: "h2-e2", habitatId: "h2", taskTitle: "H2 Live Event", action: "created" }),
      ...(harness.eventsByHabitat.get("h2") ?? []),
    ]);
    act(() => {
      h2ActivitySource.deliver({ type: "task.created", data: { id: "t-h2-2", missionId: "m2" } });
    });
    await screen.findByText('"H2 Live Event"');

    // Click Back to Habitat h2 board and verify board SSE still works and Activity stream closed
    fireEvent.click(screen.getByText("Back"));
    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed),
      ).toHaveLength(1),
    );
    expect(h2ActivitySource.close).toHaveBeenCalled();
    const h2BoardSource2 = harness.sources.find(
      (s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed,
    )!;
    const h2BoardFetchesBefore = harness.fetchCalls.filter((u) =>
      u.endsWith("/api/habitats/h2"),
    ).length;
    act(() => {
      h2BoardSource2.deliver({ type: "task.created", data: { id: "t-h2-board", missionId: "m2" } });
    });
    await waitFor(() =>
      expect(
        harness.fetchCalls.filter((u) => u.endsWith("/api/habitats/h2")).length,
      ).toBeGreaterThan(h2BoardFetchesBefore),
    );
  });

  it("closes Activity stream and isolates cache across session replacement (logout / login)", async () => {
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "alice-e1", taskTitle: "Alice Event", action: "created" }),
    ]);

    window.history.pushState({}, "", "/habitats/h1/activity");
    render(<App />);

    await screen.findByText('"Alice Event"');
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const aliceSource = harness.sources.find((s) => !s.closed)!;

    // Logout via TopAppBar UserMenu
    fireEvent.click(screen.getByTestId("user-avatar-btn"));
    fireEvent.click(screen.getByTestId("user-menu-logout"));
    await screen.findByLabelText("Username");

    expect(aliceSource.close).toHaveBeenCalled();

    // Deliver to Alice's closed/retired stream -> must not fetch
    const eventsFetchesAfterLogout = harness.fetchCalls.filter((u) =>
      u.includes("/api/habitats/h1/events"),
    ).length;
    act(() => {
      aliceSource.deliver({ type: "task.created", data: { id: "t-alice-stale", missionId: "m1" } });
    });
    expect(
      harness.fetchCalls.filter((u) => u.includes("/api/habitats/h1/events")).length,
    ).toBe(eventsFetchesAfterLogout);

    // Swap server events for Bob's session and sign in
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "bob-e1", taskTitle: "Bob Event", action: "created" }),
    ]);
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText("Alpha Habitat");
    fireEvent.click(screen.getByText("Alpha Habitat"));
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByTestId("nav-item-wake"));
    await screen.findByText('"Bob Event"');
    expect(screen.queryByText('"Alice Event"')).toBeNull();

    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed),
      ).toHaveLength(1),
    );
    const bobActivitySource = harness.sources.find((s) => !s.closed)!;
    expect(bobActivitySource).not.toBe(aliceSource);

    // Live event in Bob's session updates Bob's Activity feed
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "bob-e2", taskTitle: "Bob Live Event", action: "created" }),
      ...(harness.eventsByHabitat.get("h1") ?? []),
    ]);
    act(() => {
      bobActivitySource.deliver({ type: "task.created", data: { id: "t-bob-2", missionId: "m1" } });
    });
    await screen.findByText('"Bob Live Event"');
  });

  it("switches SSE stream cleanly when navigating from desktop board header and directly between Habitat Activity routes", async () => {
    harness.eventsByHabitat.set("h1", [
      makeEvent({ id: "d-h1-1", habitatId: "h1", taskTitle: "Desktop H1 Event", action: "created" }),
    ]);
    harness.eventsByHabitat.set("h2", [
      makeEvent({ id: "d-h2-1", habitatId: "h2", taskTitle: "Desktop H2 Event", action: "created" }),
    ]);

    window.history.pushState({}, "", "/habitats/h1");
    render(<App />);

    await screen.findByText("Alpha Habitat");
    await waitFor(() =>
      expect(harness.sources.some((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed)).toBe(
        true,
      ),
    );
    const boardSource = harness.sources.find((s) => !s.closed)!;

    // Click desktop Activity header button on HabitatPage
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    await screen.findByText('"Desktop H1 Event"');
    expect(boardSource.close).toHaveBeenCalled();

    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h1/stream") && !s.closed),
      ).toHaveLength(1),
    );
    const h1ActivitySource = harness.sources.find((s) => !s.closed)!;

    // Directly navigate /habitats/h1/activity -> /habitats/h2/activity (ActivityPage stays mounted)
    act(() => {
      window.history.pushState({}, "", "/habitats/h2/activity");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await screen.findByText('"Desktop H2 Event"');
    expect(h1ActivitySource.close).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        harness.sources.filter((s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed),
      ).toHaveLength(1),
    );
    const h2ActivitySource = harness.sources.find(
      (s) => s.url.includes("/sse/habitats/h2/stream") && !s.closed,
    )!;

    // Stale h1 delivery triggers no fetch; h2 delivery updates h2 Activity
    const h1CallsBefore = harness.fetchCalls.filter((u) =>
      u.includes("/api/habitats/h1/events"),
    ).length;
    act(() => {
      h1ActivitySource.deliver({ type: "task.created", data: { id: "t-stale-h1", missionId: "m1" } });
    });
    expect(
      harness.fetchCalls.filter((u) => u.includes("/api/habitats/h1/events")).length,
    ).toBe(h1CallsBefore);

    harness.eventsByHabitat.set("h2", [
      makeEvent({ id: "d-h2-2", habitatId: "h2", taskTitle: "Desktop H2 Live", action: "created" }),
      ...(harness.eventsByHabitat.get("h2") ?? []),
    ]);
    act(() => {
      h2ActivitySource.deliver({ type: "task.created", data: { id: "t-live-h2", missionId: "m2" } });
    });
    await screen.findByText('"Desktop H2 Live"');
  });
});
