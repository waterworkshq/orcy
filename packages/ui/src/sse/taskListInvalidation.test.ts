import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { projectSSEServerEvent } from "./registry.js";
import { queryKeys } from "../lib/queryKeys.js";
import type { ServerProjectionContext } from "./types.js";
import type { SSEEvent, Task } from "../types/index.js";

/**
 * Issue regression: task lifecycle SSE events must invalidate the affected
 * habitat's task-list QUERY PREFIX (`["habitats","tasks",habitatId]`) so every
 * filtered/paginated variant with an active observer actually refetches.
 *
 * Determinism contract:
 *   - Real `projectSSEServerEvent` and real `QueryObserver`s (no renderer, no
 *     EventSource) — exactly the cache-level reproduction from the issue.
 *   - Controlled "server" revisions: every fetch returns the CURRENT revision
 *     and bumps a per-key fetch counter, so `fetches` proves an actual refetch
 *     happened and `data.revision` proves the observer's current data advanced
 *     (not just that an invalidation-spy was called).
 *   - `staleTime: Infinity` + `refetchOnWindowFocus: false` — deliberately
 *     STRICTER than the production `sessionState.tsx` defaults (staleTime
 *     60_000; refetchOnWindowFocus false does mirror production): the
 *     observers can never refetch on a timer, only when the projector
 *     invalidates them. Stale-time or window-focus noise cannot fake a pass.
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

interface Revisioned {
  revision: number;
}

/** The production key variants an active task table / sprint dashboard holds. */
const habitatVariants: { label: string; filters?: Record<string, unknown> }[] = [
  { label: "unfiltered (SprintDashboard: useHabitatTasks(habitatId, {}))", filters: {} },
  {
    label: "filtered+paginated (TaskTableView)",
    filters: {
      status: "in_progress",
      search: "fix",
      assignedAgentId: "a1",
      isArchived: false,
      limit: 50,
      offset: 0,
      sortBy: "priority",
      sortDir: "desc",
    },
  },
];

function ctx(
  event: SSEEvent,
  qc: QueryClient,
  overrides: Partial<ServerProjectionContext> = {},
): ServerProjectionContext {
  return {
    event,
    queryClient: qc,
    subscriptionHabitatId: "h1",
    routeHabitatId: "h1",
    isActive: () => true,
    navigateHome: vi.fn(),
    ...overrides,
  };
}

/**
 * The controlled server. Every family serves `{revision}` from a shared
 * `serverRevision`; each queryFn invocation bumps its key's fetch counter.
 */
function setup() {
  const serverRevision = { value: 1 };
  const fetches = new Map<string, number>();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });

  function observe(key: readonly unknown[]) {
    const hash = JSON.stringify(key);
    const observer = new QueryObserver<Revisioned>(qc, {
      queryKey: key,
      queryFn: () => {
        fetches.set(hash, (fetches.get(hash) ?? 0) + 1);
        return Promise.resolve({ revision: serverRevision.value });
      },
      staleTime: Infinity,
      retry: false,
    });
    observer.subscribe(() => {});
    return observer;
  }

  async function awaitRevision(observer: QueryObserver<Revisioned>, revision: number) {
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data?.revision).toBe(revision);
    });
  }

  /**
   * Positive controls elsewhere in the test prove an invalidation-driven
   * refetch completes well inside this window; anything that has NOT refetched
   * after it stayed put because nothing invalidated it.
   */
  async function settle() {
    await new Promise((r) => setTimeout(r, 50));
  }

  const state = (key: readonly unknown[]) => ({
    data: (qc.getQueryData(key) as Revisioned | undefined)?.revision,
    fetches: fetches.get(JSON.stringify(key)) ?? 0,
  });

  const keys = {
    habitatTasks: (habitatId: string, filters?: Record<string, unknown>) =>
      queryKeys.habitats.tasks(habitatId, filters as never),
    missionTasks: queryKeys.missions.tasks("m1"),
    taskDetail: queryKeys.tasks.detail("t1"),
    habitatDetail: queryKeys.habitats.detail("h1"),
  };

  return { qc, serverRevision, observe, awaitRevision, settle, state, keys };
}

describe("issue — task SSE events refresh active habitat task-list observers", () => {
  const taskEvents: { type: SSEEvent["type"]; data: unknown }[] = [
    { type: "task.created", data: makeTask() },
    { type: "task.updated", data: makeTask({ version: 2 }) },
    { type: "task.deleted", data: { taskId: "t1" } },
  ];

  it.each(taskEvents)(
    "$type through the real projector refetches the affected habitat's task lists",
    async ({ type, data }) => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();

      // Active observers with production keys: the affected habitat's list in
      // both production variants, an unrelated habitat's list (negative
      // control), and the detail families the lifecycle already refreshes.
      const h1Lists = habitatVariants.map((v) => observe(keys.habitatTasks("h1", v.filters)));
      const h2List = observe(keys.habitatTasks("h2", {}));
      const missionList = observe(keys.missionTasks);
      const taskDetail = observe(keys.taskDetail);
      const habitatDetail = observe(keys.habitatDetail);

      for (const o of [...h1Lists, h2List, missionList, taskDetail, habitatDetail]) {
        await awaitRevision(o, 1);
      }

      serverRevision.value = 2;
      const event = { type, data } as unknown as SSEEvent;
      await projectSSEServerEvent(event, ctx(event, qc));

      // The regression: the affected habitat's task-list observers must
      // actually refetch — filtered and paginated variants included, via
      // PREFIX matching rather than exact filter-object equality.
      for (const o of h1Lists) await awaitRevision(o, 2);
      for (const v of habitatVariants) {
        expect(state(keys.habitatTasks("h1", v.filters)), `${type} → ${v.label}`).toEqual({
          data: 2,
          fetches: 2,
        });
      }

      // Existing detail behavior remains: task detail + habitat detail refreshed.
      await awaitRevision(taskDetail, 2);
      await awaitRevision(habitatDetail, 2);
      expect(state(keys.taskDetail)).toEqual({ data: 2, fetches: 2 });
      expect(state(keys.habitatDetail)).toEqual({ data: 2, fetches: 2 });

      await settle();
      // Negative control: the unrelated habitat's task list is untouched — no
      // cross-habitat (global) invalidation.
      expect(state(keys.habitatTasks("h2", {}))).toEqual({ data: 1, fetches: 1 });

      // The task event itself does not own the mission task-list family (that
      // is the companion mission-progress compensation path, asserted below).
      expect(state(keys.missionTasks)).toEqual({ data: 1, fetches: 1 });
    },
  );

  it("mission.progress companion compensates mission lists but is NOT a habitat task-list refresh", async () => {
    const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();

    const h1List = observe(keys.habitatTasks("h1", {}));
    const missionList = observe(keys.missionTasks);
    await awaitRevision(h1List, 1);
    await awaitRevision(missionList, 1);

    serverRevision.value = 2;
    const progress: SSEEvent = {
      type: "mission.progress",
      data: { missionId: "m1", completed: 2, total: 4 },
    };
    await projectSSEServerEvent(progress, ctx(progress, qc));

    await awaitRevision(missionList, 2);
    expect(state(keys.missionTasks)).toEqual({ data: 2, fetches: 2 });
    await settle();
    // The companion event must never substitute for habitat task-list coverage.
    expect(state(keys.habitatTasks("h1", {}))).toEqual({ data: 1, fetches: 1 });
  });

  it("companion sequence task.updated + mission.progress leaves BOTH families current", async () => {
    const { qc, serverRevision, observe, awaitRevision, state, keys } = setup();

    const h1List = observe(keys.habitatTasks("h1", {}));
    const missionList = observe(keys.missionTasks);
    await awaitRevision(h1List, 1);
    await awaitRevision(missionList, 1);

    serverRevision.value = 2;
    const updated = {
      type: "task.updated",
      data: makeTask({ version: 2 }),
    } as unknown as SSEEvent;
    await projectSSEServerEvent(updated, ctx(updated, qc));
    const progress: SSEEvent = {
      type: "mission.progress",
      data: { missionId: "m1", completed: 2, total: 4 },
    };
    await projectSSEServerEvent(progress, ctx(progress, qc));

    await awaitRevision(missionList, 2);
    await awaitRevision(h1List, 2);
    expect(state(keys.missionTasks)).toEqual({ data: 2, fetches: 2 });
    expect(state(keys.habitatTasks("h1", {}))).toEqual({ data: 2, fetches: 2 });
  });

  it("control: explicit task-list invalidation refreshes the same observers (observer wiring is sound)", async () => {
    const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();

    const h1Lists = habitatVariants.map((v) => observe(keys.habitatTasks("h1", v.filters)));
    const h2List = observe(keys.habitatTasks("h2", {}));
    for (const o of [...h1Lists, h2List]) await awaitRevision(o, 1);

    serverRevision.value = 2;
    void qc.invalidateQueries({
      queryKey: [...queryKeys.habitats.all, "tasks", "h1"],
    });
    for (const o of h1Lists) await awaitRevision(o, 2);

    for (const v of habitatVariants) {
      expect(state(keys.habitatTasks("h1", v.filters))).toEqual({ data: 2, fetches: 2 });
    }
    await settle();
    expect(state(keys.habitatTasks("h2", {}))).toEqual({ data: 1, fetches: 1 });
  });
});
