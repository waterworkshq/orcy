/**
 * T4C Phase 3 — Causal task.created ingestion proofs.
 *
 * Synthetic trusted-envelope tests for the ingestion-side causal-chain safety
 * logic. No live producer is required (T8B owns the producer migration);
 * these tests prove the ingestion contract the producer will rely on:
 *
 *  - Envelope-signature gate (dormancy): legacy SSE task.created → no-op.
 *  - Causal cycle: triggering rule in hops → exactly one causal_cycle skip.
 *  - Causal depth limit: 32 hops → exactly one causal_depth_limit skip.
 *  - Distinct rules chain: non-repeating hops → proceeds (no cycle).
 *  - Reservation on redelivery (execute): same eventId twice → one run.
 *  - Reservation on redelivery (skip): same eventId twice → one skip run.
 *  - Clone normalization: cloned lifecycle → one evaluation.
 *  - Untrusted callers: causal fields used only for cycle/depth, not identity.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pulseRepo from "../repositories/pulse.js";
import { ingestEvent } from "../services/automationEventService.js";
import type { CausalContext } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "T4C Test Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "T4C Mission", createdBy: "user-1" });
}

function setupTask(missionId: string) {
  return taskRepo.createTask({ missionId, title: "T4C Task", createdBy: "user-1" });
}

function createTaskCreatedRule(
  habitatId: string,
  opts?: { cooldownSeconds?: number; maxRunsPerHour?: number },
) {
  ruleRepo.createAutomationRule({
    habitatId,
    name: "T4C Rule",
    trigger: { type: "event", eventType: "task.created" },
    condition: { type: "always" },
    actions: [{ type: "create_signal", content: "T4C triggered" }],
    cooldownSeconds: opts?.cooldownSeconds ?? 300,
    maxRunsPerHour: opts?.maxRunsPerHour ?? 100,
    priority: 0,
    enabled: true,
    createdBy: "test",
  });
  return ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, "task.created")[0];
}

function buildEnvelopeData(
  eventId: string,
  taskId: string,
  causalContext: CausalContext,
  lifecycleAction: "created" | "cloned" = "created",
): Record<string, unknown> {
  return {
    taskId,
    eventId,
    habitatId: "",
    lifecycleAction,
    causalContext,
  };
}

function buildHops(count: number, ruleIdAtIndex0?: string) {
  const hops: Array<{ type: string; id: string }> = [];
  for (let i = 0; i < count; i++) {
    hops.push({
      type: "automation",
      id: ruleIdAtIndex0 && i === 0 ? ruleIdAtIndex0 : `other-rule-${i}`,
    });
  }
  return hops;
}

function countRunsForRule(ruleId: string): number {
  return runRepo.listRunsByRule(ruleId).total;
}

function getSkippedRuns(ruleId: string) {
  return runRepo.getSkippedRunsByRule(ruleId).runs;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("automationEventService — task.created ingestion (T4C Phase 3)", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // --- Envelope-signature gate (dormancy) ---

  describe("envelope-signature gate (dormancy)", () => {
    it("drops legacy SSE task.created (no causalContext) → no-op", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      createTaskCreatedRule(h.id);

      // Simulate the public Task SSE DTO — no causalContext field.
      const result = await ingestEvent(h.id, {
        type: "task.created",
        data: { id: task.id, title: task.title, status: task.status, priority: task.priority },
      });

      expect(result.matched).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("processes trusted-envelope task.created (has causalContext)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-gate-1", task.id, {
        root: { type: "human", id: "user-1" },
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(countRunsForRule(rule.id)).toBe(1);
    });
  });

  // --- Causal cycle ---

  describe("causal cycle detection", () => {
    it("skips with causal_cycle when the triggering rule is in the chain", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-cycle-1", task.id, {
        root: { type: "human", id: "user-1" },
        hops: [{ type: "automation", id: rule.id }],
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(0);
      expect(result.skipped).toBe(1);

      const skips = getSkippedRuns(rule.id);
      expect(skips).toHaveLength(1);
      expect(skips[0].skipReason).toBe("causal_cycle");

      // No pulse created (no execution).
      const pulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 });
      expect(pulses.total).toBe(0);
    });
  });

  // --- Causal depth limit ---

  describe("causal depth limit", () => {
    it("skips with causal_depth_limit at 32 hops", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-depth-1", task.id, {
        root: { type: "human", id: "user-1" },
        hops: buildHops(32),
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(0);
      expect(result.skipped).toBe(1);

      const skips = getSkippedRuns(rule.id);
      expect(skips).toHaveLength(1);
      expect(skips[0].skipReason).toBe("causal_depth_limit");
    });

    it("proceeds at 31 hops (below the limit)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-depth-31", task.id, {
        root: { type: "human", id: "user-1" },
        hops: buildHops(31),
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  // --- Distinct rules chain (no cycle) ---

  describe("distinct rules chain", () => {
    it("proceeds when hops contain only other rules (no cycle)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-distinct-1", task.id, {
        root: { type: "human", id: "user-1" },
        hops: [
          { type: "automation", id: "rule-alpha" },
          { type: "automation", id: "rule-beta" },
        ],
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(countRunsForRule(rule.id)).toBe(1);

      // Pulse created (action executed).
      const pulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 });
      expect(pulses.total).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Reservation on redelivery ---

  describe("reservation on redelivery", () => {
    it("execute: same eventId delivered twice → exactly one run (no double-execute)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id, { cooldownSeconds: 0 });

      const data = buildEnvelopeData("evt-redeliver-1", task.id, {
        root: { type: "human", id: "user-1" },
      });

      // First delivery — creates and executes the run.
      await ingestEvent(h.id, { type: "task.created", data });
      // Second delivery — reservation prevents a second run.
      await ingestEvent(h.id, { type: "task.created", data });

      // Exactly ONE run row exists.
      expect(countRunsForRule(rule.id)).toBe(1);

      // Exactly ONE pulse (action executed once, not twice).
      const pulses = pulseRepo.getPulsesByHabitat(h.id, { limit: 100, offset: 0 });
      expect(pulses.total).toBe(1);
    });

    it("skip: same eventId with cycle delivered twice → exactly one skip run", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData("evt-redeliver-skip-1", task.id, {
        root: { type: "human", id: "user-1" },
        hops: [{ type: "automation", id: rule.id }],
      });

      await ingestEvent(h.id, { type: "task.created", data });
      await ingestEvent(h.id, { type: "task.created", data });

      // Exactly ONE skip run (the reservation in recordSkippedRun prevents the
      // second skip row via the Phase 2 `!created` early return).
      expect(countRunsForRule(rule.id)).toBe(1);
      const skips = getSkippedRuns(rule.id);
      expect(skips).toHaveLength(1);
      expect(skips[0].skipReason).toBe("causal_cycle");
    });
  });

  // --- Clone normalization ---

  describe("clone normalization", () => {
    it("a cloned envelope produces exactly one task.created evaluation", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData(
        "evt-clone-1",
        task.id,
        { root: { type: "human", id: "user-1" } },
        "cloned",
      );

      const result = await ingestEvent(h.id, { type: "task.created", data });

      // Exactly one evaluation — same as a created envelope.
      expect(result.matched).toBe(1);
      expect(result.skipped).toBe(0);
      expect(countRunsForRule(rule.id)).toBe(1);
    });

    it("a cloned envelope with a cycle is skipped (same guard as created)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      const data = buildEnvelopeData(
        "evt-clone-cycle-1",
        task.id,
        {
          root: { type: "human", id: "user-1" },
          hops: [{ type: "automation", id: rule.id }],
        },
        "cloned",
      );

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(0);
      expect(result.skipped).toBe(1);
      const skips = getSkippedRuns(rule.id);
      expect(skips[0].skipReason).toBe("causal_cycle");
    });
  });

  // --- Untrusted callers cannot inject identities ---

  describe("untrusted caller identity isolation", () => {
    it("causalContext fields are used only for cycle/depth — not for run identity", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);
      const rule = createTaskCreatedRule(h.id);

      // Fabricated causal identities from an "untrusted" source. The ingestion
      // should use hops ONLY for cycle/depth detection, never to assert these
      // as privileged run/actor identities on the run row.
      const data = buildEnvelopeData("evt-untrusted-1", task.id, {
        root: { type: "agent", id: "fabricated-actor" },
        parent: { type: "automation_rule_run", id: "fabricated-run" },
        hops: [],
      });

      const result = await ingestEvent(h.id, { type: "task.created", data });

      expect(result.matched).toBe(1);

      // The run row's identity fields come from the event's eventId/taskId,
      // not from the fabricated causal root/parent.
      const { runs } = runRepo.listRunsByRule(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].triggerEventId).toBe("evt-untrusted-1");
      expect(runs[0].targetId).toBe(task.id);
      // The fabricated actor/run IDs do NOT leak into the run's metadata.
      const meta = runs[0].metadata as Record<string, unknown> | null;
      expect(JSON.stringify(meta ?? {})).not.toContain("fabricated-actor");
      expect(JSON.stringify(meta ?? {})).not.toContain("fabricated-run");
    });
  });

  // --- Non-task.created events unaffected ---

  describe("non-task.created events are unaffected by the gate", () => {
    it("legacy task.rejected still processes normally (no causalContext required)", async () => {
      const h = setupHabitat();
      const mission = setupMission(h.id);
      const task = setupTask(mission.id);

      ruleRepo.createAutomationRule({
        habitatId: h.id,
        name: "Rejected rule",
        trigger: { type: "event", eventType: "task.rejected" },
        condition: { type: "always" },
        actions: [{ type: "create_signal", content: "Rejected!" }],
        cooldownSeconds: 300,
        maxRunsPerHour: 100,
        priority: 0,
        enabled: true,
        createdBy: "test",
      });

      // task.rejected does NOT carry causalContext — the gate is task.created-only.
      const result = await ingestEvent(h.id, {
        type: "task.rejected",
        data: { taskId: task.id, eventId: "evt-rejected-1" },
      });

      expect(result.matched).toBe(1);
    });
  });
});
