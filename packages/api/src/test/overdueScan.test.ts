/**
 * Scheduled overdue scan (issue #405): Mission due and SLA deadlines are
 * compared with the current instant, so a canonical ISO deadline that elapsed
 * earlier the same UTC day emits `task.overdue` today instead of at the next
 * date change. A compact `±HHMM` offset, which the import routes persist
 * verbatim, is read as the same instant as its `±HH:MM` spelling.
 *
 * Runs the real `checkOverdueTasks` query against the disposable test
 * database. The matching rule's `notify` has no recipients, so nothing is
 * delivered.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { missions, tasks } from "../db/schema/index.js";
import { createHabitat } from "../services/habitatService.js";
import { createAutomationRule } from "../repositories/automationRule.js";
import { listRunsByRule } from "../repositories/automationRuleRun.js";
import { createMission, updateMission } from "../repositories/mission.js";
import { createTask } from "../repositories/task.js";
import { checkOverdueTasks } from "../services/scheduler.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { habitatExportRoutes } from "../routes/board-export.js";

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

function overdueEvent(taskId: string, habitat: Pick<typeof owner, "habitatId"> = owner) {
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
  ["compact positive offset", "2026-10-17T17:29:59.999+0530", true],
  ["compact positive offset, equal", "2026-10-17T17:30:00.500+0530", false],
  ["compact positive offset, one millisecond after", "2026-10-17T17:30:00.501+0530", false],
  ["compact negative offset", "2026-10-17T06:59:59.999-0500", true],
  ["compact negative offset, equal", "2026-10-17T07:00:00.500-0500", false],
  ["compact negative offset, one millisecond after", "2026-10-17T07:00:00.501-0500", false],
  ["compact offset without milliseconds", "2026-10-17T17:29:59+0530", true],
  ["legacy SQLite timestamp", "2026-10-17 11:59:59.999", true],
  ["legacy SQLite timestamp with compact offset", "2026-10-17 17:29:59.999+0530", true],
  ["compact offset on an invalid calendar date", "2026-13-45T17:29:59.999+0530", false],
  ["out-of-range compact offset", "2026-10-17T17:29:59.999+2530", false],
  ["hour-only offset", "2026-10-17T17:29:59.999+05", false],
  ["offset with seconds", "2026-10-17T17:29:59.999+05:30:00", false],
  ["malformed with a digit suffix", "not a date+1234", false],
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

/** Deadlines sent through the real import route, which stores `dueAt` verbatim. */
const imported = [
  ["compact positive offset", "2026-10-17T17:29:59.999+0530", true],
  ["compact negative offset", "2026-10-17T06:59:59.999-0500", true],
  ["compact offset without milliseconds", "2026-10-17T17:29:59+0530", true],
  ["colon offset", "2026-10-17T17:29:59.999+05:30", true],
  ["canonical", "2026-10-17T11:59:00.000Z", true],
  ["compact positive offset, equal", "2026-10-17T17:30:00.500+0530", false],
  ["compact negative offset, future", "2026-10-17T07:00:00.501-0500", false],
  ["compact offset on an invalid calendar date", "2026-13-45T17:29:59.999+0530", false],
  ["out-of-range compact offset", "2026-10-17T17:29:59.999+2530", false],
  ["malformed with a digit suffix", "not a date+1234", false],
] as const;
const IMPORTED_AT = "2026-07-21T12:00:00.000Z";

/** Serves the import routes the way `boardExportImportDispatch.test.ts` does. */
async function serveImportRoutes(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatExportRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

function importHabitat(app: FastifyInstance, payload: Record<string, unknown>) {
  const token = jwt.sign(
    { sub: "admin-1", username: "overdue-scan-test", role: "admin" },
    "dev-secret-change-in-production",
    { issuer: "orcy" },
  );
  return app.inject({
    method: "POST",
    url: "/api/habitats/import",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("deadlines persisted by the import route", () => {
  it("stores each deadline verbatim and reports the elapsed ones", async () => {
    const app = await serveImportRoutes();
    try {
      const v3 = await importHabitat(app, {
        version: 3,
        manifestId: `overdue-scan-${randomUUID()}`,
        generatedAt: IMPORTED_AT,
        mode: "new",
        identityPolicy: "remap",
        lineage: { sourceHabitatId: null, sourceExportedAt: IMPORTED_AT, sourceManifestId: null },
        domains: {
          habitatSettings: {
            disposition: "replace",
            data: { sourceId: "habitat-1", name: "Imported v3", description: "", settings: {} },
          },
          columns: {
            disposition: "replace",
            data: [
              {
                sourceId: "col-1",
                name: "Todo",
                order: 0,
                color: null,
                wipLimit: null,
                nextColumnName: null,
                isTerminal: false,
              },
            ],
          },
          missions: {
            disposition: "replace",
            data: imported.map(([name, dueAt], i) => ({
              sourceId: `mission-${i}`,
              title: `v3 ${name}`,
              description: "",
              acceptanceCriteria: "",
              priority: "medium",
              labels: [],
              columnName: "Todo",
              dependsOnSourceIds: [],
              blocksSourceIds: [],
              dueAt,
            })),
          },
          tasks: {
            disposition: "replace",
            data: imported.map(([name], i) => ({
              sourceId: `task-${i}`,
              missionSourceId: `mission-${i}`,
              title: `v3 ${name}`,
              description: "",
              priority: "medium",
              requiredDomain: null,
              requiredCapabilities: [],
            })),
          },
        },
      });
      expect(v3.statusCode).toBe(201);

      // The legacy adapter reads the same value out of a v2 export.
      const v2 = await importHabitat(app, {
        version: 2,
        exportedAt: IMPORTED_AT,
        habitat: {
          name: "Imported v2",
          description: "",
          columns: [{ name: "Todo", order: 0, wipLimit: null, nextColumnName: null, isTerminal: false }],
          missions: [
            {
              title: "v2 compact positive offset",
              description: "",
              acceptanceCriteria: "",
              priority: "medium",
              labels: [],
              columnName: "Todo",
              dependsOn: [],
              blocks: [],
              dueAt: "2026-10-17T17:29:59.999+0530",
              tasks: [
                {
                  title: "v2 compact positive offset",
                  description: "",
                  priority: "medium",
                  requiredDomain: null,
                  requiredCapabilities: [],
                },
              ],
            },
          ],
          comments: [],
          templates: [],
          webhooks: [],
        },
      });
      expect(v2.statusCode).toBe(201);
    } finally {
      await app.close();
    }

    // Stored as sent: the scan meets the stored text, not a normalized copy.
    const persisted = getDb()
      .select({
        taskId: tasks.id,
        habitatId: missions.habitatId,
        title: missions.title,
        dueAt: missions.dueAt,
      })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .all();
    expect(persisted.map((row) => [row.title, row.dueAt]).sort()).toEqual(
      [
        ...imported.map(([name, dueAt]) => [`v3 ${name}`, dueAt]),
        ["v2 compact positive offset", "2026-10-17T17:29:59.999+0530"],
      ].sort(),
    );

    const elapsed = new Set([
      ...imported.filter(([, , isElapsed]) => isElapsed).map(([name]) => `v3 ${name}`),
      "v2 compact positive offset",
    ]);
    const { publications } = scan();
    expect(publications).toEqual(
      expect.arrayContaining(
        persisted
          .filter((row) => elapsed.has(row.title))
          .map((row) => overdueEvent(row.taskId, { habitatId: row.habitatId })),
      ),
    );
    expect(publications).toHaveLength(elapsed.size);
  });
});
