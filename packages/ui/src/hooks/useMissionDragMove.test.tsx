import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useMissionDragMove } from "./useMissionDragMove.js";
import { queryKeys } from "../lib/queryKeys.js";
import { ApiError } from "../api/transport.js";
import type { MissionWithProgress } from "../types/index.js";

const moveMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("../api/index.js", () => ({
  api: {
    missions: {
      move: (...args: any[]) => moveMock(...args),
    },
  },
}));

vi.mock("../lib/toast.js", () => ({
  notify: {
    error: (...args: any[]) => toastErrorMock(...args),
  },
}));

function makeMission(overrides: Partial<MissionWithProgress> = {}): MissionWithProgress {
  return {
    id: "m1",
    title: "Test",
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    status: "in_progress",
    habitatId: "h1",
    columnId: "col-a",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    releaseDeadlineType: null,
    releaseDeadlineVersion: null,
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
    ...overrides,
  };
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function renderHookWithQC(habitatId: string | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const detailKey = habitatId ? queryKeys.habitats.detail(habitatId) : null;
  if (detailKey) {
    qc.setQueryData(detailKey, {
      habitat: { id: habitatId! },
      columns: [],
      missions: [makeMission({ id: "m1", columnId: "col-a", version: 1 })],
    });
  }
  const result = renderHook(() => useMissionDragMove(habitatId), { wrapper: makeWrapper(qc) });
  return { ...result, qc };
}

describe("useMissionDragMove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not send a move when target equals canonical column", () => {
    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-a",
        expectedVersion: 1,
      });
    });

    expect(moveMock).not.toHaveBeenCalled();
  });

  it("sends exactly one move request on drop to a different column", async () => {
    moveMock.mockResolvedValue({
      mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }),
    });

    const { result } = renderHookWithQC("h1");

    await act(async () => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    });

    expect(moveMock).toHaveBeenCalledWith(
      "m1",
      { columnId: "col-b", expectedVersion: 1 },
      expect.any(AbortSignal),
    );
  });

  it("does not send request C before request B settles; C dispatched with B's returned version", async () => {
    let resolveB: (val: any) => void = () => {};
    const bPromise = new Promise((resolve) => {
      resolveB = resolve;
    });
    moveMock.mockReturnValueOnce(bPromise);

    const { result } = renderHookWithQC("h1");

    // Drop B: col-a → col-b (starts in-flight)
    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });

    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    expect(moveMock).toHaveBeenLastCalledWith(
      "m1",
      { columnId: "col-b", expectedVersion: 1 },
      expect.any(AbortSignal),
    );

    // Drop C: while B is in-flight, coalesce to col-c
    moveMock.mockResolvedValueOnce({
      mission: makeMission({ id: "m1", columnId: "col-c", version: 3 }),
    });

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-c",
        expectedVersion: 1,
      });
    });

    // C must NOT have been sent yet (only B is in-flight)
    expect(moveMock).toHaveBeenCalledTimes(1);

    // Resolve B with version 2
    await act(async () => {
      resolveB({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    });

    // C was dispatched with B's returned version (2)
    expect(moveMock).toHaveBeenLastCalledWith(
      "m1",
      { columnId: "col-c", expectedVersion: 2 },
      expect.any(AbortSignal),
    );
  });

  it("coalesces intermediate targets; only latest target is dispatched", async () => {
    let resolveB: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveB = resolve;
      }),
    );

    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    // Queue intermediate col-x, then latest col-c
    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-x",
        expectedVersion: 1,
      });
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-c",
        expectedVersion: 1,
      });
    });

    expect(moveMock).toHaveBeenCalledTimes(1);

    moveMock.mockResolvedValueOnce({
      mission: makeMission({ id: "m1", columnId: "col-c", version: 3 }),
    });

    await act(async () => {
      resolveB({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    });

    // Latest target (col-c) dispatched, intermediate (col-x) discarded
    expect(moveMock).toHaveBeenLastCalledWith(
      "m1",
      { columnId: "col-c", expectedVersion: 2 },
      expect.any(AbortSignal),
    );
  });

  it("does not re-dispatch when queued target equals just-completed target (compare on column)", async () => {
    let resolveB: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveB = resolve;
      }),
    );

    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    // Queue same target col-b again
    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });

    await act(async () => {
      resolveB({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
      await new Promise((r) => setTimeout(r, 50));
    });

    // Only B was sent; no spurious re-dispatch
    expect(moveMock).toHaveBeenCalledTimes(1);
  });

  it("on 409 conflict: clears queued intent, notifies user, invalidates, never auto-overwrites", async () => {
    const conflictError = new ApiError("VERSION_CONFLICT", 409);
    moveMock.mockRejectedValueOnce(conflictError);

    const { result, qc } = renderHookWithQC("h1");
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    await act(async () => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalled();
    expect(result.current.previewByMission["m1"]).toBeUndefined();
  });

  it("R4: does not abort a committed move on habitat switch; completion reconciles the captured habitat's cache", async () => {
    let resolveMove: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMove = resolve;
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.habitats.detail("h1"), {
      habitat: { id: "h1" },
      columns: [],
      missions: [makeMission({ id: "m1", columnId: "col-a", version: 1 })],
    });

    const { result, rerender } = renderHook(({ hid }: { hid: string }) => useMissionDragMove(hid), {
      initialProps: { hid: "h1" },
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    const signal = moveMock.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(result.current.previewByMission["m1"]).toBe("col-b");

    rerender({ hid: "h2" });

    // The committed move is NEVER aborted — the server may already have applied it.
    expect(signal.aborted).toBe(false);
    expect(result.current.previewByMission["m1"]).toBeUndefined();
    expect(result.current.isMoving).toBe(false);

    await act(async () => {
      resolveMove({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
      await new Promise((r) => setTimeout(r, 50));
    });

    // The captured (h1) habitat reconciles — it must not render stale-but-fresh.
    const h1Detail = qc.getQueryData<{ missions: MissionWithProgress[] }>(
      queryKeys.habitats.detail("h1"),
    );
    const cached = h1Detail?.missions.find((m) => m.id === "m1");
    expect(cached?.columnId).toBe("col-b");
    expect(cached?.version).toBe(2);
  });

  it("R4: does not abort a committed move on unmount; completion reconciles the cache", async () => {
    let resolveMove: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMove = resolve;
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.habitats.detail("h1"), {
      habitat: { id: "h1" },
      columns: [],
      missions: [makeMission({ id: "m1", columnId: "col-a", version: 1 })],
    });

    const { result, unmount } = renderHook(() => useMissionDragMove("h1"), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    const signal = moveMock.mock.calls[0][2] as AbortSignal;

    unmount();

    expect(signal.aborted).toBe(false);

    await act(async () => {
      resolveMove({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
      await new Promise((r) => setTimeout(r, 50));
    });

    const h1Detail = qc.getQueryData<{ missions: MissionWithProgress[] }>(
      queryKeys.habitats.detail("h1"),
    );
    const cached = h1Detail?.missions.find((m) => m.id === "m1");
    expect(cached?.columnId).toBe("col-b");
    expect(cached?.version).toBe(2);
  });

  it("R5: a completion does not clear a newer drag-over preview for the same mission", async () => {
    let resolveB: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveB = resolve;
      }),
    );

    const { result } = renderHookWithQC("h1");

    // Drop B: col-a → col-b (in-flight)
    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    expect(result.current.previewByMission["m1"]).toBe("col-b");

    // A newer drag-over previews col-c while B is pending.
    act(() => {
      result.current.setPreview("m1", "col-c");
    });
    expect(result.current.previewByMission["m1"]).toBe("col-c");

    // Resolving B must NOT snap the card back (clear the newer col-c preview).
    await act(async () => {
      resolveB({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
    });

    expect(result.current.previewByMission["m1"]).toBe("col-c");
  });

  it("R5: a fast follow-up drop derives expectedVersion from the just-patched cache, not the lagging prop", async () => {
    moveMock.mockResolvedValueOnce({
      mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }),
    });

    const { result, qc } = renderHookWithQC("h1");

    // Drop B (col-a → col-b, v1). Completes and patches the cache → m1 v2.
    await act(async () => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));
    });

    const detail = qc.getQueryData<{ missions: MissionWithProgress[] }>(
      queryKeys.habitats.detail("h1"),
    );
    expect(detail?.missions.find((m) => m.id === "m1")?.version).toBe(2);

    // Immediately drop C before the parent rerenders — pass the LAGGING prop (v1).
    moveMock.mockResolvedValueOnce({
      mission: makeMission({ id: "m1", columnId: "col-c", version: 3 }),
    });
    await act(async () => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-c",
        expectedVersion: 1,
      });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    });

    // The canonical version (2) was read from the just-patched cache, not the prop (1).
    expect(moveMock).toHaveBeenLastCalledWith(
      "m1",
      { columnId: "col-c", expectedVersion: 2 },
      expect.any(AbortSignal),
    );
  });

  it("R6: a drop after a habitat switch issues a fresh move, not coalesced onto the stale pre-switch entry", async () => {
    let resolveH1: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveH1 = resolve;
      }),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.habitats.detail("h1"), {
      habitat: { id: "h1" },
      columns: [],
      missions: [makeMission({ id: "m1", columnId: "col-a", version: 1 })],
    });
    qc.setQueryData(queryKeys.habitats.detail("h2"), {
      habitat: { id: "h2" },
      columns: [],
      missions: [makeMission({ id: "m1", columnId: "col-a", version: 1 })],
    });

    const { result, rerender } = renderHook(({ hid }: { hid: string }) => useMissionDragMove(hid), {
      initialProps: { hid: "h1" },
      wrapper: makeWrapper(qc),
    });

    // h1 drop B (in-flight). Entry is tagged h1.
    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    // Switch habitat. The stale h1 entry remains in the registry (not aborted).
    rerender({ hid: "h2" });

    // h2 drop for m1 must issue a fresh move immediately, NOT queue onto the h1
    // entry (which would only fire after h1 resolves, or be discarded).
    moveMock.mockResolvedValueOnce({
      mission: makeMission({ id: "m1", columnId: "col-c", version: 2 }),
    });
    await act(async () => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-c",
        expectedVersion: 1,
      });
      await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    });

    expect(moveMock).toHaveBeenLastCalledWith(
      "m1",
      { columnId: "col-c", expectedVersion: 1 },
      expect.any(AbortSignal),
    );

    // The stale h1 entry still completes and reconciles h1 (R4, no data loss).
    await act(async () => {
      resolveH1({ mission: makeMission({ id: "m1", columnId: "col-b", version: 5 }) });
      await new Promise((r) => setTimeout(r, 50));
    });
    const h1Detail = qc.getQueryData<{ missions: MissionWithProgress[] }>(
      queryKeys.habitats.detail("h1"),
    );
    expect(h1Detail?.missions.find((m) => m.id === "m1")?.columnId).toBe("col-b");
  });

  it("restorePreview returns to the in-flight target while a move is running, and clears when idle", async () => {
    let resolveMove: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMove = resolve;
      }),
    );

    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });
    await vi.waitFor(() => expect(moveMock).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.setPreview("m1", "col-c");
    });
    expect(result.current.previewByMission["m1"]).toBe("col-c");

    act(() => {
      result.current.restorePreview("m1");
    });
    expect(result.current.previewByMission["m1"]).toBe("col-b");

    await act(async () => {
      resolveMove({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
    });

    expect(result.current.isMoving).toBe(false);

    act(() => {
      result.current.restorePreview("m1");
    });
    expect(result.current.previewByMission["m1"]).toBeUndefined();
  });

  it("sets preview immediately on dragOver for instant visual feedback", () => {
    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.setPreview("m1", "col-c");
    });

    expect(result.current.previewByMission["m1"]).toBe("col-c");
    expect(result.current.isMoving).toBe(false);
  });

  it("reports isMoving true while a move is in-flight", async () => {
    let resolveMove: (val: any) => void = () => {};
    moveMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMove = resolve;
      }),
    );

    const { result } = renderHookWithQC("h1");

    act(() => {
      result.current.drop({
        missionId: "m1",
        canonicalColumnId: "col-a",
        targetColumnId: "col-b",
        expectedVersion: 1,
      });
    });

    expect(result.current.isMoving).toBe(true);

    await act(async () => {
      resolveMove({ mission: makeMission({ id: "m1", columnId: "col-b", version: 2 }) });
    });

    expect(result.current.isMoving).toBe(false);
  });
});
