import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as habitatRepo from "../repositories/board.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as missionRepo from "../repositories/feature.js";
import { buildFingerprint } from "@orcy/shared";
import type { AutomationScanType, AutomationRule } from "@orcy/shared";

export interface ScanReport {
  scanType: AutomationScanType;
  habitatId: string;
  rulesMatched: number;
  rulesSkipped: number;
  errors: string[];
}

export function runAllScans(): ScanReport[] {
  const reports: ScanReport[] = [];
  const habitats = habitatRepo.listHabitats();
  for (const h of habitats) {
    reports.push(...runMissionBlockedScan(h.id));
    reports.push(...runSprintEndingScan(h.id));
    reports.push(...runAgentSilentScan(h.id));
    reports.push(...runEvidenceGapScan(h.id));
  }
  return reports;
}

function runMissionBlockedScan(habitatId: string): ScanReport[] {
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
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType: scanType,
        triggerEventId: `scan:${scanType}:${habitatId}`,
        targetType: "habitat",
        targetId: habitatId,
      });
      runRepo.finishRuleRun(run.id, { status: "succeeded" });
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

function runSprintEndingScan(habitatId: string): ScanReport[] {
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
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType: scanType,
        triggerEventId: `scan:${scanType}:${active.id}`,
        targetType: "sprint",
        targetId: active.id,
      });
      runRepo.finishRuleRun(run.id, { status: "succeeded" });
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

function runAgentSilentScan(habitatId: string): ScanReport[] {
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
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType: scanType,
        triggerEventId: `scan:${scanType}:${habitatId}`,
        targetType: "agent",
        targetId: null,
      });
      runRepo.finishRuleRun(run.id, { status: "succeeded" });
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

function runEvidenceGapScan(habitatId: string): ScanReport[] {
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
      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType: scanType,
        triggerEventId: `scan:${scanType}:${habitatId}`,
        targetType: "habitat",
        targetId: habitatId,
      });
      runRepo.finishRuleRun(run.id, { status: "succeeded" });
      matched++;
    } catch (err) {
      errs.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [{ scanType, habitatId, rulesMatched: matched, rulesSkipped: skipped, errors: errs }];
}

function applyGuards(
  rule: AutomationRule,
  habitatId: string,
  scanType: AutomationScanType,
): boolean {
  const last = runRepo.getLastSuccessfulRunForFingerprint({
    habitatId,
    ruleId: rule.id,
    triggerType: scanType,
    triggerEventId: `scan:${scanType}:${habitatId}`,
    targetType: "habitat",
    targetId: habitatId,
  });
  if (last) {
    const window = rule.cooldownSeconds * 1000;
    if (Date.now() - new Date(last.startedAt).getTime() < window) {
      recordScanSkip(rule, habitatId, scanType, "cooldown", `scan:${scanType}:${habitatId}`);
      return false;
    }
  }
  const count = runRepo.getHourlyRunCount(rule.id, new Date().toISOString());
  if (count >= rule.maxRunsPerHour) {
    recordScanSkip(rule, habitatId, scanType, "rate_limited", `scan:${scanType}:${habitatId}`);
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
