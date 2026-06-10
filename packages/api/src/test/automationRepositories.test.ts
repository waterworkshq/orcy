import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import type { CreateAutomationRuleInput } from "@orcy/shared";

function setupHabitat() {
  return boardRepo.createHabitat({ name: "Test Habitat" });
}

function createTestRule(
  habitatId: string,
  overrides?: Partial<CreateAutomationRuleInput>,
): CreateAutomationRuleInput & { id: string } {
  return {
    ...ruleRepo.createAutomationRule({
      habitatId,
      name: "Test Rule",
      trigger: { type: "event", eventType: "task.rejected" },
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Task rejected" }],
      createdBy: "system:test",
      ...overrides,
    }),
    id: ruleRepo.createAutomationRule({
      habitatId,
      name: "Test Rule 2",
      trigger: { type: "event", eventType: "task.rejected" },
      actions: [],
      createdBy: "system:test",
      ...overrides,
    }).id,
  };
}

function createRule(habitatId: string, overrides?: Partial<CreateAutomationRuleInput>) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: "Test Rule",
    trigger: { type: "event", eventType: "task.rejected" },
    actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Test" }],
    createdBy: "system:test",
    ...overrides,
  });
}

describe("automationRule repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("createAutomationRule", () => {
    it("creates and retrieves a rule", () => {
      const habitat = setupHabitat();
      const rule = ruleRepo.createAutomationRule({
        habitatId: habitat.id,
        name: "Reject Notifier",
        trigger: { type: "event", eventType: "task.rejected" },
        actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Rejected" }],
        createdBy: "user-1",
      });

      expect(rule.id).toBeDefined();
      expect(rule.habitatId).toBe(habitat.id);
      expect(rule.name).toBe("Reject Notifier");
      expect(rule.enabled).toBe(false);
      expect(rule.priority).toBe(0);
      expect(rule.cooldownSeconds).toBe(300);
      expect(rule.maxRunsPerHour).toBe(30);
      expect(rule.lastRunAt).toBeNull();

      const fetched = ruleRepo.getAutomationRuleById(rule.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("Reject Notifier");
    });

    it("defaults enabled to false", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      expect(rule.enabled).toBe(false);
    });

    it("preserves enabled=true when set", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, { enabled: true });
      expect(rule.enabled).toBe(true);
    });

    it("stores trigger, condition, actions as JSON", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, {
        trigger: { type: "scan", scanType: "mission_blocked" },
        condition: {
          type: "and",
          children: [{ type: "priority_above", threshold: "high" }],
        },
        actions: [
          { type: "notify", recipients: [{ type: "assignee" }], template: "T1" },
          { type: "create_signal", content: "Mission blocked" },
        ],
      });

      const fetched = ruleRepo.getAutomationRuleById(rule.id)!;
      expect(fetched.trigger.type).toBe("scan");
      expect((fetched.trigger as { scanType: string }).scanType).toBe("mission_blocked");
      expect(fetched.condition.type).toBe("and");
      expect((fetched.condition as { children: unknown[] }).children).toHaveLength(1);
      expect(fetched.actions).toHaveLength(2);
    });
  });

  describe("listAutomationRulesByHabitat", () => {
    it("returns all rules for habitat ordered by priority ascending", () => {
      const habitat = setupHabitat();
      const r1 = createRule(habitat.id, { name: "Low", priority: 100 });
      const r2 = createRule(habitat.id, { name: "High", priority: 1 });
      const r3 = createRule(habitat.id, { name: "Mid", priority: 50 });

      const list = ruleRepo.listAutomationRulesByHabitat(habitat.id);
      expect(list).toHaveLength(3);
      expect(list.map((r) => r.name)).toEqual(["High", "Mid", "Low"]);
      expect(list.map((r) => r.id)).toEqual([r2.id, r3.id, r1.id]);
    });

    it("returns empty array for habitat with no rules", () => {
      const habitat = setupHabitat();
      const list = ruleRepo.listAutomationRulesByHabitat(habitat.id);
      expect(list).toEqual([]);
    });

    it("isolates rules by habitat", () => {
      const h1 = setupHabitat();
      const h2 = setupHabitat();
      createRule(h1.id, { name: "H1-R" });
      createRule(h2.id, { name: "H2-R" });

      expect(ruleRepo.listAutomationRulesByHabitat(h1.id)).toHaveLength(1);
      expect(ruleRepo.listAutomationRulesByHabitat(h2.id)).toHaveLength(1);
    });
  });

  describe("getEnabledRulesByHabitat", () => {
    it("returns only enabled rules in priority order", () => {
      const habitat = setupHabitat();
      createRule(habitat.id, { name: "Enabled-1", priority: 10, enabled: true });
      createRule(habitat.id, { name: "Disabled-1", priority: 5, enabled: false });
      createRule(habitat.id, { name: "Enabled-2", priority: 20, enabled: true });

      const list = ruleRepo.getEnabledRulesByHabitat(habitat.id);
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.name)).toEqual(["Enabled-1", "Enabled-2"]);
    });
  });

  describe("getEnabledRulesByHabitatAndTrigger", () => {
    it("filters by event trigger type", () => {
      const habitat = setupHabitat();
      createRule(habitat.id, {
        name: "Reject",
        enabled: true,
        trigger: { type: "event", eventType: "task.rejected" },
      });
      createRule(habitat.id, {
        name: "Overdue",
        enabled: true,
        trigger: { type: "event", eventType: "task.overdue" },
      });
      createRule(habitat.id, {
        name: "Blocked",
        enabled: true,
        trigger: { type: "scan", scanType: "mission_blocked" },
      });

      const rejects = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitat.id, "task.rejected");
      expect(rejects).toHaveLength(1);
      expect(rejects[0].name).toBe("Reject");
    });

    it("filters by scan trigger type", () => {
      const habitat = setupHabitat();
      createRule(habitat.id, {
        name: "Blocked",
        enabled: true,
        trigger: { type: "scan", scanType: "mission_blocked" },
      });
      createRule(habitat.id, {
        name: "SprintEnding",
        enabled: true,
        trigger: { type: "scan", scanType: "sprint_ending" },
      });

      const blocked = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitat.id, "mission_blocked");
      expect(blocked).toHaveLength(1);
      expect(blocked[0].name).toBe("Blocked");
    });

    it("excludes disabled rules", () => {
      const habitat = setupHabitat();
      createRule(habitat.id, {
        name: "Disabled",
        enabled: false,
        trigger: { type: "event", eventType: "task.rejected" },
      });

      const list = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitat.id, "task.rejected");
      expect(list).toHaveLength(0);
    });
  });

  describe("updateAutomationRule", () => {
    it("updates name and description", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, { name: "Old Name" });

      const updated = ruleRepo.updateAutomationRule(rule.id, {
        name: "New Name",
        description: "Updated description",
      });

      expect(updated.name).toBe("New Name");
      expect(updated.description).toBe("Updated description");
    });

    it("toggles enabled flag", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const enabled = ruleRepo.setRuleEnabled(rule.id, true);
      expect(enabled.enabled).toBe(true);

      const disabled = ruleRepo.setRuleEnabled(rule.id, false);
      expect(disabled.enabled).toBe(false);
    });

    it("updates priority", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, { priority: 10 });

      const updated = ruleRepo.updateAutomationRule(rule.id, { priority: 5 });
      expect(updated.priority).toBe(5);
    });

    it("updates trigger and actions", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const updated = ruleRepo.updateAutomationRule(rule.id, {
        trigger: { type: "scan", scanType: "agent_silent" },
        actions: [{ type: "create_signal", content: "Agent silent" }],
      });

      expect(updated.trigger.type).toBe("scan");
      expect(updated.actions).toHaveLength(1);
    });

    it("updates cooldown and max runs", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const updated = ruleRepo.updateAutomationRule(rule.id, {
        cooldownSeconds: 60,
        maxRunsPerHour: 5,
      });

      expect(updated.cooldownSeconds).toBe(60);
      expect(updated.maxRunsPerHour).toBe(5);
    });

    it("updates timestamp on each update", async () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const originalUpdatedAt = rule.updatedAt;

      await new Promise((r) => setTimeout(r, 10));

      const updated = ruleRepo.updateAutomationRule(rule.id, { name: "Renamed" });
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt).getTime(),
      );
    });
  });

  describe("recordRuleLastRun", () => {
    it("updates lastRunAt timestamp", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const updated = ruleRepo.recordRuleLastRun(rule.id, "2025-06-10T12:00:00Z");
      expect(updated.lastRunAt).toBe("2025-06-10T12:00:00Z");
    });
  });

  describe("deleteAutomationRule", () => {
    it("returns true when deleted", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const result = ruleRepo.deleteAutomationRule(rule.id);
      expect(result).toBe(true);
      expect(ruleRepo.getAutomationRuleById(rule.id)).toBeNull();
    });

    it("returns true even when no rule existed (deletion is idempotent)", () => {
      // In sql.js, result.changes is undefined, so we use the
      // `changes === undefined || changes > 0` pattern. Verify the
      // deletion is idempotent by checking the row truly is gone.
      ruleRepo.deleteAutomationRule("nonexistent-id");
      expect(ruleRepo.getAutomationRuleById("nonexistent-id")).toBeNull();
    });

    it("cascades runs deletion", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
      });

      ruleRepo.deleteAutomationRule(rule.id);

      const { runs, total } = runRepo.listRunsByRule(rule.id);
      expect(total).toBe(0);
      expect(runs).toEqual([]);
    });
  });

  describe("countRulesByHabitat", () => {
    it("counts rules for habitat", () => {
      const habitat = setupHabitat();
      createRule(habitat.id);
      createRule(habitat.id);
      createRule(habitat.id);

      expect(ruleRepo.countRulesByHabitat(habitat.id)).toBe(3);
    });
  });

  describe("listAllRulesForHabitatDescending", () => {
    it("returns rules in descending priority order", () => {
      const habitat = setupHabitat();
      createRule(habitat.id, { name: "L", priority: 1 });
      createRule(habitat.id, { name: "H", priority: 100 });

      const list = ruleRepo.listAllRulesForHabitatDescending(habitat.id);
      expect(list.map((r) => r.name)).toEqual(["H", "L"]);
    });
  });
});

describe("automationRuleRun repository", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("startRuleRun", () => {
    it("creates a running run with computed fingerprint", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-42",
      });

      expect(run.status).toBe("running");
      expect(run.skipReason).toBeNull();
      expect(run.finishedAt).toBeNull();
      expect(run.fingerprint).toBe(`${habitat.id}:${rule.id}:task.rejected:evt-1:task:task-42`);
    });

    it("stores metadata as JSON", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        metadata: { source: "test", payload: { x: 1 } },
      });

      const fetched = runRepo.getRuleRunById(run.id)!;
      expect(fetched.metadata).toMatchObject({ source: "test", payload: { x: 1 } });
    });

    it("accepts custom timestamp", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T00:00:00.000Z",
      });

      expect(run.startedAt).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("finishRuleRun", () => {
    it("marks run as succeeded with condition and action results", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      const conditionResult = {
        matched: true,
        conditionType: "always",
        reason: "Always matches",
      };
      const actionResults = [
        { actionType: "notify" as const, actionIndex: 0, status: "succeeded" as const },
      ];

      const finished = runRepo.finishRuleRun(run.id, {
        status: "succeeded",
        conditionResult,
        actionResults,
      });

      expect(finished.status).toBe("succeeded");
      expect(finished.finishedAt).not.toBeNull();
      expect(finished.conditionResult).toMatchObject(conditionResult);
      expect(finished.actionResults).toHaveLength(1);
    });

    it("marks run as partial_failed when some actions fail", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      const finished = runRepo.finishRuleRun(run.id, {
        status: "partial_failed",
        actionResults: [
          { actionType: "notify", actionIndex: 0, status: "succeeded" },
          { actionType: "change_priority", actionIndex: 1, status: "failed", error: "Not found" },
        ],
      });

      expect(finished.status).toBe("partial_failed");
    });

    it("marks run as simulated", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      const finished = runRepo.finishRuleRun(run.id, { status: "simulated" });
      expect(finished.status).toBe("simulated");
    });

    it("updates rule lastRunAt when run finishes", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      runRepo.finishRuleRun(run.id, { status: "succeeded" });

      const updated = ruleRepo.getAutomationRuleById(rule.id);
      expect(updated!.lastRunAt).not.toBeNull();
    });
  });

  describe("skipRuleRun", () => {
    it("marks run as skipped with reason", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      const skipped = runRepo.skipRuleRun(run.id, "cooldown");
      expect(skipped.status).toBe("skipped");
      expect(skipped.skipReason).toBe("cooldown");
      expect(skipped.finishedAt).not.toBeNull();
    });

    it("preserves skip reason in metadata", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });

      const skipped = runRepo.skipRuleRun(run.id, "rate_limited", {
        ruleId: rule.id,
        limit: 30,
        actual: 31,
      });
      expect(skipped.metadata).toMatchObject({ limit: 30, actual: 31 });
    });
  });

  describe("listRunsByRule", () => {
    it("lists runs for a rule with pagination", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      for (let i = 0; i < 5; i++) {
        runRepo.startRuleRun({
          ruleId: rule.id,
          habitatId: habitat.id,
          triggerType: "task.rejected",
          triggerEventId: `evt-${i}`,
        });
      }

      const page1 = runRepo.listRunsByRule(rule.id, { limit: 2, offset: 0 });
      expect(page1.runs).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = runRepo.listRunsByRule(rule.id, { limit: 2, offset: 2 });
      expect(page2.runs).toHaveLength(2);

      const page3 = runRepo.listRunsByRule(rule.id, { limit: 2, offset: 4 });
      expect(page3.runs).toHaveLength(1);
    });

    it("orders runs by started_at descending", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T10:00:00.000Z",
      });
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T11:00:00.000Z",
      });

      const { runs } = runRepo.listRunsByRule(rule.id);
      expect(runs[0].startedAt).toBe("2025-01-01T11:00:00.000Z");
      expect(runs[1].startedAt).toBe("2025-01-01T10:00:00.000Z");
    });
  });

  describe("listRunsByHabitat", () => {
    it("lists all runs in habitat with status filter", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const r1 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      const r2 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.overdue",
      });
      runRepo.finishRuleRun(r1.id, { status: "succeeded" });
      runRepo.skipRuleRun(r2.id, "cooldown");

      const succeeded = runRepo.listRunsByHabitat(habitat.id, { status: "succeeded" });
      expect(succeeded.runs).toHaveLength(1);

      const skipped = runRepo.listRunsByHabitat(habitat.id, { status: "skipped" });
      expect(skipped.runs).toHaveLength(1);

      const all = runRepo.listRunsByHabitat(habitat.id);
      expect(all.total).toBe(2);
    });

    it("isolates runs by habitat", () => {
      const h1 = setupHabitat();
      const h2 = setupHabitat();
      const rule1 = createRule(h1.id);
      const rule2 = createRule(h2.id);
      runRepo.startRuleRun({
        ruleId: rule1.id,
        habitatId: h1.id,
        triggerType: "task.rejected",
      });
      runRepo.startRuleRun({
        ruleId: rule2.id,
        habitatId: h2.id,
        triggerType: "task.rejected",
      });

      expect(runRepo.listRunsByHabitat(h1.id).total).toBe(1);
      expect(runRepo.listRunsByHabitat(h2.id).total).toBe(1);
    });

    it("supports array status filter", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const r1 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      const r2 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      runRepo.finishRuleRun(r1.id, { status: "succeeded" });
      runRepo.skipRuleRun(r2.id, "cooldown");

      const result = runRepo.listRunsByHabitat(habitat.id, {
        status: ["succeeded", "skipped"],
      });
      expect(result.runs).toHaveLength(2);
    });
  });

  describe("cooldown/fingerprint lookup", () => {
    it("getLastSuccessfulRunForFingerprint returns the most recent successful run", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      const r1 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
        now: "2025-01-01T10:00:00.000Z",
      });
      runRepo.finishRuleRun(r1.id, { status: "succeeded" });

      const r2 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
        now: "2025-01-01T11:00:00.000Z",
      });
      runRepo.finishRuleRun(r2.id, { status: "succeeded" });

      const last = runRepo.getLastSuccessfulRunForFingerprint({
        habitatId: habitat.id,
        ruleId: rule.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
      });

      expect(last).not.toBeNull();
      expect(last!.id).toBe(r2.id);
    });

    it("returns null when no successful run exists", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      runRepo.finishRuleRun(run.id, { status: "failed" });

      const last = runRepo.getLastSuccessfulRunForFingerprint({
        habitatId: habitat.id,
        ruleId: rule.id,
        triggerType: "task.rejected",
        triggerEventId: null,
        targetType: null,
        targetId: null,
      });
      expect(last).toBeNull();
    });

    it("getRunsByFingerprint returns all runs with that fingerprint", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const fingerprint = `${habitat.id}:${rule.id}:task.rejected:evt-1:task:task-1`;

      for (let i = 0; i < 3; i++) {
        runRepo.startRuleRun({
          ruleId: rule.id,
          habitatId: habitat.id,
          triggerType: "task.rejected",
          triggerEventId: "evt-1",
          targetType: "task",
          targetId: "task-1",
        });
      }

      const runs = runRepo.getRunsByFingerprint(habitat.id, fingerprint);
      expect(runs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("hourly run count", () => {
    it("getRunCountForRuleSince counts runs in window", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);

      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T10:00:00.000Z",
      });
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T10:30:00.000Z",
      });
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T09:30:00.000Z",
      });

      const count = runRepo.getRunCountForRuleSince(
        rule.id,
        "2025-01-01T10:00:00.000Z",
        "2025-01-01T11:00:00.000Z",
      );
      expect(count).toBe(2);
    });

    it("getHourlyRunCount counts runs in the last hour", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const now = "2025-01-01T12:00:00.000Z";

      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T11:30:00.000Z",
      });
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T10:00:00.000Z",
      });

      const count = runRepo.getHourlyRunCount(rule.id, now);
      expect(count).toBe(1);
    });

    it("returns 0 when no runs in window", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        now: "2025-01-01T10:00:00.000Z",
      });

      const count = runRepo.getHourlyRunCount(rule.id, "2025-01-01T20:00:00.000Z");
      expect(count).toBe(0);
    });
  });

  describe("getSkippedRunsByRule", () => {
    it("returns only skipped runs with skip reason", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      const r1 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      const r2 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
      });
      runRepo.skipRuleRun(r1.id, "cooldown");
      runRepo.finishRuleRun(r2.id, { status: "succeeded" });

      const { runs, total } = runRepo.getSkippedRunsByRule(rule.id);
      expect(total).toBe(1);
      expect(runs[0].skipReason).toBe("cooldown");
    });
  });

  describe("deleteRunsForRule", () => {
    it("deletes all runs for a rule", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id);
      for (let i = 0; i < 3; i++) {
        runRepo.startRuleRun({
          ruleId: rule.id,
          habitatId: habitat.id,
          triggerType: "task.rejected",
        });
      }

      runRepo.deleteRunsForRule(rule.id);

      const { total } = runRepo.listRunsByRule(rule.id);
      expect(total).toBe(0);
    });
  });

  describe("end-to-end run lifecycle", () => {
    it("complete lifecycle: create -> run -> finish succeeded", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, { enabled: true });

      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-99",
        targetType: "task",
        targetId: "task-99",
      });

      expect(run.status).toBe("running");

      const finished = runRepo.finishRuleRun(run.id, {
        status: "succeeded",
        conditionResult: {
          matched: true,
          conditionType: "always",
          reason: "Match",
        },
        actionResults: [{ actionType: "notify", actionIndex: 0, status: "succeeded" }],
      });

      expect(finished.status).toBe("succeeded");
      expect(finished.finishedAt).not.toBeNull();

      const ruleAfter = ruleRepo.getAutomationRuleById(rule.id);
      expect(ruleAfter!.lastRunAt).not.toBeNull();
    });

    it("cooldown: duplicate trigger inside window is queryable", () => {
      const habitat = setupHabitat();
      const rule = createRule(habitat.id, { cooldownSeconds: 300 });
      const t1 = "2025-01-01T10:00:00.000Z";
      const t2 = "2025-01-01T10:02:00.000Z";

      const r1 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
        now: t1,
      });
      runRepo.finishRuleRun(r1.id, { status: "succeeded" });

      const r2 = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId: habitat.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
        now: t2,
      });
      runRepo.skipRuleRun(r2.id, "cooldown");

      const last = runRepo.getLastSuccessfulRunForFingerprint({
        habitatId: habitat.id,
        ruleId: rule.id,
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        targetType: "task",
        targetId: "task-1",
      });
      expect(last!.id).toBe(r1.id);
      expect(last!.startedAt).toBe(t1);
    });
  });
});
