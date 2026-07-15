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

vi.mock("../api/index.js", () => ({
  api: {
    habitats: {
      events: vi.fn(),
    },
  },
}));

import { api } from "../api/index.js";

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
  vi.clearAllMocks();
});

describe("useHabitatEventsInfinite — M11 empty-page terminal guard", () => {
  it("terminates (no next page) when a page returns empty while total > rawAccumulated", async () => {
    const TOTAL = 100;
    const mockEvents = api.habitats.events as ReturnType<typeof vi.fn>;
    mockEvents.mockImplementation((_habitat: string, filters: { offset?: number }) => {
      const offset = filters.offset ?? 0;
      if (offset === 0) return Promise.resolve(eventsPage(0, PAGE_SIZE, TOTAL));
      // A later page comes back empty but total still reports 100 — without the
      // empty-page guard this would loop on the same offset forever.
      return Promise.resolve({ events: [], total: TOTAL });
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
    expect(api.habitats.events).toHaveBeenCalledTimes(2);
  });
});

describe("useHabitatEventsInfinite — m6 signal forwarded (abort on unmount)", () => {
  it("forwards the React Query AbortSignal to api.habitats.events", async () => {
    const capturedSignals: AbortSignal[] = [];
    const mockEvents = api.habitats.events as ReturnType<typeof vi.fn>;
    mockEvents.mockImplementation((_habitat: string, _filters: unknown, signal?: AbortSignal) => {
      capturedSignals.push(signal!);
      return new Promise(() => {});
    });

    const { unmount } = renderHook(() => useHabitatEventsInfinite("h1"), {
      wrapper: createWrapper().wrapper,
    });

    await waitFor(() => expect(capturedSignals.length).toBe(1));
    expect(capturedSignals[0].aborted).toBe(false);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);

    unmount();

    await waitFor(() => expect(capturedSignals[0].aborted).toBe(true));
  });
});
