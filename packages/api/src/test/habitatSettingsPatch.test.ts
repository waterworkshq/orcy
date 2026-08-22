import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import {
  detectStaleInProgress,
  getAnomalySettings,
  getDefaultAnomalySettings,
} from "../services/anomalyService.js";
import { getDefaultAutoAssignSettings } from "../services/autoAssignService.js";
import { exportHabitatManifest } from "../services/habitatManifestExporter.js";
import { getHabitat, listHabitats, updateHabitat } from "../services/habitatService.js";
import {
  DEFAULT_RELEASE_SETTINGS,
  DEFAULT_ROADMAP_SETTINGS,
  DEFAULT_TRIAGE_SETTINGS,
} from "@orcy/shared";

/** Creates a habitat whose settings columns are all NULL (the null-blob case). */
function freshNullBlobHabitat(): string {
  return habitatRepo.createHabitat({ name: "Null Blob Habitat" }).id;
}

beforeEach(async () => {
  await initTestDb();
  getDb().delete(habitats).run();
});

afterEach(() => {
  closeDb();
});

describe("partial settings PATCH on a null-blob habitat", () => {
  it("persists complete anomalySettings (thresholds and notifications intact)", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { anomalySettings: { enabled: false } });

    const blob = habitatRepo.getHabitatById(habitatId)!.anomalySettings;
    expect(blob).toMatchObject({ enabled: false });
    expect(blob?.thresholds).toEqual(getDefaultAnomalySettings().thresholds);
    expect(blob?.notifications).toEqual(getDefaultAnomalySettings().notifications);
  });

  it("keeps the stale-in-progress detector from crashing after the first-ever anomaly PATCH", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { anomalySettings: { enabled: true } });

    expect(() => detectStaleInProgress(habitatId, getAnomalySettings(habitatId))).not.toThrow();
  });

  it("merges a partial nested thresholds PATCH over sibling threshold fields", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { anomalySettings: { thresholds: { staleInProgressMinutes: 30 } } });

    const blob = habitatRepo.getHabitatById(habitatId)!.anomalySettings;
    expect(blob?.thresholds).toEqual({
      ...getDefaultAnomalySettings().thresholds,
      staleInProgressMinutes: 30,
    });
  });

  it("resolves per-field defaults for legacy partial anomaly blobs (read-side heal)", () => {
    const habitatId = freshNullBlobHabitat();
    // Simulate a row written before the merge fix: non-null blob, no thresholds.
    // (The repo type now expects complete blobs, so the partial needs a cast.)
    habitatRepo.updateHabitat(habitatId, {
      anomalySettings: {
        enabled: true,
      } as unknown as ReturnType<typeof getDefaultAnomalySettings>,
    });

    expect(getAnomalySettings(habitatId).thresholds).toEqual(
      getDefaultAnomalySettings().thresholds,
    );
  });

  it("class-guard: persists a complete object for every settings blob with canonical defaults", () => {
    const cases = [
      ["anomalySettings", { enabled: false }, getDefaultAnomalySettings()],
      ["triageSettings", { minClusterSize: 5 }, { ...DEFAULT_TRIAGE_SETTINGS }],
      ["releaseSettings", { autoPromote: false }, { ...DEFAULT_RELEASE_SETTINGS }],
      ["roadmapSettings", { mode: "feature" }, { ...DEFAULT_ROADMAP_SETTINGS }],
      ["autoAssignSettings", { enabled: true }, getDefaultAutoAssignSettings()],
      ["codeReviewSettings", { taskPattern: "ORC-" }, { autoApproveOnMerge: false }],
    ] as const;

    for (const [key, patch, defaults] of cases) {
      const habitatId = freshNullBlobHabitat();
      updateHabitat(habitatId, { [key]: patch });

      const blob = (habitatRepo.getHabitatById(habitatId) as unknown as Record<
        string,
        Record<string, unknown>
      >)[key];
      for (const defaultKey of Object.keys(defaults)) {
        expect(
          blob[defaultKey],
          `${key}.${defaultKey} must survive a first partial PATCH`,
        ).toBeDefined();
      }
      expect(blob).toMatchObject(patch);
    }
  });

  it("returns and stores the complete releaseSettings shape (raw-consumer contract)", () => {
    const habitatId = freshNullBlobHabitat();
    const updated = updateHabitat(habitatId, { releaseSettings: { autoPromote: false } })!;

    const expected = { ...DEFAULT_RELEASE_SETTINGS, autoPromote: false };
    expect(updated.releaseSettings).toEqual(expected);
    expect(habitatRepo.getHabitatById(habitatId)!.releaseSettings).toEqual(expected);
  });

  it("returns and stores the complete roadmapSettings shape (raw-consumer contract)", () => {
    const habitatId = freshNullBlobHabitat();
    const updated = updateHabitat(habitatId, { roadmapSettings: { mode: "feature" } })!;

    const expected = { ...DEFAULT_ROADMAP_SETTINGS, mode: "feature" };
    expect(updated.roadmapSettings).toEqual(expected);
    expect(habitatRepo.getHabitatById(habitatId)!.roadmapSettings).toEqual(expected);
  });

  it("returns and stores the complete autoAssignSettings shape (raw-consumer contract)", () => {
    const habitatId = freshNullBlobHabitat();
    const updated = updateHabitat(habitatId, { autoAssignSettings: { enabled: true } })!;

    const expected = { ...getDefaultAutoAssignSettings(), enabled: true };
    expect(updated.autoAssignSettings).toEqual(expected);
    expect(habitatRepo.getHabitatById(habitatId)!.autoAssignSettings).toEqual(expected);
  });

  it("exports the complete releaseSettings shape in the habitat manifest", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { releaseSettings: { autoPromote: false } });

    const manifest = exportHabitatManifest(habitatId);
    expect(manifest!.domains.habitatSettings!.data.settings.releaseSettings).toEqual({
      ...DEFAULT_RELEASE_SETTINGS,
      autoPromote: false,
    });
  });

  it("still clears a settings blob when the PATCH explicitly sends null", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { releaseSettings: { autoPromote: false } });
    updateHabitat(habitatId, { releaseSettings: null });

    expect(habitatRepo.getHabitatById(habitatId)!.releaseSettings).toBeNull();
  });
});

describe("legacy partial blobs are normalized at every raw boundary", () => {
  // Rows written before the updateHabitat merge fix could persist partial blobs
  // verbatim; every public read surface must heal them with canonical defaults
  // (mirroring the per-service read resolvers) without a re-PATCH.
  const LEGACY_CASES = [
    ["releaseSettings", { autoPromote: false }, { ...DEFAULT_RELEASE_SETTINGS, autoPromote: false }],
    ["roadmapSettings", { mode: "feature" }, { ...DEFAULT_ROADMAP_SETTINGS, mode: "feature" }],
    ["autoAssignSettings", { enabled: true }, { ...getDefaultAutoAssignSettings(), enabled: true }],
    ["triageSettings", { minClusterSize: 5 }, { ...DEFAULT_TRIAGE_SETTINGS, minClusterSize: 5 }],
    ["anomalySettings", { enabled: true }, { ...getDefaultAnomalySettings(), enabled: true }],
  ] as const;

  it.each(LEGACY_CASES)(
    "%s: GET/list/PATCH responses and manifest export serve the complete shape",
    (key, partial, expected) => {
      const habitatId = freshNullBlobHabitat();
      habitatRepo.updateHabitat(habitatId, {
        [key]: partial,
      } as unknown as Parameters<typeof habitatRepo.updateHabitat>[1]);

      expect(getHabitat(habitatId)!.habitat).toMatchObject({ [key]: expected });
      expect(listHabitats()).toMatchObject([{ id: habitatId, [key]: expected }]);
      expect(updateHabitat(habitatId, { name: "Renamed" })).toMatchObject({
        [key]: expected,
      });
      const manifest = exportHabitatManifest(habitatId);
      expect(manifest!.domains.habitatSettings!.data.settings).toMatchObject({
        [key]: expected,
      });
    },
  );

  it("anomalySettings: legacy partial heals NESTED thresholds and notifications", () => {
    const habitatId = freshNullBlobHabitat();
    habitatRepo.updateHabitat(
      habitatId,
      {
        anomalySettings: { enabled: true, thresholds: { staleInProgressMinutes: 30 } },
      } as unknown as Parameters<typeof habitatRepo.updateHabitat>[1],
    );

    const healed = getHabitat(habitatId)!.habitat.anomalySettings!;
    expect(healed.thresholds).toEqual({
      ...getDefaultAnomalySettings().thresholds,
      staleInProgressMinutes: 30,
    });
    expect(healed.notifications).toEqual(getDefaultAnomalySettings().notifications);
  });

  it("codeReviewSettings: legacy taskPattern-only blob serves the complete masked shape", () => {
    const habitatId = freshNullBlobHabitat();
    habitatRepo.updateHabitat(
      habitatId,
      {
        codeReviewSettings: { taskPattern: "ORC-" },
      } as unknown as Parameters<typeof habitatRepo.updateHabitat>[1],
    );

    expect(getHabitat(habitatId)!.habitat.codeReviewSettings).toEqual({
      hasGithubSecret: false,
      hasGitlabSecret: false,
      taskPattern: "ORC-",
      autoApproveOnMerge: false,
    });
  });

  it("null blobs stay null (no default materialization on reads)", () => {
    const habitatId = freshNullBlobHabitat();
    expect(getHabitat(habitatId)!.habitat.releaseSettings).toBeNull();
  });
});
