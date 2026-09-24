/**
 * REC-06 (automation-release batch) — the committed-release postlude is
 * BEST-EFFORT: a non-required emitter failure after the bundle commits must
 * never manufacture a false action failure ("committed" stays committed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { tasks, taskEvents } from "../db/schema/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as ruleRepo from "../repositories/automationRule.js";
import { executeActions } from "../services/automationExecutor.js";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type { AutomationRule, AutomationRuleRun, Task } from "@orcy/shared";

vi.mock("../services/tasks/transition-emitter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/tasks/transition-emitter.js")>();
  return {
    ...original,
    emitTransitionNonRequired: () => {
      throw new Error("postlude observer exploded");
    },
  };
});

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "Postlude Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function buildRun(habitatId: string, ruleId: string, targetId: string): AutomationRuleRun {
  return {
    id: "run-postlude-1",
    ruleId,
    habitatId,
    triggerType: "release.shipped",
    triggerEventId: null,
    targetType: "task",
    targetId,
    fingerprint: `${habitatId}:${ruleId}:release.shipped:::task:${targetId}`,
    status: "running",
    skipReason: null,
    conditionResult: null,
    actionResults: null,
    metadata: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
  };
}

describe("automation release_assignment — committed postlude is best-effort", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => {
    closeDb();
  });

  it("an emitter failure after commit does not falsely report the release uncommitted", async () => {
    const h = setupHabitat();
    const agent = agentRepo.createAgent({
      name: "a",
      type: "claude-code",
      domain: "backend",
    }).agent;
    const mission = missionRepo.createMission({ habitatId: h.id, title: "M", createdBy: "user-1" });
    const created = taskRepo.createTask({ missionId: mission.id, title: "T", createdBy: "user-1" });
    const claim = taskRepo.claimTask(created.id, agent.id);
    if (!claim.success) throw new Error(claim.reason);
    const task: Task = taskRepo.getTaskById(created.id)!;

    const rule = ruleRepo.createAutomationRule({
      habitatId: h.id,
      name: "Release Rule",
      priority: 0,
      trigger: { type: "event", eventType: "release.shipped" } as never,
      condition: { type: "always" } as never,
      actions: [{ type: "release_assignment" }] as never,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      enabled: true,
      createdBy: "test",
    });

    const ctx: AutomationEvaluationContext = {
      habitat: { id: h.id, name: "h" } as never,
      task,
      mission: null,
      agent: null,
      sprint: null,
      warnings: [],
      missingFields: [],
      raw: {},
    };

    const { status, actionResults } = await executeActions(
      rule,
      buildRun(h.id, rule.id, task.id),
      ctx,
    );

    // Truthful outcome: the bundle COMMITTED; the observer error is not a
    // release failure.
    expect(status).toBe("succeeded");
    expect(actionResults[0]!.status).toBe("succeeded");
    const row = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .get() as typeof tasks.$inferSelect;
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    const events = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, task.id))
      .all()
      .filter((e) => e.action === "released");
    expect(events).toHaveLength(1);
  });
});
