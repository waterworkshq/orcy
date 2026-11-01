/**
 * Rejected-task rework ownership survives retry-ladder escalation (#137).
 *
 * Every test drives the REAL lifecycle spine (claimTask / startTask /
 * submitTask / the lifecycle service's rejectTask) plus the real
 * retry/escalation writers against the sql.js test DB — the retry service is
 * never mocked. The discriminator is the retry POLICY on the task row:
 *
 *   escalation enabled  {maxRetries:0, escalateToHuman:true,  retryOnStatuses:["all"]}
 *   control             {maxRetries:0, escalateToHuman:false, retryOnStatuses:["all"]}
 *
 * `maxRetries: 0` makes the very first reviewer rejection take the
 * escalation arm deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as taskService from "../services/tasks/index.js";
import { escalateToHuman } from "../services/retryService.js";
import { closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { getEventsByTaskId } from "../repositories/event.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { ExecutionEpochMismatchError } from "../errors.js";
import type { Task } from "../models/index.js";

const ESCALATING = {
  maxRetries: 0,
  escalateToHuman: true,
  retryOnStatuses: ["all"],
};
const CONTROL = {
  maxRetries: 0,
  escalateToHuman: false,
  retryOnStatuses: ["all"],
};

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Rejected Rework Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => {
  closeDb();
});

afterAll(() => {
  pluginManager.resetPlugins();
});

function seedAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent;
}

function seedTask(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" });
}

function escalatedEventCount(taskId: string): number {
  return getEventsByTaskId(taskId).events.filter((e) => e.action === "escalated").length;
}

/** claim → start → submit through the real service spine; returns the claim epoch token. */
function claimStartSubmit(taskId: string, agentId: string): string {
  const claim = taskService.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const token = taskRepo.getTaskById(taskId)!.executionToken;
  expect(token).not.toBeNull();
  const started = taskService.startTask(taskId, agentId, token);
  expect(started?.status).toBe("in_progress");
  const submitted = taskService.submitTask(taskId, agentId, "first result", [], token);
  expect(submitted.task).not.toBeNull();
  expect(submitted.task!.status).toBe("submitted");
  return token as string;
}

describe("rejected-task rework ownership vs retry-ladder escalation (#137)", () => {
  it("escalated rejection preserves the owner, the continuation token, and the rework path", () => {
    const agent = seedAgent("owner-1");
    const task = seedTask("escalated-rejection");
    taskRepo.updateTask(task.id, { retryPolicy: ESCALATING });
    const token1 = claimStartSubmit(task.id, agent.id);

    expect(taskService.rejectTask(task.id, "rev-1", "needs work", "human")).not.toBeNull();

    const after = taskRepo.getTaskById(task.id)!;
    expect(after.status).toBe("rejected"); // status preserved
    expect(after.assignedAgentId).toBe(agent.id); // owner preserved
    expect(after.executionToken).toBe(token1); // continuation token preserved
    expect(after.rejectionReason).toBe("needs work"); // reviewer reason retained
    expect(escalatedEventCount(task.id)).toBe(1); // attention still recorded

    // The owner restarts rework with the preserved token; the restart mints
    // the NEXT execution epoch (REC-10 rejected-continuation contract).
    const restarted = taskService.startTask(task.id, agent.id, token1);
    expect(restarted?.status).toBe("in_progress");
    expect(restarted!.executionToken).toBeTruthy();
    expect(restarted!.executionToken).not.toBe(token1);

    // Stale continuation token stays fenced on the new epoch.
    expect(() =>
      taskService.submitTask(task.id, agent.id, "stale", [], token1),
    ).toThrow(ExecutionEpochMismatchError);

    // Rework completes under the new epoch: review semantics continue after
    // escalation (ownership generation was not invalidated).
    const resubmit = taskService.submitTask(
      task.id,
      agent.id,
      "fixed result",
      [],
      restarted!.executionToken,
    );
    expect(resubmit.task?.status).toBe("submitted");
  });

  it("a different agent cannot claim or restart the escalated-rejected task", () => {
    const agent = seedAgent("owner-2");
    const other = seedAgent("usurper-2");
    const task = seedTask("escalated-fence");
    taskRepo.updateTask(task.id, { retryPolicy: ESCALATING });
    const token1 = claimStartSubmit(task.id, agent.id);
    expect(taskService.rejectTask(task.id, "rev-2", "no", "human")).not.toBeNull();

    expect(taskService.claimTask(task.id, other.id).success).toBe(false);
    expect(taskService.startTask(task.id, other.id, token1)).toBeNull();

    const after = taskRepo.getTaskById(task.id)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(agent.id);
    expect(after.executionToken).toBe(token1);
  });

  it("non-escalating rejection control keeps the documented owner continuation", () => {
    const agent = seedAgent("owner-3");
    const task = seedTask("control-rejection");
    taskRepo.updateTask(task.id, { retryPolicy: CONTROL });
    const token1 = claimStartSubmit(task.id, agent.id);
    expect(taskService.rejectTask(task.id, "rev-3", "no", "human")).not.toBeNull();

    const after = taskRepo.getTaskById(task.id)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(agent.id);
    expect(after.executionToken).toBe(token1);
    expect(escalatedEventCount(task.id)).toBe(0);

    const restarted = taskService.startTask(task.id, agent.id, token1);
    expect(restarted?.status).toBe("in_progress");
  });

  it("failed-task escalation still ends custody (failed lane unchanged)", () => {
    // (a) Real service flow: failTask itself ends ownership + token.
    const agent = seedAgent("owner-4");
    const task = seedTask("failed-escalation");
    taskRepo.updateTask(task.id, { retryPolicy: ESCALATING });
    const claim = taskService.claimTask(task.id, agent.id);
    expect(claim.success).toBe(true);
    const token = taskRepo.getTaskById(task.id)!.executionToken as string;
    expect(taskService.startTask(task.id, agent.id, token)?.status).toBe("in_progress");
    expect(taskService.failTask(task.id, agent.id, "agent", "boom", token)).not.toBeNull();
    const failed = taskRepo.getTaskById(task.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.assignedAgentId).toBeNull();
    expect(failed.executionToken).toBeNull();

    // (b) Discriminator: a failed row that STILL holds custody (legacy /
    // worker-shaped) — only the custody-ending escalation writer clears it.
    const agent2 = seedAgent("owner-4b");
    const task2 = seedTask("failed-escalation-custody");
    taskRepo.updateTask(task2.id, { retryPolicy: CONTROL });
    const claim2 = taskService.claimTask(task2.id, agent2.id);
    expect(claim2.success).toBe(true);
    const token2 = taskRepo.getTaskById(task2.id)!.executionToken as string;
    expect(taskService.startTask(task2.id, agent2.id, token2)?.status).toBe("in_progress");
    updateTaskFixtureForTests(task2.id, { status: "failed" });
    const before = taskRepo.getTaskById(task2.id)!;
    expect(before.assignedAgentId).toBe(agent2.id);
    expect(before.executionToken).toBe(token2);

    const out = escalateToHuman(taskRepo.getTaskById(task2.id) as unknown as Task);
    expect(out).not.toBeNull();
    const after = taskRepo.getTaskById(task2.id)!;
    expect(after.status).toBe("failed");
    expect(after.assignedAgentId).toBeNull();
    expect(after.executionToken).toBeNull();
  });

  it("rejected-lane attention escalation retires a stale nextRetryAt pointer without touching custody", () => {
    const agent = seedAgent("owner-5");
    const task = seedTask("escalated-pointer");
    taskRepo.updateTask(task.id, { retryPolicy: ESCALATING });
    const token1 = claimStartSubmit(task.id, agent.id);
    expect(taskService.rejectTask(task.id, "rev-5", "no", "human")).not.toBeNull();

    // Policy-shrink edge: a due nextRetryAt on the escalated rejected row
    // must not re-arm the processor loop every tick.
    taskRepo.updateTask(task.id, { nextRetryAt: "2000-01-01T00:00:00.000Z" });
    const out = escalateToHuman(taskRepo.getTaskById(task.id) as unknown as Task);
    expect(out).not.toBeNull();

    const after = taskRepo.getTaskById(task.id)!;
    expect(after.status).toBe("rejected");
    expect(after.assignedAgentId).toBe(agent.id);
    expect(after.executionToken).toBe(token1);
    expect(after.nextRetryAt).toBeNull();
  });
});
