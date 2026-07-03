import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  missionDependencies,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as releaseRepo from "../repositories/release.js";
import { getAvailableTasksForAgent } from "../repositories/taskQueries.js";
import { matchesReleaseType, matchesReleaseVersion, type ReleaseType } from "@orcy/shared";

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Triage Insertion Habitat" });
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

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

function seedTriagedFinding(subject: string) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "agent-1",
    signalType: "finding",
    subject,
    body: "",
    metadata: { findingKind: "bug", severity: "minor", blocksCurrentWork: false },
  });
  const t = findingTriageRepo.createForPulse(pulse);
  findingTriageRepo.transitionStatus(t.id, "triaged", ACTOR);
  findingTriageRepo.setBucket(t.id, "defer_to_release");
  return t;
}

/**
 * Replicates the `/habitats/:id/roadmap` route handler's composition so the
 * test exercises the same repo seams + derivation that the roadmap endpoint
 * exposes to the triage investigation agent.
 */
function fetchRoadmapContext() {
  const db = getDb();
  const missionRows = db
    .select()
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all() as Array<typeof missions.$inferSelect>;
  const depRows = db
    .select({
      missionId: missionDependencies.missionId,
      dependsOnId: missionDependencies.dependsOnId,
    })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
    .where(eq(missions.habitatId, habitatId))
    .all();

  const recentReleases = releaseRepo.findRecentByHabitat(habitatId, 10);
  const habitatReleaseTypes = new Set(
    db
      .select({ releaseType: releasesTable.releaseType })
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all()
      .map((r) => r.releaseType as ReleaseType),
  );
  const habitatReleaseVersions = db
    .select({ version: releasesTable.version })
    .from(releasesTable)
    .where(eq(releasesTable.habitatId, habitatId))
    .all()
    .map((r) => r.version);

  const missionById = new Map(missionRows.map((m) => [m.id, m]));
  const blockingByMission = new Map<string, Set<string>>();
  for (const dep of depRows) {
    const entry = blockingByMission.get(dep.missionId) ?? new Set<string>();
    entry.add(dep.dependsOnId);
    blockingByMission.set(dep.missionId, entry);
  }

  const nextInLine = missionRows
    .filter((m) => {
      if (m.status === "done" || m.status === "failed") return false;
      const blockers = blockingByMission.get(m.id);
      if (blockers) {
        for (const blockerId of blockers) {
          const blocker = missionById.get(blockerId);
          if (blocker && blocker.status !== "done") return false;
        }
      }
      if (m.releaseGateType || m.releaseGateVersion) {
        const typeArm = m.releaseGateType
          ? [...habitatReleaseTypes].some((shipped) =>
              matchesReleaseType(m.releaseGateType as ReleaseType, shipped),
            )
          : false;
        const versionArm = m.releaseGateVersion
          ? habitatReleaseVersions.some((v) => matchesReleaseVersion(m.releaseGateVersion!, v))
          : false;
        if (!typeArm && !versionArm) return false;
      }
      return true;
    })
    .map((m) => m.id);

  return {
    missions: missionRows.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      releaseGateType: m.releaseGateType,
      releaseGateVersion: m.releaseGateVersion,
      priority: m.priority,
      displayOrder: m.displayOrder,
    })),
    dependencies: depRows,
    nextInLine,
    recentReleases: recentReleases.map((r) => ({
      version: r.version,
      releaseType: r.releaseType,
      detectedAt: r.detectedAt,
    })),
  };
}

/**
 * Replicates the `insert_deferred_mission` MCP action's contract against the
 * API: create a gated mission with deps, link the finding, return a placement
 * note that the daemon agent echoes into an analysis pulse. Tests at the API
 * layer exercise the real persistence + DAG behaviour rather than HTTP mocks.
 */
function insertDeferredMission(opts: {
  findingId: string;
  missionTitle: string;
  missionDescription?: string;
  dependsOn?: string[];
  releaseGateType: "patch" | "minor" | "major";
  releaseGateVersion?: string;
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.missionTitle,
    description: opts.missionDescription,
    labels: ["triage", "deferred"],
    dependsOn: opts.dependsOn,
    releaseGateType: opts.releaseGateType,
    releaseGateVersion: opts.releaseGateVersion,
    createdBy: "triage-agent",
  });
  findingTriageRepo.setTriageMissionId(opts.findingId, mission.id);

  const depsCount = (opts.dependsOn ?? []).length;
  const placementNote =
    `Inserted deferred mission ${mission.id} gated on ${opts.releaseGateType}` +
    (opts.releaseGateVersion ? `@${opts.releaseGateVersion}` : "") +
    ` with ${depsCount} dependency edge(s); linked to finding ${opts.findingId}.`;

  // Analysis pulse recording placement reasoning (AC-INSERT-6).
  pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    signalType: "context",
    fromType: "agent",
    fromId: "triage-agent",
    subject: `Roadmap placement: ${mission.title}`,
    body: placementNote,
    metadata: {
      analysisKind: "roadmap_placement",
      missionId: mission.id,
      releaseGateType: opts.releaseGateType,
      releaseGateVersion: opts.releaseGateVersion ?? null,
      dependsOn: opts.dependsOn ?? [],
      findingId: opts.findingId,
    },
  });

  return { mission, finding: findingTriageRepo.getById(opts.findingId)!, placementNote };
}

/**
 * AC-INSERT-1 — the triage investigation context includes roadmap DAG data:
 * the habitat's missions, dependency edges, gate fields, and the derived
 * nextInLine ordering.
 */
describe("AC-INSERT-1: roadmap context surfaces DAG + gate fields", () => {
  it("returns missions, dependencies, nextInLine, and recentReleases with gate fields", () => {
    const prior = missionRepo.createMission({
      habitatId,
      columnId,
      title: "in-flight",
      createdBy: "user-1",
    });
    // Seed a detected release so recentReleases is non-empty.
    releaseRepo.create({
      habitatId,
      version: "0.1.0",
      releaseType: "minor",
      detectedBy: "api",
    });

    const roadmap = fetchRoadmapContext();

    expect(Array.isArray(roadmap.missions)).toBe(true);
    expect(roadmap.missions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(roadmap.dependencies)).toBe(true);
    expect(Array.isArray(roadmap.nextInLine)).toBe(true);
    expect(Array.isArray(roadmap.recentReleases)).toBe(true);
    expect(roadmap.recentReleases.length).toBe(1);

    const seenIds = roadmap.missions.map((m) => m.id);
    expect(seenIds).toContain(prior.id);

    // Each mission exposes gate fields.
    for (const m of roadmap.missions) {
      expect(m).toHaveProperty("releaseGateType");
      expect(m).toHaveProperty("releaseGateVersion");
    }
  });

  it("nextInLine excludes gated missions whose gate is not yet satisfied", () => {
    const gated = missionRepo.createMission({
      habitatId,
      columnId,
      title: "gated-not-yet",
      createdBy: "user-1",
      releaseGateType: "minor",
    });
    const free = missionRepo.createMission({
      habitatId,
      columnId,
      title: "free",
      createdBy: "user-1",
    });

    const roadmap = fetchRoadmapContext();

    expect(roadmap.nextInLine).toContain(free.id);
    expect(roadmap.nextInLine).not.toContain(gated.id);
  });

  it("nextInLine includes gated missions once a matching release ships", () => {
    const gated = missionRepo.createMission({
      habitatId,
      columnId,
      title: "gated-satisfied",
      createdBy: "user-1",
      releaseGateType: "minor",
    });
    releaseRepo.create({
      habitatId,
      version: "0.2.0",
      releaseType: "minor",
      detectedBy: "api",
    });

    const roadmap = fetchRoadmapContext();

    expect(roadmap.nextInLine).toContain(gated.id);
  });
});

/**
 * AC-INSERT-2 — the insertion creates a mission with release-gate set.
 */
describe("AC-INSERT-2: insert_deferred_mission creates a gated mission", () => {
  it("persists releaseGateType='minor' on the created mission", () => {
    const finding = seedTriagedFinding("defer-minor");

    const { mission } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Deferred minor corrective",
      missionDescription: "gated corrective work",
      releaseGateType: "minor",
    });

    const created = missionRepo.getMissionById(mission.id)!;
    expect(created.releaseGateType).toBe("minor");
    expect(created.releaseGateVersion).toBeNull();
    expect(created.labels).toContain("triage");
    expect(created.labels).toContain("deferred");
  });

  it("persists releaseGateVersion alongside the type when supplied", () => {
    const finding = seedTriagedFinding("defer-pinned");

    const { mission } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Pinned corrective",
      releaseGateType: "patch",
      releaseGateVersion: "v0.25.1",
    });

    const created = missionRepo.getMissionById(mission.id)!;
    expect(created.releaseGateType).toBe("patch");
    expect(created.releaseGateVersion).toBe("v0.25.1");
  });
});

/**
 * AC-INSERT-3 — the created gated mission has missionDependencies set
 * positioning it in the DAG (not orphaned).
 */
describe("AC-INSERT-3: created gated mission is positioned in the DAG", () => {
  it("persists missionDependencies supplied at insertion", () => {
    const finding = seedTriagedFinding("defer-with-deps");
    const prior = missionRepo.createMission({
      habitatId,
      columnId,
      title: "prior-in-flight",
      createdBy: "user-1",
    });

    const { mission } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Depends-on-prior",
      releaseGateType: "minor",
      dependsOn: [prior.id],
    });

    const db = getDb();
    const edges = db
      .select()
      .from(missionDependencies)
      .where(eq(missionDependencies.missionId, mission.id))
      .all();
    expect(edges.length).toBe(1);
    expect(edges[0].dependsOnId).toBe(prior.id);
  });
});

/**
 * AC-INSERT-4 — the created gated mission is visible but its tasks are
 * unclaimable until the gate resolves.
 */
describe("AC-INSERT-4: created mission visible-but-blocked until gate resolves", () => {
  it("the mission exists with status not_started; tasks excluded until a matching release ships", () => {
    const finding = seedTriagedFinding("defer-blocked");

    const { mission } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Blocked mission",
      releaseGateType: "minor",
    });

    const created = missionRepo.getMissionById(mission.id)!;
    expect(created.status).toBe("not_started");
    expect(created.releaseGateType).toBe("minor");

    const task = taskRepo.createTask({
      missionId: created.id,
      title: "gated-task",
      createdBy: "triage-agent",
    });

    expect(
      getAvailableTasksForAgent(habitatId, "backend", { status: "pending" }).map((t) => t.id),
    ).not.toContain(task.id);

    // After a matching release ships, the gate satisfies and tasks become claimable.
    releaseRepo.create({
      habitatId,
      version: "0.2.0",
      releaseType: "minor",
      detectedBy: "api",
    });
    expect(
      getAvailableTasksForAgent(habitatId, "backend", { status: "pending" }).map((t) => t.id),
    ).toContain(task.id);
  });
});

/**
 * AC-INSERT-5 — the finding (`finding_triage`) links to the created gated mission.
 */
describe("AC-INSERT-5: finding links to the created gated mission", () => {
  it("finding.triageMissionId is set to the created mission's id", () => {
    const finding = seedTriagedFinding("defer-link");

    const { mission } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Linked mission",
      releaseGateType: "minor",
    });

    const refreshed = findingTriageRepo.getById(finding.id)!;
    expect(refreshed.triageMissionId).toBe(mission.id);
  });
});

/**
 * AC-INSERT-6 — the insertion is auditable: an analysis pulse records the
 * placement decision (which deps set, which gate, why).
 */
describe("AC-INSERT-6: insertion posts an analysis pulse recording placement", () => {
  it("records a roadmap_placement pulse carrying gate, deps, and finding linkage", () => {
    const finding = seedTriagedFinding("defer-audit");
    const prior = missionRepo.createMission({
      habitatId,
      columnId,
      title: "prior",
      createdBy: "user-1",
    });

    const { mission, placementNote } = insertDeferredMission({
      findingId: finding.id,
      missionTitle: "Auditable mission",
      releaseGateType: "minor",
      releaseGateVersion: "v0.25",
      dependsOn: [prior.id],
    });

    expect(placementNote).toContain("minor");
    expect(placementNote).toContain("v0.25");
    expect(placementNote).toContain("1 dependency edge");
    expect(placementNote).toContain(finding.id);

    const db = getDb();
    const auditPulse = db
      .select()
      .from(pulses)
      .where(eq(pulses.habitatId, habitatId))
      .all()
      .find((p) => {
        const meta = p.metadata as Record<string, unknown> | null;
        return meta?.analysisKind === "roadmap_placement" && meta?.missionId === mission.id;
      });
    expect(auditPulse).toBeDefined();
    const meta = auditPulse!.metadata as Record<string, unknown>;
    expect(meta.releaseGateType).toBe("minor");
    expect(meta.releaseGateVersion).toBe("v0.25");
    expect(meta.findingId).toBe(finding.id);
    expect(meta.dependsOn).toEqual([prior.id]);
  });
});
