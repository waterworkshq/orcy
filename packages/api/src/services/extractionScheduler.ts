/**
 * Learning Loop extraction scheduler — periodic scan for due enabled policies.
 *
 * Mirrors `detectorScanService.ts`'s init/stop pattern. The scheduled path
 * calls `runExtraction` for each due enabled policy. No extraction ever
 * routes through Automation Rules — every scheduled run flows through the
 * one lifecycle seam.
 *
 * The scan interval is configurable via `ORCY_LEARNING_LOOP_SCAN_INTERVAL_SECONDS`
 * (default: 300 / 5 minutes). The scheduler only runs when the global feature
 * flag is on (`ORCY_LEARNING_LOOP_ENABLED=true`).
 *
 * Boot wiring in `index.ts` calls `initExtractionScan()` at startup, mirroring
 * `initDetectorScan()`.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { learningLoopPolicies } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import { isLearningLoopGloballyEnabled } from "./extractionPolicyService.js";
import { runExtraction } from "./extractionRunLifecycle.js";
import type { LearningLoopPolicyRow } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Scheduler state
// ---------------------------------------------------------------------------

let scanInterval: ReturnType<typeof setInterval> | undefined;

const DEFAULT_SCAN_INTERVAL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configured scan interval in milliseconds. */
function getScanIntervalMs(): number {
  const seconds = Number(
    process.env.ORCY_LEARNING_LOOP_SCAN_INTERVAL_SECONDS ?? DEFAULT_SCAN_INTERVAL_SECONDS,
  );
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SCAN_INTERVAL_SECONDS) * 1000;
}

/**
 * Fetch all enabled policies across all habitats. Only returns policies where
 * the per-habitat `enabled` flag is on. The global feature flag check is
 * done by `initExtractionScan` / `runScan`.
 */
function getEnabledPolicies(): LearningLoopPolicyRow[] {
  if (!isLearningLoopGloballyEnabled()) return [];

  const db = getDb();
  const rows = db
    .select()
    .from(learningLoopPolicies)
    .where(eq(learningLoopPolicies.enabled, 1))
    .all();

  return rows.map((row) => ({
    id: row.id,
    habitatId: row.habitatId,
    extractorKey: row.extractorKey,
    enabled: row.enabled === 1,
    sourceTypes: row.sourceTypes,
    schedule: row.schedule,
    windowSeconds: row.windowSeconds,
    lookbackSeconds: row.lookbackSeconds,
    minConfidence: row.minConfidence,
    minSampleSize: row.minSampleSize,
    config: row.config,
    version: row.version,
    createdByType: row.createdByType as "human" | "agent" | "system",
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Run one scheduled scan pass. For each enabled policy, call `runExtraction`
 * with `deliveryMode: "scheduled"`.
 */
export async function runExtractionScan(): Promise<void> {
  if (!isLearningLoopGloballyEnabled()) return;

  const policies = getEnabledPolicies();
  if (policies.length === 0) return;

  for (const policy of policies) {
    try {
      const disposition = runExtraction({
        habitatId: policy.habitatId,
        policy,
        deliveryMode: "scheduled",
        actorType: "system",
        actorId: "extraction-scheduler",
      });

      logger.debug(
        { kind: disposition.kind, policyId: policy.id, habitatId: policy.habitatId },
        "Extraction scheduled scan processed policy",
      );
    } catch (err) {
      logger.error(
        { err, policyId: policy.id, habitatId: policy.habitatId },
        "Extraction scheduled scan failed for policy",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Init / stop (mirror detectorScanService)
// ---------------------------------------------------------------------------

/**
 * Initialize the periodic extraction scan. Called at boot from `index.ts`,
 * mirroring `initDetectorScan`. Does nothing if the global feature flag is off.
 */
export function initExtractionScan(): void {
  if (!isLearningLoopGloballyEnabled()) {
    logger.info("Learning Loop feature is disabled — extraction scheduler not started");
    return;
  }

  if (scanInterval) {
    clearInterval(scanInterval);
  }

  const intervalMs = getScanIntervalMs();
  scanInterval = setInterval(() => {
    runExtractionScan().catch((err) => {
      logger.error({ err }, "Extraction scan interval threw");
    });
  }, intervalMs);

  logger.info({ intervalMs }, "Extraction scheduler initialized");
}

/**
 * Stop the periodic extraction scan. Called on shutdown.
 */
export function stopExtractionScan(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = undefined;
  }
}
