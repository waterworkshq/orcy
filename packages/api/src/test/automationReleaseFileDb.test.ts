/**
 * REC-06 (automation-release batch) — the production-driver (better-sqlite3,
 * file-backed, WAL) atomicity contract for the frozen release bundle:
 *
 *   - the release writes (CAS release + event + receipts) are NOT durable
 *     until the whole bundle commits — a crash between the release and the
 *     checkpoint proof (simulated as an explicit ROLLBACK of the open
 *     writer transaction) leaves every row byte-identical;
 *   - the composed frozen bundle (release + fenced proof) commits and is
 *     durably visible on the real driver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, initDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  effectReceipts,
  automationDeliveryActionCheckpoints,
} from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as revisionRepo from "../repositories/automationRuleRevision.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { admitReleaseShippedEventToInbox } from "../services/automationInboxService.js";
import { releaseTaskWithEffectsWithClient } from "../services/effects/releaseEffects.js";
import { executeFrozenReleaseAssignment } from "../services/automationReleaseAssignment.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type { Task } from "@orcy/shared";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:10:00.000Z";

let dbFile: string;

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "File DB Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function makeClaimedTask(habitatId: string) {
  const agent = agentRepo.createAgent({
    name: "fda",
    type: "claude-code",
    domain: "backend",
  }).agent;
  const mission = missionRepo.createMission({ habitatId, title: "M", createdBy: "user-1" });
  const created = taskRepo.createTask({ missionId: mission.id, title: "T", createdBy: "user-1" });
  const r = taskRepo.claimTask(created.id, agent.id);
  if (!r.success) throw new Error(r.reason);
  return { agent, task: taskRepo.getTaskById(created.id)! };
}

function releasedEvents(taskId: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "released")))
    .all();
}

describe("automation release bundle — production file DB (better-sqlite3, WAL)", () => {
  beforeEach(async () => {
    dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-auto-rel-")), "orcy.db");
    await initDb(dbFile);
  });
  afterEach(async () => {
    closeDb();
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it("crash between release and proof (open-tx ROLLBACK) persists ZERO release writes", () => {
    const h = setupHabitat();
    const { task } = makeClaimedTask(h.id);
    const before = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;

    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    try {
      const inTx = releaseTaskWithEffectsWithClient(db, {
        taskId: task.id,
        actorId: "automation-executor",
        reason: "automation_rule_action",
        preImage: task,
      });
      expect(inTx).not.toBeNull();
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
          .where(eq(taskEvents.taskId, task.id))
          .all()
          .filter((e) => e.action === "released"),
      ).toHaveLength(1);
      // …but the crash lands BEFORE the checkpoint proof/COMMIT:
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
    expect(releasedEvents(task.id)).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, task.id)).all(),
    ).toHaveLength(0);
  });

  it("the composed frozen bundle commits durably on the real driver (release + event + receipts + proved proof)", async () => {
    const h = setupHabitat();
    const { task, agent } = makeClaimedTask(h.id);
    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "FileDB Release Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [{ type: "release_assignment" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });

    admitReleaseShippedEventToInbox({
      habitatId: h.id,
      eventId: "rel-filedb",
      payload: { eventId: "rel-filedb" },
      now: T0,
    });
    const inbox = deliveryRepo.listInboxEntriesForHabitat(h.id)[0]!;
    const deliveryId = deliveryRepo.listDeliveriesForInbox(inbox.id)[0]!.id;
    const lease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "w1",
      now: T0,
      ttlMs: 60_000,
    });
    expect(lease.acquired).toBe(true);

    const delivery = deliveryRepo.getDeliveryById(deliveryId)!;
    const revision = revisionRepo.getRuleRevisionById(delivery.ruleRevisionId)!;
    const disposition = await attemptRuleRun({
      rule,
      source: "event",
      trigger: {
        triggerType: "release.shipped",
        triggerEventId: "evt-filedb",
        habitatId: h.id,
        targetType: "task",
        targetId: task.id,
        payload: {},
      },
      now: T1,
      frozen: {
        delivery: {
          id: deliveryId,
          generation: delivery.generation,
          fence: lease.fence,
          eventDedupeKey: delivery.eventDedupeKey,
        },
        inbox: { id: inbox.id, eventType: "release.shipped", eventId: "evt-filedb" },
        revision,
      },
    } as never);

    expect(disposition).toMatchObject({ kind: "executed", outcome: "succeeded" });
    const events = releasedEvents(task.id);
    expect(events).toHaveLength(1);
    const row = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.lastReleaseEventId).toBe(events[0]!.id);
    expect(
      getDb()
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.subjectId, events[0]!.id))
        .all(),
    ).toHaveLength(2);

    const checkpoint = getDb()
      .select()
      .from(automationDeliveryActionCheckpoints)
      .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
      .all()[0] as {
      state: string;
      receipt: Record<string, unknown> | null;
      idempotencyKey: string | null;
    };
    expect(checkpoint.state).toBe("proved");
    expect((checkpoint.receipt as { eventId?: string })?.eventId).toBe(events[0]!.id);
    expect(checkpoint.idempotencyKey).toBe(
      JSON.stringify({
        v: 1,
        taskId: task.id,
        assignedAgentId: agent.id,
        executionToken: task.executionToken,
      }),
    );
    void (task as Task);
  });

  // F4: the SERVICE's own ROLLBACK branch on the real driver — the proof
  // seam is forced false/throwing AFTER the release bundle writes, through
  // the production `executeFrozenReleaseAssignment` call (no manual
  // transaction demonstration).
  function frozenReleaseSetup(habitatId: string) {
    const { task, agent } = makeClaimedTask(habitatId);
    const rule = ruleRepo.createAutomationRule({
      habitatId,
      name: "F4 Release Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [{ type: "release_assignment" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });
    admitReleaseShippedEventToInbox({
      habitatId,
      eventId: `rel-f4-${Math.random().toString(36).slice(2, 8)}`,
      payload: {},
      now: T0,
    });
    const inbox = deliveryRepo.listInboxEntriesForHabitat(habitatId)[0]!;
    const deliveryId = deliveryRepo.listDeliveriesForInbox(inbox.id)[0]!.id;
    const lease = deliveryRepo.leaseDelivery({
      deliveryId,
      leaseOwner: "w1",
      now: T0,
      ttlMs: 60_000,
    });
    if (!lease.acquired) throw new Error("setup lease failed");
    const revision = revisionRepo.getRuleRevisionById(
      deliveryRepo.getDeliveryById(deliveryId)!.ruleRevisionId,
    )!;
    const ctx: AutomationEvaluationContext = {
      habitat: { id: habitatId, name: "h" } as never,
      task,
      mission: null,
      agent: null,
      sprint: null,
      warnings: [],
      missingFields: [],
      raw: {},
    };
    const call = () =>
      executeFrozenReleaseAssignment({
        action: { type: "release_assignment" } as never,
        index: 0,
        rule,
        run: { id: "run-f4" } as never,
        ctx,
        delivery: { id: deliveryId, fence: lease.fence },
        actionKey: deliveryRepo.computeActionKey(revision.actions[0] as never),
        now: T0,
      });
    return { task, agent, deliveryId, call };
  }

  function assertNothingCommitted(task: Task) {
    const row = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).not.toBeNull();
    expect(row.executionToken).toBe(task.executionToken);
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
  }

  it("F4 real driver: proof false AFTER the bundle write → service ROLLBACK, fenced_out, checkpoint pending+pin intact", async () => {
    const h = setupHabitat();
    const { task, deliveryId, call } = frozenReleaseSetup(h.id);

    const deliveryModule = await import("../repositories/automationRuleDelivery.js");
    vi.spyOn(deliveryModule, "recordCheckpointOutcomeWithClient").mockReturnValue(false);

    const outcome = call();
    expect(outcome).toMatchObject({ kind: "fenced_out" });
    assertNothingCommitted(task);
    const checkpoint = getDb()
      .select()
      .from(automationDeliveryActionCheckpoints)
      .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
      .all()[0] as { state: string; idempotencyKey: string | null };
    expect(checkpoint.state).toBe("pending");
    expect(checkpoint.idempotencyKey).not.toBeNull();
  });

  it("F4 real driver: proof THROWS after the bundle write → rollback + rethrow, zero durable writes", async () => {
    const h = setupHabitat();
    const { task, deliveryId, call } = frozenReleaseSetup(h.id);

    const deliveryModule = await import("../repositories/automationRuleDelivery.js");
    vi.spyOn(deliveryModule, "recordCheckpointOutcomeWithClient").mockImplementation(() => {
      throw new Error("proof seam exploded on the real driver");
    });

    expect(() => call()).toThrow(/proof seam exploded/);
    assertNothingCommitted(task);
    const checkpoint = getDb()
      .select()
      .from(automationDeliveryActionCheckpoints)
      .where(eq(automationDeliveryActionCheckpoints.deliveryId, deliveryId))
      .all()[0] as { state: string; idempotencyKey: string | null };
    expect(checkpoint.state).toBe("pending");
    expect(checkpoint.idempotencyKey).not.toBeNull();
  });
});
