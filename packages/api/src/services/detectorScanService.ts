/**
 * Detector catch-up scan service (ADR-0015, v0.22.3; ADR-0039 T4 recovery).
 *
 * Periodically re-scans events that may have been missed by the live detector hooks
 * (`onPulseCreated` / `onTaskEvent` / `onCommentCreated`) during server downtime or
 * detector enrollment latency. For each enrolled detector with a stale `lastScannedAt`
 * watermark, the scan queries source events since the watermark, dedup-checks against
 * `plugin_runs` (events already durably-accounted are skipped), and dispatches the
 * detector on the missed events via per-target `dispatchDetectorTarget`.
 *
 * T4 (ADR-0039): the scanner now dispatches ONE concrete Detector target per event
 * (not a kind-kind broadcast) and advances the watermark only when every event-target
 * pair returns `already_accounted` or `durably_started`. `recovery_deferred`
 * (quarantine, capacity, start failure) keeps the watermark behind so the target
 * retries on the next pass.
 */
import { getDb } from "../db/index.js";
import { pulses, taskEvents, tasks, missions } from "../db/schema/index.js";
import { eq, and, gte } from "drizzle-orm";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { logger } from "../lib/logger.js";
import type { EventSourceRef } from "../plugins/types.js";
import type { DetectorSourceEvent } from "@orcy/shared";

let scanInterval: ReturnType<typeof setInterval> | undefined;

const DEFAULT_SCAN_INTERVAL_SECONDS = 300;

/** Returns the configured scan interval in milliseconds (env-overridable). */
function getScanIntervalMs(): number {
  const seconds = Number(
    process.env.ORCY_DETECTOR_SCAN_INTERVAL_SECONDS ?? DEFAULT_SCAN_INTERVAL_SECONDS,
  );
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SCAN_INTERVAL_SECONDS) * 1000;
}

/**
 * Queries pulses created since `since` in a habitat, excluding detected signals
 * (they are detector OUTPUT, not input — recursion guard per ADR-0013).
 */
function queryMissedPulses(habitatId: string, since: string): EventSourceRef[] {
  const db = getDb();
  const rows = db
    .select({ id: pulses.id, createdAt: pulses.createdAt, signalType: pulses.signalType })
    .from(pulses)
    .where(and(eq(pulses.habitatId, habitatId), gte(pulses.createdAt, since)))
    .all();
  return rows
    .filter((r) => r.signalType !== "detected")
    .map((r) => ({
      kind: "pulseCreated" as const,
      sourceId: r.id,
      habitatId,
      occurredAt: r.createdAt,
    }));
}

/**
 * Queries task events since `since` in a habitat (joined through tasks → missions
 * to scope by habitat_id).
 */
function queryMissedTaskEvents(habitatId: string, since: string): EventSourceRef[] {
  const db = getDb();
  const rows = db
    .select({
      taskId: taskEvents.taskId,
      action: taskEvents.action,
      timestamp: taskEvents.timestamp,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(eq(missions.habitatId, habitatId), gte(taskEvents.timestamp, since)))
    .all();
  return rows.map((r) => ({
    kind: "taskEvent" as const,
    sourceId: `${r.taskId}:${r.action}`,
    habitatId,
    occurredAt: r.timestamp,
  }));
}

/** Returns the appropriate missed-events query for a detector's `detects` kind. */
function queryMissedEvents(
  kind: DetectorSourceEvent,
  habitatId: string,
  since: string,
): EventSourceRef[] {
  switch (kind) {
    case "pulseCreated":
      return queryMissedPulses(habitatId, since);
    case "taskEvent":
    case "taskSubmitted":
      return queryMissedTaskEvents(habitatId, since);
    case "commentCreated":
      // Comment catch-up requires querying task_comments + mission_comments with joins.
      // Deferred to a future enhancement — the live hook covers this for now.
      return [];
    default:
      return [];
  }
}

/**
 * Runs a single catch-up scan pass. For each enrolled detector with a stale watermark,
 * queries missed events, dedup-checks against plugin_runs (status-aware: only
 * running/succeeded/failed count as durably-accounted), and dispatches unprocessed
 * events via per-target `dispatchDetectorTarget`.
 *
 * T4 (ADR-0039): the scanner dispatches ONE concrete target per event and advances
 * the watermark only when every event-target pair is `already_accounted` or
 * `durably_started`. `recovery_deferred` (quarantine/capacity/start failure) keeps
 * the watermark behind so the target retries on the next pass.
 */
export async function runScan(): Promise<void> {
  try {
    const detectors = enrollmentRepo.listEnabledDetectors();
    if (detectors.length === 0) return;

    const now = new Date().toISOString();
    let totalDispatched = 0;

    for (const enrollment of detectors) {
      try {
        const detectorKey = `${enrollment.pluginId}:${enrollment.contributionId}`;
        const detectorEntry = pluginManager.getDetectorEntry(detectorKey);
        if (!detectorEntry) continue;

        const detects = detectorEntry.contribution.detects;
        const since = enrollment.lastScannedAt ?? enrollment.enrolledAt;

        const missedEvents = queryMissedEvents(detects, enrollment.habitatId, since);
        if (missedEvents.length === 0) {
          enrollmentRepo.updateLastScannedAt(enrollment.id, now);
          continue;
        }

        // Build the concrete DetectorTarget once for this enrollment (ADR-0039 T4).
        const target: import("../plugins/invocationRuntime.js").DetectorTarget = {
          kind: "signalDetector",
          pluginId: enrollment.pluginId,
          contributionId: enrollment.contributionId,
          handler: detectorEntry.handler,
          contribution: detectorEntry.contribution,
          requires: detectorEntry.requires,
          timeoutMs: detectorEntry.timeoutMs,
          canonicalKey: detectorEntry.canonicalKey,
        };

        let dispatched = 0;
        let allProcessed = true;
        for (const ref of missedEvents) {
          const ack = await pluginManager.dispatchDetectorTarget(target, ref);
          if (ack.state === "already_accounted") {
            continue;
          }
          if (ack.state === "durably_started") {
            dispatched++;
          } else {
            // recovery_deferred — quarantine, capacity, or start failure.
            // Don't advance the watermark past this event; the next scan retries.
            allProcessed = false;
          }
        }

        // Only advance the watermark if every eligible event was either
        // already-accounted (dedup) or durably-started (handler launched).
        if (allProcessed) {
          enrollmentRepo.updateLastScannedAt(enrollment.id, now);
        }
        totalDispatched += dispatched;

        if (dispatched > 0) {
          logger.info(
            {
              pluginId: enrollment.pluginId,
              contributionId: enrollment.contributionId,
              dispatched,
            },
            "Detector catch-up scan dispatched missed events",
          );
        }
      } catch (err) {
        // Per-detector error — don't abort the entire scan for other detectors.
        logger.error(
          { err, pluginId: enrollment.pluginId, contributionId: enrollment.contributionId },
          "Detector catch-up scan failed for this enrollment",
        );
      }
    }

    if (totalDispatched > 0) {
      logger.info(
        { totalDispatched, detectorCount: detectors.length },
        "Detector catch-up scan complete",
      );
    }
  } catch (err) {
    logger.error({ err }, "Detector catch-up scan failed");
  }
}

/**
 * Initializes the detector catch-up scan periodic task. Called once at API boot
 * after plugin initialization. The scan runs at `ORCY_DETECTOR_SCAN_INTERVAL_SECONDS`
 * (default 300s). Safe to call multiple times — re-init clears the prior interval.
 */
export function initDetectorScan(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
  }
  const intervalMs = getScanIntervalMs();
  scanInterval = setInterval(runScan, intervalMs);
  logger.info({ intervalMs }, "Detector catch-up scan initialized");
}

/** Stops the catch-up scan (test/teardown helper). */
export function stopDetectorScan(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = undefined;
  }
}
