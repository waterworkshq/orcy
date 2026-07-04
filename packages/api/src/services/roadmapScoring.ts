import { getDb } from "../db/index.js";
import { taskDependencies, missions, missionDependencies } from "../db/schema/index.js";
import { eq, inArray } from "drizzle-orm";
import * as missionRepo from "../repositories/feature.js";
import * as releaseRepo from "../repositories/release.js";
import {
  isReleaseGateSatisfied,
  type ReleaseType,
  type RoadmapScoringAlgorithm,
} from "@orcy/shared";
import type { Task } from "../models/index.js";
import { resolveRoadmapSettings } from "./roadmapSettingsService.js";

const BONUS_WEIGHT = 5;
const MAX_BONUS = 25;
/** release_proximity: how recent a gate-resolving release must be to boost (days). */
const PROXIMITY_WINDOW_DAYS = 7;

/** A strategy's per-task contribution: the bonus added to the score + the agent-facing reason. */
export interface StrategyBonusEntry {
  bonus: number;
  reason: string;
}

/** Input to a scoring strategy, batched once per suggestion pass. */
export interface ScoringContext {
  habitatId: string;
  candidateTasks: Task[];
}

/** A roadmap-position scoring algorithm. Builds a bonus map in one pass (not per task). */
export interface RoadmapScoringStrategy {
  buildBonusMap(ctx: ScoringContext): Map<string, StrategyBonusEntry>;
}

function capBonus(raw: number): number {
  return Math.min(raw, MAX_BONUS);
}

/** fanout (v0.25.0 default): boost tasks that unblock many direct dependents. */
const fanoutStrategy: RoadmapScoringStrategy = {
  buildBonusMap({ candidateTasks }) {
    const map = new Map<string, StrategyBonusEntry>();
    if (candidateTasks.length === 0) return map;
    const ids = candidateTasks.map((t) => t.id);
    const rows = getDb()
      .select({ dependsOnId: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .where(inArray(taskDependencies.dependsOnId, ids))
      .all();
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.dependsOnId, (counts.get(r.dependsOnId) ?? 0) + 1);
    for (const t of candidateTasks) {
      const c = counts.get(t.id) ?? 0;
      if (c > 0) {
        map.set(t.id, {
          bonus: capBonus(BONUS_WEIGHT * c),
          reason: `Unblocks ${c} downstream task${c > 1 ? "s" : ""}`,
        });
      }
    }
    return map;
  },
};

/**
 * depth_from_root: boost foundational work (missions near the DAG roots). Depth is
 * computed over missionDependencies (roots = missions with no dependsOn). Lower depth → higher bonus.
 */
const depthFromRootStrategy: RoadmapScoringStrategy = {
  buildBonusMap({ habitatId, candidateTasks }) {
    const map = new Map<string, StrategyBonusEntry>();
    if (candidateTasks.length === 0) return map;
    const edges = getDb()
      .select({
        missionId: missionDependencies.missionId,
        dependsOnId: missionDependencies.dependsOnId,
      })
      .from(missionDependencies)
      .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
      .where(eq(missions.habitatId, habitatId))
      .all();
    // dependsOn adjacency: missionId → dependsOnId[]; reverse: dependsOnId → missionId[]
    const dependsOn = new Map<string, string[]>();
    const allMissions = new Set<string>();
    for (const e of edges) {
      allMissions.add(e.missionId);
      allMissions.add(e.dependsOnId);
      const list = dependsOn.get(e.missionId) ?? [];
      list.push(e.dependsOnId);
      dependsOn.set(e.missionId, list);
    }
    // BFS from roots (missions with no dependsOn). Depth 0 = root.
    const depth = new Map<string, number>();
    const roots: string[] = [];
    for (const m of allMissions)
      if (!dependsOn.has(m) || dependsOn.get(m)!.length === 0) roots.push(m);
    // Also treat any candidate mission not in the edge set as a root (depth 0).
    for (const t of candidateTasks) if (!allMissions.has(t.missionId)) roots.push(t.missionId);
    let queue = roots;
    let d = 0;
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next: string[] = [];
      for (const m of queue) {
        if (seen.has(m)) continue;
        seen.add(m);
        depth.set(m, d);
      }
      // missions that depend on any mission at depth d are at depth d+1
      for (const e of edges) {
        if (depth.get(e.dependsOnId) === d && !seen.has(e.missionId)) next.push(e.missionId);
      }
      queue = next;
      d++;
    }
    for (const t of candidateTasks) {
      const md = depth.get(t.missionId) ?? 0;
      const bonus = capBonus(MAX_BONUS - md * BONUS_WEIGHT);
      if (bonus > 0) {
        map.set(t.id, {
          bonus,
          reason: `Foundational mission (depth ${md} from root)`,
        });
      }
    }
    return map;
  },
};

/**
 * release_proximity: boost tasks whose mission's release-gate was satisfied by a
 * recent release — i.e. freshly-unblocked work gets priority. Scales by recency.
 */
const releaseProximityStrategy: RoadmapScoringStrategy = {
  buildBonusMap({ habitatId, candidateTasks }) {
    const map = new Map<string, StrategyBonusEntry>();
    if (candidateTasks.length === 0) return map;
    const recent = releaseRepo.findRecentByHabitat(habitatId, 5);
    if (recent.length === 0) return map;
    const now = Date.now();
    const windowMs = PROXIMITY_WINDOW_DAYS * 86_400_000;
    const shippedTypes = new Set(recent.map((r) => r.releaseType as ReleaseType));
    const shippedVersions = recent.map((r) => r.version);
    for (const t of candidateTasks) {
      const mission = missionRepo.getMissionById(t.missionId);
      if (!mission || (!mission.releaseGateType && !mission.releaseGateVersion)) continue;
      if (!isReleaseGateSatisfied(mission, shippedTypes, shippedVersions)) continue;
      // Most recent release that resolves the gate → recency factor.
      const resolver = recent
        .filter((r) =>
          isReleaseGateSatisfied(mission, new Set([r.releaseType as ReleaseType]), [r.version]),
        )
        .map((r) => new Date(r.detectedAt).getTime())
        .sort((a, b) => b - a)[0];
      if (resolver === undefined) continue;
      const ageMs = now - resolver;
      if (ageMs > windowMs) continue;
      const recencyFactor = Math.max(0, 1 - ageMs / windowMs);
      const bonus = capBonus(Math.round(MAX_BONUS * recencyFactor));
      if (bonus > 0) map.set(t.id, { bonus, reason: "Gate just resolved by recent release" });
    }
    return map;
  },
};

/**
 * goal_directed (RM-15): boost tasks on the prerequisite chain of the focus goal.
 * The focus is `roadmapSettings.focusMissionId` (explicit, set by an orcy) or, when
 * unset, self-derived as the active mission with the most direct dependents (the one
 * blocking the most downstream work). The boost is SOFT — it never gates claiming —
 * and scales by proximity (shortest hop count from the task's mission to the goal).
 */
const ACTIVE_FOR_GOAL = new Set(["not_started", "in_progress", "review"]);
function pushEdge(map: Map<string, string[]>, key: string, val: string): void {
  const a = map.get(key);
  if (a) a.push(val);
  else map.set(key, [val]);
}

const goalDirectedStrategy: RoadmapScoringStrategy = {
  buildBonusMap({ habitatId, candidateTasks }) {
    const map = new Map<string, StrategyBonusEntry>();
    if (candidateTasks.length === 0) return map;

    // Mission-dependency edges within the habitat (missionId depends on dependsOnId).
    const edges = getDb()
      .select({
        missionId: missionDependencies.missionId,
        dependsOnId: missionDependencies.dependsOnId,
      })
      .from(missionDependencies)
      .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
      .where(eq(missions.habitatId, habitatId))
      .all();
    const dependents = new Map<string, string[]>(); // dependsOnId -> missions that depend on it (fan-out)
    const prerequisites = new Map<string, string[]>(); // missionId -> its dependsOn (prereq closure)
    for (const e of edges) {
      pushEdge(dependents, e.dependsOnId, e.missionId);
      pushEdge(prerequisites, e.missionId, e.dependsOnId);
    }

    // Resolve the focus goal: explicit setting (validated) or self-derived highest fan-out.
    const settings = resolveRoadmapSettings(habitatId);
    let goalId: string | null = settings.focusMissionId;
    if (goalId) {
      const m = missionRepo.getMissionById(goalId);
      if (!m || m.habitatId !== habitatId || !ACTIVE_FOR_GOAL.has(m.status)) goalId = null;
    }
    if (!goalId) {
      const active = missionRepo
        .getMissionsByHabitatId(habitatId, { limit: 1000 })
        .missions.filter((m) => !m.isArchived && ACTIVE_FOR_GOAL.has(m.status));
      let best: string | null = null;
      let bestFanout = 0;
      for (const m of active) {
        const fan = dependents.get(m.id)?.length ?? 0;
        if (fan > bestFanout) {
          bestFanout = fan;
          best = m.id;
        }
      }
      goalId = best;
    }
    if (!goalId) return map;

    // BFS the goal's transitive prerequisites; depth = shortest hop count from the goal.
    const depth = new Map<string, number>([[goalId, 0]]);
    const queue: string[] = [goalId];
    let head = 0;
    while (head < queue.length) {
      const id = queue[head++];
      const d = depth.get(id)!;
      for (const p of prerequisites.get(id) ?? []) {
        if (!depth.has(p)) {
          depth.set(p, d + 1);
          queue.push(p);
        }
      }
    }

    // Soft-boost candidate tasks whose mission is in the closure (incl. the goal itself).
    for (const t of candidateTasks) {
      const d = depth.get(t.missionId);
      if (d === undefined) continue;
      const bonus = capBonus(MAX_BONUS - d * BONUS_WEIGHT);
      if (bonus > 0) {
        map.set(t.id, {
          bonus,
          reason:
            d === 0
              ? "Focus goal"
              : `Advances focus goal (${d} prerequisite hop${d > 1 ? "s" : ""} away)`,
        });
      }
    }
    return map;
  },
};

/**
 * Registry of selectable algorithms. `fanout` is the default (v0.25.0 behavior).
 */
export const SCORING_STRATEGIES: Record<RoadmapScoringAlgorithm, RoadmapScoringStrategy> = {
  fanout: fanoutStrategy,
  depth_from_root: depthFromRootStrategy,
  release_proximity: releaseProximityStrategy,
  goal_directed: goalDirectedStrategy,
};
