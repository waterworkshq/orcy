import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useHabitatEventsInfinite, EVENTS_PAGE_SIZE } from "./useHabitatData.js";
import type { EnrichedHabitatEvent } from "../types/index.js";

const PAGE_SIZE = EVENTS_PAGE_SIZE;

function makeEvent(id: string): EnrichedHabitatEvent {
  return { id } as EnrichedHabitatEvent;
}

function eventsPage(start: number, count: number, total: number) {
  const events = Array.from({ length: count }, (_, i) => makeEvent(`e${start + i}`));
  return { events, total };
}

/** Build a fetch Response-like object the real transport (`request`) accepts. */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

function createWrapper(qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client }, children);
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("useHabitatEventsInfinite — M11 empty-page terminal guard", () => {
  it("terminates (no next page) when a page returns empty while total > rawAccumulated", async () => {
    const TOTAL = 100;
    // Real api: spy on globalThis.fetch (the transport calls fetch) and answer
    // based on the request URL's offset query param.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const offsetMatch = url.match(/[?&]offset=(\d+)/);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      if (offset === 0) return Promise.resolve(okResponse(eventsPage(0, PAGE_SIZE, TOTAL)));
      // A later page comes back empty but total still reports 100 — without the
      // empty-page guard this would loop on the same offset forever.
      return Promise.resolve(okResponse({ events: [], total: TOTAL }));
    });

    const { result } = renderHook(() => useHabitatEventsInfinite("h1"), {
      wrapper: createWrapper().wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    expect(result.current.hasNextPage).toBe(false);
    // No third fetch is attempted after the empty terminal page.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useHabitatEventsInfinite — m6 signal forwarded through the real api to fetch", () => {
  it("forwards the React Query AbortSignal to globalThis.fetch and aborts on unmount", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      seenSignals.push((init as RequestInit | undefined)?.signal ?? undefined);
      // Never resolves: the query stays in-flight so unmount is what aborts it.
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useHabitatEventsInfinite("h1"), {
      wrapper: createWrapper().wrapper,
    });

    await waitFor(() => expect(seenSignals).toHaveLength(1));
    const signal = seenSignals[0]!;
    // The signal is a real AbortSignal threaded from the hook → queryFn →
    // api.habitats.events → transport.request → fetch's RequestInit.signal.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    unmount();

    // On unmount React Query aborts the in-flight query's signal, which is the
    // SAME object handed to fetch — proving the abort reaches the network layer.
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});
