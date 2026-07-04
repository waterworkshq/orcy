import { getHabitatById } from "../repositories/board.js";
import { DEFAULT_ROADMAP_SETTINGS, type RoadmapSettings } from "@orcy/shared";

/**
 * Resolves the effective roadmap scoring settings for a habitat, merging stored
 * JSON over defaults (mirrors `resolveReleaseSettings`). A NULL `roadmap_settings`
 * column yields `DEFAULT_ROADMAP_SETTINGS` — backward-compat for existing habitats
 * (default algorithm: `fanout`, the v0.25.0 behavior).
 */
export function resolveRoadmapSettings(habitatId: string): RoadmapSettings {
  const habitat = getHabitatById(habitatId);
  if (!habitat || !habitat.roadmapSettings) return { ...DEFAULT_ROADMAP_SETTINGS };
  return {
    scoringAlgorithm:
      habitat.roadmapSettings.scoringAlgorithm ?? DEFAULT_ROADMAP_SETTINGS.scoringAlgorithm,
    mode: habitat.roadmapSettings.mode ?? DEFAULT_ROADMAP_SETTINGS.mode,
    focusMissionId:
      habitat.roadmapSettings.focusMissionId ?? DEFAULT_ROADMAP_SETTINGS.focusMissionId,
  };
}
