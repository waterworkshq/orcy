import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as missionRepo from "../repositories/mission.js";
import { buildFingerprint } from "@orcy/shared";
import type { AutomationScanType, AutomationRule } from "@orcy/shared";
import { executeAndRecordRuleRun } from "./automationExecutor.js";
import { runSignalPatternClusteredScan } from "./triageScanService.js";
import { runAgentQualityDegradedScan } from "./agentQualityScanService.js";
import { runOrphanMissionUnmappedScan } from "./orphanScanService.js";

/** Result summary of one automation scan pass over a habitat's automation rules. */
export interface ScanReport {
  scanType: AutomationScanType;
  habitatId: string;
  rulesMatched: number;
  rulesSkipped: number;
  errors: string[];
}

/** Runs every automation scan type across all habitats, starting and recording rule runs as matches fire. Returns a {@link ScanReport} per habitat-scan that matched any rules. */
export async function runAllScans(): Promise<ScanReport[]> {
  const reports: ScanReport[] = [];
  const habitats = habitatRepo.listHabitats();
  for (const h of habitats) {
    reports.push(...(await runMissionBlockedScan(h.id)));
    reports.push(...(await runSprintEndingScan(h.id)));
    reports.push(...(await runAgentSilentScan(h.id)));
    reports.push(...(await runEvidenceGapScan(h.id)));
    reports.push(...(await runSignalPatternClusteredScan(h.id)));
    reports.push(...(await runAgentQualityDegradedScan(h.id)));
    reports.push(...(await runOrphanMissionUnmappedScan(h.id)));
  }
  return reports;
}

async function runMissionBlockedScan(habitatId: string): Promise<ScanReport[]> {
  const errs: string[] = [];
  let matched = 0;
  let skipped = 0;
  const scanType: AutomationScanType = "mission_blocked";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  if (rules.length === 0) return [];
  for (const rule of rules) {
    try {
      if (!applyGuards(rule, habitatId, scanType)) {
        skipped++;
        continue;
      }
      await executeAndRecordRuleRun(
        rule,
        habitatId,
        scanType,
        `scan:${scanType}:${habitatId}`,
        "habitat",
        habitatId,
      );
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

async function runSprintEndingScan(habitatId: string): Promise<ScanReport[]> {
  const errs: string[] = [];
  let matched = 0;
  let skipped = 0;
  const scanType: AutomationScanType = "sprint_ending";
  const sprints = sprintRepo.getByHabitatId(habitatId);
  const active = sprints.find((s) => s.status === "active");
  if (!active) return [];
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  if (rules.length === 0) return [];
  for (const rule of rules) {
    try {
      if (!applyGuards(rule, habitatId, scanType)) {
        skipped++;
        continue;
      }
      await executeAndRecordRuleRun(
        rule,
        habitatId,
        scanType,
        `scan:${scanType}:${active.id}`,
        "sprint",
        active.id,
      );
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

async function runAgentSilentScan(habitatId: string): Promise<ScanReport[]> {
  const errs: string[] = [];
  let matched = 0;
  let skipped = 0;
  const scanType: AutomationScanType = "agent_silent";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  if (rules.length === 0) return [];
  for (const rule of rules) {
    try {
      if (!applyGuards(rule, habitatId, scanType)) {
        skipped++;
        continue;
      }
      await executeAndRecordRuleRun(
        rule,
        habitatId,
        scanType,
        `scan:${scanType}:${habitatId}`,
        "agent",
        null,
      );
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

async function runEvidenceGapScan(habitatId: string): Promise<ScanReport[]> {
  const errs: string[] = [];
  let matched = 0;
  let skipped = 0;
  const scanType: AutomationScanType = "evidence_gap_open";
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, scanType);
  if (rules.length === 0) return [];
  for (const rule of rules) {
    try {
      if (!applyGuards(rule, habitatId, scanType)) {
        skipped++;
        continue;
      }
      await executeAndRecordRuleRun(
        rule,
        habitatId,
        scanType,
        `scan:${scanType}:${habitatId}`,
        "habitat",
        habitatId,
      );
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

export function applyGuards(
  rule: AutomationRule,
  habitatId: string,
  scanType: AutomationScanType,
  triggerEventId?: string,
  targetType?: string,
  targetId?: string,
): boolean {
  const resolvedTriggerEventId = triggerEventId ?? `scan:${scanType}:${habitatId}`;
  const resolvedTargetType = targetType ?? "habitat";
  const resolvedTargetId = targetId ?? habitatId;
  const last = runRepo.getLastSuccessfulRunForFingerprint({
    habitatId,
    ruleId: rule.id,
    triggerType: scanType,
    triggerEventId: resolvedTriggerEventId,
    targetType: resolvedTargetType,
    targetId: resolvedTargetId,
  });
  if (last) {
    const window = rule.cooldownSeconds * 1000;
    if (Date.now() - new Date(last.startedAt).getTime() < window) {
      recordScanSkip(rule, habitatId, scanType, "cooldown", resolvedTriggerEventId);
      return false;
    }
  }
  const count = runRepo.getHourlyRunCount(rule.id, new Date().toISOString());
  if (count >= rule.maxRunsPerHour) {
    recordScanSkip(rule, habitatId, scanType, "rate_limited", resolvedTriggerEventId);
    return false;
  }
  return true;
}

function recordScanSkip(
  rule: AutomationRule,
  habitatId: string,
  scanType: AutomationScanType,
  reason: string,
  triggerEventId: string,
): void {
  const run = runRepo.startRuleRun({
    ruleId: rule.id,
    habitatId,
    triggerType: scanType,
    triggerEventId,
    targetType: "habitat",
    targetId: habitatId,
  });
  runRepo.skipRuleRun(run.id, reason as any, { scanType, guard: reason });
}
