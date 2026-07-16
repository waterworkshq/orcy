import type { AutomationScanType, AgentQualityPayload } from "@orcy/shared";
import { DEFAULT_TRIAGE_SETTINGS } from "@orcy/shared";
import type { ScanReport } from "./automationScanService.js";
import { applyGuards } from "./automationScanService.js";
import { executeAndRecordRuleRun } from "./automationExecutor.js";
import { getAgentQualitySignals } from "./agentQualityService.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as boardRepo from "../repositories/habitat.js";

/** Resolves habitat-level agent-quality thresholds, falling back to defaults. */
function resolveThresholds(habitatId: string): {
  qualityThreshold: number;
  qualityMinSample: number;
} {
  const habitat = boardRepo.getHabitatById(habitatId);
  const settings = habitat?.triageSettings;
  return {
    qualityThreshold:
      settings?.agentQualityThreshold ?? DEFAULT_TRIAGE_SETTINGS.agentQualityThreshold,
    qualityMinSample:
      settings?.agentQualityMinSample ?? DEFAULT_TRIAGE_SETTINGS.agentQualityMinSample,
  };
}

/** Scan type this service emits. */
const SCAN_TYPE: AutomationScanType = "agent_quality_degraded";

/**
 * Periodic agent-quality scan. Evaluates composite agent-quality signals
 * against a threshold with a sample-size gate, and fires automation rules per
 * degraded agent with an {@link AgentQualityPayload}.
 *
 * Informational only — never mutates assignment, gates, or permissions
 * (CONTEXT.md). Scan errors are caught and surfaced as an error ScanReport;
 * they never crash the scheduler loop.
 */
export async function runAgentQualityDegradedScan(habitatId: string): Promise<ScanReport[]> {
  try {
    const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, SCAN_TYPE);
    if (rules.length === 0) return [];

    const qualityResponse = getAgentQualitySignals(habitatId);
    const { qualityThreshold, qualityMinSample } = resolveThresholds(habitatId);

    const errs: string[] = [];
    let matched = 0;
    let skipped = 0;

    for (const signal of qualityResponse.signals) {
      if (signal.sampleSize < qualityMinSample) continue;
      if (signal.score === null || signal.score >= qualityThreshold) {
        continue;
      }

      const payload: AgentQualityPayload = {
        agentId: signal.agentId,
        agentName: signal.agentName,
        score: signal.score,
        confidence: signal.confidence,
        sampleSize: signal.sampleSize,
        dimensions: {
          approval: signal.dimensions.approval,
          nonRejectionRate: signal.dimensions.nonRejectionRate,
          consistency: signal.dimensions.consistency,
        },
      };
      const triggerEventId = `agent_quality:${signal.agentId}:${habitatId}`;

      for (const rule of rules) {
        try {
          if (!applyGuards(rule, habitatId, SCAN_TYPE, triggerEventId, "agent", signal.agentId)) {
            skipped++;
            continue;
          }
          await executeAndRecordRuleRun(
            rule,
            habitatId,
            SCAN_TYPE,
            triggerEventId,
            "agent",
            signal.agentId,
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
