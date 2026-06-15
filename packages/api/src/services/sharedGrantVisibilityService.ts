import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow, RemoteGrantTargetRow } from "../repositories/remoteGrant.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";

/** Outcome of a grant visibility check, carrying the matched grant when visible and a human-readable reason when not. */
export interface GrantVisibilityResult {
  visible: boolean;
  matchedGrant?: RemoteGrantRow;
  reason?: string;
}

/** Determines whether a remote participant may view a specific task, mission, or other target by evaluating pod-wide baseline, allowlist, and rule-based grants. */
export function isTargetVisibleToParticipant(
  ctx: RemoteParticipantContext,
  targetType: "task" | "mission" | "habitat" | "label" | "domain" | "column",
  targetId: string,
): GrantVisibilityResult {
  const activeGrants = ctx.grants.filter((g) => g.status === "active");

  for (const grant of activeGrants) {
    if (grant.grantType === "baseline_observer" && grant.remoteParticipantId === null) {
      // Pod-wide baseline observer — sees everything in the habitat
      return { visible: true, matchedGrant: grant };
    }

    if (grant.eligibilityMode === "allowlist") {
      const targets = grantRepo.getRemoteGrantTargets(grant.id);
      if (targetsMatch(targets, targetType, targetId)) {
        return { visible: true, matchedGrant: grant };
      }
    } else if (grant.eligibilityMode === "rule_based") {
      const rule = grantRepo.getRemoteGrantRule(grant.id);
      if (!rule) continue;

      // For rule_based, visibility on a task requires it to be in the
      // snapshot (default) — future matching is gated by includeFutureMatches
      if (targetType === "task") {
        if (grantRepo.isTaskInGrantSnapshot(grant.id, targetId)) {
          return { visible: true, matchedGrant: grant };
        }
      }
    }
  }

  return {
    visible: false,
    reason: "No active grant covers this target",
  };
}

function targetsMatch(
  targets: RemoteGrantTargetRow[],
  targetType: "task" | "mission" | "habitat" | "label" | "domain" | "column",
  targetId: string,
): boolean {
  return targets.some((t) => {
    if (t.targetType !== targetType) return false;
    if (targetType === "habitat") return t.targetId === targetId;
    return t.targetId === targetId;
  });
}

/**
 * Return all grants (active, frozen, expired, revoked) for the current
 * remote participant — for the trust metadata route.
 */
export function listMyGrants(ctx: RemoteParticipantContext): RemoteGrantRow[] {
  return ctx.grants.map((g) => g);
}
