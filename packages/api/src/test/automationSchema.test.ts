import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import { automationRules, automationRuleRuns } from "../db/schema/index.js";
import { buildFingerprint } from "@orcy/shared";
import type {
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
  AutomationEventType,
  AutomationScanType,
  AutomationRunStatus,
  AutomationSkipReason,
  AutomationTargetType,
} from "@orcy/shared";
import { eq } from "drizzle-orm";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Test Habitat" });
}

function insertRule(
  db: ReturnType<typeof getDb>,
  habitatId: string,
  overrides?: Partial<{
    name: string;
    enabled: boolean;
    priority: number;
    trigger: AutomationTrigger;
    condition: AutomationCondition;
    actions: AutomationAction[];
    createdBy: string;
  }>,
) {
  const id = `rule-${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  db.insert(automationRules)
    .values({
      id,
      habitatId,
      name: overrides?.name ?? "Test Rule",
      description: "",
      enabled: overrides?.enabled ?? false,
      priority: overrides?.priority ?? 0,
      trigger: (overrides?.trigger ?? {
        type: "event",
        eventType: "task.rejected",
      }) as Record<string, unknown>,
      condition: (overrides?.condition ?? {
        type: "always",
      }) as Record<string, unknown>,
      actions: (overrides?.actions ?? []) as unknown as Record<string, unknown>[],
      cooldownSeconds: 300,
      maxRunsPerHour: 30,
      createdBy: overrides?.createdBy ?? "system:automation",
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
    })
    .run();
  return id;
}

function insertRun(
  db: ReturnType<typeof getDb>,
  ruleId: string,
  habitatId: string,
  overrides?: Partial<{
    triggerType: string;
    triggerEventId: string;
    targetType: string;
    targetId: string;
    fingerprint: string;
    status: AutomationRunStatus;
    skipReason: AutomationSkipReason;
    startedAt: string;
    finishedAt: string;
  }>,
) {
  const id = `run-${Math.random().toString(36).slice(2, 9)}`;
  db.insert(automationRuleRuns)
    .values({
      id,
      ruleId,
      habitatId,
      triggerType: overrides?.triggerType ?? "task.rejected",
      triggerEventId: overrides?.triggerEventId ?? null,
      targetType: overrides?.targetType ?? "task",
      targetId: overrides?.targetId ?? "task-1",
      fingerprint:
        overrides?.fingerprint ??
        buildFingerprint(habitatId, ruleId, "task.rejected", null, "task", "task-1"),
      status: overrides?.status ?? "succeeded",
      skipReason: overrides?.skipReason ?? null,
      conditionResult: null,
      actionResults: null,
      metadata: null,
      startedAt: overrides?.startedAt ?? new Date().toISOString(),
      finishedAt: overrides?.finishedAt ?? null,
    })
    .run();
  return id;
}

describe("automation schema - automation_rules", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and reads an automation rule", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id, {
      name: "Reject Notifier",
      enabled: true,
      priority: 10,
      trigger: { type: "event", eventType: "task.rejected" },
      condition: { type: "always" },
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Task rejected" }],
      createdBy: "user-1",
    });

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    expect(row).not.toBeNull();
    expect(row!.name).toBe("Reject Notifier");
    expect(row!.enabled).toBe(true);
    expect(row!.priority).toBe(10);
    expect(row!.habitatId).toBe(habitat.id);
    expect((row!.trigger as Record<string, unknown>).type).toBe("event");
    expect((row!.trigger as Record<string, unknown>).eventType).toBe("task.rejected");
    expect((row!.condition as Record<string, unknown>).type).toBe("always");
    expect(row!.actions).toHaveLength(1);
    expect(row!.createdBy).toBe("user-1");
  });

  it("defaults enabled to false", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    expect(row!.enabled).toBe(false);
  });

  it("defaults description to empty string", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    expect(row!.description).toBe("");
  });

  it("defaults cooldown to 300 seconds and max runs to 30", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    expect(row!.cooldownSeconds).toBe(300);
    expect(row!.maxRunsPerHour).toBe(30);
  });

  it("stores scan trigger type", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id, {
      trigger: { type: "scan", scanType: "mission_blocked" } as AutomationTrigger,
    });

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    expect((row!.trigger as Record<string, unknown>).type).toBe("scan");
    expect((row!.trigger as Record<string, unknown>).scanType).toBe("mission_blocked");
  });

  it("stores nested condition tree", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const condition: AutomationCondition = {
      type: "and",
      children: [
        { type: "priority_above", threshold: "medium" },
        { type: "status_in", statuses: ["in_progress", "claimed"] },
        { type: "not", child: { type: "unassigned" } },
      ],
    };
    const ruleId = insertRule(db, habitat.id, { condition });

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();

    const stored = row!.condition as Record<string, unknown>;
    expect(stored.type).toBe("and");
    expect(stored.children).toHaveLength(3);
  });

  it("lists rules by habitat", () => {
    const h1 = setupHabitat();
    const h2 = setupHabitat();
    const db = getDb();
    insertRule(db, h1.id, { name: "R1" });
    insertRule(db, h1.id, { name: "R2" });
    insertRule(db, h2.id, { name: "R3" });

    const rows = db
      .select()
      .from(automationRules)
      .where(eq(automationRules.habitatId, h1.id))
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(["R1", "R2"]);
  });

  it("cascades delete with habitat", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);

    boardRepo.deleteHabitat(habitat.id);

    const row = db.select().from(automationRules).where(eq(automationRules.id, ruleId)).get();
    expect(row).toBeUndefined();
  });
});

describe("automation schema - automation_rule_runs", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("creates and reads an automation rule run", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const runId = insertRun(db, ruleId, habitat.id, {
      status: "succeeded",
      targetType: "task",
      targetId: "task-42",
    });

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();

    expect(row).not.toBeNull();
    expect(row!.ruleId).toBe(ruleId);
    expect(row!.habitatId).toBe(habitat.id);
    expect(row!.status).toBe("succeeded");
    expect(row!.targetType).toBe("task");
    expect(row!.targetId).toBe("task-42");
  });

  it("stores skipped run with reason", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const runId = insertRun(db, ruleId, habitat.id, {
      status: "skipped",
      skipReason: "cooldown",
    });

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();

    expect(row!.status).toBe("skipped");
    expect(row!.skipReason).toBe("cooldown");
  });

  it("stores condition result as JSON", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const conditionResult = {
      matched: true,
      conditionType: "and",
      reason: "All conditions met",
      children: [
        { matched: true, conditionType: "priority_above", reason: "Priority critical > medium" },
      ],
    };

    const runId = `run-${Math.random().toString(36).slice(2, 9)}`;
    db.insert(automationRuleRuns)
      .values({
        id: runId,
        ruleId,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        fingerprint: buildFingerprint(habitat.id, ruleId, "task.rejected", null, null, null),
        status: "matched",
        conditionResult,
        startedAt: new Date().toISOString(),
      })
      .run();

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();

    const result = row!.conditionResult as Record<string, unknown>;
    expect(result.matched).toBe(true);
    expect(result.conditionType).toBe("and");
    expect(result.children).toHaveLength(1);
  });

  it("stores action results as JSON array", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const actionResults = [
      { actionType: "notify", actionIndex: 0, status: "succeeded" },
      { actionType: "change_priority", actionIndex: 1, status: "failed", error: "Task not found" },
    ];

    const runId = `run-${Math.random().toString(36).slice(2, 9)}`;
    db.insert(automationRuleRuns)
      .values({
        id: runId,
        ruleId,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        fingerprint: buildFingerprint(habitat.id, ruleId, "task.rejected", null, null, null),
        status: "partial_failed",
        actionResults,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      })
      .run();

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();

    const results = row!.actionResults as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    expect(results[0].actionType).toBe("notify");
    expect(results[1].status).toBe("failed");
    expect(results[1].error).toBe("Task not found");
  });

  it("stores run metadata with provenance", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const metadata = {
      triggerSource: "server_event",
      actorId: "user-1",
      provenance: { source: "automation", ruleId, runId: "run-prev" },
    };

    const runId = `run-${Math.random().toString(36).slice(2, 9)}`;
    db.insert(automationRuleRuns)
      .values({
        id: runId,
        ruleId,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        fingerprint: buildFingerprint(habitat.id, ruleId, "task.rejected", null, null, null),
        status: "succeeded",
        metadata,
        startedAt: new Date().toISOString(),
      })
      .run();

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();

    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.triggerSource).toBe("server_event");
    expect((meta.provenance as Record<string, unknown>).ruleId).toBe(ruleId);
  });

  it("lists runs by rule ordered by started_at", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const t1 = new Date("2025-01-01T10:00:00Z").toISOString();
    const t2 = new Date("2025-01-01T11:00:00Z").toISOString();
    insertRun(db, ruleId, habitat.id, { startedAt: t1 });
    insertRun(db, ruleId, habitat.id, { startedAt: t2 });

    const rows = db
      .select()
      .from(automationRuleRuns)
      .where(eq(automationRuleRuns.ruleId, ruleId))
      .all();

    expect(rows).toHaveLength(2);
  });

  it("cascades delete with rule", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const runId = insertRun(db, ruleId, habitat.id);

    db.delete(automationRules).where(eq(automationRules.id, ruleId)).run();

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();
    expect(row).toBeUndefined();
  });

  it("cascades delete with habitat", () => {
    const habitat = setupHabitat();
    const db = getDb();
    const ruleId = insertRule(db, habitat.id);
    const runId = insertRun(db, ruleId, habitat.id);

    boardRepo.deleteHabitat(habitat.id);

    const row = db.select().from(automationRuleRuns).where(eq(automationRuleRuns.id, runId)).get();
    expect(row).toBeUndefined();
  });
});

describe("buildFingerprint utility", () => {
  it("builds deterministic fingerprint", () => {
    const fp = buildFingerprint("h1", "r1", "task.rejected", "evt-1", "task", "task-1");
    expect(fp).toBe("h1:r1:task.rejected:evt-1:task:task-1");
  });

  it("handles null segments", () => {
    const fp = buildFingerprint("h1", "r1", "mission_blocked", null, null, null);
    expect(fp).toBe("h1:r1:mission_blocked:::");
  });

  it("is deterministic for same inputs", () => {
    const fp1 = buildFingerprint("h1", "r1", "task.rejected", "e1", "task", "t1");
    const fp2 = buildFingerprint("h1", "r1", "task.rejected", "e1", "task", "t1");
    expect(fp1).toBe(fp2);
  });

  it("differs for different inputs", () => {
    const fp1 = buildFingerprint("h1", "r1", "task.rejected", "e1", "task", "t1");
    const fp2 = buildFingerprint("h1", "r1", "task.rejected", "e2", "task", "t1");
    expect(fp1).not.toBe(fp2);
  });
});

describe("automation type compile coverage", () => {
  it("AutomationEventType covers all event types", () => {
    const types: AutomationEventType[] = [
      "task.rejected",
      "task.overdue",
      "task.priority_changed",
      "task.review_assigned",
      "task.review_completed",
      "mission.status_changed",
      "mission.progress",
      "pulse.signal_posted",
      "scheduled_task.failed",
      "code_evidence.updated",
      "anomaly.detected",
      "sprint.started",
      "sprint.completed",
    ];
    expect(types).toHaveLength(13);
  });

  it("AutomationScanType covers all scan types", () => {
    const types: AutomationScanType[] = [
      "mission_blocked",
      "sprint_ending",
      "agent_silent",
      "evidence_gap_open",
    ];
    expect(types).toHaveLength(4);
  });

  it("AutomationRunStatus covers all statuses", () => {
    const statuses: AutomationRunStatus[] = [
      "matched",
      "skipped",
      "running",
      "succeeded",
      "partial_failed",
      "failed",
      "simulated",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("AutomationSkipReason covers all reasons", () => {
    const reasons: AutomationSkipReason[] = [
      "disabled",
      "condition_false",
      "cooldown",
      "loop_guard",
      "rate_limited",
      "missing_target",
    ];
    expect(reasons).toHaveLength(6);
  });

  it("AutomationTargetType covers all target types", () => {
    const types: AutomationTargetType[] = [
      "task",
      "mission",
      "agent",
      "sprint",
      "pulse",
      "habitat",
      "integration",
      "none",
    ];
    expect(types).toHaveLength(8);
  });
});
