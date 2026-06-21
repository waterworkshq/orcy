import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as eventCrudRepo from "../repositories/events/event-crud.js";
import {
  buildFailureContext,
  getFailureContext,
  getFailureContextsForTask,
  resolveFailureContext,
  linkRecoveryTask,
  actionToFailureKind,
  MAX_LIFECYCLE_EVENTS,
  MAX_EXPERIENCE_SIGNALS,
  MAX_RETRY_ATTEMPTS,
  CURRENT_BUNDLE_SCHEMA_VERSION,
} from "../services/failureContextService.js";
import type { Artifact } from "../models/index.js";
import { tasks, agents, missions, columns, habitats } from "../db/schema/index.js";

function setupHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  const col = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  return { habitat, col };
}

function setupMission(habitatId: string, colId: string) {
  return missionRepo.createMission({
    habitatId,
    columnId: colId,
    title: "Test Mission",
    createdBy: "human-1",
  });
}

function setupAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "general",
  }).agent;
}

function attachArtifacts(taskId: string, artifacts: Artifact[]) {
  const db = getDb();
  db.update(tasks).set({ artifacts }).where(eq(tasks.id, taskId)).run();
}

function assignAgent(taskId: string, agentId: string, status: TaskStatus = "in_progress") {
  getDb().update(tasks).set({ assignedAgentId: agentId, status }).where(eq(tasks.id, taskId)).run();
}

import type { TaskStatus } from "../models/index.js";

describe("failureContextService", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(missions).run();
    db.delete(columns).run();
    db.delete(agents).run();
    db.delete(habitats).run();
  });

  afterEach(() => {
    closeDb();
  });

  describe("actionToFailureKind", () => {
    it("maps failed -> lifecycle_failed", () => {
      expect(actionToFailureKind("failed")).toBe("lifecycle_failed");
    });
    it("maps rejected -> lifecycle_rejected", () => {
      expect(actionToFailureKind("rejected")).toBe("lifecycle_rejected");
    });
    it("maps released -> heartbeat_lost", () => {
      expect(actionToFailureKind("released")).toBe("heartbeat_lost");
    });
    it("returns null for non-failure actions", () => {
      expect(actionToFailureKind("completed")).toBeNull();
      expect(actionToFailureKind("approved")).toBeNull();
      expect(actionToFailureKind("submitted")).toBeNull();
    });
  });

  describe("buildFailureContext", () => {
    it("returns null when the task does not exist", () => {
      expect(buildFailureContext("nonexistent", "lifecycle_failed")).toBeNull();
    });

    it("assembles a bundle with all expected fields populated", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agent = setupAgent("failing-agent");
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Do the thing",
        createdBy: "human-1",
      });
      // Assign the agent so failedByAgentId is captured.
      getDb()
        .update(tasks)
        .set({ assignedAgentId: agent.id, status: "in_progress" })
        .where(eq(tasks.id, task.id))
        .run();
      attachArtifacts(task.id, [
        { type: "file", url: "file://src/index.ts", description: "entry point" },
      ]);

      // A few lifecycle events
      eventCrudRepo.createEvent({
        taskId: task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "claimed",
      });
      eventCrudRepo.createEvent({
        taskId: task.id,
        actorType: "agent",
        actorId: agent.id,
        action: "started",
      });

      // Experience signals from the failing agent
      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: agent.id,
        signalType: "experience",
        subject: "Hit rate limit",
        taskId: task.id,
        metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
      });
      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: agent.id,
        signalType: "experience",
        subject: "Confused by config",
        taskId: task.id,
        metadata: { experience: "confused", implicit: true, timing: "mid_task" },
      });

      const ctx = buildFailureContext(task.id, "lifecycle_failed", {
        failureReason: "exhausted retries",
      });

      expect(ctx).not.toBeNull();
      expect(ctx!.failedTaskId).toBe(task.id);
      expect(ctx!.habitatId).toBe(habitat.id);
      expect(ctx!.failureKind).toBe("lifecycle_failed");
      expect(ctx!.failureReason).toBe("exhausted retries");
      expect(ctx!.failedByAgentId).toBe(agent.id);
      expect(ctx!.bundleSchemaVersion).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
      expect(ctx!.resolvedAt).toBeNull();
      expect(ctx!.resolutionKind).toBeNull();

      // Bundle shape
      expect(ctx!.bundle.artifacts).toHaveLength(1);
      expect(ctx!.bundle.artifacts[0].url).toBe("file://src/index.ts");
      expect(ctx!.bundle.recentLifecycleEvents.length).toBeGreaterThanOrEqual(2);
      expect(ctx!.bundle.experienceSignals).toHaveLength(2);
      expect(ctx!.bundle.retryHistory).toEqual([]);
      expect(ctx!.bundle.experienceCategorySummary).toEqual({ stuck: 1, confused: 1 });
    });

    it("caps lifecycle events at MAX_LIFECYCLE_EVENTS", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Many events",
        createdBy: "human-1",
      });
      for (let i = 0; i < MAX_LIFECYCLE_EVENTS + 5; i++) {
        eventCrudRepo.createEvent({
          taskId: task.id,
          actorType: "system",
          actorId: "system",
          action: "updated",
        });
      }
      const ctx = buildFailureContext(task.id, "manual")!;
      expect(ctx.bundle.recentLifecycleEvents).toHaveLength(MAX_LIFECYCLE_EVENTS);
    });

    it("caps experience signals at MAX_EXPERIENCE_SIGNALS", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agent = setupAgent("verbose-agent");
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Noisy task",
        createdBy: "human-1",
      });
      getDb().update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, task.id)).run();
      for (let i = 0; i < MAX_EXPERIENCE_SIGNALS + 10; i++) {
        pulseRepo.createPulse({
          habitatId: habitat.id,
          missionId: mission.id,
          fromType: "agent",
          fromId: agent.id,
          signalType: "experience",
          subject: `Signal ${i}`,
          taskId: task.id,
          metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
        });
      }
      const ctx = buildFailureContext(task.id, "lifecycle_failed")!;
      expect(ctx.bundle.experienceSignals).toHaveLength(MAX_EXPERIENCE_SIGNALS);
      // Summary counts the same set (capped at 50)
      expect(ctx.bundle.experienceCategorySummary.stuck).toBe(MAX_EXPERIENCE_SIGNALS);
    });

    it("caps retry history at MAX_RETRY_ATTEMPTS", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Retried task",
        createdBy: "human-1",
      });
      for (let i = 0; i < MAX_RETRY_ATTEMPTS + 5; i++) {
        eventCrudRepo.createEvent({
          taskId: task.id,
          actorType: "system",
          actorId: "retry-service",
          action: "retry_scheduled",
        });
      }
      const ctx = buildFailureContext(task.id, "lifecycle_failed")!;
      expect(ctx.bundle.retryHistory).toHaveLength(MAX_RETRY_ATTEMPTS);
    });

    it("produces valid empty arrays/objects when nothing exists (no artifacts, events, signals, retries)", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Empty task",
        createdBy: "human-1",
      });

      const ctx = buildFailureContext(task.id, "manual")!;
      expect(ctx.bundle.artifacts).toEqual([]);
      expect(ctx.bundle.recentLifecycleEvents).toEqual([]);
      expect(ctx.bundle.experienceSignals).toEqual([]);
      expect(ctx.bundle.retryHistory).toEqual([]);
      expect(ctx.bundle.experienceCategorySummary).toEqual({});
      expect(ctx.failedByAgentId).toBeNull(); // no agent assigned
    });

    it("does not capture experience signals from other agents", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failingAgent = setupAgent("failing");
      const otherAgent = setupAgent("other");
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Filtered signals",
        createdBy: "human-1",
      });
      getDb()
        .update(tasks)
        .set({ assignedAgentId: failingAgent.id })
        .where(eq(tasks.id, task.id))
        .run();

      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: failingAgent.id,
        signalType: "experience",
        subject: "Mine",
        taskId: task.id,
        metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
      });
      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: otherAgent.id,
        signalType: "experience",
        subject: "Theirs",
        taskId: task.id,
        metadata: { experience: "surprised", implicit: true, timing: "mid_task" },
      });

      const ctx = buildFailureContext(task.id, "lifecycle_failed")!;
      expect(ctx.bundle.experienceSignals).toHaveLength(1);
      expect(ctx.bundle.experienceSignals[0].subject).toBe("Mine");
      expect(ctx.bundle.experienceCategorySummary).toEqual({ stuck: 1 });
    });

    it("does not capture non-experience signals", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agent = setupAgent("a");
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Only experience",
        createdBy: "human-1",
      });
      getDb().update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, task.id)).run();

      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: agent.id,
        signalType: "finding",
        subject: "Found a thing",
        taskId: task.id,
      });
      pulseRepo.createPulse({
        habitatId: habitat.id,
        missionId: mission.id,
        fromType: "agent",
        fromId: agent.id,
        signalType: "blocker",
        subject: "Hit a wall",
        taskId: task.id,
      });

      const ctx = buildFailureContext(task.id, "lifecycle_failed")!;
      expect(ctx.bundle.experienceSignals).toEqual([]);
      expect(ctx.bundle.experienceCategorySummary).toEqual({});
    });

    it("captures every lifecycle event in the bundle", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Ordered",
        createdBy: "human-1",
      });
      eventCrudRepo.createEvent({
        taskId: task.id,
        actorType: "agent",
        actorId: "agent-1",
        action: "claimed",
      });
      eventCrudRepo.createEvent({
        taskId: task.id,
        actorType: "agent",
        actorId: "agent-1",
        action: "started",
      });

      const ctx = buildFailureContext(task.id, "manual")!;
      // When timestamps tie (same millisecond), order is non-deterministic — assert presence.
      const actions = ctx.bundle.recentLifecycleEvents.map((e) => e.action).sort();
      expect(actions).toEqual(["claimed", "started"]);
    });

    it("computes category summary across multiple categories", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const agent = setupAgent("a");
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Summary",
        createdBy: "human-1",
      });
      getDb().update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, task.id)).run();

      const post = (experience: string) =>
        pulseRepo.createPulse({
          habitatId: habitat.id,
          missionId: mission.id,
          fromType: "agent",
          fromId: agent.id,
          signalType: "experience",
          subject: `${experience} signal`,
          taskId: task.id,
          metadata: { experience, implicit: true, timing: "mid_task" },
        });
      post("stuck");
      post("stuck");
      post("confused");
      post("smooth");

      const ctx = buildFailureContext(task.id, "lifecycle_failed")!;
      expect(ctx.bundle.experienceCategorySummary).toEqual({
        stuck: 2,
        confused: 1,
        smooth: 1,
      });
    });
  });

  describe("getFailureContext", () => {
    it("returns the most recent unresolved context for a task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Get",
        createdBy: "human-1",
      });
      const first = buildFailureContext(task.id, "manual")!;
      // Resolve the first, then build a second
      resolveFailureContext(first.id, "superseded");
      const second = buildFailureContext(task.id, "lifecycle_failed")!;

      const current = getFailureContext(task.id);
      expect(current?.id).toBe(second.id);
    });

    it("returns null when all contexts for the task are resolved", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Resolved",
        createdBy: "human-1",
      });
      const ctx = buildFailureContext(task.id, "manual")!;
      resolveFailureContext(ctx.id, "redeemed");

      expect(getFailureContext(task.id)).toBeNull();
    });

    it("returns null when no contexts exist for the task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Nothing",
        createdBy: "human-1",
      });
      expect(getFailureContext(task.id)).toBeNull();
    });
  });

  describe("getFailureContextsForTask", () => {
    it("returns every context (resolved or not) for a task", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "History",
        createdBy: "human-1",
      });
      const first = buildFailureContext(task.id, "manual")!;
      const second = buildFailureContext(task.id, "lifecycle_failed")!;

      const all = getFailureContextsForTask(task.id);
      // When failedAt timestamps tie (same millisecond), order is non-deterministic — assert membership.
      expect(new Set(all.map((c) => c.id))).toEqual(new Set([first.id, second.id]));
    });
  });

  describe("resolveFailureContext", () => {
    it("sets resolvedAt and resolutionKind", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const task = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Resolve",
        createdBy: "human-1",
      });
      const ctx = buildFailureContext(task.id, "manual")!;

      resolveFailureContext(ctx.id, "redeemed");

      const refreshed = getFailureContextsForTask(task.id)[0];
      expect(refreshed.resolvedAt).not.toBeNull();
      expect(refreshed.resolutionKind).toBe("redeemed");
    });
  });

  describe("linkRecoveryTask", () => {
    it("writes the spawned recovery task id onto the failure context row", () => {
      const { habitat, col } = setupHabitat();
      const mission = setupMission(habitat.id, col.id);
      const failedTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Failed",
        createdBy: "human-1",
      });
      const recoveryTask = taskCrudRepo.createTask({
        missionId: mission.id,
        title: "Recovery",
        createdBy: "system",
      });
      const ctx = buildFailureContext(failedTask.id, "lifecycle_failed")!;

      linkRecoveryTask(ctx.id, recoveryTask.id);

      const refreshed = getFailureContextsForTask(failedTask.id)[0];
      expect(refreshed.recoveryTaskId).toBe(recoveryTask.id);
    });
  });
});
