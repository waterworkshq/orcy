import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import React from "react";
import type { Mock } from "vitest";
import { useSSE } from "./useSSE.js";
import { queryKeys } from "../lib/queryKeys.js";
import type { SSEEvent } from "../types/index.js";

const { storeState, mockHandleSSEEvent } = vi.hoisted(() => ({
  storeState: { handleSSEEvent: vi.fn(), recentSSEEvents: [] as unknown[] },
  mockHandleSSEEvent: vi.fn(),
}));
storeState.handleSSEEvent = mockHandleSSEEvent;

vi.mock("../store/habitatStore.js", () => ({
  useHabitatStore: Object.assign(() => storeState, { getState: () => storeState }),
}));

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

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function captureMessageHandler(inst: MockEventSource) {
  const calls = (inst.addEventListener as Mock).mock.calls;
  const pair = calls.find((c) => c[0] === "message");
  return pair![1] as (e: { data: string }) => void;
}

describe("useSSE — M10 commit-to-cleanup window (real QueryClient)", () => {
  let instances: MockEventSource[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleSSEEvent.mockReset();
    instances = installMockEventSource();
    (globalThis as any).localStorage = { getItem: vi.fn(() => null) } as any;
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    if (window.location.hash) window.location.hash = "";
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it("a stale-generation event delivered in the commit-to-cleanup window performs no effect", async () => {
    const client = makeQueryClient();
    // Seed habitat A's detail cache with an active mission. A stale archive
    // event for A delivered during the A->B window must not evict it, and must
    // not touch the store or navigate.
    client.setQueryData(queryKeys.habitats.detail("A"), {
      habitat: { id: "A" },
      columns: [],
      missions: [{ id: "m1", habitatId: "A", version: 5 } as never],
    });
    const archivePayload: SSEEvent = {
      type: "mission.updated",
      data: { id: "m1", habitatId: "A", version: 4, isArchived: true } as never,
    };

    const { rerender } = renderHook(({ id }) => useSSE(id), {
      wrapper: wrapperWith(client),
      initialProps: { id: "A" },
    });
    await waitFor(() => expect(instances.length).toBe(1));

    // Capture the stale subscription's listener before any cleanup can run.
    const staleHandler = captureMessageHandler(instances[0]);
    const missionsBefore = client.getQueryData<{ missions: { id: string; version: number }[] }>(
      queryKeys.habitats.detail("A"),
    )!.missions;

    // flushSync forces the re-render + layout effects synchronously (committed
    // habitat becomes B) while DEFERRING passive-effect cleanup (the generation
    // is NOT bumped yet). This is the exact window M10 exploits.
    flushSync(() => {
      rerender({ id: "B" });
    });

    // Deliver the stale A event in the window: generation still matches, but the
    // committed habitat (B) no longer matches the subscription (A).
    staleHandler({ data: JSON.stringify(archivePayload) });

    // Store: handleSSEEvent never ran.
    expect(mockHandleSSEEvent).not.toHaveBeenCalled();
    // Cache: the newer active entry is intact (archive did not evict it).
    const missionsAfter = client.getQueryData<{
      missions: { id: string; version: number }[];
    }>(queryKeys.habitats.detail("A"))!.missions;
    expect(missionsAfter).toEqual(missionsBefore);
    expect(missionsAfter.some((m) => m.id === "m1")).toBe(true);
    // Navigation: no redirect.
    expect(window.location.hash).not.toBe("#/");

    // Let the deferred passive effects flush: A tears down, B connects.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(instances.some((i) => i.url.includes("/habitats/B/"))).toBe(true));
  });
});
