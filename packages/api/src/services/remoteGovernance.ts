import { getHabitatById } from "../repositories/habitat.js";
import type { RemoteGovernanceSettings } from "../models/index.js";

/**
 * Parse `ORCY_REMOTE_GOVERNANCE_DEFAULT` as a boolean. Truthy variants
 * ("true", "1", "yes", "on") → `true`; everything else (including unset) → `false`.
 * Both flags share the same env default — the per-habitat JSON column is the
 * per-flag override.
 */
function envDefault(): boolean {
  const raw = process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT?.toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Resolves the **effective** remote-governance flags for a habitat.
 *
 * Two-layer resolution (mirrors the `automationSettings` kill-switch precedent):
 * each flag = `habitat?.remoteGovernanceSettings?.X ?? envDefault()`. The env
 * var `ORCY_REMOTE_GOVERNANCE_DEFAULT` supplies the fallback when the habitat
 * column is NULL or a flag is absent; it defaults to `false` (both flags OFF)
 * when unset.
 *
 * No production caller reads these flags yet — this helper is the seam that a
 * later ticket (the remote wrapper) will consume.
 */
export function getRemoteGovernanceSettings(habitatId: string): RemoteGovernanceSettings {
  const habitat = getHabitatById(habitatId);
  const fallback = envDefault();
  const stored = habitat?.remoteGovernanceSettings;
  return {
    applyInterceptorsToRemote: stored?.applyInterceptorsToRemote ?? fallback,
    enforceHostApprovedCapability: stored?.enforceHostApprovedCapability ?? fallback,
  };
}
