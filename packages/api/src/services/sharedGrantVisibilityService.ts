import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow, RemoteGrantTargetRow } from "../repositories/remoteGrant.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import { isEffectivelyActive } from "./remoteGrantTime.js";

/**
 * Result of a grant visibility check.
 */
export interface GrantVisibilityResult {
  visible: boolean;
  matchedGrant?: RemoteGrantRow;
  reason?: string;
}

/**
 * Optional inputs for callers that must not evaluate the transport snapshot —
 * a per-event stream refresh re-reads current grants and passes one captured
 * clock value for the whole decision.
 */
export interface TargetVisibilityOptions {
  /** Grants to evaluate. Defaults to the context's transport snapshot. */
  grants?: RemoteGrantRow[];
  /** Epoch milliseconds. Defaults to a single clock value captured for this decision. */
  now?: number;
}

/**
 * Check if a remote participant can see a given target. The target is a
 * specific task, mission, or other entity.
 *
 * Visibility is determined by:
 *
 * 1. Allowlist: any EFFECTIVELY ACTIVE grant with an explicit target matching
 *    the entity
 * 2. Rule-based: any effectively active rule_based grant whose snapshot
 *    contains the task, or whose rule matches the task's metadata (handled by
 *    the caller)
 * 3. Pod-wide baseline: any effectively active baseline_observer grant without
 *    a specific participant (covers the whole pod)
 *
 * Only a grant that is active AT THE DECISION contributes. A persisted
 * `status` of `active` whose configured deadline has passed contributes
 * nothing, and a grace-state grant never contributes visibility — grace covers
 * the three continuation actions only. Every existing predicate below the
 * effective-time gate is unchanged, and the three are independent: a baseline
 * grant still cannot be read from without separate read authority, and Mission
 * visibility is never inferred for a child Task.
 */
export function isTargetVisibleToParticipant(
  ctx: RemoteParticipantContext,
  targetType: "task" | "mission" | "habitat" | "label" | "domain" | "column",
  targetId: string,
  options?: TargetVisibilityOptions,
): GrantVisibilityResult {
  const grants = options?.grants ?? ctx.grants;
  const now = options?.now ?? Date.now();

  for (const grant of grants) {
    if (!isEffectivelyActive(grant, now)) continue;

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
    reason: "No effectively active grant covers this target",
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
