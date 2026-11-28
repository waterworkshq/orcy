/**
 * Scheduled overdue scan (issue #405): Mission due and SLA deadlines are
 * compared with the current instant, so a canonical ISO deadline that elapsed
 * earlier the same UTC day emits `task.overdue` today instead of at the next
 * date change.
 *
 * Runs the real `checkOverdueTasks` query against the disposable test
 * database. The matching rule's `notify` has no recipients, so nothing is
 * delivered.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { createHabitat } from "../services/habitatService.js";
import { createAutomationRule } from "../repositories/automationRule.js";
import { listRunsByRule } from "../repositories/automationRuleRun.js";
import { createMission, updateMission } from "../repositories/mission.js";
import { createTask } from "../repositories/task.js";
import { checkOverdueTasks } from "../services/scheduler.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

const NOW = new Date("2026-10-17T12:00:00.500Z");
const ELAPSED = "2026-10-17T11:59:00.000Z";
const FUTURE = "2026-10-17T12:01:00.000Z";

type Deadline = "dueAt" | "slaDeadlineAt";
type Deadlines = Partial<Record<Deadline, string | null>>;

let owner: { habitatId: string; columnId: string };

beforeEach(async () => {
  await initTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  owner = newOwner("Overdue scan");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  closeDb();
});

function newOwner(name: string) {
  const { habitat, columns } = createHabitat({ name, defaultColumns: true });
  return { habitatId: habitat.id, columnId: columns[0].id };
}

/** Creates an open Task whose Mission carries the given stored deadlines. */
function openTask(deadlines: Deadlines, habitat = owner) {
  const mission = createMission({
    habitatId: habitat.habitatId,
    columnId: habitat.columnId,
    title: "Deadline",
    createdBy: "test-user",
    dueAt: deadlines.dueAt ?? null,
  });
  // The SLA deadline column has no route-level writer, so store it directly.
  updateMission(mission.id, { slaDeadlineAt: deadlines.slaDeadlineAt ?? null });
  const task = createTask({ missionId: mission.id, title: "Open task", createdBy: "test-user" });
  return { mission, task };
}

const single = (column: Deadline, value: string | null): Deadlines =>
  column === "dueAt" ? { dueAt: value } : { slaDeadlineAt: value };

/** Runs one real scheduler scan and returns each `task.overdue` publication with the Habitat it was routed to. */
function scan(notified = new Set<string>()) {
  const publish = vi.spyOn(sseBroadcaster, "publish");
  const onError = vi.fn();
  const count = checkOverdueTasks(notified, onError);
  const publications = publish.mock.calls.map(([routedTo, event]) => ({ routedTo, event }));
  publish.mockRestore();
  expect(onError).not.toHaveBeenCalled();
  return { count, publications };
}

function overdueEvent(taskId: string, habitat = owner) {
  return {
    routedTo: habitat.habitatId,
    event: {
      type: "task.overdue",
      data: { taskId, habitatId: habitat.habitatId, detectedAt: NOW.toISOString() },
    },
  };
}

function overdueRule(habitatId: string, enabled = true) {
  return createAutomationRule({
    habitatId,
    name: "Overdue rule",
    priority: 0,
    trigger: { type: "event", eventType: "task.overdue" } as never,
    enabled,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    actions: [{ type: "notify", recipients: [], template: "Overdue" }] as never,
    createdBy: "system:test",
  });
}

/** Waits for the broadcaster's non-blocking automation ingestion to leave the rule with exactly `statuses` runs. */
async function runsOf(ruleId: string, statuses: string[]) {
  const statusesOf = () => listRunsByRule(ruleId).runs.map((run) => run.status);
  await vi.waitFor(() => expect(statusesOf()).toEqual(statuses));
  return listRunsByRule(ruleId).runs;
}

it.each(["dueAt", "slaDeadlineAt"] as const)(
  "emits one event and runs the enabled rule for a same-day elapsed canonical %s",
  async (column) => {
    const { task } = openTask(single(column, ELAPSED));
    const enabled = overdueRule(owner.habitatId);
    const disabled = overdueRule(owner.habitatId, false);

    const notified = new Set<string>();
    expect(scan(notified)).toEqual({ count: 1, publications: [overdueEvent(task.id)] });

    expect(await runsOf(enabled.id, ["succeeded"])).toEqual([
      expect.objectContaining({
        ruleId: enabled.id,
        habitatId: owner.habitatId,
        triggerType: "task.overdue",
        targetType: "task",
        targetId: task.id,
      }),
    ]);
    expect(listRunsByRule(disabled.id).total).toBe(0);

    // A repeated scan deduplicates: no second event, no second run.
    expect(scan(notified).publications).toEqual([]);
    expect(listRunsByRule(enabled.id).total).toBe(1);
  },
);

const instants = [
  ["same day before", "2026-10-17T11:59:59.999Z", true],
  ["one millisecond before", "2026-10-17T12:00:00.499Z", true],
  ["equal", "2026-10-17T12:00:00.500Z", false],
  ["one millisecond after", "2026-10-17T12:00:00.501Z", false],
  ["previous UTC day", "2026-10-16T23:59:59.999Z", true],
  ["next UTC day", "2026-10-18T00:00:00.000Z", false],
  ["equal positive offset", "2026-10-17T17:30:00.500+05:30", false],
  ["elapsed positive offset", "2026-10-17T17:29:59.999+05:30", true],
  ["future negative offset", "2026-10-17T07:00:00.501-05:00", false],
  ["legacy SQLite timestamp", "2026-10-17 11:59:59.999", true],
  ["date only", "2026-10-17", true],
  ["null", null, false],
  ["malformed", "not a date", false],
  ["empty", "", false],
] as const;

for (const column of ["dueAt", "slaDeadlineAt"] as const) {
  it.each(instants)(`compares the Mission ${column} as an instant: %s`, (_name, value, eligible) => {
    const { task } = openTask(single(column, value));
    expect(scan().publications).toEqual(eligible ? [overdueEvent(task.id)] : []);
  });
}

it.each([
  ["due elapsed, SLA absent", { dueAt: ELAPSED }, true],
  ["SLA elapsed, due absent", { slaDeadlineAt: ELAPSED }, true],
  ["due elapsed, SLA future", { dueAt: ELAPSED, slaDeadlineAt: FUTURE }, true],
  ["due future, SLA elapsed", { dueAt: FUTURE, slaDeadlineAt: ELAPSED }, true],
  ["both future", { dueAt: FUTURE, slaDeadlineAt: FUTURE }, false],
  ["both absent", {}, false],
] as const)("combines the deadlines independently: %s", (_name, deadlines, eligible) => {
  const { task } = openTask(deadlines);
  expect(scan().publications).toEqual(eligible ? [overdueEvent(task.id)] : []);
});

it.each(["done", "approved", "failed"] as const)(
  "excludes %s tasks despite an elapsed deadline",
  (status) => {
    const { task } = openTask({ dueAt: ELAPSED, slaDeadlineAt: ELAPSED });
    getDb().update(tasks).set({ status }).where(eq(tasks.id, task.id)).run();
    expect(scan().publications).toEqual([]);
  },
);

it("re-emits when a Task becomes overdue again after leaving the overdue set", async () => {
  const { mission, task } = openTask({ dueAt: ELAPSED });
  const rule = overdueRule(owner.habitatId);
  const notified = new Set<string>();

  expect(scan(notified).publications).toEqual([overdueEvent(task.id)]);

  // Deadline pushed past the clock: the Task leaves the notified set.
  updateMission(mission.id, { dueAt: FUTURE });
  expect(scan(notified).publications).toEqual([]);
  expect(notified.has(task.id)).toBe(false);

  updateMission(mission.id, { dueAt: ELAPSED });
  expect(scan(notified).publications).toEqual([overdueEvent(task.id)]);
  expect((await runsOf(rule.id, ["succeeded", "succeeded"])).map((run) => run.targetId)).toEqual([
    task.id,
    task.id,
  ]);
});

it("routes each event and rule run to the Task's own Habitat", async () => {
  const other = newOwner("Other habitat");
  const { task: here } = openTask({ dueAt: ELAPSED });
  const { task: there } = openTask({ slaDeadlineAt: ELAPSED }, other);
  const hereRule = overdueRule(owner.habitatId);
  const thereRule = overdueRule(other.habitatId);

  expect(scan().publications).toEqual(
    expect.arrayContaining([overdueEvent(here.id), overdueEvent(there.id, other)]),
  );

  expect((await runsOf(hereRule.id, ["succeeded"])).map((run) => run.targetId)).toEqual([here.id]);
  expect((await runsOf(thereRule.id, ["succeeded"])).map((run) => run.targetId)).toEqual([there.id]);
});
