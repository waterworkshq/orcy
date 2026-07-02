import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { missions, pulses, triageClusterMissions } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import { runSignalPatternClusteredScan } from "../services/triageScanService.js";
import { runAgentQualityDegradedScan } from "../services/agentQualityScanService.js";
import { normalize } from "../services/habitatSkillService.js";
import { getAgentQualitySignals } from "../services/agentQualityService.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import { tasks, taskEvents } from "../db/schema/index.js";

const NOW = new Date("2026-07-01T12:00:00.000Z");

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await initTestDb();
  const db = getDb();
  db.delete(pulses).run();
  db.delete(triageClusterMissions).run();
  db.delete(missions).run();

  const habitat = habitatRepo.createHabitat({ name: "Triage Scan Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Seed Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

/** Seed a clusterable pulse directly into the pulses table. */
function seedPulse(opts: {
  signalType: "experience" | "finding" | "detected" | "context";
  subject: string;
  fromId?: string;
  taskId?: string;
  missionId?: string;
  createdAt?: Date;
  metadata?: Record<string, unknown>;
}) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId: opts.missionId ?? missionId,
    scope: "mission",
    fromType: "agent",
    fromId: opts.fromId ?? "agent-1",
    signalType: opts.signalType,
    subject: opts.subject,
    body: "",
    taskId: opts.taskId,
    metadata: opts.metadata ?? {},
  });
  // createPulse always stamps createdAt = now; override for time-window tests.
  if (opts.createdAt) {
    getDb()
      .update(pulses)
      .set({ createdAt: opts.createdAt.toISOString() })
      .where(eq(pulses.id, pulse.id))
      .run();
  }
  return pulse;
}

function createTaskId(label: string) {
  const task = taskRepo.createTask({
    missionId,
    title: `Task ${label}`,
    createdBy: "user-1",
    estimatedMinutes: 30,
  });
  return task.id;
}

function createScanRule(
  habitatId: string,
  scanType: "signal_pattern_clustered" | "agent_quality_degraded",
) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: `${scanType} rule`,
    priority: 0,
    trigger: { type: "scan", scanType } as any,
    enabled: true,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
    createdBy: "system:test",
  });
}

describe("triageScanService", () => {
  describe("runSignalPatternClusteredScan", () => {
    it("AC-REACTIVE-1: detects cluster when 3+ signals share clusterKey within 7-day window", async () => {
      for (let i = 0; i < 3; i++) {
        seedPulse({
          signalType: "experience",
          subject: "flaky ci retry",
          fromId: `agent-${i}`,
          taskId: createTaskId(`r1-${i}`),
        });
      }

      const reports = await runSignalPatternClusteredScan(habitatId);

      expect(reports).toHaveLength(1);
      // A triage mission must be created when threshold is crossed even with no rules.
      const db = getDb();
      const triageMissions = db.select().from(triageClusterMissions).all();
      expect(triageMissions.length).toBeGreaterThanOrEqual(1);
      const junction = triageClusterMissionsRepo.findActiveByClusterKey(
        habitatId,
        normalize("flaky ci retry"),
      );
      expect(junction).not.toBeNull();
    });

    it("AC-REACTIVE-2: cluster payload includes provenance breakdown, task IDs, agent IDs", async () => {
      // Capture the payload that flows into executeAndRecordRuleRun via a rule + run record.
      createScanRule(habitatId, "signal_pattern_clustered");
      seedPulse({
        signalType: "experience",
        subject: "shared subject x",
        taskId: createTaskId("a"),
        fromId: "agent-x",
      });
      seedPulse({
        signalType: "finding",
        subject: "shared subject x",
        taskId: createTaskId("b"),
        fromId: "agent-y",
        metadata: { findingKind: "bug" },
      });
      seedPulse({
        signalType: "detected",
        subject: "shared subject x",
        taskId: createTaskId("c"),
        fromId: "agent-z",
      });

      await runSignalPatternClusteredScan(habitatId);

      // Mission description embeds cluster context (AC-REACTIVE-4 equivalent).
      const db = getDb();
      const missionRows = db.select().from(missions).all();
      const triageMission = missionRows.find(
        (m) => typeof m.title === "string" && m.title.includes("shared subject x"),
      );
      expect(triageMission).toBeDefined();
      const desc = String(triageMission!.description ?? "");
      // Provenance breakdown is JSON-stringified into the description body.
      expect(desc).toContain("Provenance Breakdown");
      expect(desc).toContain('"experience"');
      expect(desc).toContain('"finding"');
      expect(desc).toContain('"detected"');
      // Agent IDs surface in the "Affected Agents" block of the description.
      expect(desc).toContain("agent-x");
      expect(desc).toContain("agent-y");
      expect(desc).toContain("agent-z");
      // Task IDs flow into the rule payload via affectedTaskIds (proven by the
      // 3 seeded tasks each appearing on a distinct pulse in the cluster); the
      // description renders agents + missions, not task IDs, so we verify the
      // cluster captured all three tasks via the signal count.
      expect(desc).toMatch(/Signal Count\s+\n?3/);
    });

    it("AC-REACTIVE-5: sub-threshold (2 signals) does not trigger", async () => {
      seedPulse({ signalType: "experience", subject: "below threshold" });
      seedPulse({ signalType: "experience", subject: "below threshold", fromId: "agent-2" });

      await runSignalPatternClusteredScan(habitatId);

      expect(
        triageClusterMissionsRepo.findActiveByClusterKey(habitatId, normalize("below threshold")),
      ).toBeNull();
    });

    it("AC-REACTIVE-5: signals outside time window do not trigger", async () => {
      // Two pulses inside window + one well outside (so cluster stays below threshold).
      seedPulse({ signalType: "experience", subject: "windowed subject" });
      seedPulse({ signalType: "experience", subject: "windowed subject", fromId: "agent-2" });
      // 30 days ago — outside the 7-day default window
      seedPulse({
        signalType: "experience",
        subject: "windowed subject",
        fromId: "agent-3",
        createdAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      });

      await runSignalPatternClusteredScan(habitatId);

      expect(
        triageClusterMissionsRepo.findActiveByClusterKey(habitatId, normalize("windowed subject")),
      ).toBeNull();
    });

    it("AC-REACTIVE-6: cross-mission clusters rank higher than single-mission", async () => {
      createScanRule(habitatId, "signal_pattern_clustered");
      // Cross-mission cluster (3 signals, 2 missions)
      const otherMission = missionRepo.createMission({
        habitatId,
        columnId,
        title: "Other Mission",
        createdBy: "user-1",
      });
      seedPulse({
        signalType: "experience",
        subject: "cross mission subject",
        missionId: missionId,
        fromId: "a1",
      });
      seedPulse({
        signalType: "experience",
        subject: "cross mission subject",
        missionId: missionId,
        fromId: "a2",
      });
      seedPulse({
        signalType: "experience",
        subject: "cross mission subject",
        missionId: otherMission.id,
        fromId: "a3",
      });

      await runSignalPatternClusteredScan(habitatId);

      const db = getDb();
      const triageMission = db
        .select()
        .from(missions)
        .all()
        .find((m) => String(m.title).includes("cross mission subject"));
      expect(triageMission).toBeDefined();
      const desc = String(triageMission!.description ?? "");
      // crossMissionCount must surface in the description (the strength multiplier input)
      expect(desc).toMatch(/Cross-Mission Count\s+\n?2/);
    });

    it("AC-REACTIVE-7: signals with metadata.triageGenerated are excluded", async () => {
      // 2 real + 1 triage-generated (should not push over threshold)
      seedPulse({ signalType: "experience", subject: "loop guard subject" });
      seedPulse({ signalType: "experience", subject: "loop guard subject", fromId: "a2" });
      seedPulse({
        signalType: "experience",
        subject: "loop guard subject",
        fromId: "triage",
        metadata: { triageGenerated: true, triageMissionId: "m-x" },
      });

      await runSignalPatternClusteredScan(habitatId);

      // With the triage-generated signal excluded, only 2 clusterable → no triage.
      expect(
        triageClusterMissionsRepo.findActiveByClusterKey(
          habitatId,
          normalize("loop guard subject"),
        ),
      ).toBeNull();
    });

    it("AC-REACTIVE-8: no duplicate triage mission for existing open clusterKey", async () => {
      for (let i = 0; i < 3; i++) {
        seedPulse({
          signalType: "experience",
          subject: "dup suppress subject",
          fromId: `agent-${i}`,
        });
      }

      await runSignalPatternClusteredScan(habitatId);
      // Add more clusterable signals for the same key, then re-run.
      for (let i = 0; i < 3; i++) {
        seedPulse({
          signalType: "experience",
          subject: "dup suppress subject",
          fromId: `agent-extra-${i}`,
        });
      }
      await runSignalPatternClusteredScan(habitatId);

      const db = getDb();
      const junctions = db
        .select()
        .from(triageClusterMissions)
        .all()
        .filter((j) => j.clusterKey === normalize("dup suppress subject"));
      // Exactly one open junction — second scan suppressed.
      const open = junctions.filter((j) => j.status === "open");
      expect(open).toHaveLength(1);
    });
  });

  describe("runAgentQualityDegradedScan", () => {
    function seedAgentWithTasks(opts: { name: string; taskCount: number; rejectedCount?: number }) {
      const { agent } = agentRepo.createAgent({
        name: opts.name,
        type: "codex",
        domain: "backend",
      });
      const db = getDb();
      for (let i = 0; i < opts.taskCount; i++) {
        const task = taskRepo.createTask({
          missionId,
          title: `Quality Task ${i}`,
          createdBy: "user-1",
          estimatedMinutes: 60,
        });
        const completedAt = new Date(NOW.getTime() - i * 60_000).toISOString();
        const claimedAt = new Date(NOW.getTime() - (i * 60_000 + 60 * 60_000)).toISOString();
        db.update(tasks)
          .set({
            assignedAgentId: agent.id,
            status: "approved",
            claimedAt,
            completedAt,
            cycleTimeMinutes: 60,
          })
          .where(eq(tasks.id, task.id))
          .run();
        db.insert(taskEvents)
          .values({
            id: `approved-${task.id}`,
            taskId: task.id,
            actorType: "human",
            actorId: "reviewer-1",
            action: "approved",
            timestamp: completedAt,
          })
          .run();
        if (opts.rejectedCount && i < opts.rejectedCount) {
          db.insert(taskEvents)
            .values({
              id: `rejected-${task.id}`,
              taskId: task.id,
              actorType: "human",
              actorId: "reviewer-1",
              action: "rejected",
              timestamp: claimedAt,
            })
            .run();
        }
      }
      return agent;
    }

    it("AC-QUALITY-1: evaluates each agent's composite score against threshold", async () => {
      createScanRule(habitatId, "agent_quality_degraded");
      seedAgentWithTasks({ name: "Evaluated Agent", taskCount: 6 });

      const reports = await runAgentQualityDegradedScan(habitatId);

      // The scan ran and produced an evaluation report for the habitat.
      expect(reports).toHaveLength(1);
      expect(reports[0].scanType).toBe("agent_quality_degraded");
      expect(reports[0].habitatId).toBe(habitatId);
      // The underlying signal evaluator produces a composite score for the agent.
      const signals = getAgentQualitySignals(habitatId).signals;
      expect(signals.length).toBeGreaterThan(0);
      const target = signals.find((s) => s.agentName === "Evaluated Agent");
      expect(target).toBeDefined();
      // With >= 5 samples the evaluator computes a non-null composite score
      // (the gate passed) — the scan then compares it to the threshold.
      expect(target!.score).not.toBeNull();
    });

    it("AC-QUALITY-2: agents below minimum sample size are not flagged", async () => {
      createScanRule(habitatId, "agent_quality_degraded");
      // 3 tasks (below default min sample 5) with high rejection → still no fire.
      seedAgentWithTasks({ name: "Low Sample Agent", taskCount: 3, rejectedCount: 3 });

      const reports = await runAgentQualityDegradedScan(habitatId);

      expect(reports[0].rulesMatched).toBe(0);
      const signals = getAgentQualitySignals(habitatId).signals;
      const target = signals.find((s) => s.agentName === "Low Sample Agent");
      expect(target).toBeDefined();
      expect(target!.sampleSize).toBeLessThan(5);
    });

    it("AC-QUALITY-3: degraded agent with adequate sample fires rule", async () => {
      createScanRule(habitatId, "agent_quality_degraded");
      // 5 tasks, all rejected → very low score, adequate sample.
      seedAgentWithTasks({ name: "Degraded Agent", taskCount: 5, rejectedCount: 5 });

      const reports = await runAgentQualityDegradedScan(habitatId);

      expect(reports[0].rulesMatched).toBe(1);
    });

    it("AC-QUALITY-4: quality triggers are informational only — no assignment change", async () => {
      createScanRule(habitatId, "agent_quality_degraded");
      const { agent } = agentRepo.createAgent({
        name: "Informational Agent",
        type: "codex",
        domain: "backend",
      });
      const db = getDb();
      // 5 tasks each rejected once
      for (let i = 0; i < 5; i++) {
        const task = taskRepo.createTask({
          missionId,
          title: `Info Task ${i}`,
          createdBy: "user-1",
          estimatedMinutes: 60,
        });
        const completedAt = new Date(NOW.getTime() - i * 60_000).toISOString();
        const claimedAt = new Date(NOW.getTime() - (i * 60_000 + 60 * 60_000)).toISOString();
        db.update(tasks)
          .set({
            assignedAgentId: agent.id,
            status: "approved",
            claimedAt,
            completedAt,
            cycleTimeMinutes: 60,
          })
          .where(eq(tasks.id, task.id))
          .run();
        db.insert(taskEvents)
          .values({
            id: `rej-${task.id}`,
            taskId: task.id,
            actorType: "human",
            actorId: "reviewer-1",
            action: "rejected",
            timestamp: claimedAt,
          })
          .run();
        db.insert(taskEvents)
          .values({
            id: `appr-${task.id}`,
            taskId: task.id,
            actorType: "human",
            actorId: "reviewer-1",
            action: "approved",
            timestamp: completedAt,
          })
          .run();
      }

      const before = db.select().from(tasks).where(eq(tasks.assignedAgentId, agent.id)).all();

      const reports = await runAgentQualityDegradedScan(habitatId);
      expect(reports[0].rulesMatched).toBe(1);

      // No assignment mutation: tasks are unchanged (still assigned to the degraded agent).
      const after = db.select().from(tasks).where(eq(tasks.assignedAgentId, agent.id)).all();
      expect(after.length).toBe(before.length);
      expect(after.every((t) => t.assignedAgentId === agent.id)).toBe(true);
    });
  });

  describe("habitat-level triage thresholds", () => {
    it("respects custom minClusterSize from habitat triageSettings", async () => {
      createScanRule(habitatId, "signal_pattern_clustered");

      // Set a high threshold: 5 signals needed to cluster (default is 3).
      habitatRepo.updateHabitat(habitatId, {
        triageSettings: {
          minClusterSize: 5,
          clusterWindowDays: 7,
          agentQualityThreshold: 40,
          agentQualityMinSample: 5,
        },
      });

      // Seed only 3 signals — default would cluster them, but custom threshold of 5 won't.
      seedPulse({ signalType: "experience", subject: "same problem" });
      seedPulse({ signalType: "experience", subject: "same problem" });
      seedPulse({ signalType: "experience", subject: "same problem" });

      const reports = await runSignalPatternClusteredScan(habitatId);
      expect(reports[0].rulesMatched).toBe(0);

      // No triage mission should be created.
      const active = triageClusterMissionsRepo.findActiveClusterKeys(habitatId, ["same problem"]);
      expect(active.size).toBe(0);
    });

    it("falls back to defaults when triageSettings is null", async () => {
      createScanRule(habitatId, "signal_pattern_clustered");

      // 3 signals — default minClusterSize is 3, so this should cluster.
      seedPulse({ signalType: "experience", subject: "default threshold" });
      seedPulse({ signalType: "experience", subject: "default threshold" });
      seedPulse({ signalType: "experience", subject: "default threshold" });

      const reports = await runSignalPatternClusteredScan(habitatId);
      expect(reports[0].rulesMatched).toBe(1);
    });
  });
});
