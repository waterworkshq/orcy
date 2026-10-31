import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  describe("burst coalescing — habitat-scope invalidations are windowed per QueryClient", () => {
    it("100-event synchronous burst (single listener stack) also coalesces to one refetch", async () => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();
      const h1Lists = habitatVariants.map((v) => observe(keys.habitatTasks("h1", v.filters)));
      for (const o of h1Lists) await awaitRevision(o, 1);

      serverRevision.value = 2;
      for (let i = 0; i < 100; i++) {
        const event = {
          type: "task.updated",
          data: makeTask({ id: `t${i}`, version: 2 }),
        } as unknown as SSEEvent;
        void projectSSEServerEvent(event, ctx(event, qc));
      }

      for (const o of h1Lists) await awaitRevision(o, 2);
      await settle();
      for (const v of habitatVariants) {
        const s = state(keys.habitatTasks("h1", v.filters));
        expect(s.data, v.label).toBe(2);
        expect(s.fetches, v.label).toBeLessThanOrEqual(2);
      }
    });

    it("two QueryClients in the same window each flush their own state (no shared flag, no cross-client loss)", async () => {
      const a = setup();
      const b = setup();
      const aList = a.observe(a.keys.habitatTasks("h1", {}));
      const bList = b.observe(b.keys.habitatTasks("h1", {}));
      await a.awaitRevision(aList, 1);
      await b.awaitRevision(bList, 1);

      a.serverRevision.value = 2;
      b.serverRevision.value = 2;
      // Client A bursts 100 events for h1; client B schedules ONE h1 event in
      // the SAME window. A shared scheduled-flag across clients would ride B's
      // habitat on A's timer and B would never flush — B must still advance.
      for (let i = 0; i < 100; i++) {
        const event = {
          type: "task.updated",
          data: makeTask({ id: `t${i}`, version: 2 }),
        } as unknown as SSEEvent;
        void projectSSEServerEvent(event, ctx(event, a.qc));
      }
      const bEvent = {
        type: "task.updated",
        data: makeTask({ id: "bx", version: 2 }),
      } as unknown as SSEEvent;
      void projectSSEServerEvent(bEvent, ctx(bEvent, b.qc));

      await a.awaitRevision(aList, 2);
      await b.awaitRevision(bList, 2);
      await a.settle();
      expect(a.state(a.keys.habitatTasks("h1", {})).fetches).toBe(2);
      expect(b.state(b.keys.habitatTasks("h1", {})).fetches).toBe(2);
    });

    it("drip slower than the window still lands the latest revision — no starvation, no dropped tail", async () => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();
      const h1List = observe(keys.habitatTasks("h1", {}));
      await awaitRevision(h1List, 1);

      // Each event gets its own generation (spacing > coalesce window): the
      // honest ceiling — spaced events refetch per event, exactly like today,
      // and the LAST event's revision must still land (nothing dropped).
      for (let i = 0; i < 5; i++) {
        serverRevision.value = i + 2;
        const event = {
          type: "task.updated",
          data: makeTask({ id: `d${i}`, version: i + 2 }),
        } as unknown as SSEEvent;
        void projectSSEServerEvent(event, ctx(event, qc));
        await new Promise((r) => setTimeout(r, 80));
      }
      await settle();
      const s = state(keys.habitatTasks("h1", {}));
      expect(s.data).toBe(6);
      expect(s.fetches).toBeGreaterThanOrEqual(2);
      expect(s.fetches).toBeLessThanOrEqual(6);
    });
  });

  describe("generation fence — a retired subscription's queued invalidation never fires", () => {
    it("generation retires AFTER enqueue ⇒ zero invalidation, zero fetch (stale gen never effects)", async () => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();
      const h1List = observe(keys.habitatTasks("h1", {}));
      const habitatDetail = observe(keys.habitatDetail);
      await awaitRevision(h1List, 1);
      await awaitRevision(habitatDetail, 1);

      serverRevision.value = 2;
      let active = true;
      const event = {
        type: "task.updated",
        data: makeTask({ version: 2 }),
      } as unknown as SSEEvent;
      await projectSSEServerEvent(event, ctx(event, qc, { isActive: () => active }));
      active = false; // subscription retires before the window flushes
      await settle();

      expect(state(keys.habitatTasks("h1", {}))).toEqual({ data: 1, fetches: 1 });
      expect(state(keys.habitatDetail)).toEqual({ data: 1, fetches: 1 });
    });

    it("live guard FIRST, retired guard LAST — dropping to a last-write-wins guard must not suppress the flush", async () => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();
      const h1List = observe(keys.habitatTasks("h1", {}));
      await awaitRevision(h1List, 1);

      serverRevision.value = 2;
      const live = {
        type: "task.updated",
        data: makeTask({ id: "live", version: 2 }),
      } as unknown as SSEEvent;
      await projectSSEServerEvent(live, ctx(live, qc, { isActive: () => true }));
      let retired = true;
      const dead = {
        type: "task.updated",
        data: makeTask({ id: "dead", version: 2 }),
      } as unknown as SSEEvent;
      await projectSSEServerEvent(dead, ctx(dead, qc, { isActive: () => retired }));
      retired = false;

      await awaitRevision(h1List, 2);
      await settle();
      expect(state(keys.habitatTasks("h1", {}))).toEqual({ data: 2, fetches: 2 });
    });

    it("retired guard FIRST, live guard LAST — flush still fires (any-active wins)", async () => {
      const { qc, serverRevision, observe, awaitRevision, settle, state, keys } = setup();
      const h1List = observe(keys.habitatTasks("h1", {}));
      await awaitRevision(h1List, 1);

      serverRevision.value = 2;
      let retired = true;
      const dead = {
        type: "task.updated",
        data: makeTask({ id: "dead", version: 2 }),
      } as unknown as SSEEvent;
      await projectSSEServerEvent(dead, ctx(dead, qc, { isActive: () => retired }));
      retired = false;
      const live = {
        type: "task.updated",
        data: makeTask({ id: "live", version: 2 }),
      } as unknown as SSEEvent;
      await projectSSEServerEvent(live, ctx(live, qc, { isActive: () => true }));

      await awaitRevision(h1List, 2);
      await settle();
      expect(state(keys.habitatTasks("h1", {}))).toEqual({ data: 2, fetches: 2 });
    });
  });

  describe("timer window determinism (fake timers — no load assumptions)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Settle promise-only (observer fetch/notify) chains without advancing the clock. */
    const drainMicrotasks = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it("macrotask-dispatched 100-event burst (microtask checkpoint after every listener) flushes exactly ONCE at the window boundary", async () => {
      const { qc, serverRevision, observe, state, keys } = setup();
      const h1Lists = habitatVariants.map((v) => observe(keys.habitatTasks("h1", v.filters)));
      const h2List = observe(keys.habitatTasks("h2", {}));
      const habitatDetail = observe(keys.habitatDetail);
      await drainMicrotasks();

      serverRevision.value = 2;
      // Real EventSource dispatch shape: every message is its own macrotask,
      // and a microtask checkpoint runs after EVERY listener
      // (advanceTimersByTimeAsync flushes microtasks between callbacks). A
      // queueMicrotask-only coalescer flushes between every pair of these and
      // issues one request per event — that variant must FAIL this test.
      for (let i = 0; i < 100; i++) {
        setTimeout(() => {
          const event = {
            type: "task.updated",
            data: makeTask({ id: `t${i}`, version: 2 }),
          } as unknown as SSEEvent;
          void projectSSEServerEvent(event, ctx(event, qc));
        }, 0);
      }

      await vi.advanceTimersByTimeAsync(49); // the whole burst dispatches; window NOT elapsed
      for (const v of habitatVariants) {
        expect(state(keys.habitatTasks("h1", v.filters)).fetches, `49ms ${v.label}`).toBe(1);
      }
      await vi.advanceTimersByTimeAsync(1); // boundary: the single flush fires
      await drainMicrotasks();
      for (const v of habitatVariants) {
        const s = state(keys.habitatTasks("h1", v.filters));
        expect(s.data, v.label).toBe(2);
        expect(s.fetches, v.label).toBe(2);
      }
      const detail = state(keys.habitatDetail);
      expect(detail.data).toBe(2);
      expect(detail.fetches).toBe(2);
      // Negative control: unrelated habitat untouched by the burst.
      expect(state(keys.habitatTasks("h2", {}))).toEqual({ data: 1, fetches: 1 });
      await vi.advanceTimersByTimeAsync(200); // nothing pending: no second flush
      for (const v of habitatVariants) {
        expect(state(keys.habitatTasks("h1", v.filters)).fetches, v.label).toBe(2);
      }
    });

    it("sustained 5ms drip (40 events over 200ms) flushes at window cadence — bounded requests, no starvation, final revision lands", async () => {
      const { qc, serverRevision, observe, state, keys } = setup();
      const h1List = observe(keys.habitatTasks("h1", {}));
      await drainMicrotasks();

      for (let i = 0; i < 40; i++) {
        setTimeout(() => {
          serverRevision.value = i + 2;
          const event = {
            type: "task.updated",
            data: makeTask({ id: `s${i}`, version: i + 2 }),
          } as unknown as SSEEvent;
          void projectSSEServerEvent(event, ctx(event, qc));
        }, i * 5);
      }
      await vi.advanceTimersByTimeAsync(300);
      await drainMicrotasks();

      const s = state(keys.habitatTasks("h1", {}));
      expect(s.data).toBe(41); // the LAST event's revision landed — not starved, not dropped
      expect(s.fetches).toBeGreaterThanOrEqual(2);
      expect(s.fetches).toBeLessThanOrEqual(8); // window cadence, never per-event (41)
    });
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
