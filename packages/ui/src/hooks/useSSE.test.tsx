import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useSSE } from "./useSSE.js";

const { storeState, mockHandleSSEEvent } = vi.hoisted(() => ({
  storeState: { handleSSEEvent: vi.fn(), recentSSEEvents: [] as unknown[] },
  mockHandleSSEEvent: vi.fn(),
}));
storeState.handleSSEEvent = mockHandleSSEEvent;

vi.mock("../store/habitatStore.js", () => ({
  useHabitatStore: Object.assign(() => storeState, { getState: () => storeState }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<any>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
      cancelQueries: vi.fn().mockResolvedValue(undefined),
      getQueryData: vi.fn(),
      setQueryData: vi.fn(),
      resetQueries: vi.fn(),
    }),
  };
});

interface MockEventSource {
  url: string;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  deliver: (data: string) => void;
  fireError: () => void;
}

const originalEventSource = globalThis.EventSource;

function installMockEventSource() {
  const instances: MockEventSource[] = [];
  (globalThis as any).EventSource = function (url: string) {
    const handlers: Record<string, ((...args: any[]) => void) | undefined> = {};
    const inst: MockEventSource = {
      url,
      close: vi.fn(() => {
        handlers["message"] = undefined;
        handlers["error"] = undefined;
      }),
      addEventListener: vi.fn((type: string, fn: any) => {
        handlers[type] = fn;
      }),
      deliver: (data: string) => handlers["message"]?.({ data }),
      fireError: () => handlers["error"]?.(),
    };
    instances.push(inst);
    return inst as any;
  };
  return instances;
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe("useSSE", () => {
  let instances: MockEventSource[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleSSEEvent.mockReset();
    instances = installMockEventSource();
    (globalThis as any).localStorage = { getItem: vi.fn(() => null) } as any;
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  async function waitForConnect() {
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  }

  it("connects to the habitat SSE stream (unauthenticated path)", async () => {
    renderHook(() => useSSE("b1"), { wrapper });
    await waitForConnect();
    expect(instances[0].url).toBe("/sse/habitats/b1/stream");
  });

  it("projects fresh-generation events through the server projector", async () => {
    const { result } = renderHook(() => useSSE("b1"), { wrapper });
    void result;
    await waitForConnect();

    act(() => {
      instances[0].deliver(
        JSON.stringify({
          type: "mission.progress",
          data: { missionId: "m1", completed: 1, total: 2 },
        }),
      );
    });

    expect(mockHandleSSEEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores events delivered by a stale generation after a habitat switch", async () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), {
      wrapper,
      initialProps: { id: "A" },
    });
    await waitForConnect();
    const staleStream = instances[0];

    rerender({ id: "B" });
    await waitForConnect();

    const before = mockHandleSSEEvent.mock.calls.length;
    act(() => {
      staleStream.deliver(
        JSON.stringify({
          type: "mission.progress",
          data: { missionId: "m1", completed: 1, total: 2 },
        }),
      );
    });

    expect(mockHandleSSEEvent.mock.calls.length).toBe(before);
  });

  it("closes the stale generation's stream on habitat switch", async () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), {
      wrapper,
      initialProps: { id: "A" },
    });
    await waitForConnect();
    const staleStream = instances[0];

    rerender({ id: "B" });
    await waitForConnect();

    expect(staleStream.close).toHaveBeenCalled();
  });

  it("aborts a pending stream-token request on habitat switch and never installs the stale stream", async () => {
    const tokenRequests: {
      signal: AbortSignal;
      resolve: (v: unknown) => void;
    }[] = [];
    (globalThis as any).fetch = vi.fn((url: string, opts?: { signal?: AbortSignal }) => {
      if (String(url).includes("/api/auth/stream-token")) {
        return new Promise((resolve) => {
          tokenRequests.push({ signal: opts!.signal as AbortSignal, resolve });
          opts?.signal?.addEventListener("abort", () => resolve({ ok: false }));
        });
      }
      return Promise.resolve({ ok: false });
    });
    (globalThis as any).localStorage = { getItem: vi.fn(() => "token") } as any;

    const { rerender } = renderHook(({ id }) => useSSE(id), {
      wrapper,
      initialProps: { id: "A" },
    });
    await waitFor(() => expect(tokenRequests.length).toBe(1));
    const aRequest = tokenRequests[0];

    rerender({ id: "B" });
    await waitFor(() => expect(tokenRequests.length).toBe(2));
    tokenRequests[1].resolve({ ok: false });
    await waitForConnect();

    expect(aRequest.signal.aborted).toBe(true);
    const streamUrls = instances.map((i) => i.url);
    expect(streamUrls.every((u) => !u.includes("/habitats/A/"))).toBe(true);
    expect(streamUrls.some((u) => u.includes("/habitats/B/"))).toBe(true);
  });

  it("does not navigate on a stale habitat.deleted for the old subscription", async () => {
    const { rerender } = renderHook(({ id }) => useSSE(id), {
      wrapper,
      initialProps: { id: "A" },
    });
    await waitForConnect();
    const staleStream = instances[0];
    const originalHash = window.location.hash;

    rerender({ id: "B" });
    await waitForConnect();

    act(() => {
      staleStream.deliver(JSON.stringify({ type: "habitat.deleted", data: { habitatId: "A" } }));
    });

    expect(window.location.hash).toBe(originalHash);
  });

  it("navigates home on an active-subscription habitat.deleted", async () => {
    renderHook(() => useSSE("A"), { wrapper });
    await waitForConnect();

    act(() => {
      instances[0].deliver(JSON.stringify({ type: "habitat.deleted", data: { habitatId: "A" } }));
    });

    expect(window.location.hash).toBe("#/");
  });

  it("parses bad payloads without throwing", async () => {
    renderHook(() => useSSE("b1"), { wrapper });
    await waitForConnect();

    expect(() => {
      act(() => instances[0].deliver("not-json"));
    }).not.toThrow();
    expect(mockHandleSSEEvent).not.toHaveBeenCalled();
  });

  it("tears down the stream and aborts on unmount", async () => {
    const { unmount } = renderHook(() => useSSE("b1"), { wrapper });
    await waitForConnect();
    const stream = instances[0];

    unmount();

    expect(stream.close).toHaveBeenCalled();
  });
});
