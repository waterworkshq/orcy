import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { pulses, findingTriage as findingTriageTable, missions } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as findingTriageService from "../services/findingTriageService.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as triageService from "../services/triageService.js";
import type { ClusterPayload } from "@orcy/shared";
import { normalize } from "../services/habitatSkillService.js";

const ACTOR = { type: "human" as const, id: "user-1" };

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Resolutions Habitat" });
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
    title: "Resolutions Mission",
    createdBy: "user-1",
  });
  missionId = mission.id;
});

afterEach(() => closeDb());

function makePayload(clusterKey: string, over: Partial<ClusterPayload> = {}): ClusterPayload {
  return {
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
    ...over,
  };
}

describe("triageResolutions", () => {
  it("AC-PROACTIVE-1: resolving cluster triage writes triage_resolutions keyed by clusterKey", () => {
    const clusterKey = normalize("recurring ci failure");
    const { missionId: triageMissionId } = triageService.createTriageMission(
      habitatId,
      makePayload(clusterKey),
    );

    triageService.recordResolution(
      triageMissionId,
      {
        rootCause: "missing retry backoff",
        resolution: "added exponential backoff",
        resolutionKind: "code_fix",
        skillCategory: "ci",
      },
      ACTOR,
    );

    const resolutions = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].source).toBe("cluster_triage");
    expect(resolutions[0].sourceId).toBe(triageMissionId);
    expect(resolutions[0].clusterKey).toBe(clusterKey);
    expect(resolutions[0].rootCause).toBe("missing retry backoff");
    expect(resolutions[0].resolution).toBe("added exponential backoff");
    expect(resolutions[0].resolutionKind).toBe("code_fix");
    expect(resolutions[0].resolvedById).toBe("user-1");
  });

  it("AC-PROACTIVE-2: resolving finding triage writes triage_resolutions keyed by clusterKey", () => {
    const finding = pulseRepo.createPulse({
      habitatId,
      missionId,
      scope: "mission",
      fromType: "agent",
      fromId: "agent-1",
      signalType: "finding",
      subject: "race condition in cache",
      body: "",
      metadata: { findingKind: "bug", severity: "major", blocksCurrentWork: false },
    });
    const { findingTriageId } = findingTriageService.enterTriage({
      id: finding.id,
      habitatId,
      subject: finding.subject,
      metadata: finding.metadata,
    });
    // open → triaged → in_progress → resolved
    findingTriageService.confirmBucket(findingTriageId, "fix_now", ACTOR);
    findingTriageService.promote(findingTriageId, ACTOR);
    findingTriageService.resolve(findingTriageId, "fixed with lock", ACTOR);

    const clusterKey = normalize("race condition in cache");
    const resolutions = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].source).toBe("finding_triage");
    expect(resolutions[0].sourceId).toBe(findingTriageId);
    expect(resolutions[0].clusterKey).toBe(clusterKey);
    expect(resolutions[0].resolution).toBe("fixed with lock");
  });

  it("AC-PROACTIVE-3: new cluster with matching clusterKey surfaces historical resolution", () => {
    const clusterKey = normalize("known flaky test");
    // Step 1: a prior cluster triage was resolved, recording a resolution.
    const { missionId: firstMissionId } = triageService.createTriageMission(
      habitatId,
      makePayload(clusterKey),
    );
    triageService.recordResolution(
      firstMissionId,
      { rootCause: "timing", resolution: "added wait", resolutionKind: "code_fix" },
      ACTOR,
    );

    // Step 2: the same clusterKey re-emerges. createTriageMission embeds the
    // historical resolution as a proactive suggestion in the new mission's
    // description (the scan does the lookup; the service surfaces it).
    const { missionId: secondMissionId } = triageService.createTriageMission(
      habitatId,
      makePayload(clusterKey, { signalCount: 5 }),
    );

    // The historical resolution is surfaced: lookup returns it, and the new
    // mission description carries a "Proactive Suggestion" block.
    const historical = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);
    expect(historical.length).toBeGreaterThanOrEqual(1);

    const db = getDb();
    const rows = db.select().from(missions).all();
    const target = rows.find((m) => m.id === secondMissionId);
    expect(target).toBeDefined();
    const desc = String(target!.description ?? "");
    expect(desc).toContain("Proactive Suggestion");
    expect(desc).toContain("added wait");
  });
});
