import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as ruleRepo from "../repositories/automationRule.js";
import {
  buildEvaluationContext,
  buildTriggerContext,
} from "../services/automationContextBuilder.js";
import {
  evaluateCondition,
  validateRule,
  ConditionDepthExceededError,
  MAX_CONDITION_DEPTH,
  InvalidConditionError,
} from "../services/automationEvaluator.js";
import { simulateRule, buildSimulationTrigger } from "../services/automationSimulationService.js";
import type {
  AutomationRule,
  AutomationTriggerContext,
  AutomationCondition,
  AutomationAction,
  TaskPriority,
  TaskStatus,
} from "@orcy/shared";

function setupHabitat() {
  const habitat = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  return habitat;
}

function setupMission(habitatId: string, opts?: { dueAt?: string | null }) {
  return missionRepo.createMission({
    habitatId,
    title: "Test Mission",
    createdBy: "user-1",
    dueAt: opts?.dueAt ?? null,
  });
}

function setupAgent(name: string, domain: string) {
  const result = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain,
  });
  return result.agent;
}

function setupTask(
  missionId: string,
  opts?: {
    priority?: TaskPriority;
    status?: TaskStatus;
    assignedAgentId?: string | null;
    labels?: string[];
  },
) {
  const task = taskRepo.createTask({
    missionId,
    title: "Test Task",
    createdBy: "user-1",
    priority: opts?.priority,
    labels: opts?.labels,
  });
  if (opts?.assignedAgentId !== undefined && opts.assignedAgentId !== null) {
    const result = taskRepo.updateTask(task.id, { assignedAgentId: opts.assignedAgentId });
    if (result && "task" in result) return result.task;
  }
  return task;
}

function buildRule(overrides?: Partial<AutomationRule>): AutomationRule {
  return {
    id: "rule-1",
    habitatId: "hab-1",
    name: "Test Rule",
    description: "",
    enabled: true,
    priority: 0,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" },
    actions: [
      { type: "notify", recipients: [{ type: "assignee" }], template: "Test notification" },
    ],
    cooldownSeconds: 300,
    maxRunsPerHour: 30,
    createdBy: "system:test",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    lastRunAt: null,
    ...overrides,
  };
}

function buildEmptyContext() {
  return {
    habitat: null,
    task: null,
    mission: null,
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: {},
  };
}

describe("automationContextBuilder", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("buildEvaluationContext", () => {
    it("returns empty context when no target", () => {
      const trigger: AutomationTriggerContext = {
        triggerType: "task.rejected",
        triggerEventId: null,
        habitatId: "missing-habitat",
        targetType: "none",
        targetId: null,
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.habitat).toBeNull();
      expect(ctx.task).toBeNull();
      expect(ctx.mission).toBeNull();
      expect(ctx.agent).toBeNull();
      expect(ctx.missingFields).toContain("habitat");
    });

    it("loads habitat when habitat exists", () => {
      const habitat = setupHabitat();
      const trigger: AutomationTriggerContext = {
        triggerType: "sprint.started",
        triggerEventId: null,
        habitatId: habitat.id,
        targetType: "none",
        targetId: null,
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.habitat).not.toBeNull();
      expect(ctx.habitat!.id).toBe(habitat.id);
    });

    it("loads task + mission + agent for task target", () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");
      const mission = setupMission(habitat.id);
      const task = setupTask(mission.id, { priority: "high", assignedAgentId: agent.id });

      const trigger: AutomationTriggerContext = {
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        habitatId: habitat.id,
        targetType: "task",
        targetId: task.id,
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.task).not.toBeNull();
      expect(ctx.task!.id).toBe(task.id);
      expect(ctx.mission).not.toBeNull();
      expect(ctx.mission!.id).toBe(mission.id);
      expect(ctx.agent).not.toBeNull();
      expect(ctx.agent!.id).toBe(agent.id);
    });

    it("reports missing task for nonexistent task id", () => {
      const habitat = setupHabitat();
      const trigger: AutomationTriggerContext = {
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        habitatId: habitat.id,
        targetType: "task",
        targetId: "nonexistent-task",
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.task).toBeNull();
      expect(ctx.missingFields).toContain("task");
    });

    it("loads mission for mission target", () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);

      const trigger: AutomationTriggerContext = {
        triggerType: "mission.status_changed",
        triggerEventId: "evt-1",
        habitatId: habitat.id,
        targetType: "mission",
        targetId: mission.id,
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.mission).not.toBeNull();
      expect(ctx.task).toBeNull();
    });

    it("loads agent for agent target", () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");

      const trigger: AutomationTriggerContext = {
        triggerType: "anomaly.detected",
        triggerEventId: "evt-1",
        habitatId: habitat.id,
        targetType: "agent",
        targetId: agent.id,
        payload: {},
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.agent).not.toBeNull();
      expect(ctx.agent!.id).toBe(agent.id);
    });

    it("passes raw payload through", () => {
      const habitat = setupHabitat();
      const trigger: AutomationTriggerContext = {
        triggerType: "task.rejected",
        triggerEventId: null,
        habitatId: habitat.id,
        targetType: "none",
        targetId: null,
        payload: { x: 1, y: "hello" },
      };
      const ctx = buildEvaluationContext(trigger);
      expect(ctx.raw).toEqual({ x: 1, y: "hello" });
    });
  });

  describe("buildTriggerContext", () => {
    it("builds a trigger context with all fields", () => {
      const tc = buildTriggerContext({
        triggerType: "task.rejected",
        triggerEventId: "evt-1",
        habitatId: "h-1",
        targetType: "task",
        targetId: "t-1",
        payload: { foo: "bar" },
        provenance: { source: "server", ruleId: "r-1", runId: "run-1" },
      });
      expect(tc.triggerType).toBe("task.rejected");
      expect(tc.triggerEventId).toBe("evt-1");
      expect(tc.targetType).toBe("task");
      expect(tc.provenance?.source).toBe("server");
    });
  });
});

describe("automationEvaluator - condition types", () => {
  describe("always", () => {
    it("matches unconditionally", () => {
      const result = evaluateCondition({ type: "always" }, buildEmptyContext());
      expect(result.matched).toBe(true);
      expect(result.conditionType).toBe("always");
    });
  });

  describe("and", () => {
    it("matches when all children match", () => {
      const result = evaluateCondition(
        {
          type: "and",
          children: [{ type: "always" }, { type: "always" }],
        },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(true);
      expect(result.children).toHaveLength(2);
    });

    it("does not match when any child fails", () => {
      const result = evaluateCondition(
        {
          type: "and",
          children: [{ type: "always" }, { type: "unassigned" }],
        },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(false);
    });

    it("empty AND matches vacuously", () => {
      const result = evaluateCondition({ type: "and", children: [] }, buildEmptyContext());
      expect(result.matched).toBe(true);
    });
  });

  describe("or", () => {
    it("matches when any child matches", () => {
      const result = evaluateCondition(
        {
          type: "or",
          children: [{ type: "unassigned" }, { type: "always" }],
        },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when all children fail", () => {
      const result = evaluateCondition(
        {
          type: "or",
          children: [{ type: "unassigned" }, { type: "unassigned" }],
        },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(false);
    });

    it("empty OR does not match", () => {
      const result = evaluateCondition({ type: "or", children: [] }, buildEmptyContext());
      expect(result.matched).toBe(false);
    });
  });

  describe("not", () => {
    it("inverts child result", () => {
      const result = evaluateCondition(
        { type: "not", child: { type: "always" } },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(false);
    });

    it("empty NOT matches vacuously", () => {
      const result = evaluateCondition(
        { type: "not", child: { type: "always" } as AutomationCondition },
        buildEmptyContext(),
      );
      // not(empty) = true, so above is false
      // but the spec says empty NOT matches vacuously
      // we test: not(undefined) -> true
      const result2 = evaluateCondition(
        { type: "not", child: undefined as unknown as AutomationCondition },
        buildEmptyContext(),
      );
      expect(result2.matched).toBe(true);
      // sanity
      expect(result.matched).toBe(false);
    });
  });

  describe("priority_above / priority_below", () => {
    it("priority_above matches when task priority is above threshold", () => {
      const result = evaluateCondition(
        { type: "priority_above", threshold: "medium" },
        { ...buildEmptyContext(), task: { priority: "high" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("priority_above does not match when priority equals threshold", () => {
      const result = evaluateCondition(
        { type: "priority_above", threshold: "high" },
        { ...buildEmptyContext(), task: { priority: "high" } as any },
      );
      expect(result.matched).toBe(false);
    });

    it("priority_above does not match when task is missing", () => {
      const result = evaluateCondition(
        { type: "priority_above", threshold: "medium" },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(false);
    });

    it("priority_below matches when task priority is below threshold", () => {
      const result = evaluateCondition(
        { type: "priority_below", threshold: "high" },
        { ...buildEmptyContext(), task: { priority: "medium" } as any },
      );
      expect(result.matched).toBe(true);
    });
  });

  describe("status_in", () => {
    it("matches when task status is in list", () => {
      const result = evaluateCondition(
        { type: "status_in", statuses: ["in_progress", "claimed"] },
        { ...buildEmptyContext(), task: { status: "claimed" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when status is not in list", () => {
      const result = evaluateCondition(
        { type: "status_in", statuses: ["approved"] },
        { ...buildEmptyContext(), task: { status: "rejected" } as any },
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("assigned_to", () => {
    it("matches when agent is assigned", () => {
      const result = evaluateCondition(
        { type: "assigned_to", recipientType: "agent", recipientId: "a-1" },
        { ...buildEmptyContext(), task: { assignedAgentId: "a-1" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when different agent is assigned", () => {
      const result = evaluateCondition(
        { type: "assigned_to", recipientType: "agent", recipientId: "a-1" },
        { ...buildEmptyContext(), task: { assignedAgentId: "a-2" } as any },
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("unassigned", () => {
    it("matches when task is unassigned", () => {
      const result = evaluateCondition(
        { type: "unassigned" },
        { ...buildEmptyContext(), task: { assignedAgentId: null } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when task has assignee", () => {
      const result = evaluateCondition(
        { type: "unassigned" },
        { ...buildEmptyContext(), task: { assignedAgentId: "a-1" } as any },
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("overdue_by", () => {
    it("matches when mission is overdue beyond threshold", () => {
      const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const result = evaluateCondition(
        { type: "overdue_by", minutes: 5 },
        {
          ...buildEmptyContext(),
          task: {} as any,
          mission: { dueAt: past } as any,
        },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when within threshold", () => {
      const past = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const result = evaluateCondition(
        { type: "overdue_by", minutes: 5 },
        {
          ...buildEmptyContext(),
          task: {} as any,
          mission: { dueAt: past } as any,
        },
      );
      expect(result.matched).toBe(false);
    });

    it("does not match when mission has no dueAt", () => {
      const result = evaluateCondition(
        { type: "overdue_by", minutes: 5 },
        {
          ...buildEmptyContext(),
          task: {} as any,
          mission: { dueAt: null } as any,
        },
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("label_contains", () => {
    it("matches when task has the label", () => {
      const result = evaluateCondition(
        { type: "label_contains", label: "bug" },
        { ...buildEmptyContext(), task: { labels: ["bug", "urgent"] } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when label is absent", () => {
      const result = evaluateCondition(
        { type: "label_contains", label: "feature" },
        { ...buildEmptyContext(), task: { labels: ["bug"] } as any },
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("domain_is", () => {
    it("matches when agent domain matches", () => {
      const result = evaluateCondition(
        { type: "domain_is", domain: "backend" },
        { ...buildEmptyContext(), agent: { domain: "backend" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("does not match when agent domain differs", () => {
      const result = evaluateCondition(
        { type: "domain_is", domain: "backend" },
        { ...buildEmptyContext(), agent: { domain: "frontend" } as any },
      );
      expect(result.matched).toBe(false);
    });

    it("does not match when agent is missing", () => {
      const result = evaluateCondition(
        { type: "domain_is", domain: "backend" },
        buildEmptyContext(),
      );
      expect(result.matched).toBe(false);
    });
  });

  describe("field condition", () => {
    it("equals operator", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.status", operator: "equals", value: "claimed" },
        { ...buildEmptyContext(), task: { status: "claimed" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("not_equals operator", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.priority", operator: "not_equals", value: "low" },
        { ...buildEmptyContext(), task: { priority: "high" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("contains operator on string", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.title", operator: "contains", value: "bug" },
        { ...buildEmptyContext(), task: { title: "Fix login bug" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("contains operator on array", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.labels", operator: "contains", value: "urgent" },
        { ...buildEmptyContext(), task: { labels: ["bug", "urgent"] } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("greater_than operator", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.rejectedCount", operator: "greater_than", value: 1 },
        { ...buildEmptyContext(), task: { rejectedCount: 3 } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("in operator", () => {
      const result = evaluateCondition(
        {
          type: "field",
          field: "task.priority",
          operator: "in",
          value: ["high", "critical"],
        },
        { ...buildEmptyContext(), task: { priority: "high" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("exists operator", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.assignedAgentId", operator: "exists", value: undefined },
        { ...buildEmptyContext(), task: { assignedAgentId: "a-1" } as any },
      );
      expect(result.matched).toBe(true);
    });

    it("not_exists operator on null", () => {
      const result = evaluateCondition(
        { type: "field", field: "task.assignedAgentId", operator: "not_exists", value: undefined },
        { ...buildEmptyContext(), task: { assignedAgentId: null } as any },
      );
      expect(result.matched).toBe(true);
    });
  });

  describe("nesting", () => {
    it("AND of ORs produces a tree", () => {
      const condition: AutomationCondition = {
        type: "and",
        children: [
          {
            type: "or",
            children: [
              { type: "priority_above", threshold: "high" },
              { type: "label_contains", label: "urgent" },
            ],
          },
          { type: "not", child: { type: "unassigned" } },
        ],
      };
      const result = evaluateCondition(condition, {
        ...buildEmptyContext(),
        task: { priority: "critical", assignedAgentId: "a-1", labels: ["bug"] } as any,
      });
      expect(result.matched).toBe(true);
      expect(result.children).toHaveLength(2);
    });
  });

  describe("depth limit", () => {
    it("throws when nesting exceeds 5", () => {
      // root(0) > and(1) > and(2) > and(3) > and(4) > and(5) > and(6) > always(7)
      // MAX_CONDITION_DEPTH is 5, so depth=6 throws.
      const deep: AutomationCondition = {
        type: "and",
        children: [
          {
            type: "and",
            children: [
              {
                type: "and",
                children: [
                  {
                    type: "and",
                    children: [
                      {
                        type: "and",
                        children: [
                          {
                            type: "and",
                            children: [{ type: "always" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(() => evaluateCondition(deep, buildEmptyContext())).toThrow(
        ConditionDepthExceededError,
      );
    });

    it("depth of 5 succeeds", () => {
      const cond: AutomationCondition = {
        type: "and",
        children: [
          {
            type: "and",
            children: [
              {
                type: "and",
                children: [
                  {
                    type: "and",
                    children: [{ type: "always" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = evaluateCondition(cond, buildEmptyContext());
      expect(result.matched).toBe(true);
    });

    it("exposes MAX_CONDITION_DEPTH constant", () => {
      expect(MAX_CONDITION_DEPTH).toBe(5);
    });
  });

  describe("validation errors", () => {
    it("throws on invalid condition shape", () => {
      expect(() =>
        evaluateCondition(null as unknown as AutomationCondition, buildEmptyContext()),
      ).toThrow(InvalidConditionError);
    });
  });
});

describe("validateRule", () => {
  it("passes for a valid rule with notify action", () => {
    const rule = buildRule();
    const result = validateRule(rule);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails for rule with no actions", () => {
    const rule = buildRule({ actions: [] });
    const result = validateRule(rule);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one action"))).toBe(true);
  });

  it("fails for rule with more than 10 actions", () => {
    const actions: AutomationAction[] = Array.from({ length: 11 }, () => ({
      type: "create_signal",
      content: "x",
    }));
    const rule = buildRule({ actions });
    const result = validateRule(rule);
    expect(result.valid).toBe(false);
  });

  it("fails for notify with template over 4000 chars", () => {
    const rule = buildRule({
      actions: [
        {
          type: "notify",
          recipients: [{ type: "assignee" }],
          template: "x".repeat(4001),
        },
      ],
    });
    const result = validateRule(rule);
    expect(result.valid).toBe(false);
  });

  it("warns for create_task without explicit missionId", () => {
    const rule = buildRule({
      actions: [{ type: "create_task", title: "New task" }],
    });
    const result = validateRule(rule);
    expect(result.warnings.some((w) => w.includes("missionId"))).toBe(true);
  });

  it("fails for call_webhook with banned headers", () => {
    const rule = buildRule({
      actions: [
        {
          type: "call_webhook",
          url: "https://example.com",
          headers: { Authorization: "Bearer secret" },
        },
      ],
    });
    const result = validateRule(rule);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("authorization"))).toBe(true);
  });

  it("rejects x-api-key header", () => {
    const rule = buildRule({
      actions: [
        {
          type: "call_webhook",
          url: "https://example.com",
          headers: { "x-api-key": "secret" },
        },
      ],
    });
    const result = validateRule(rule);
    expect(result.valid).toBe(false);
  });
});

describe("automationSimulationService", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("simulates an always-true rule that would execute", () => {
    const habitat = setupHabitat();
    const rule = buildRule({ habitatId: habitat.id, name: "Always Rule" });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
      triggerEventId: null,
    });

    const result = simulateRule({ rule, trigger });

    expect(result.wouldExecute).toBe(true);
    expect(result.skipReason).toBeUndefined();
    expect(result.conditionResult.matched).toBe(true);
    expect(result.actionPreviews).toHaveLength(1);
    expect(result.actionPreviews[0].actionType).toBe("notify");
  });

  it("simulates a rule whose condition does not match -> wouldExecute false", () => {
    const habitat = setupHabitat();
    const rule = buildRule({
      habitatId: habitat.id,
      condition: { type: "unassigned" },
    });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const result = simulateRule({ rule, trigger });

    expect(result.wouldExecute).toBe(false);
    expect(result.skipReason).toBe("condition_false");
  });

  it("simulates a rule with invalid validation -> wouldExecute false with missing_target", () => {
    const habitat = setupHabitat();
    const rule = buildRule({
      habitatId: habitat.id,
      actions: [
        {
          type: "call_webhook",
          url: "https://example.com",
          headers: { Authorization: "Bearer x" },
        },
      ],
    });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const result = simulateRule({ rule, trigger });

    expect(result.wouldExecute).toBe(false);
    expect(result.skipReason).toBe("missing_target");
    expect(result.validation.valid).toBe(false);
  });

  it("simulation does NOT execute actions", () => {
    const habitat = setupHabitat();
    const rule = buildRule({ habitatId: habitat.id });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    // Should not throw, should not call any external system
    const result = simulateRule({ rule, trigger });

    expect(result.wouldExecute).toBe(true);
    // Action previews describe intent only
    expect(result.actionPreviews[0].description).toContain("Send notification");
  });

  it("returns context with target entities loaded", () => {
    const habitat = setupHabitat();
    const agent = setupAgent("Agent-1", "backend");
    const mission = setupMission(habitat.id);
    const task = setupTask(mission.id, { priority: "high", assignedAgentId: agent.id });
    const rule = buildRule({
      habitatId: habitat.id,
      condition: { type: "priority_above", threshold: "medium" },
    });
    const trigger: AutomationTriggerContext = {
      triggerType: "task.rejected",
      triggerEventId: "evt-1",
      habitatId: habitat.id,
      targetType: "task",
      targetId: task.id,
      payload: {},
    };

    const result = simulateRule({ rule, trigger });

    expect(result.context.task).not.toBeNull();
    expect(result.context.task!.id).toBe(task.id);
    expect(result.context.agent).not.toBeNull();
    expect(result.context.mission).not.toBeNull();
  });

  it("supports overrideCondition for what-if testing", () => {
    const habitat = setupHabitat();
    const rule = buildRule({
      habitatId: habitat.id,
      condition: { type: "unassigned" },
    });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const result = simulateRule({
      rule,
      trigger,
      overrideCondition: { type: "always" },
    });

    expect(result.wouldExecute).toBe(true);
  });

  it("preview text describes each action type", () => {
    const habitat = setupHabitat();
    const rule = buildRule({
      habitatId: habitat.id,
      actions: [
        { type: "notify", recipients: [{ type: "assignee" }], template: "Hello" },
        { type: "create_signal", content: "Hello" },
        { type: "create_task", title: "New" },
        { type: "change_priority", priority: "high" },
        { type: "assign", recipientType: "agent", recipientId: "a-1" },
        { type: "release_assignment" },
        { type: "request_review" },
        { type: "call_webhook", url: "https://example.com" },
        { type: "mark_risk", level: "high" },
      ],
    });
    const trigger = buildSimulationTrigger({
      habitatId: habitat.id,
      triggerType: "task.rejected",
    });

    const result = simulateRule({ rule, trigger });

    expect(result.actionPreviews).toHaveLength(9);
    expect(result.actionPreviews.map((p) => p.actionType)).toEqual([
      "notify",
      "create_signal",
      "create_task",
      "change_priority",
      "assign",
      "release_assignment",
      "request_review",
      "call_webhook",
      "mark_risk",
    ]);
  });
});

describe("integration: simulate end-to-end with real entities", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  it("rejected task with high priority triggers condition that matches", () => {
    const habitat = setupHabitat();
    const agent = setupAgent("Agent-1", "backend");
    const mission = setupMission(habitat.id);
    const task = setupTask(mission.id, { priority: "high", assignedAgentId: agent.id });

    const rule = buildRule({
      habitatId: habitat.id,
      trigger: { type: "event", eventType: "task.rejected" },
      condition: {
        type: "and",
        children: [
          { type: "priority_above", threshold: "medium" },
          { type: "assigned_to", recipientType: "agent", recipientId: agent.id },
        ],
      },
    });
    const trigger: AutomationTriggerContext = {
      triggerType: "task.rejected",
      triggerEventId: "evt-1",
      habitatId: habitat.id,
      targetType: "task",
      targetId: task.id,
      payload: {},
    };

    const result = simulateRule({ rule, trigger });

    expect(result.wouldExecute).toBe(true);
    expect(result.conditionResult.matched).toBe(true);
  });

  it("rule is skipped when target task does not exist", () => {
    const habitat = setupHabitat();
    const rule = buildRule({ habitatId: habitat.id });
    const trigger: AutomationTriggerContext = {
      triggerType: "task.rejected",
      triggerEventId: "evt-1",
      habitatId: habitat.id,
      targetType: "task",
      targetId: "nonexistent",
      payload: {},
    };

    const result = simulateRule({ rule, trigger });

    expect(result.context.task).toBeNull();
    expect(result.context.missingFields).toContain("task");
    // The condition was 'always' so it still matches, but execution would proceed
    // The simulator does not auto-skip on missing target; the executor does
    expect(result.wouldExecute).toBe(true);
  });
});
