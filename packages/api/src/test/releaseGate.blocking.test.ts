import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  missions,
  pulses,
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as releaseRepo from "../repositories/release.js";
import { getAvailableTasksForAgent } from "../repositories/taskQueries.js";
import type { ReleaseType } from "@orcy/shared";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();
  db.delete(pulses).run();

  const habitat = habitatRepo.createHabitat({ name: "Gate Blocking Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => closeDb());

const ACTOR = { type: "human" as const, id: "user-1" };

/** Direct insert of a release row bypassing detectAndActivate (no classification). */
function seedRelease(version: string, releaseType: ReleaseType) {
  return releaseRepo.create({
    habitatId,
    version,
    releaseType,
    detectedBy: "api",
  });
}

/** Mission with optional release-gate. Tasks created via repo so they enter the eligibility set. */
function seedGatedMission(opts: {
  title: string;
  releaseGateType?: ReleaseType | null;
  releaseGateVersion?: string | null;
  dependsOn?: string[];
}) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: opts.title,
    createdBy: "user-1",
    releaseGateType: opts.releaseGateType ?? null,
    releaseGateVersion: opts.releaseGateVersion ?? null,
    dependsOn: opts.dependsOn ?? [],
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: `task-for-${mission.id}`,
    createdBy: "user-1",
  });
  return { mission, task };
}

function availableTaskIds(): string[] {
  return getAvailableTasksForAgent(habitatId, "backend", { status: "pending" }).map((t) => t.id);
}

/**
 * AC-GATE-1 — migration 0050 adds the release-gate columns; existing rows default NULL.
 */
describe("AC-GATE-1: migration 0050 adds nullable release-gate columns", () => {
  it("missions table has release_gate_type and release_gate_version columns", () => {
    const db = getDb();
    const cols = db
      .all("PRAGMA table_info(missions)")
      .map((r) => (r as Record<string, unknown>).name);
    expect(cols).toContain("release_gate_type");
    expect(cols).toContain("release_gate_version");
  });

  it("a mission created without explicit gate fields has NULL for both (default behaviour)", () => {
    const { mission } = seedGatedMission({ title: "no-gate" });
    const row = getDb()
      .select()
      .from(missions)
      .where(eq(missions.id, mission.id))
      .get() as typeof missions.$inferSelect;
    expect(row.releaseGateType).toBeNull();
    expect(row.releaseGateVersion).toBeNull();
  });
});

/**
 * AC-GATE-2 — a gated mission with no matching release is excluded from
 * `getAvailableTasksForAgent` even when its missionDependencies are met.
 */
describe("AC-GATE-2: gated mission with no matching release is blocked", () => {
  it("excludes tasks of a minor-gated mission when no release has shipped", () => {
    const { task } = seedGatedMission({
      title: "gated-no-release",
      releaseGateType: "minor",
    });

    expect(availableTaskIds()).not.toContain(task.id);
  });

  it("excludes tasks of a version-pinned mission when no matching release has shipped", () => {
    const { task } = seedGatedMission({
      title: "gated-version",
      releaseGateVersion: "v0.25",
    });

    expect(availableTaskIds()).not.toContain(task.id);
  });
});

/**
 * AC-GATE-3 — when a matching release HAS shipped, the gate is satisfied and
 * the mission's tasks are claimable.
 */
describe("AC-GATE-3: gated mission with matching release is claimable", () => {
  it("includes tasks of a minor-gated mission once a minor release ships", () => {
    seedRelease("0.2.0", "minor");
    const { task } = seedGatedMission({
      title: "gated-minor-satisfied",
      releaseGateType: "minor",
    });

    expect(availableTaskIds()).toContain(task.id);
  });

  it("includes tasks of a version-pinned mission once the pinned version ships", () => {
    seedRelease("0.25.0", "minor");
    const { task } = seedGatedMission({
      title: "gated-pin-satisfied",
      releaseGateVersion: "v0.25",
    });

    expect(availableTaskIds()).toContain(task.id);
  });
});

/**
 * AC-GATE-4 — gate matching uses the gate-perspective truth table:
 *   patch gate → satisfied by ANY shipped release (patch | minor | major)
 *   minor gate → satisfied by minor or major
 *   major gate → satisfied by major only
 * Version-pin (exact or prefix) matches independently.
 */
describe("AC-GATE-4: gate-perspective type-cascade truth table", () => {
  const gateTypes: ReleaseType[] = ["patch", "minor", "major"];
  const shippedTypes: ReleaseType[] = ["patch", "minor", "major"];

  // Build the expected matrix by hand. From matchesReleaseType's gate-perspective:
  //   patch gate matches any shipped type
  //   minor gate matches minor or major (not patch)
  //   major gate matches major only
  const expectedSatisfied = (gate: ReleaseType, shipped: ReleaseType): boolean => {
    if (gate === "patch") return true; // any shipped release satisfies a patch gate
    if (gate === "minor") return shipped === "minor" || shipped === "major";
    return shipped === "major"; // major gate
  };

  for (const gate of gateTypes) {
    for (const shipped of shippedTypes) {
      it(`${gate}-gate ${expectedSatisfied(gate, shipped) ? "IS" : "is NOT"} satisfied by a ${shipped} release`, () => {
        seedRelease(`0.${shippedTypes.indexOf(shipped) + 1}.0`, shipped);
        const { task } = seedGatedMission({
          title: `${gate}-gate-vs-${shipped}`,
          releaseGateType: gate,
        });

        const included = availableTaskIds().includes(task.id);
        expect(included).toBe(expectedSatisfied(gate, shipped));
      });
    }
  }

  it("version-prefix pin matches any shipped version with the prefix", () => {
    seedRelease("0.25.0", "minor");
    const { task: matchingTask } = seedGatedMission({
      title: "pin-v0.25-match",
      releaseGateVersion: "v0.25",
    });
    const { task: nonMatchingTask } = seedGatedMission({
      title: "pin-v0.26-no-match",
      releaseGateVersion: "v0.26",
    });

    expect(availableTaskIds()).toContain(matchingTask.id);
    expect(availableTaskIds()).not.toContain(nonMatchingTask.id);
  });

  it("either-match semantics: type OR version arm satisfies the gate", () => {
    // No matching version (v9.9.9 not shipped) but type arm matches.
    seedRelease("0.2.0", "minor");
    const { task } = seedGatedMission({
      title: "dual-or",
      releaseGateType: "minor",
      releaseGateVersion: "v9.9.9",
    });

    expect(availableTaskIds()).toContain(task.id);
  });
});

/**
 * AC-GATE-5 — a gated mission with BOTH unmet `missionDependencies` AND an
 * unsatisfied release-gate stays blocked until BOTH resolve.
 */
describe("AC-GATE-5: compound blocking — deps AND gate must both resolve", () => {
  it("stays blocked when only the gate is satisfied (deps still unmet)", () => {
    seedRelease("0.2.0", "minor"); // satisfies a minor gate
    const { mission: blocker } = seedGatedMission({ title: "blocker-mission" });
    const { task } = seedGatedMission({
      title: "compound-blocked",
      releaseGateType: "minor",
      dependsOn: [blocker.id],
    });

    // Gate satisfied but blocker mission is not done → still blocked.
    expect(availableTaskIds()).not.toContain(task.id);
  });

  it("stays blocked when only deps are met (gate still unsatisfied)", () => {
    // No release shipped → gate unsatisfied.
    const { mission: blocker } = seedGatedMission({ title: "blocker-mission" });
    // Mark the blocker mission done so its dependent's deps are met.
    missionRepo.updateMission(blocker.id, { status: "done" }, undefined);
    const { task } = seedGatedMission({
      title: "compound-blocked-gate",
      releaseGateType: "minor",
      dependsOn: [blocker.id],
    });

    expect(availableTaskIds()).not.toContain(task.id);
  });

  it("becomes claimable only when BOTH deps and gate resolve", () => {
    seedRelease("0.2.0", "minor");
    const { mission: blocker } = seedGatedMission({ title: "blocker-mission" });
    const { task } = seedGatedMission({
      title: "compound-resolves",
      releaseGateType: "minor",
      dependsOn: [blocker.id],
    });

    // Initially blocked on deps.
    expect(availableTaskIds()).not.toContain(task.id);

    // Resolve the dependency.
    missionRepo.updateMission(blocker.id, { status: "done" }, undefined);

    expect(availableTaskIds()).toContain(task.id);
  });
});

// Unused ACTOR retained for clarity / future seed helpers.
void ACTOR;
void dependencyRepo;
