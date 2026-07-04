import type { AutomationScanType } from "@orcy/shared";
import type { ScanReport } from "./automationScanService.js";
import { applyGuards } from "./automationScanService.js";
import { executeAndRecordRuleRun } from "./automationExecutor.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as missionRepo from "../repositories/feature.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as triageService from "./triageService.js";
import { getDb } from "../db/index.js";
import { missionDependencies } from "../db/schema/index.js";
import { inArray, or } from "drizzle-orm";

/** Scan type this service emits. */
const SCAN_TYPE: AutomationScanType = "orphan_mission_unmapped";

/** Mission statuses that count as in-flight (worth mapping). `done`/`failed` are left alone. */
const ACTIVE_STATUSES = new Set(["not_started", "in_progress", "review"]);

/**
 * Periodic orphan-mission scan (RM-7). Finds missions disconnected from the roadmap
 * DAG (no `missionDependencies` edges in or out, active, not archived) and spawns a
 * triage investigation for each — the daemon agent then decides placement and
 * positions the orphan via `orcy_triage map_orphan_mission`. Positioning is the
 * agent's judgment, not a hardcoded heuristic.
 *
 * Re-firing is suppressed per-orphan via the `triage_cluster_missions` junction
 * (keyed `orphan-mission:{missionId}`); the junction resolves when the triage
 * mission completes. Scan errors are caught and surfaced as an error ScanReport —
 * they never crash the scheduler loop (mirrors `runSignalPatternClusteredScan`).
 */
export async function runOrphanMissionUnmappedScan(habitatId: string): Promise<ScanReport[]> {
  try {
    const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, SCAN_TYPE);

    // Active, non-archived missions in the habitat.
    const habitatMissions = missionRepo
      .getMissionsByHabitatId(habitatId, { limit: 1000 })
      .missions.filter((m) => !m.isArchived && ACTIVE_STATUSES.has(m.status));
    if (habitatMissions.length === 0) return [];

    const ids = habitatMissions.map((m) => m.id);

    // Every dependency edge touching any of these missions (either side).
    const edges = getDb()
      .select({
        missionId: missionDependencies.missionId,
        dependsOnId: missionDependencies.dependsOnId,
      })
      .from(missionDependencies)
      .where(
        or(
          inArray(missionDependencies.missionId, ids),
          inArray(missionDependencies.dependsOnId, ids),
        ),
      )
      .all();
    const connected = new Set<string>();
    for (const e of edges) {
      connected.add(e.missionId);
      connected.add(e.dependsOnId);
    }

    // Orphans = active missions with zero incident dependency edges.
    const orphans = habitatMissions.filter((m) => !connected.has(m.id));
    if (orphans.length === 0) return [];

    const errs: string[] = [];
    let matched = 0;
    let skipped = 0;

    for (const orphan of orphans) {
      const clusterKey = `orphan-mission:${orphan.id}`;

      // Active-triage suppression: skip orphans already under investigation.
      if (triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey)) continue;

      // Create the investigation BEFORE firing rules (mirrors ADR-0026): even with
      // zero rules the orphan needs mapping.
      try {
        triageService.createOrphanTriageMission(habitatId, orphan);
      } catch (err) {
        errs.push(
          `createOrphanTriageMission ${orphan.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const triggerEventId = `orphan:${orphan.id}`;
      const payload = { missionId: orphan.id, title: orphan.title, clusterKey };
      for (const rule of rules) {
        try {
          if (!applyGuards(rule, habitatId, SCAN_TYPE, triggerEventId, "mission", orphan.id)) {
            skipped++;
            continue;
          }
          await executeAndRecordRuleRun(
            rule,
            habitatId,
            SCAN_TYPE,
            triggerEventId,
            "mission",
            orphan.id,
            payload,
          );
          matched++;
        } catch (err) {
          errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return [
      {
        scanType: SCAN_TYPE,
        habitatId,
        rulesMatched: matched,
        rulesSkipped: skipped,
        errors: errs,
      },
    ];
  } catch (err) {
    return [
      {
        scanType: SCAN_TYPE,
        habitatId,
        rulesMatched: 0,
        rulesSkipped: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      },
    ];
  }
}
