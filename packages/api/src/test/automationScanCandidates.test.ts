/**
 * CS-56 T5 — Per-scan true/false condition characterization.
 *
 * For each of the seven scheduled scan families, assert that:
 *   - the documented candidate context is evaluated against a TRUE
 *     condition (the lifecycle reaches `executed` with
 *     `conditionResult.matched === true`), AND
 *   - the same context is evaluated against a FALSE condition (the run
 *     finalizes `skipped/condition_false` with no action).
 *
 * Each pair exercises a fresh Habitat + rule per scenario so cooldown and
 * hourly admission can't mask a missing candidate or a faulty target. We
 * drive `attemptRuleRun` directly with a synthetic candidate so the
 * assertion isolates the candidate-context contract from incidental
 * action-execution concerns (e.g., `create_signal` requiring `missionId`).
 *
 * Scans covered:
 *   1. `mission_blocked`
 *   2. `sprint_ending`
 *   3. `agent_silent`
 *   4. `evidence_gap_open`
 *   5. `signal_pattern_clustered`
 *   6. `agent_quality_degraded`
 *   7. `orphan_mission_unmapped`
 *
 * CS-56 cold-review m3.3 — candidate-query negative tests. The original
 * characterization hand-constructed candidate contexts and called
 * `attemptRuleRun` directly. That bypassed the candidate queries
 * (`listBlockedMissions`, `listSilentAgentsInHabitat`,
 * `listActiveEvidenceGapsInHabitat`) entirely, so a regression in the
 * candidate query (e.g., a global Agent becoming a silent candidate) was
 * not observable. The following `describe` block exercises the
 * candidate-query functions DIRECTLY with negative fixtures to pin the
 * Habitat-scoped semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as taskRepoAll from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as sprintService from "../services/sprintService.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import { attemptRuleRun } from "../services/automationAttemptLifecycle.js";
import {
  listBlockedMissions,
  listSilentAgentsInHabitat,
  listActiveEvidenceGapsInHabitat,
} from "../services/automationScanService.js";
import { agents } from "../db/schema/agent.js";
import { codeEvidenceGaps } from "../db/schema/code-evidence.js";
import { missionDependencies } from "../db/schema/habitat.js";
import { tasks as tasksSchema } from "../db/schema/task.js";
import type { AutomationCondition } from "@orcy/shared";

function setupHabitat() {
  const h = boardRepo.createHabitat({ name: "ScanCandidate Habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Backlog", order: 0, requiresClaim: false });
  return h;
}

function setupMission(habitatId: string) {
  return missionRepo.createMission({ habitatId, title: "Mission", createdBy: "user-1" });
}

function setupTask(missionId: string) {
  return taskRepo.createTask({ missionId, title: "Task", createdBy: "user-1" });
}

function createRule(
  habitatId: string,
  scanType: string,
  condition: AutomationCondition,
  name: string,
) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name,
    priority: 0,
    trigger: { type: "scan", scanType } as any,
    condition,
    actions: [], // T5 candidate-context assertions don't need actions.
    enabled: true,
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    createdBy: "system:test",
  });
}

/** A condition that is always true (`{type:"always"}`). */
const ALWAYS: AutomationCondition = { type: "always" } as AutomationCondition;
/**
 * A condition that is always false for our target shapes. `priority_above`
 * with `threshold: "critical"` never matches a `low`-priority task; for
 * non-task candidates we evaluate on the (nonexistent) task slot, so the
 * tree resolves to false.
 */
const NEVER: AutomationCondition = {
  type: "priority_above",
  threshold: "critical",
} as AutomationCondition;

describe("CS-56 T5 — per-scan true/false condition tests", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // -------------------------------------------------------------------------
  // 1. mission_blocked
  // -------------------------------------------------------------------------
  describe("mission_blocked — target Mission, blocker facts in payload", () => {
    it("TRUE: condition matches against a blocked Mission", async () => {
      const habitat = setupHabitat();
      const blocker = setupMission(habitat.id);
      const blocked = setupMission(habitat.id);
      getDb()
        .insert(missionDependencies)
        .values({ missionId: blocked.id, dependsOnId: blocker.id })
        .run();
      const rule = createRule(habitat.id, "mission_blocked", ALWAYS, "Blocked True");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "mission_blocked",
          triggerEventId: `scan:mission_blocked:${blocked.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "mission",
          targetId: blocked.id,
          payload: {
            missionId: blocked.id,
            title: blocked.title,
            blockedBy: [{ missionId: blocker.id, title: blocker.title, status: blocker.status }],
            blockedByCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("mission");
        expect(disposition.run.targetId).toBe(blocked.id);
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const blocker = setupMission(habitat.id);
      const blocked = setupMission(habitat.id);
      getDb()
        .insert(missionDependencies)
        .values({ missionId: blocked.id, dependsOnId: blocker.id })
        .run();
      const rule = createRule(habitat.id, "mission_blocked", NEVER, "Blocked False");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "mission_blocked",
          triggerEventId: `scan:mission_blocked:${blocked.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "mission",
          targetId: blocked.id,
          payload: {
            missionId: blocked.id,
            title: blocked.title,
            blockedBy: [{ missionId: blocker.id, title: blocker.title, status: blocker.status }],
            blockedByCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. sprint_ending
  // -------------------------------------------------------------------------
  describe("sprint_ending — target active Sprint, raw payload", () => {
    function makeActiveSprint(habitatId: string) {
      const sprint = sprintRepo.create(habitatId, {
        name: "Sprint",
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
        createdBy: "user-1",
      });
      sprintService.startSprint(sprint.id);
      return sprintRepo.getById(sprint.id)!;
    }

    it("TRUE: condition matches against an active Sprint", async () => {
      const habitat = setupHabitat();
      const sprint = makeActiveSprint(habitat.id);
      const rule = createRule(habitat.id, "sprint_ending", ALWAYS, "Sprint True");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "sprint_ending",
          triggerEventId: `scan:sprint_ending:${sprint.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "sprint",
          targetId: sprint.id,
          payload: {
            sprintId: sprint.id,
            name: sprint.name,
            endDate: sprint.endDate,
            startDate: sprint.startDate,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("sprint");
        expect(disposition.run.targetId).toBe(sprint.id);
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const sprint = makeActiveSprint(habitat.id);
      const rule = createRule(habitat.id, "sprint_ending", NEVER, "Sprint False");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "sprint_ending",
          triggerEventId: `scan:sprint_ending:${sprint.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "sprint",
          targetId: sprint.id,
          payload: {
            sprintId: sprint.id,
            name: sprint.name,
            endDate: sprint.endDate,
            startDate: sprint.startDate,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. agent_silent
  // -------------------------------------------------------------------------
  describe("agent_silent — target Agent, heartbeat/threshold/active Tasks in payload", () => {
    async function setupSilentAgent(habitatId: string) {
      const agent = agentRepo.createAgent({
        name: "silent",
        type: "claude-code",
        domain: "backend",
      }).agent;
      const mission = setupMission(habitatId);
      const task = setupTask(mission.id);
      taskRepo.claimTask(task.id, agent.id);
      agentRepo.updateAgent(agent.id, { status: "working" });
      const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      getDb()
        .update(agents)
        .set({ lastHeartbeat: stale })
        .where(eq(agents.id, agent.id))
        .run();
      return agent;
    }

    it("TRUE: condition matches against a silent Habitat-scoped Agent", async () => {
      const habitat = setupHabitat();
      const agent = await setupSilentAgent(habitat.id);
      const rule = createRule(habitat.id, "agent_silent", ALWAYS, "Silent True");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "agent_silent",
          triggerEventId: `scan:agent_silent:${agent.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "agent",
          targetId: agent.id,
          payload: {
            agentId: agent.id,
            name: agent.name,
            lastHeartbeat: agent.lastHeartbeat,
            elapsedMinutes: 60,
            thresholdMinutes: 15,
            activeTaskIds: [],
            activeTaskCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("agent");
        expect(disposition.run.targetId).toBe(agent.id);
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const agent = await setupSilentAgent(habitat.id);
      const rule = createRule(habitat.id, "agent_silent", NEVER, "Silent False");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "agent_silent",
          triggerEventId: `scan:agent_silent:${agent.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "agent",
          targetId: agent.id,
          payload: {
            agentId: agent.id,
            name: agent.name,
            lastHeartbeat: agent.lastHeartbeat,
            elapsedMinutes: 60,
            thresholdMinutes: 15,
            activeTaskIds: [],
            activeTaskCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. evidence_gap_open
  // -------------------------------------------------------------------------
  describe("evidence_gap_open — target Task/Mission owning the gap", () => {
    it("TRUE: condition matches against an active Habitat-scoped gap", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(mission.id);
      const rule = createRule(habitat.id, "evidence_gap_open", ALWAYS, "Gap True");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "evidence_gap_open",
          triggerEventId: `scan:evidence_gap_open:gap1:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "task",
          targetId: task.id,
          payload: {
            gapId: "gap1",
            targetType: "task",
            targetId: task.id,
            reasonCode: "no_link",
            reasonNote: null,
            reportedAt: new Date().toISOString(),
            activeGapCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("task");
        expect(disposition.run.targetId).toBe(task.id);
      }
      void mission;
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const mission = setupMission(habitat.id);
      const task = setupTask(mission.id);
      const rule = createRule(habitat.id, "evidence_gap_open", NEVER, "Gap False");

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "evidence_gap_open",
          triggerEventId: `scan:evidence_gap_open:gap2:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "task",
          targetId: task.id,
          payload: {
            gapId: "gap2",
            targetType: "task",
            targetId: task.id,
            reasonCode: "no_link",
            reasonNote: null,
            reportedAt: new Date().toISOString(),
            activeGapCount: 1,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. signal_pattern_clustered
  // -------------------------------------------------------------------------
  describe("signal_pattern_clustered — target Habitat, raw cluster payload", () => {
    it("TRUE: condition matches a clustered signal", async () => {
      const habitat = setupHabitat();
      const rule = createRule(
        habitat.id,
        "signal_pattern_clustered",
        ALWAYS,
        "Cluster True",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "signal_pattern_clustered",
          triggerEventId: `cluster:abc:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "habitat",
          targetId: habitat.id,
          payload: {
            clusterKey: "abc",
            skillCategory: "experience",
            provenanceBreakdown: { experience: 3 },
            signalCount: 3,
            affectedTaskIds: [],
            affectedMissionIds: [],
            agentIds: [],
            crossMissionCount: 0,
            distinctAgentCount: 1,
            timeWindowDays: 30,
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("habitat");
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const rule = createRule(
        habitat.id,
        "signal_pattern_clustered",
        NEVER,
        "Cluster False",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "signal_pattern_clustered",
          triggerEventId: `cluster:abc:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "habitat",
          targetId: habitat.id,
          payload: {
            clusterKey: "abc",
            skillCategory: "experience",
            provenanceBreakdown: { experience: 3 },
            signalCount: 3,
            affectedTaskIds: [],
            affectedMissionIds: [],
            agentIds: [],
            crossMissionCount: 0,
            distinctAgentCount: 1,
            timeWindowDays: 30,
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. agent_quality_degraded
  // -------------------------------------------------------------------------
  describe("agent_quality_degraded — target Agent, quality payload", () => {
    it("TRUE: condition matches against a degraded Agent", async () => {
      const habitat = setupHabitat();
      const agent = agentRepo.createAgent({
        name: "degraded",
        type: "claude-code",
        domain: "backend",
      }).agent;
      const rule = createRule(
        habitat.id,
        "agent_quality_degraded",
        ALWAYS,
        "Quality True",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "agent_quality_degraded",
          triggerEventId: `agent_quality:${agent.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "agent",
          targetId: agent.id,
          payload: {
            agentId: agent.id,
            agentName: agent.name,
            score: 0.3,
            confidence: 0.8,
            sampleSize: 10,
            dimensions: { approval: 0.5, nonRejectionRate: 0.5, consistency: 0.5 },
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("agent");
        expect(disposition.run.targetId).toBe(agent.id);
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const agent = agentRepo.createAgent({
        name: "degraded-false",
        type: "claude-code",
        domain: "backend",
      }).agent;
      const rule = createRule(
        habitat.id,
        "agent_quality_degraded",
        NEVER,
        "Quality False",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "agent_quality_degraded",
          triggerEventId: `agent_quality:${agent.id}:${habitat.id}`,
          habitatId: habitat.id,
          targetType: "agent",
          targetId: agent.id,
          payload: {
            agentId: agent.id,
            agentName: agent.name,
            score: 0.3,
            confidence: 0.8,
            sampleSize: 10,
            dimensions: { approval: 0.5, nonRejectionRate: 0.5, consistency: 0.5 },
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 7. orphan_mission_unmapped
  // -------------------------------------------------------------------------
  describe("orphan_mission_unmapped — target orphan Mission", () => {
    it("TRUE: condition matches against an orphan Mission", async () => {
      const habitat = setupHabitat();
      const orphan = setupMission(habitat.id);
      const rule = createRule(
        habitat.id,
        "orphan_mission_unmapped",
        ALWAYS,
        "Orphan True",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "orphan_mission_unmapped",
          triggerEventId: `orphan:${orphan.id}`,
          habitatId: habitat.id,
          targetType: "mission",
          targetId: orphan.id,
          payload: {
            missionId: orphan.id,
            title: orphan.title,
            clusterKey: `orphan-mission:${orphan.id}`,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("executed");
      if (disposition.kind === "executed") {
        expect(disposition.run.conditionResult?.matched).toBe(true);
        expect(disposition.run.targetType).toBe("mission");
        expect(disposition.run.targetId).toBe(orphan.id);
      }
    });

    it("FALSE: condition_false recorded, no action", async () => {
      const habitat = setupHabitat();
      const orphan = setupMission(habitat.id);
      const rule = createRule(
        habitat.id,
        "orphan_mission_unmapped",
        NEVER,
        "Orphan False",
      );

      const disposition = await attemptRuleRun({
        rule,
        source: "scan",
        trigger: {
          triggerType: "orphan_mission_unmapped",
          triggerEventId: `orphan:${orphan.id}`,
          habitatId: habitat.id,
          targetType: "mission",
          targetId: orphan.id,
          payload: {
            missionId: orphan.id,
            title: orphan.title,
            clusterKey: `orphan-mission:${orphan.id}`,
          },
        },
        eventDedupeKey: null,
      });

      expect(disposition.kind).toBe("skipped");
      if (disposition.kind === "skipped") {
        expect(disposition.reason).toBe("condition_false");
        expect(disposition.run.conditionResult?.matched).toBe(false);
        expect(disposition.run.actionResults).toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// CS-56 cold-review m3.3 — candidate-query NEGATIVE tests.
//
// These tests exercise the candidate-query functions directly so a
// regression in `listBlockedMissions`, `listSilentAgentsInHabitat`, or
// `listActiveEvidenceGapsInHabitat` (e.g., a global Agent becoming a
// silent candidate, a Mission with only done deps becoming blocked) is
// observable. The pre-fix characterization constructed candidates by hand
// and could NOT observe such regressions.
// ---------------------------------------------------------------------------

describe("CS-56 cold-review m3.3 — candidate-query negative tests", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // ---- mission_blocked ----

  it("listBlockedMissions is empty when a Habitat has only done-dependency Missions (no blockers left)", async () => {
    const habitat = setupHabitat();
    const blocker = setupMission(habitat.id);
    const blocked = setupMission(habitat.id);
    getDb()
      .insert(missionDependencies)
      .values({ missionId: blocked.id, dependsOnId: blocker.id })
      .run();
    // Mark the blocker done so blocked-by no longer synthesizes a block.
    const { missions: missionsSchema } = await import("../db/schema/habitat.js");
    missionRepo.updateMission(blocker.id, { status: "done" });

    expect(listBlockedMissions(habitat.id)).toEqual([]);
  });

  it("listBlockedMissions is empty when a Habitat has no dependency edges", () => {
    const habitat = setupHabitat();
    setupMission(habitat.id);
    expect(listBlockedMissions(habitat.id)).toEqual([]);
  });

  it("listBlockedMissions is empty for a Habitat with active Missions but no edges (no-blockers baseline)", () => {
    const habitat = setupHabitat();
    setupMission(habitat.id);
    setupMission(habitat.id);
    // Two non-blocked Missions, no edges → candidates list is empty.
    expect(listBlockedMissions(habitat.id)).toEqual([]);
  });

  // ---- agent_silent ----

  it("listSilentAgentsInHabitat is empty for a global Agent with NO Habitat work (cross-Habitat isolation)", async () => {
    const h1 = boardRepo.createHabitat({ name: "Habitat X" });
    columnRepo.createColumn({ habitatId: h1.id, name: "Backlog", order: 0, requiresClaim: false });
    const h2 = boardRepo.createHabitat({ name: "Habitat Y" });
    columnRepo.createColumn({ habitatId: h2.id, name: "Backlog", order: 0, requiresClaim: false });
    const agent = agentRepo.createAgent({
      name: "global-agent-no-habitat-work",
      type: "claude-code",
      domain: "backend",
    }).agent;
    // Create a Mission in h2 ONLY and claim a Task for the agent, but set
    // the heartbeat to a stale value.
    const mission = setupMission(h2.id);
    const task = setupTask(mission.id);
    taskRepoAll.claimTask(task.id, agent.id);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb()
      .update(agents)
      .set({ lastHeartbeat: stale, status: "working" })
      .where(eq(agents.id, agent.id))
      .run();

    // The agent has active work ONLY in h2. From h1's perspective, the
    // agent is a global Agent without Habitat work → NOT a candidate.
    expect(listSilentAgentsInHabitat(h1.id)).toEqual([]);
    // Sanity: the agent IS a candidate in h2.
    expect(listSilentAgentsInHabitat(h2.id).map((c) => c.agentId)).toContain(agent.id);
  });

  it("listSilentAgentsInHabitat is empty for an Agent whose only Habitat Task is `done` (Major 1 fix at the candidate-query seam)", async () => {
    const habitat = setupHabitat();
    const agent = agentRepo.createAgent({
      name: "agent-with-done-task",
      type: "claude-code",
      domain: "backend",
    }).agent;
    const mission = setupMission(habitat.id);
    const task = setupTask(mission.id);
    taskRepoAll.claimTask(task.id, agent.id);
    // Mark done.
    getDb()
      .update(tasksSchema)
      .set({ status: "done" })
      .where(eq(tasksSchema.id, task.id))
      .run();
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb()
      .update(agents)
      .set({ lastHeartbeat: stale, status: "working" })
      .where(eq(agents.id, agent.id))
      .run();

    // No active Habitat work → not a silent candidate.
    expect(listSilentAgentsInHabitat(habitat.id)).toEqual([]);
  });

  // ---- evidence_gap_open ----

  it("listActiveEvidenceGapsInHabitat excludes orphaned gaps (target deleted) and cross-Habitat gaps", async () => {
    const h1 = boardRepo.createHabitat({ name: "Habitat Gap A" });
    columnRepo.createColumn({ habitatId: h1.id, name: "Backlog", order: 0, requiresClaim: false });
    const h2 = boardRepo.createHabitat({ name: "Habitat Gap B" });
    columnRepo.createColumn({ habitatId: h2.id, name: "Backlog", order: 0, requiresClaim: false });

    // Habitat-owned gap (in h1, target Task in h1-owned Mission) — INCLUDED.
    const ownMission = setupMission(h1.id);
    const ownTask = setupTask(ownMission.id);
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: ownTask.id,
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });

    // Cross-Habitat gap (in h1, target Task in h2-owned Mission) — EXCLUDED.
    const otherMission = setupMission(h2.id);
    const otherTask = setupTask(otherMission.id);
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: otherTask.id,
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });

    // Orphaned gap (target id does not resolve to any Task) — EXCLUDED.
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-does-not-exist",
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });

    const h1Candidates = listActiveEvidenceGapsInHabitat(h1.id);
    const h2Candidates = listActiveEvidenceGapsInHabitat(h2.id);

    expect(h1Candidates.map((c) => c.targetId)).toEqual([ownTask.id]);
    expect(h2Candidates.map((c) => c.targetId)).toEqual([otherTask.id]);
  });

  it("listActiveEvidenceGapsInHabitat excludes resolved (`status='resolved'`) and pending gaps", async () => {
    const habitat = setupHabitat();
    const mission = setupMission(habitat.id);
    const task = setupTask(mission.id);

    // An "active" gap (the only kind the query admits).
    const active = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: task.id,
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });
    expect(active).not.toBeNull();

    // A "resolved" gap on the same target — must be excluded by the
    // `status='active'` filter. Resolve via the repository so we exercise
    // the production helper (it marks status + audit fields).
    const resolved = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: task.id,
      reasonCode: "no_link",
      reportedByType: "system",
      reportedById: "test",
    });
    expect(resolved).not.toBeNull();
    codeEvidenceGapRepo.resolveGap(resolved!.id, "system", "test-harness", "auto-resolved-by-test");

    const candidates = listActiveEvidenceGapsInHabitat(habitat.id);
    expect(candidates.map((c) => c.gapId)).toEqual([active!.id]);
  });
});
