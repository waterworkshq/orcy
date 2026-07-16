import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as failureContextService from "../services/failureContextService.js";
import * as eventRepo from "../repositories/events/event-crud.js";
import { initSkillHooks } from "../services/habitatSkillService.js";
import { attachWorkflow, initWorkflowService } from "../services/workflowService.js";
import { claimTask } from "../repositories/taskStateMachine.js";
import { emitTransition } from "../services/tasks/transition-emitter.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import {
  taskWorkflowGates,
  workflows,
  tasks,
  missions,
  columns,
  habitats,
  pulses,
} from "../db/schema/index.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";

const N = 50;

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

beforeAll(async () => {
  await initTestDb();
  initWorkflowService();
  initSkillHooks();
  const db = getDb();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(pulses).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Perf Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({ habitatId, name: "Todo", order: 0 });
  columnId = col.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Perf Mission",
    createdBy: "human-1",
  });
  missionId = mission.id;
  const agent = agentRepo.createAgent({
    name: "perf-agent",
    type: "claude-code",
    domain: "general",
  }).agent;
  agentId = agent.id;
});

afterAll(() => {
  closeDb();
});

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

describe("I2 Benchmark 1 — claimTask latency: gated vs non-gated", () => {
  it("measures claimTask overhead from workflow gate check (<20% soft threshold)", () => {
    const db = getDb();

    // Create N non-gated tasks and N gated tasks.
    const nonGatedIds: string[] = [];
    const gatedIds: string[] = [];

    for (let i = 0; i < N; i++) {
      const t = taskCrudRepo.createTask({
        missionId,
        title: `Non-gated ${i}`,
        createdBy: "perf",
      });
      nonGatedIds.push(t.id);
    }

    // For gated tasks, create pairs: upstream→downstream with on_complete gate.
    const upstreamIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const upstream = taskCrudRepo.createTask({
        missionId,
        title: `Gated-upstream ${i}`,
        createdBy: "perf",
      });
      const downstream = taskCrudRepo.createTask({
        missionId,
        title: `Gated-downstream ${i}`,
        createdBy: "perf",
      });
      upstreamIds.push(upstream.id);
      gatedIds.push(downstream.id);

      // Attach a workflow with on_complete gate: upstream → downstream.
      // To avoid creating N separate workflows, create one workflow per pair.
      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_complete",
          },
        ],
      };
      attachWorkflow(missionId, habitatId, definition, {}, "perf");
    }

    // Pre-satisfy all gates so gated tasks are claimable.
    for (const uid of upstreamIds) {
      db.update(taskWorkflowGates)
        .set({ satisfied: true })
        .where(eq(taskWorkflowGates.upstreamTaskId, uid))
        .run();
    }

    // Measure non-gated claims.
    const nonGatedTimes: number[] = [];
    for (const id of nonGatedIds) {
      const t0 = performance.now();
      claimTask(id, agentId);
      const t1 = performance.now();
      nonGatedTimes.push(t1 - t0);
    }

    // Reset non-gated tasks to pending (so they don't interfere).
    for (const id of nonGatedIds) {
      db.update(tasks).set({ status: "done", assignedAgentId: null }).where(eq(tasks.id, id)).run();
    }

    // Measure gated claims.
    const gatedTimes: number[] = [];
    for (const id of gatedIds) {
      const t0 = performance.now();
      claimTask(id, agentId);
      const t1 = performance.now();
      gatedTimes.push(t1 - t0);
    }

    const nonGatedAvg = avg(nonGatedTimes);
    const gatedAvg = avg(gatedTimes);
    const overheadPct = nonGatedAvg > 0 ? ((gatedAvg - nonGatedAvg) / nonGatedAvg) * 100 : 0;

    console.log(
      `[Benchmark 1] claimTask: non-gated avg=${nonGatedAvg.toFixed(3)}ms, ` +
        `gated avg=${gatedAvg.toFixed(3)}ms, overhead=${overheadPct.toFixed(1)}%`,
    );
    console.log(
      `[Benchmark 1] non-gated p95=${p95(nonGatedTimes).toFixed(3)}ms, ` +
        `gated p95=${p95(gatedTimes).toFixed(3)}ms`,
    );

    // Soft assertion: fail if overhead > 20%.
    if (nonGatedAvg > 0.001) {
      expect(overheadPct).toBeLessThan(20);
    }
  });
});

describe("I2 Benchmark 2 — subscriber cost: early-filter vs full evaluation", () => {
  it("measures onTransition subscriber overhead for non-workflow and workflow tasks", () => {
    const db = getDb();

    // Create tasks NOT in any workflow.
    const nonWfTaskIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const t = taskCrudRepo.createTask({
        missionId,
        title: `Non-WF ${i}`,
        createdBy: "perf",
      });
      nonWfTaskIds.push(t.id);
    }

    // Create tasks IN a workflow with on_complete gates (all already satisfied).
    const wfTaskIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const upstream = taskCrudRepo.createTask({
        missionId,
        title: `WF-upstream ${i}`,
        createdBy: "perf",
      });
      const downstream = taskCrudRepo.createTask({
        missionId,
        title: `WF-downstream ${i}`,
        createdBy: "perf",
      });
      wfTaskIds.push(upstream.id);

      const definition: WorkflowTemplateDefinition = {
        gates: [
          {
            upstreamTaskKey: upstream.id,
            downstreamTaskKey: downstream.id,
            gateType: "on_complete",
          },
        ],
      };
      attachWorkflow(missionId, habitatId, definition, {}, "perf");
      // Pre-satisfy so the subscriber evaluates and finds the gate already satisfied.
      db.update(taskWorkflowGates)
        .set({ satisfied: true })
        .where(eq(taskWorkflowGates.upstreamTaskId, upstream.id))
        .run();
    }

    // Measure transition emissions for non-workflow tasks (early-filter path).
    const nonWfTimes: number[] = [];
    for (const id of nonWfTaskIds) {
      const t0 = performance.now();
      emitTransition(id, "completed", habitatId, {
        actorType: "system",
        actorId: "perf",
      });
      const t1 = performance.now();
      nonWfTimes.push(t1 - t0);
    }

    // Measure transition emissions for workflow tasks (full evaluation path).
    const wfTimes: number[] = [];
    for (const id of wfTaskIds) {
      const t0 = performance.now();
      emitTransition(id, "completed", habitatId, {
        actorType: "system",
        actorId: "perf",
      });
      const t1 = performance.now();
      wfTimes.push(t1 - t0);
    }

    const nonWfAvg = avg(nonWfTimes);
    const wfAvg = avg(wfTimes);
    const subscriberOverhead = wfAvg - nonWfAvg;

    console.log(
      `[Benchmark 2] subscriber: non-workflow avg=${nonWfAvg.toFixed(3)}ms, ` +
        `workflow avg=${wfAvg.toFixed(3)}ms, delta=${subscriberOverhead.toFixed(3)}ms`,
    );
    console.log(
      `[Benchmark 2] non-workflow p95=${p95(nonWfTimes).toFixed(3)}ms, ` +
        `workflow p95=${p95(wfTimes).toFixed(3)}ms`,
    );

    // Soft assertion: early-filter overhead should be < 10ms per event.
    expect(nonWfAvg).toBeLessThan(10);

    // Full evaluation overhead should be < 10ms per event (generous threshold).
    expect(wfAvg).toBeLessThan(10);
  });
});

describe("I2 Benchmark 3 — FailureBundle construction latency", () => {
  it("measures buildFailureContext with maxed-out bundle (20 events, 50 signals, 10 retries)", () => {
    const db = getDb();

    const task = taskCrudRepo.createTask({
      missionId,
      title: "Perf failure task",
      createdBy: "perf",
    });
    const agent = agentRepo.createAgent({
      name: "perf-fail-agent",
      type: "claude-code",
      domain: "general",
    }).agent;
    taskCrudRepo.updateTask(task.id, { assignedAgentId: agent.id });

    // Insert 25 lifecycle events (cap is 20, extras are dropped).
    for (let i = 0; i < 25; i++) {
      eventRepo.createEvent({
        taskId: task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "updated",
        metadata: { index: i },
      });
    }

    // Insert 55 experience signals (cap is 50, extras are dropped).
    for (let i = 0; i < 55; i++) {
      pulseRepo.createPulse({
        missionId,
        habitatId,
        fromType: "agent",
        fromId: agent.id,
        signalType: "experience",
        subject: `Stuck on issue ${i}`,
        taskId: task.id,
        metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
      });
    }

    // Insert 12 retry events (cap is 10, extras are dropped).
    for (let i = 0; i < 12; i++) {
      eventRepo.createEvent({
        taskId: task.id,
        actorType: "system",
        actorId: "retry-service",
        action: i % 2 === 0 ? "retry_scheduled" : "retry_executed",
        metadata: { attempt: i },
      });
    }

    // Attach a workflow so resolveWorkflowId finds it.
    const definition: WorkflowTemplateDefinition = {
      gates: [{ upstreamTaskKey: task.id, downstreamTaskKey: task.id, gateType: "on_fail" }],
    };
    attachWorkflow(missionId, habitatId, definition, {}, "perf");

    // Measure buildFailureContext.
    const iterations = 10;
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      // Clean up prior context so each iteration builds fresh.
      const existing = failureContextService.getFailureContext(task.id);
      if (existing) {
        failureContextService.resolveFailureContext(existing.id, "manual_intervention");
      }

      const t0 = performance.now();
      failureContextService.buildFailureContext(task.id, "lifecycle_failed", {
        failureReason: "perf benchmark",
      });
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const avgMs = avg(times);
    const p95Ms = p95(times);

    console.log(
      `[Benchmark 3] buildFailureContext: avg=${avgMs.toFixed(3)}ms, p95=${p95Ms.toFixed(3)}ms ` +
        `(20 events cap, 50 signals cap, 10 retries cap)`,
    );

    // Soft assertion: should complete in < 50ms.
    expect(avgMs).toBeLessThan(50);
  });
});
