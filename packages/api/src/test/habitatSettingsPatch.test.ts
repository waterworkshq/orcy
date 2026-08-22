import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import {
  detectStaleInProgress,
  getAnomalySettings,
  getDefaultAnomalySettings,
} from "../services/anomalyService.js";
import { exportHabitatManifest } from "../services/habitatManifestExporter.js";
import { updateHabitat } from "../services/habitatService.js";
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

  it("still clears a settings blob when the PATCH explicitly sends null", () => {
    const habitatId = freshNullBlobHabitat();
    updateHabitat(habitatId, { releaseSettings: { autoPromote: false } });
    updateHabitat(habitatId, { releaseSettings: null });

    expect(habitatRepo.getHabitatById(habitatId)!.releaseSettings).toBeNull();
  });
});
