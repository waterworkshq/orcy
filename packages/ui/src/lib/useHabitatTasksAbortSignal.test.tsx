import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useHabitatTasks } from "./useHabitatData.js";
import { projectSSEServerEvent } from "../sse/registry.js";
import type { ServerProjectionContext } from "../sse/types.js";
import type { SSEEvent, Task } from "../types/index.js";

/**
 * Regression: `useHabitatTasks` must forward TanStack's AbortSignal through
 * the real transport (hook -> api.habitats.tasks -> request -> controlled
 * fetch that emulates native abort-and-reject semantics and records aborts).
 * Supersede-cancel only applies to a query with cached data, so the initial
 * load completes before the held invalidation refetch.
 */

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  missionId: "m1",
  title: "T1",
  description: "",
  priority: "medium",
  assignedAgentId: null,
  delegatedToAgentId: null,
  requiredDomain: null,
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
  createdBy: "u1",
  createdAt: "",
  updatedAt: "",
  lastActivityAt: null,
  version: 1,
  estimatedMinutes: null,
  labels: [],
  retryPolicy: null,
  retryCount: 0,
  nextRetryAt: null,
  actualMinutes: null,
  cycleTimeMinutes: null,
  leadTimeMinutes: null,
  estimationAccuracy: null,
  ...overrides,
});

/** One in-flight HTTP request issued by the real transport. */
interface Flight {
  url: string;
  signal: AbortSignal | undefined;
  aborted: boolean;
  settle: (revision: number) => void;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function setupControlledFetch() {
  const flights: Flight[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    let settle!: (revision: number) => void;
    let fail!: (reason?: unknown) => void;
    const promise = new Promise<Response>((resolve, reject) => {
      settle = (revision: number) => resolve(jsonResponse({ tasks: [], total: revision }));
      fail = reject;
    });
    const flight: Flight = { url, signal: init?.signal ?? undefined, aborted: false, settle };
    flight.signal?.addEventListener("abort", () => {
      flight.aborted = true;
      fail(new DOMException("Aborted", "AbortError"));
    });
    flights.push(flight);
    return promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  const forUrl = (substr: string) => flights.filter((f) => f.url.includes(substr));
  return { flights, fetchMock, forUrl };
}

function sseContext(event: SSEEvent, qc: QueryClient): ServerProjectionContext {
  return {
    event,
    queryClient: qc,
    subscriptionHabitatId: "h1",
    routeHabitatId: "h1",
    isActive: () => true,
    navigateHome: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useHabitatTasks forwards the query AbortSignal to the HTTP request", () => {
  it("a superseding task-SSE invalidation aborts the in-flight task-list request; only the latest response is cached; unrelated habitats are unaffected", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { forUrl } = setupControlledFetch();

    const h1 = renderHook(() => useHabitatTasks("h1"), { wrapper });
    const h2 = renderHook(() => useHabitatTasks("h2"), { wrapper });

    // Initial loads complete and populate the cache (prerequisite for a
    // superseding refetch to cancel the previous flight).
    await waitFor(() => expect(forUrl("/habitats/h1/tasks").length).toBe(1));
    await waitFor(() => expect(forUrl("/habitats/h2/tasks").length).toBe(1));
    forUrl("/habitats/h1/tasks")[0].settle(1);
    forUrl("/habitats/h2/tasks")[0].settle(1);
    await waitFor(() => expect(h1.result.current.data?.total).toBe(1));
    await waitFor(() => expect(h2.result.current.data?.total).toBe(1));

    // Task-event burst, event 1: the invalidation refetch goes in flight and
    // is deliberately held (slow server).
    const event1 = { type: "task.updated", data: makeTask({ version: 2 }) } as unknown as SSEEvent;
    await projectSSEServerEvent(event1, sseContext(event1, qc));
    await waitFor(() => expect(forUrl("/habitats/h1/tasks").length).toBe(2));
    expect(forUrl("/habitats/h1/tasks")[1].aborted).toBe(false);

    // Task-event burst, event 2: supersedes event 1's still-pending request.
    const event2 = { type: "task.updated", data: makeTask({ version: 3 }) } as unknown as SSEEvent;
    await projectSSEServerEvent(event2, sseContext(event2, qc));
    await waitFor(() => expect(forUrl("/habitats/h1/tasks").length).toBe(3));

    // The regression: the superseded flight carried a forwarded AbortSignal
    // and the superseding invalidation aborted it — the client transport
    // stops waiting on a response nobody will read (server-side execution
    // of an aborted request is not guaranteed to stop).
    const superseded = forUrl("/habitats/h1/tasks")[1];
    expect(superseded.signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(superseded.aborted).toBe(true));

    // Only the latest response lands in the cache; the query stays clean
    // (silent supersede-cancel surfaces no error).
    forUrl("/habitats/h1/tasks")[2].settle(2);
    await waitFor(() => expect(h1.result.current.data?.total).toBe(2));
    expect(h1.result.current.error).toBeNull();

    // A late body from the superseded flight cannot clobber the fresh cache
    // entry (its transport promise already rejected on abort).
    superseded.settle(99);
    await waitFor(() => expect(h1.result.current.data?.total).toBe(2));
    expect(h1.result.current.data?.total).toBe(2);

    // Unrelated habitat: exactly its initial fetch, never aborted, never
    // refetched by h1's task events.
    const h2Flights = forUrl("/habitats/h2/tasks");
    expect(h2Flights.length).toBe(1);
    expect(h2Flights[0].aborted).toBe(false);
    expect(h2.result.current.data?.total).toBe(1);

    // Exactly one aborted request in the whole run — the superseded h1 fetch.
    expect(forUrl("/habitats/h1/tasks").filter((f) => f.aborted)).toHaveLength(1);
  });
});
