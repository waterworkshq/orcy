import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useArchivedMissionsInfinite } from "./useHabitatData.js";
import type { MissionWithProgress } from "../types/index.js";

function makeMission(id: string): MissionWithProgress {
  return {
    id,
    habitatId: "h1",
    columnId: "c1",
    title: `Archived ${id}`,
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    labels: [],
    status: "done",
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "a1",
    createdAt: "",
    updatedAt: "",
    version: 1,
    isArchived: true,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    releaseDeadlineType: null,
    releaseDeadlineVersion: null,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    progress: {
      total: 0,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
  };
}

const PAGE_SIZE = 50;
const TOTAL = 130;

function page(start: number, count: number, ids: string[] = []) {
  const missions = Array.from({ length: count }, (_, i) =>
    makeMission(ids[start + i] ?? `m${start + i}`),
  );
  return { missions, total: TOTAL };
}

vi.mock("../api/index.js", () => ({
  api: {
    missions: {
      list: vi.fn(),
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

describe("useArchivedMissionsInfinite (3-page fixture)", () => {
  it("walks three pages using raw-cardinality offsets, then terminates", async () => {
    const mockList = api.missions.list as ReturnType<typeof vi.fn>;
    mockList.mockImplementation((_habitat: string, filters: { offset?: number }) => {
      const offset = filters.offset ?? 0;
      if (offset === 0) return Promise.resolve(page(0, PAGE_SIZE));
      if (offset === PAGE_SIZE) return Promise.resolve(page(PAGE_SIZE, PAGE_SIZE));
      if (offset === PAGE_SIZE * 2)
        return Promise.resolve(page(PAGE_SIZE * 2, TOTAL - PAGE_SIZE * 2));
      return Promise.resolve({ missions: [], total: TOTAL });
    });

    const { result } = renderHook(() => useArchivedMissionsInfinite("h1"), {
      wrapper: createWrapper().wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages).toHaveLength(1);
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(api.missions.list).toHaveBeenLastCalledWith(
      "h1",
      expect.objectContaining({ offset: PAGE_SIZE }),
      expect.anything(),
    );

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(3));
    expect(api.missions.list).toHaveBeenLastCalledWith(
      "h1",
      expect.objectContaining({ offset: PAGE_SIZE * 2 }),
      expect.anything(),
    );

    expect(result.current.hasNextPage).toBe(false);
  });

  it("flattens and deduplicates the render projection", async () => {
    const shared = makeMission("dup");
    const mockList = api.missions.list as ReturnType<typeof vi.fn>;
    mockList.mockImplementation((_habitat: string, filters: { offset?: number }) => {
      const offset = filters.offset ?? 0;
      if (offset === 0)
        return Promise.resolve({ missions: [shared, ...page(0, 9).missions], total: 15 });
      return Promise.resolve({ missions: [shared, ...page(10, 5).missions], total: 15 });
    });

    const { result } = renderHook(() => useArchivedMissionsInfinite("h1"), {
      wrapper: createWrapper().wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.fetchNextPage({ cancelRefetch: false });
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

    const pages = result.current.data?.pages ?? [];
    const seen = new Set<string>();
    const flattened: MissionWithProgress[] = [];
    for (const p of pages) {
      for (const m of p.missions) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        flattened.push(m);
      }
    }
    expect(flattened).toHaveLength(15);
    expect(flattened.filter((m) => m.id === "dup")).toHaveLength(1);
  });

  it("discards accumulated pages and refetches offset zero on Habitat/key change (generation reset)", async () => {
    const mockList = api.missions.list as ReturnType<typeof vi.fn>;
    const h1Page = { missions: [makeMission("h1m1"), makeMission("h1m2")], total: 2 };
    const h2Page = { missions: [makeMission("h2m1")], total: 1 };
    mockList.mockImplementation((habitat: string, filters: { offset?: number }) => {
      const offset = filters.offset ?? 0;
      if (offset !== 0) return Promise.resolve({ missions: [], total: 0 });
      return Promise.resolve(habitat === "h1" ? h1Page : h2Page);
    });

    const { wrapper } = createWrapper();

    let currentHabitat = "h1";
    const { result, rerender } = renderHook(() => useArchivedMissionsInfinite(currentHabitat), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0].missions.map((m) => m.id)).toEqual(["h1m1", "h1m2"]);

    currentHabitat = "h2";
    rerender();

    await waitFor(() =>
      expect(result.current.data?.pages[0].missions.map((m) => m.id)).toEqual(["h2m1"]),
    );
    expect(api.missions.list).toHaveBeenLastCalledWith(
      "h2",
      expect.objectContaining({ offset: 0 }),
      expect.anything(),
    );
    expect(result.current.data?.pages).toHaveLength(1);
  });
});
