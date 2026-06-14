import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow, RemoteGrantTargetRow } from "../repositories/remoteGrant.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";

/**
 * Result of a grant visibility check.
 */
export interface GrantVisibilityResult {
  visible: boolean;
  matchedGrant?: RemoteGrantRow;
  reason?: string;
}

/**
 * Check if a remote participant can see a given target. The target is a
 * specific task, mission, or other entity. Visibility is determined by:
 *
 * 1. Allowlist: any active grant with an explicit target matching the entity
 * 2. Rule-based: any active rule_based grant whose snapshot contains the task,
 *    or whose rule matches the task's metadata (handled by the caller)
 * 3. Pod-wide baseline: any active baseline_observer grant without a
 *    specific participant (covers the whole pod)
 */
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

      // Mission-level rule_based: check if rule.domains matches
      if (targetType === "mission" && rule.domains && rule.domains.length > 0) {
        // Rule-based mission match is caller-provided metadata check
        // For now, allow any rule with domains to match missions in the habitat
        return { visible: true, matchedGrant: grant };
      }

      // For habitat-level scope, a rule_based grant with empty rule matches all
      if (targetType === "habitat" && (!rule.domains || rule.domains.length === 0)) {
        return { visible: true, matchedGrant: grant };
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
