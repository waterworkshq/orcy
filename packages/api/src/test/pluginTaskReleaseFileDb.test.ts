/**
 * Plugin task operations — production-driver (better-sqlite3, file-backed,
 * WAL) rollback proof for the plugin release act-tx: the composed bundle
 * (in-tx budget guard + fences + CAS release write + `released` event + the
 * two required receipts) is NOT durable until the caller's transaction
 * commits. A crash before COMMIT (simulated as an explicit ROLLBACK of the
 * open writer transaction after the production in-tx body ran and its writes
 * were visible on the connection) leaves every row byte-identical — the
 * plugin release path can never surface a partially-applied release.
 *
 * Mirrors the automation-release file-DB proof: the PRODUCTION in-tx body
 * (`pluginReleaseBundleInTx`) is invoked directly on the open transaction —
 * no manual SQL, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, initDb, getDb } from "../db/index.js";
import { tasks, taskEvents, effectReceipts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import { pluginReleaseBundleInTx, releaseTaskForPlugin } from "../services/pluginTaskOperations.js";

// Fault-injection toggle for the MID-BUNDLE event-INSERT failure (F2): the
// release act-tx has already written the CAS release when the `released`
// event INSERT throws — the PUBLIC wrapper must roll the whole bundle back.
const eventCrudState = vi.hoisted(() => ({ failCreateWithClient: false }));
vi.mock("../repositories/events/event-crud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/events/event-crud.js")>();
  return {
    ...actual,
    createEventWithClient: (db: unknown, input: unknown) => {
      if (eventCrudState.failCreateWithClient) {
        throw new Error("injected mid-bundle event insert failure");
      }
      return actual.createEventWithClient(db as never, input as never);
    },
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dbFile: string;
let habitatId: string;
let missionId: string;

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-pto-rel-")), "orcy.db");
  await initDb(dbFile);
  eventCrudState.failCreateWithClient = false;
  const h = habitatRepo.createHabitat({ name: "Plugin File DB Habitat" });
  habitatId = h.id;
  columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
  missionId = missionRepo.createMission({ habitatId, title: "M", createdBy: "user-1" }).id;
});

afterEach(async () => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

function makeClaimedTask() {
  const agent = agentRepo.createAgent({
    name: "pto-fdb",
    type: "claude-code",
    domain: "backend",
  }).agent;
  const created = taskRepo.createTask({ missionId, title: "T", createdBy: "user-1" });
  const r = taskRepo.claimTask(created.id, agent.id);
  if (!r.success) throw new Error(r.reason);
  const task = taskRepo.getTaskById(created.id)!;
  return { agent, task };
}

describe("plugin release bundle — production file DB (better-sqlite3, WAL)", () => {
  it("crash before COMMIT (open-tx ROLLBACK) persists ZERO release writes from the production in-tx body", () => {
    const { task } = makeClaimedTask();
    const before = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;

    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    try {
      const inTx = pluginReleaseBundleInTx(db, {
        pluginId: "pto-plugin",
        contributionId: "ops",
        runId: "run-file-db",
        habitatId,
        taskId: task.id,
        pair: {
          executionToken: task.executionToken ?? null,
          assignedAgentId: task.assignedAgentId ?? null,
        },
      });
      expect(inTx.ok).toBe(true);
      // Uncommitted in-tx view: the release IS visible on this connection…
      const inTxRow = db
        .select()
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .get() as typeof tasks.$inferSelect;
      expect(inTxRow.status).toBe("pending");
      expect(
        db
          .select()
          .from(taskEvents)
          .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
          .all(),
      ).toHaveLength(1);
      expect(
        db.select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
      ).toHaveLength(2);
      // …but the crash lands BEFORE COMMIT:
      db.run(sql`ROLLBACK`);
    } catch (err) {
      db.run(sql`ROLLBACK`);
      throw err;
    }

    const after = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(after.status).toBe(before.status);
    expect(after.assignedAgentId).toBe(before.assignedAgentId);
    expect(after.executionToken).toBe(before.executionToken);
    expect(after.lastReleaseEventId).toBeNull();
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
    ).toHaveLength(0);
  });

  it("the composed plugin release commits durably through the production wrapper", () => {
    const { task, agent } = makeClaimedTask();
    // The full wrapper path (BEGIN → body → COMMIT → postlude) via the
    // releaseTaskForPlugin entry the plugin context calls.
    const outcome = releaseTaskForPlugin({
      pluginId: "pto-plugin",
      contributionId: "ops",
      runId: "run-file-db",
      habitatId,
      taskId: task.id,
      pair: {
        executionToken: task.executionToken ?? null,
        assignedAgentId: agent.id,
      },
    });
    expect(outcome.ok).toBe(true);
    const row = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(row.status).toBe("pending");
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
        .all(),
    ).toHaveLength(1);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
    ).toHaveLength(2);
  });

  it("F2: the PUBLIC wrapper rolls back a mid-bundle event-INSERT failure thrown AFTER the CAS write (real driver, zero durable writes)", () => {
    const { task, agent } = makeClaimedTask();
    const before = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;

    // The release act-tx has already performed the CAS release write when the
    // `released` event INSERT fails inside `releaseTaskWithEffectsWithClient`
    // — the PUBLIC entry (`releaseTaskForPlugin`) must ROLLBACK its own
    // transaction and propagate the failure with zero durable writes.
    eventCrudState.failCreateWithClient = true;
    expect(() =>
      releaseTaskForPlugin({
        pluginId: "pto-plugin",
        contributionId: "ops",
        runId: "run-fdb-f2",
        habitatId,
        taskId: task.id,
        pair: {
          executionToken: task.executionToken ?? null,
          assignedAgentId: agent.id,
        },
      }),
    ).toThrow(/injected mid-bundle event insert failure/);
    eventCrudState.failCreateWithClient = false;

    const after = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(after.status).toBe(before.status); // claimed — the CAS write did NOT survive
    expect(after.assignedAgentId).toBe(before.assignedAgentId);
    expect(after.executionToken).toBe(before.executionToken);
    expect(after.lastReleaseEventId).toBeNull();
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
    ).toHaveLength(0);
  });

  it("F2 context-seam: the injected mid-bundle failure surfaces as a truthful releaseTask rejection with zero writes", async () => {
    const { buildPluginContext } = await import("../plugins/context.js");
    const { task, agent } = makeClaimedTask();
    const ctx = buildPluginContext({
      pluginId: "pto-plugin",
      contributionId: "ops",
      habitatId,
      runId: "run-fdb-f2-ctx",
      requires: ["taskReader", "taskWriter"],
    });
    const observed = await ctx.taskReader!.getTask(task.id); // observe the pair
    expect(observed).not.toBeNull();

    eventCrudState.failCreateWithClient = true;
    try {
      await expect(ctx.taskWriter!.releaseTask(task.id)).rejects.toThrow(
        /injected mid-bundle event insert failure/,
      );
    } finally {
      eventCrudState.failCreateWithClient = false;
    }
    const row = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(row.lastReleaseEventId).toBeNull();
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
    ).toHaveLength(0);

    // Truthful recovery: with the fault cleared, the same observed pair
    // releases cleanly through the same context.
    await ctx.taskWriter!.releaseTask(task.id);
    const after = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(after.status).toBe("pending");
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.action, "released")))
        .all(),
    ).toHaveLength(1);
  });
});
