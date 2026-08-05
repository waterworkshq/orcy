import { getHabitatById } from "../repositories/habitat.js";
import type { RemoteGovernanceSettings } from "../models/index.js";

/**
 * Parse `ORCY_REMOTE_GOVERNANCE_DEFAULT` as a boolean. When unset (or empty
 * string) → `true` (DEFAULT ON); truthy variants ("true", "1", "yes", "on") →
 * `true`; everything else ("false", "0", "off", "no", …) → `false`. Both flags
 * share the same env default — the per-habitat JSON column is the per-flag
 * override.
 */
function envDefault(): boolean {
  const raw = process.env.ORCY_REMOTE_GOVERNANCE_DEFAULT?.toLowerCase();
  if (raw === undefined || raw === "") return true; // DEFAULT ON when unset
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/**
 * Resolves the **effective** remote-governance flags for a habitat.
 *
 * Two-layer resolution (mirrors the `automationSettings` kill-switch precedent):
 * each flag = `habitat?.remoteGovernanceSettings?.X ?? envDefault()`. The env
 * var `ORCY_REMOTE_GOVERNANCE_DEFAULT` supplies the fallback when the habitat
 * column is NULL or a flag is absent; it defaults to `true` (both flags ON)
 * when unset — the remote wrappers (`claimTaskForRemote`,
 * `submitTaskForRemote`) consume these flags to gate remote governance (D1
 * interceptor application and D2 Host-Approved Capability enforcement).
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
