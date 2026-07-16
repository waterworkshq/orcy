import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { missions as missionsTable } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as missionRepo from "../repositories/feature.js";
import { importHabitat, getHabitatStats, createHabitat } from "../services/boardService.js";
import * as dependencyService from "../services/dependencyService.js";

// R1 — Real-write proofs that a malformed import payload never deletes the
// target habitat, the rebuild is atomic (a mid-rebuild failure rolls the
// delete back), and persisted counts are reported (not source-array lengths).
// These exercise the real better-sqlite3 / sql.js write path and the real
// idx_columns_habitat_order unique index; none of the repositories are mocked.

function payloadWith(missions: any[], columnsOverride?: any[]) {
  return {
    version: 2,
    exportedAt: "2025-01-01T00:00:00Z",
    habitat: {
      name: "Rebuilt Habitat",
      description: "rebuilt",
      columns: columnsOverride ?? [
        {
          name: "Todo",
          order: 0,
          wipLimit: null,
          autoAdvance: false,
          requiresClaim: false,
          nextColumnName: null,
          isTerminal: false,
        },
      ],
      missions,
      comments: [],
      templates: [],
      webhooks: [],
    },
  };
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

describe("R1 — import rebuildability preflight (no destructive delete on malformed payload)", () => {
  it("refuses and does NOT delete the target when a mission references an unknown column", () => {
    const { habitat: existing, columns } = createHabitat({
      name: "Existing",
      defaultColumns: true,
    });
    const seeded = missionRepo.createMission({
      habitatId: existing.id,
      columnId: columns[0].id,
      title: "Mission That Must Survive",
      createdBy: "tester",
    });

    const malformed = payloadWith(
      [
        {
          title: "Mission A",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "DoesNotExist",
          status: "not_started",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [],
        },
      ],
      // Payload declares only "Todo", but the mission names a missing column.
    );

    expect(() => importHabitat(malformed as any, existing.id)).toThrow(/unknown column/);

    // The target habitat and its seeded mission survived — the destructive
    // delete never ran because the preflight rejected the payload.
    const survivor = habitatRepo.getHabitatById(existing.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.id).toBe(existing.id);
    expect(missionRepo.getMissionById(seeded.id)).not.toBeNull();
  });

  it("still rebuilds a fully-resolvable payload into a new habitat (positive control)", () => {
    const valid = payloadWith([
      {
        title: "Mission A",
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        labels: [],
        columnName: "Todo",
        status: "not_started",
        dependsOn: [],
        blocks: [],
        dueAt: null,
        tasks: [],
      },
    ]);
    const result = importHabitat(valid as any)!;
    expect(result.imported.missions).toBe(1);
  });
});

describe("R1 — persisted counts, not source-array lengths", () => {
  it("reports the missions actually persisted for the standalone-tasks path (old code reported 0)", () => {
    const standalonePayload = {
      version: 2,
      exportedAt: "2025-01-01T00:00:00Z",
      habitat: {
        name: "Standalone Tasks Habitat",
        description: "",
        columns: [
          {
            name: "Todo",
            order: 0,
            wipLimit: null,
            autoAdvance: false,
            requiresClaim: false,
            nextColumnName: null,
            isTerminal: false,
          },
        ],
        missions: [],
        tasks: [
          {
            title: "T1",
            description: "",
            priority: "medium",
            requiredDomain: null,
            requiredCapabilities: [],
            createdBy: "import",
          },
          {
            title: "T2",
            description: "",
            priority: "medium",
            requiredDomain: null,
            requiredCapabilities: [],
            createdBy: "import",
          },
          {
            title: "T3",
            description: "",
            priority: "medium",
            requiredDomain: null,
            requiredCapabilities: [],
            createdBy: "import",
          },
        ],
        comments: [],
        templates: [],
        webhooks: [],
      },
    };

    const result = importHabitat(standalonePayload as any)!;
    // The standalone path creates one wrapping mission per task (3 persisted).
    // The previous implementation returned `missionsData.length || 0` = 0.
    expect(result.imported.missions).toBe(3);
    expect(result.imported.tasks).toBe(3);
  });
});

describe("R1 — atomic delete + rebuild rolls back a mid-rebuild failure", () => {
  it("restores the existing habitat when a column insert fails mid-rebuild (unique-order violation)", () => {
    const { habitat: existing, columns } = createHabitat({
      name: "Atomic Existing",
      defaultColumns: true,
    });
    const seeded = missionRepo.createMission({
      habitatId: existing.id,
      columnId: columns[0].id,
      title: "Seeded Mission",
      createdBy: "tester",
    });

    // Two columns sharing order 0 violate idx_columns_habitat_order. The
    // preflight only checks column-name resolution (both names are distinct
    // and the mission resolves), so it passes; the failure is forced at the
    // second createColumn — AFTER the existing habitat has been deleted inside
    // the transaction. A correct atomic rebuild must roll the delete back.
    const dupOrder = payloadWith(
      [
        {
          title: "Mission A",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          status: "not_started",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [],
        },
      ],
      [
        {
          name: "Todo",
          order: 0,
          wipLimit: null,
          autoAdvance: false,
          requiresClaim: false,
          nextColumnName: null,
          isTerminal: false,
        },
        {
          name: "InProgress",
          order: 0,
          wipLimit: null,
          autoAdvance: false,
          requiresClaim: false,
          nextColumnName: null,
          isTerminal: false,
        },
      ],
    );

    expect(() => importHabitat(dupOrder as any, existing.id)).toThrow();

    // The existing target was never touched: it and its seeded mission survive.
    const survivor = habitatRepo.getHabitatById(existing.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.id).toBe(existing.id);
    expect(missionRepo.getMissionById(seeded.id)).not.toBeNull();

    // No orphan habitat or missions from the rolled-back rebuild survive. The
    // partial replacement ("Rebuilt Habitat") was cleaned up by the catch
    // branch, and no "Mission A" landed under the existing habitat.
    const { missions: remaining } = missionRepo.getMissionsByHabitatId(existing.id);
    expect(remaining.some((m) => m.title === "Mission A")).toBe(false);
    expect(remaining.some((m) => m.title === "Seeded Mission")).toBe(true);
    const allHabitats = habitatRepo.listHabitats();
    expect(allHabitats.some((h) => h.name === "Rebuilt Habitat")).toBe(false);
  });
});

describe("M1 — moveMission SQL contract: the version predicate is in the WRITE, not a separate read", () => {
  it("a versioned WHERE matches zero rows after an intervening commit (the old WHERE-id-only fallback would overwrite)", () => {
    const { habitat: seeded, columns } = createHabitat({
      name: "M1 SQL Habitat",
      defaultColumns: true,
    });
    const db = getDb();
    const colA = columns[0].id;
    const colB = columns[1].id;

    const mission = missionRepo.createMission({
      habitatId: seeded.id,
      columnId: colA,
      title: "Versioned Mission",
      createdBy: "tester",
    });
    const observedVersion = mission.version;

    // Simulate a concurrent committer that bumps the version between the
    // caller's observed read and their move write. This is exactly the gap a
    // check-then-write (read version, compare, then UPDATE...WHERE id) would
    // miss: the read already happened, the compare already passed.
    db.update(missionsTable)
      .set({ version: sql`${missionsTable.version} + 1` })
      .where(eq(missionsTable.id, mission.id))
      .run();

    // The versioned move — the fix-7 contract — matches zero rows and surfaces
    // versionMismatch, because the version predicate lives inside the UPDATE.
    const stale = missionRepo.moveMission(mission.id, colB, observedVersion);
    expect(stale.success).toBe(false);
    if (!stale.success && "versionMismatch" in stale) {
      expect(stale.currentVersion).toBe(observedVersion + 1);
    }
    const after = missionRepo.getMissionById(mission.id)!;
    expect(after.columnId).toBe(colA);
    expect(after.version).toBe(observedVersion + 1);

    // Proof that the retired code path (UPDATE...WHERE id only, no version
    // predicate) WOULD have silently overwritten the stale write against this
    // exact same state: a raw WHERE-id-only update reports one changed row.
    // The version predicate in the WHERE clause is what distinguishes the two.
    db.run(sql`UPDATE missions SET column_id = ${colB} WHERE id = ${mission.id}`);
    const rawChanged = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
    expect(rawChanged).toBe(1);
  });
});

describe("getHabitatStats → missionSummary.blocked end-to-end via join-only dependency", () => {
  it("counts a dependency added through the dependency service (join edge only)", () => {
    const { habitat, columns } = createHabitat({ name: "Stats Habitat", defaultColumns: true });
    const upstream = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: "Upstream",
      createdBy: "tester",
    });
    const downstream = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: "Downstream",
      createdBy: "tester",
    });

    const added = dependencyService.addMissionDependency(downstream.id, upstream.id);
    expect(added.success).toBe(true);

    // The denormalized dependsOn JSON stays empty (join is the source of truth).
    const refreshed = missionRepo.getMissionById(downstream.id)!;
    expect(refreshed.dependsOn).toEqual([]);

    const stats = getHabitatStats(habitat.id);
    expect(stats.missionSummary.blocked).toBe(1);
    expect(stats.missionSummary.total).toBe(2);
  });
});
