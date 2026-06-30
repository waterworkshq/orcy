import type { AutomationScanType, ClusterPayload } from "@orcy/shared";
import type { ScanReport } from "./automationScanService.js";
import { applyGuards } from "./automationScanService.js";
import { executeAndRecordRuleRun } from "./automationExecutor.js";
import { normalize } from "./habitatSkillService.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as triageService from "./triageService.js";
import type { Pulse } from "@orcy/shared";

/**
 * Default thresholds for cluster detection. Hardcoded for now; habitat-settings
 * wiring lands in Phase 7 (T7.5).
 */
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MIN_CLUSTER_SIZE = 3;

/** Scan types this service emits. */
const SCAN_TYPE: AutomationScanType = "signal_pattern_clustered";

/** signalType values that opt a pulse into cluster detection. */
const CLUSTERABLE_SIGNAL_TYPES = new Set(["experience", "finding", "detected"]);

/**
 * Periodic cluster-detection scan (ADR-0024, ADR-0025).
 *
 * Queries time-windowed pulses, groups by normalized subject across provenance
 * (experience / finding / detected), applies threshold + active-triage
 * suppression + proactive resolution lookup, and fires automation rules
 * per-cluster with a {@link ClusterPayload}. Scan errors are caught and
 * surfaced as an error ScanReport — they never crash the scheduler loop.
 */
export async function runSignalPatternClusteredScan(habitatId: string): Promise<ScanReport[]> {
  try {
    const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, SCAN_TYPE);

    const windowMs = DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const now = new Date();
    const since = new Date(now.getTime() - windowMs).toISOString();
    const pulses = pulseRepo.listByHabitatBetween(habitatId, since, now.toISOString());

    const clusterable = pulses.filter((p) => isClusterable(p));
    const groups = groupByClusterKey(clusterable);

    const errs: string[] = [];
    let matched = 0;
    let skipped = 0;

    for (const [clusterKey, group] of groups) {
      if (group.length < DEFAULT_MIN_CLUSTER_SIZE) continue;

      // Active-triage suppression: skip clusters already under investigation.
      const activeMission = triageClusterMissionsRepo.findActiveByClusterKey(habitatId, clusterKey);
      if (activeMission) continue;

      // Proactive lookup: attach historical resolution as suggestion context.
      const proactiveResolutions = triageResolutionsRepo.findByClusterKey(habitatId, clusterKey);

      const payload = buildClusterPayload(clusterKey, group, proactiveResolutions.length > 0);

      // Create the triage mission BEFORE firing rules (ADR-0026). Mission
      // creation is a direct service call, not an automation action, so the
      // logic lives in one place. Even with zero rules the cluster crossed
      // threshold — it needs investigation.
      try {
        triageService.createTriageMission(habitatId, payload);
      } catch (err) {
        errs.push(
          `createTriageMission ${clusterKey}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const triggerEventId = `cluster:${clusterKey}:${habitatId}`;
      for (const rule of rules) {
        try {
          if (!applyGuards(rule, habitatId, SCAN_TYPE)) {
            skipped++;
            continue;
          }
          await executeAndRecordRuleRun(
            rule,
            habitatId,
            SCAN_TYPE,
            triggerEventId,
            "habitat",
            habitatId,
            payload as unknown as Record<string, unknown>,
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

/** A pulse opts into clustering if its signalType is clusterable, it is not
 *  triage-generated output, and (for findings) it carries a structured
 *  findingKind. Free-form findings are excluded per ADR-0025. */
function isClusterable(pulse: Pulse): boolean {
  if (!CLUSTERABLE_SIGNAL_TYPES.has(pulse.signalType)) return false;
  if (pulse.metadata?.triageGenerated === true) return false;
  if (pulse.signalType === "finding") {
    return typeof pulse.metadata?.findingKind === "string";
  }
  return true;
}

function groupByClusterKey(pulses: Pulse[]): Map<string, Pulse[]> {
  const groups = new Map<string, Pulse[]>();
  for (const pulse of pulses) {
    const key = normalize(pulse.subject);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(pulse);
    else groups.set(key, [pulse]);
  }
  return groups;
}

function buildClusterPayload(
  clusterKey: string,
  group: Pulse[],
  hasProactiveResolution: boolean,
): ClusterPayload {
  const provenanceBreakdown: Record<string, number> = {};
  const taskIds = new Set<string>();
  const missionIds = new Set<string>();
  const agentIds = new Set<string>();
  let firstSeenAt = group[0].createdAt;
  let lastSeenAt = group[0].createdAt;

  for (const pulse of group) {
    provenanceBreakdown[pulse.signalType] = (provenanceBreakdown[pulse.signalType] ?? 0) + 1;
    if (pulse.taskId) taskIds.add(pulse.taskId);
    if (pulse.missionId) missionIds.add(pulse.missionId);
    agentIds.add(pulse.fromId);
    if (pulse.createdAt < firstSeenAt) firstSeenAt = pulse.createdAt;
    if (pulse.createdAt > lastSeenAt) lastSeenAt = pulse.createdAt;
  }

  // skillCategory = primary (most-common) signalType in the breakdown.
  let skillCategory = clusterKey;
  let maxCount = -1;
  for (const [cat, count] of Object.entries(provenanceBreakdown)) {
    if (count > maxCount) {
      maxCount = count;
      skillCategory = cat;
    }
  }

  // hasProactiveResolution is intentionally unused in the payload shape today;
  // surfaced for the Phase 4 service to embed as suggestion context. Kept in
  // signature so the scan is the single source of truth for proactive hits.
  void hasProactiveResolution;

  return {
    clusterKey,
    skillCategory,
    provenanceBreakdown,
    signalCount: group.length,
    affectedTaskIds: [...taskIds],
    affectedMissionIds: [...missionIds],
    agentIds: [...agentIds],
    crossMissionCount: missionIds.size,
    distinctAgentCount: agentIds.size,
    timeWindowDays: DEFAULT_WINDOW_DAYS,
    firstSeenAt,
    lastSeenAt,
  };
}
