import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  pulses,
  triageClusterMissions,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as findingTriageService from "../services/findingTriageService.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as triageService from "../services/triageService.js";
import { runSignalPatternClusteredScan } from "../services/triageScanService.js";
import { runAgentQualityDegradedScan } from "../services/agentQualityScanService.js";
import { normalize } from "../services/habitatSkillService.js";
import { tasks, taskEvents } from "../db/schema/index.js";

const NOW = new Date("2026-07-01T12:00:00.000Z");
const ACTOR = { type: "human" as const, id: "user-1" };

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await initTestDb();
  const db = getDb();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();
  db.delete(triageClusterMissions).run();

  const habitat = habitatRepo.createHabitat({ name: "Integration Habitat" });
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
    title: "Integration Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function seedSignal(opts: {
  signalType: "experience" | "finding" | "detected";
  subject: string;
  fromId?: string;
  metadata?: Record<string, unknown>;
}) {
  const task = taskRepo.createTask({
    missionId,
    title: `Task ${opts.subject}`,
    createdBy: "user-1",
    estimatedMinutes: 30,
  });
  return pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: opts.fromId ?? "agent-1",
    signalType: opts.signalType,
    subject: opts.subject,
    body: "",
    taskId: task.id,
    metadata: opts.metadata ?? {},
  });
}

describe("triage integration", () => {
  it("reactive E2E: seed signals → scan → triage mission → resolve → resolution", async () => {
    const subject = "reactive e2e pain point";
    const clusterKey = normalize(subject);
    for (let i = 0; i < 3; i++) {
      seedSignal({ signalType: "experience", subject, fromId: `agent-${i}` });
    }

    // 1. Scan detects cluster + creates triage mission.
    await runSignalPatternClusteredScan(habitatId);
    const junction = triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey);
    expect(junction).not.toBeNull();

    // 2. Resolve the triage mission → records a resolution.
    triageService.recordResolution(
      junction!.missionId,
      { rootCause: "rca", resolution: "fix", resolutionKind: "code_fix" },
      ACTOR,
    );

    // Junction resolved + resolution persisted.
    expect(triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey)).toBeNull();
    const resolutions = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].source).toBe("cluster_triage");
  });

  it("finding E2E: post finding → triage → bucket → resolve → resolution", () => {
    const finding = pulseRepo.createPulse({
      habitatId,
      missionId,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "finding e2e bug",
      body: "",
      metadata: { findingKind: "bug", severity: "major", blocksCurrentWork: false },
    });

    // 1. Enter triage.
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });
    expect(findingTriageRepo.getById(findingTriageId)!.status).toBe("open");

    // 2. Confirm bucket → triaged.
    findingTriageService.confirmBucket(findingTriageId, "defer_to_patch", ACTOR);
    const triaged = findingTriageRepo.getById(findingTriageId);
    expect(triaged!.status).toBe("triaged");
    expect(triaged!.bucket).toBe("defer_to_patch");

    // 3. Promote → in_progress.
    findingTriageService.promote(findingTriageId, ACTOR);

    // 4. Resolve → writes resolution.
    findingTriageService.resolve(findingTriageId, "shipped in patch", ACTOR);
    const clusterKey = normalize("finding e2e bug");
    const resolutions = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].source).toBe("finding_triage");
  });

  it("proactive E2E: resolve → new cluster same key → suggestion attached", async () => {
    const subject = "proactive e2e pain";
    const clusterKey = normalize(subject);

    // First occurrence: cluster detected + resolved.
    for (let i = 0; i < 3; i++) {
      seedSignal({ signalType: "experience", subject, fromId: `agent-${i}` });
    }
    await runSignalPatternClusteredScan(habitatId);
    const firstJunction = triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey);
    triageService.recordResolution(
      firstJunction!.missionId,
      { rootCause: "initial cause", resolution: "initial fix", resolutionKind: "config_change" },
      ACTOR,
    );

    // Second occurrence: new cluster with same key gets the historical suggestion.
    const { missionId: secondMissionId } = triageService.createTriageMission(habitatId, {
      clusterKey,
      skillCategory: "experience",
      provenanceBreakdown: { experience: 3 },
      signalCount: 3,
      affectedTaskIds: [],
      affectedMissionIds: [missionId],
      agentIds: ["agent-1", "agent-2", "agent-3"],
      crossMissionCount: 1,
      distinctAgentCount: 3,
      timeWindowDays: 7,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    const db = getDb();
    const target = db
      .select()
      .from(missions)
      .all()
      .find((m) => m.id === secondMissionId);
    expect(String(target!.description)).toContain("Proactive Suggestion");
    expect(String(target!.description)).toContain("initial fix");
  });

  it("loop prevention: scan twice → single mission; triage output excluded", async () => {
    const subject = "loop prevention pain";
    for (let i = 0; i < 3; i++) {
      seedSignal({ signalType: "experience", subject, fromId: `agent-${i}` });
    }
    // Triage posts an analysis pulse (source-tagged) — must be excluded.
    const clusterKey = normalize(subject);
    await runSignalPatternClusteredScan(habitatId);
    const junction = triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey);
    triageService.postAnalysisPulse(junction!.missionId, habitatId, "analysis text");

    // Second scan: even though an analysis pulse was added for the same subject,
    // it must be excluded (loop guard 1) and the open junction suppresses a new
    // mission (loop guard 2).
    await runSignalPatternClusteredScan(habitatId);

    const db = getDb();
    const open = db
      .select()
      .from(triageClusterMissions)
      .all()
      .filter((j) => j.clusterKey === clusterKey && j.status === "open");
    expect(open).toHaveLength(1);
  });

  it("dedup: post finding → duplicate → corroborating, not new record", () => {
    const first = pulseRepo.createPulse({
      habitatId,
      missionId,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "dedup integration bug",
      body: "",
      metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
    });
    const dup = pulseRepo.createPulse({
      habitatId,
      missionId,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-2",
      signalType: "finding",
      subject: "dedup integration bug",
      body: "",
      metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
    });

    const { findingTriageId: firstId } = findingTriageService.enterTriage({
      id: first.id,
      habitatId,
      subject: first.subject,
      metadata: first.metadata,
    });
    const { findingTriageId: secondId } = findingTriageService.enterTriage({
      id: dup.id,
      habitatId,
      subject: dup.subject,
      metadata: dup.metadata,
    });

    expect(secondId).toBe(firstId);
    const record = findingTriageRepo.getById(firstId)!;
    expect(record.corroboratingPulseIds).toContain(dup.id);

    const db = getDb();
    const all = db
      .select()
      .from(findingTriageTable)
      .where(eq(findingTriageTable.habitatId, habitatId))
      .all();
    expect(all).toHaveLength(1);
  });

  it("agent quality: degraded agent → scan → rule fires → informational", async () => {
    ruleRepo.createAutomationRule({
      habitatId,
      name: "quality integration rule",
      priority: 0,
      trigger: { type: "scan", scanType: "agent_quality_degraded" } as any,
      enabled: true,
      cooldownSeconds: 0,
      maxRunsPerHour: 100,
      actions: [{ type: "notify", recipients: [{ type: "assignee" }], template: "T" }],
      createdBy: "system:test",
    });

    const db = getDb();
    const { agent: degradedAgent } = agentRepo.createAgent({
      name: "Degraded Integration Agent",
      type: "codex",
      domain: "backend",
    });
    for (let i = 0; i < 5; i++) {
      const task = taskRepo.createTask({
        missionId,
        title: `Q Task ${i}`,
        createdBy: "user-1",
        estimatedMinutes: 60,
      });
      const completedAt = new Date(NOW.getTime() - i * 60_000).toISOString();
      const claimedAt = new Date(NOW.getTime() - (i * 60_000 + 60 * 60_000)).toISOString();
      db.update(tasks)
        .set({
          assignedAgentId: degradedAgent.id,
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
          actorId: "reviewer",
          action: "rejected",
          timestamp: claimedAt,
        })
        .run();
      db.insert(taskEvents)
        .values({
          id: `appr-${task.id}`,
          taskId: task.id,
          actorType: "human",
          actorId: "reviewer",
          action: "approved",
          timestamp: completedAt,
        })
        .run();
    }

    const reports = await runAgentQualityDegradedScan(habitatId);
    expect(reports[0].rulesMatched).toBe(1);

    // Informational: no task assignment mutated.
    const assignedTasks = db
      .select()
      .from(tasks)
      .where(eq(tasks.assignedAgentId, degradedAgent.id))
      .all();
    expect(assignedTasks).toHaveLength(5);
  });
});
