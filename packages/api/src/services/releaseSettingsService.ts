import { getHabitatById } from "../repositories/board.js";
import { DEFAULT_RELEASE_SETTINGS, type ReleaseSettings } from "@orcy/shared";

/**
 * Resolves the effective release settings for a habitat, merging stored JSON
 * over defaults (mirrors the triage `resolveThresholds` pattern). A NULL
 * `release_settings` column yields `DEFAULT_RELEASE_SETTINGS` — backward-compat
 * for existing habitats.
 */
export function resolveReleaseSettings(habitatId: string): ReleaseSettings {
  const habitat = getHabitatById(habitatId);
  if (!habitat || !habitat.releaseSettings) return { ...DEFAULT_RELEASE_SETTINGS };
  return {
    autoPromote: habitat.releaseSettings.autoPromote ?? DEFAULT_RELEASE_SETTINGS.autoPromote,
    releaseWorkflowName:
      habitat.releaseSettings.releaseWorkflowName ?? DEFAULT_RELEASE_SETTINGS.releaseWorkflowName,
    requireVersionTag:
      habitat.releaseSettings.requireVersionTag ?? DEFAULT_RELEASE_SETTINGS.requireVersionTag,
  };
}

/**
 * Two-layer kill switch for the auto-promotion loop (ADR-0031): the global env
 * `ORCY_RELEASE_AUTO_PROMOTE` (default true) AND the habitat-level
 * `releaseSettings.autoPromote` (default true). Both must be true for the
 * promotion loop. Detection, recording, retrospective pulse, and the
 * `release.shipped` event fire regardless (PRD AC-ACTIVATE-8).
 */
export function isAutoPromoteEnabled(habitatId: string): boolean {
  if (process.env.ORCY_RELEASE_AUTO_PROMOTE === "false") return false;
  return resolveReleaseSettings(habitatId).autoPromote;
}
