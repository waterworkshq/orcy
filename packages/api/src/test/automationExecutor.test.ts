import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as subscriptionRepo from "../repositories/notificationSubscription.js";
import { renderTemplate } from "../services/automationTemplateRenderer.js";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type {
  AutomationRule,
  AutomationAction,
  AutomationRuleRun,
  AutomationActionResult,
} from "@orcy/shared";
import { executeActions } from "../services/automationExecutor.js";
import * as eventRepo from "../repositories/notificationEvent.js";
import * as deliveryRepo from "../repositories/notificationDelivery.js";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupAgent(name: string, domain: string) {
  const result = agentRepo.createAgent({ name, type: "claude-code", domain });
  return result.agent;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "Test Mission", createdBy: "user-1" });
}

function emptyContext(): AutomationEvaluationContext {
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

function buildRule(habitatId: string, overrides?: Partial<AutomationRule>): AutomationRule {
  return {
    id: "rule-1",
    habitatId,
    name: "Test Rule",
    description: "",
    enabled: true,
    priority: 0,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: { type: "always" },
    actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "Test" }],
    cooldownSeconds: 300,
    maxRunsPerHour: 30,
    createdBy: "system:test",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    lastRunAt: null,
    ...overrides,
  };
}

function buildRun(habitatId: string, ruleId: string): AutomationRuleRun {
  return {
    id: "run-1",
    ruleId,
    habitatId,
    triggerType: "task.rejected",
    triggerEventId: null,
    targetType: "task",
    targetId: "task-1",
    fingerprint: `${habitatId}:${ruleId}:task.rejected:::task:task-1`,
    status: "running",
    skipReason: null,
    conditionResult: null,
    actionResults: null,
    metadata: null,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: null,
  };
}

describe("automationTemplateRenderer", () => {
  it("renders task.title from context", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { title: "Fix login bug", id: "t-1" } as any,
    };
    const result = renderTemplate("Task: {{task.title}}", ctx);
    expect(result.rendered).toBe("Task: Fix login bug");
    expect(result.warnings).toHaveLength(0);
  });

  it("renders task.priority from context", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { priority: "high", id: "t-1" } as any,
    };
    const result = renderTemplate("Priority: {{task.priority}}", ctx);
    expect(result.rendered).toBe("Priority: high");
  });

  it("renders mission.title from context", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      mission: { title: "Sprint 5", id: "m-1" } as any,
    };
    const result = renderTemplate("Mission: {{mission.title}}", ctx);
    expect(result.rendered).toBe("Mission: Sprint 5");
  });

  it("renders agent.name from context", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      agent: { name: "Agent-1", id: "a-1" } as any,
    };
    const result = renderTemplate("Agent: {{agent.name}}", ctx);
    expect(result.rendered).toBe("Agent: Agent-1");
  });

  it("renders habitat.name from context", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      habitat: { name: "My Habitat", id: "h-1" } as any,
    };
    const result = renderTemplate("In {{habitat.name}}", ctx);
    expect(result.rendered).toBe("In My Habitat");
  });

  it("warns on unknown tokens", () => {
    const result = renderTemplate("{{unknown.token}} is here", emptyContext());
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("unknown.token");
    expect(result.rendered).toBe("{{unknown.token}} is here");
  });

  it("leaves null values as unreplaced", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { assignedAgentId: null, id: "t-1" } as any,
    };
    const result = renderTemplate("Assignee: {{task.assignedAgentId}}", ctx);
    expect(result.rendered).toBe("Assignee: {{task.assignedAgentId}}");
  });

  it("renders multiple tokens", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { title: "Bug", priority: "critical" } as any,
      mission: { title: "Release" } as any,
    };
    const result = renderTemplate("{{task.title}} ({{task.priority}}) in {{mission.title}}", ctx);
    expect(result.rendered).toBe("Bug (critical) in Release");
  });

  it("JSON-serializes object values", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { labels: ["bug", "urgent"] } as any,
    };
    const result = renderTemplate("Labels: {{task.labels}}", ctx);
    expect(result.rendered).toBe('Labels: ["bug","urgent"]');
  });

  it("uses extra context override", () => {
    const ctx: AutomationEvaluationContext = {
      ...emptyContext(),
      task: { title: "Original" } as any,
    };
    const result = renderTemplate("{{task.title}}", ctx, { "task.title": "Override" });
    expect(result.rendered).toBe("Override");
  });
});

describe("automationExecutor", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  describe("notify action", () => {
    it("enqueues notification through command service", async () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });
      const updated = taskRepo.updateTask(task.id, { assignedAgentId: agent.id });
      const assigned = updated && "task" in updated ? updated.task : task;

      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "task.assigned",
        channels: ["in_app"],
      });

      const rule = buildRule(habitat.id, {
        actions: [
          {
            type: "notify",
            recipients: [{ type: "assignee" }],
            template: "Task assigned: {{task.title}}",
          },
        ],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: assigned,
        mission: mission as any,
        agent: agent as any,
        sprint: null,
        warnings: [],
        missingFields: [],
        raw: {},
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
      expect(actionResults[0].actionType).toBe("notify");

      const events = eventRepo.listNotificationEventsByHabitat(habitat.id);
      expect(events.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("create_signal action", () => {
    it("creates a pulse signal", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "create_signal", content: "Something happened" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
        mission: mission as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
      expect(actionResults[0].result?.pulseId).toBeDefined();
    });
  });

  describe("create_task action", () => {
    it("creates a task under existing mission", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);

      const rule = buildRule(habitat.id, {
        actions: [{ type: "create_task", title: "Auto task", missionId: mission.id }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        mission: mission as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
      expect(actionResults[0].result?.taskId).toBeDefined();
    });

    it("fails when no mission is available", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "create_task", title: "Should fail" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx = emptyContext();

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("failed");
      expect(actionResults[0].status).toBe("failed");
      expect(actionResults[0].error).toContain("No mission");
    });

    it("fails when specified mission does not exist", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "create_task", title: "Ghost task", missionId: "nonexistent" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("failed");
      expect(actionResults[0].error).toContain("Mission not found");
    });
  });

  describe("change_priority action", () => {
    it("changes task priority", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        priority: "low",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "change_priority", priority: "critical" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");

      const updated = taskRepo.getTaskById(task.id);
      expect(updated!.priority).toBe("critical");
    });

    it("fails when task context is missing", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "change_priority", priority: "high" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const { status, actionResults } = await executeActions(rule, run, emptyContext());
      expect(status).toBe("failed");
      expect(actionResults[0].status).toBe("failed");
    });
  });

  describe("assign action", () => {
    it("assigns agent to task", async () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "assign", recipientType: "agent", recipientId: agent.id }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");

      const updated = taskRepo.getTaskById(task.id);
      expect(updated!.assignedAgentId).toBe(agent.id);
    });

    it("fails when task context is missing", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "assign", recipientType: "agent", recipientId: "a-1" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const { status, actionResults } = await executeActions(rule, run, emptyContext());
      expect(actionResults[0].status).toBe("failed");
    });
  });

  describe("release_assignment action", () => {
    it("releases assignment from task", async () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });
      const r = taskRepo.claimTask(task.id, agent.id);
      const claimed = r.success ? r.task : task;

      const rule = buildRule(habitat.id, {
        actions: [{ type: "release_assignment" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: claimed as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
    });

    it("fails when task is not assigned", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "release_assignment" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("failed");
      expect(actionResults[0].status).toBe("failed");
    });
  });

  describe("request_review action", () => {
    it("requests review via auto-assign when no reviewer specified", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "request_review" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
    });

    it("directly assigns specific reviewer", async () => {
      const habitat = setupHabitat();
      const agent = setupAgent("Agent-1", "backend");
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "request_review", reviewerType: "agent", reviewerId: agent.id }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
    });
  });

  describe("call_webhook action", () => {
    it("rejects localhost URL", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "call_webhook", url: "http://localhost:3000/hook" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const { status, actionResults } = await executeActions(rule, run, emptyContext());
      expect(status).toBe("failed");
      expect(actionResults[0].status).toBe("failed");
      expect(actionResults[0].error).toContain("private");
    });

    it("rejects 127.0.0.1 URL", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "call_webhook", url: "http://127.0.0.1/hook" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const { actionResults } = await executeActions(rule, run, emptyContext());
      expect(actionResults[0].status).toBe("failed");
    });

    it("rejects authorization header", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [
          {
            type: "call_webhook",
            url: "https://example.com/hook",
            headers: { Authorization: "Bearer x" },
          },
        ],
      });
      const run = buildRun(habitat.id, rule.id);

      const { actionResults } = await executeActions(rule, run, emptyContext());
      expect(actionResults[0].status).toBe("failed");
      expect(actionResults[0].error).toContain("Authorization");
    });

    it("rejects x-api-key header", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [
          { type: "call_webhook", url: "https://example.com", headers: { "x-api-key": "abc" } },
        ],
      });
      const run = buildRun(habitat.id, rule.id);

      const { actionResults } = await executeActions(rule, run, emptyContext());
      expect(actionResults[0].status).toBe("failed");
    });

    it("requires a URL", async () => {
      const habitat = setupHabitat();
      const rule = buildRule(habitat.id, {
        actions: [{ type: "call_webhook", url: "" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const { actionResults } = await executeActions(rule, run, emptyContext());
      expect(actionResults[0].status).toBe("failed");
      expect(actionResults[0].error).toContain("required");
    });
  });

  describe("mark_risk action", () => {
    it("marks risk on task", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [{ type: "mark_risk", level: "high", reason: "Overdue" }],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults[0].status).toBe("succeeded");
      expect(actionResults[0].result?.level).toBe("high");
      expect(actionResults[0].result?.targetType).toBe("task");
    });
  });

  describe("partial failure status", () => {
    it("returns partial_failed when some actions fail and some succeed", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        priority: "low",
        createdBy: "user-1",
      });

      const rule = buildRule(habitat.id, {
        actions: [
          { type: "change_priority", priority: "high" },
          { type: "call_webhook", url: "http://localhost/hook" },
        ],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: task as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("partial_failed");
      expect(actionResults).toHaveLength(2);
      expect(actionResults[0].status).toBe("succeeded");
      expect(actionResults[1].status).toBe("failed");
    });
  });

  describe("multiple actions execution", () => {
    it("executes multiple notify actions", async () => {
      const habitat = setupHabitat();
      const agent = setupAgent("A1", "backend");
      const mission = setupMission(habitat.id);
      subscriptionRepo.createSubscription({
        habitatId: habitat.id,
        scope: "habitat_default",
        eventType: "task.assigned",
        channels: ["in_app"],
      });

      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Test Task",
        createdBy: "user-1",
      });
      const updated = taskRepo.updateTask(task.id, { assignedAgentId: agent.id });
      const assigned = updated && "task" in updated ? updated.task : task;

      const rule = buildRule(habitat.id, {
        actions: [
          { type: "notify", recipients: [{ type: "assignee" }], template: "First" },
          { type: "create_signal", content: "Second" },
          { type: "mark_risk", level: "info" },
        ],
      });
      const run = buildRun(habitat.id, rule.id);

      const ctx: AutomationEvaluationContext = {
        ...emptyContext(),
        habitat: { id: habitat.id, name: habitat.name } as any,
        task: assigned as any,
        mission: mission as any,
      };

      const { status, actionResults } = await executeActions(rule, run, ctx);
      expect(status).toBe("succeeded");
      expect(actionResults).toHaveLength(3);
      expect(actionResults.map((a) => a.actionType)).toEqual([
        "notify",
        "create_signal",
        "mark_risk",
      ]);
    });
  });
});
