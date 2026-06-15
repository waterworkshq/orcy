import * as habitatRepo from "../repositories/board.js";
import * as anomalyRepo from "../repositories/anomaly.js";
import { daysAgoISO } from "./analyticsDate.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as emailService from "./emailService.js";
import * as chatService from "./chatService.js";
import { logger } from "../lib/logger.js";
import type { AnomalySettings } from "../models/index.js";

const DEFAULT_SETTINGS: AnomalySettings = {
  enabled: true,
  scanIntervalMinutes: 5,
  thresholds: {
    staleInProgressMinutes: 240,
    rejectionRatePercent: 40,
    rejectionWindowTasks: 10,
    cycleTimeIncreasePercent: 50,
    backlogToAgentRatio: 2,
    agentOfflineMinutes: 15,
  },
  notifications: {
    email: true,
    sse: true,
    chat: true,
  },
};

/**
 * Returns a deep-cloned copy of the baseline {@link AnomalySettings} so callers can safely mutate the result without affecting the shared default.
 */
export function getDefaultAnomalySettings(): AnomalySettings {
  return {
    ...DEFAULT_SETTINGS,
    thresholds: { ...DEFAULT_SETTINGS.thresholds },
    notifications: { ...DEFAULT_SETTINGS.notifications },
  };
}

/**
 * Returns the {@link AnomalySettings} configured on the given habitat, falling back to {@link getDefaultAnomalySettings} when the habitat is missing or has no overrides.
 */
export function getAnomalySettings(habitatId: string): AnomalySettings {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return getDefaultAnomalySettings();
  return habitat.anomalySettings ?? getDefaultAnomalySettings();
}

/** Single anomaly finding emitted by a detector, carrying its type, severity, human-readable message, and structured detail payload. */
export interface AnomalyResult {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  data: Record<string, unknown>;
}

/**
 * Returns {@link AnomalyResult}s for tasks whose `startedAt` is older than the `staleInProgressMinutes` threshold, with severity escalating as elapsed time grows.
 */
export function detectStaleInProgress(
  habitatId: string,
  settings: AnomalySettings,
): AnomalyResult[] {
  const thresholdMs = settings.thresholds.staleInProgressMinutes * 60 * 1000;
  const now = Date.now();
  const habitatMissionIds = anomalyRepo.getMissionIdsForHabitat(habitatId);

  if (habitatMissionIds.length === 0) return [];

  const rows = anomalyRepo.getStaleInProgressCandidates(habitatMissionIds);

  const anomalies: AnomalyResult[] = [];
  for (const row of rows) {
    const elapsed = now - new Date(row.startedAt!).getTime();
    if (elapsed > thresholdMs) {
      const elapsedMinutes = Math.round(elapsed / 60000);
      let severity: AnomalyResult["severity"] = "low";
      if (elapsedMinutes > settings.thresholds.staleInProgressMinutes * 3) severity = "critical";
      else if (elapsedMinutes > settings.thresholds.staleInProgressMinutes * 2) severity = "high";
      else severity = "medium";

      anomalies.push({
        type: "stale_in_progress",
        severity,
        message: `Task "${row.title}" has been in progress for ${elapsedMinutes} minutes (threshold: ${settings.thresholds.staleInProgressMinutes}m)`,
        data: {
          taskId: row.id,
          taskTitle: row.title,
          elapsedMinutes,
          agentId: row.assignedAgentId,
        },
      });
    }
  }
  return anomalies;
}

/**
 * Returns at most one {@link AnomalyResult} when the rejection rate over the most recent `rejectionWindowTasks` tasks exceeds the configured percentage, ignoring samples smaller than three tasks.
 */
export function detectRejectionSpike(
  habitatId: string,
  settings: AnomalySettings,
): AnomalyResult[] {
  const windowSize = settings.thresholds.rejectionWindowTasks;
  const habitatMissionIds = anomalyRepo.getMissionIdsForHabitat(habitatId);

  if (habitatMissionIds.length === 0) return [];

  const rows = anomalyRepo.getRecentTasksForRejectionWindow(habitatMissionIds, windowSize);

  let rejectedCount = 0;
  let total = 0;
  for (const row of rows) {
    total++;
    if (row.status === "rejected" || row.rejectedCount > 0) rejectedCount++;
  }

  if (total < 3) return [];

  const rejectionRate = (rejectedCount / total) * 100;
  if (rejectionRate > settings.thresholds.rejectionRatePercent) {
    const severity: AnomalyResult["severity"] =
      rejectionRate > 70 ? "critical" : rejectionRate > 55 ? "high" : "medium";
    return [
      {
        type: "rejection_spike",
        severity,
        message: `Rejection rate is ${Math.round(rejectionRate)}% over last ${total} tasks (threshold: ${settings.thresholds.rejectionRatePercent}%)`,
        data: { rejectionRate: Math.round(rejectionRate), rejectedCount, totalTasks: total },
      },
    ];
  }
  return [];
}

/**
 * Returns an {@link AnomalyResult} when the average cycle time over the last seven days grew by more than the configured percentage compared to the preceding seven-day window.
 */
export function detectCycleTimeDegradation(
  habitatId: string,
  settings: AnomalySettings,
): AnomalyResult[] {
  const now = new Date();
  const sevenDaysAgo = daysAgoISO(7, now);
  const fourteenDaysAgo = daysAgoISO(14, now);
  const habitatMissionIds = anomalyRepo.getMissionIdsForHabitat(habitatId);

  if (habitatMissionIds.length === 0) return [];

  const recentCycle = anomalyRepo.getAverageCycleTimeMinutes(
    habitatMissionIds,
    sevenDaysAgo,
    now.toISOString(),
  );
  const previousCycle = anomalyRepo.getAverageCycleTimeMinutes(
    habitatMissionIds,
    fourteenDaysAgo,
    sevenDaysAgo,
  );

  if (previousCycle === 0 || recentCycle === 0) return [];

  const increasePercent = ((recentCycle - previousCycle) / previousCycle) * 100;
  if (increasePercent > settings.thresholds.cycleTimeIncreasePercent) {
    const severity: AnomalyResult["severity"] =
      increasePercent > 100 ? "critical" : increasePercent > 75 ? "high" : "medium";
    return [
      {
        type: "cycle_time_increase",
        severity,
        message: `Average cycle time increased by ${Math.round(increasePercent)}% (${Math.round(previousCycle)}m → ${Math.round(recentCycle)}m)`,
        data: {
          increasePercent: Math.round(increasePercent),
          previousAvgMinutes: Math.round(previousCycle),
          recentAvgMinutes: Math.round(recentCycle),
        },
      },
    ];
  }
  return [];
}

/**
 * Returns an {@link AnomalyResult} when the ratio of pending tasks to active agents exceeds the configured `backlogToAgentRatio` threshold, skipping habitats with no currently active agents.
 */
export function detectBacklogGrowth(habitatId: string, settings: AnomalySettings): AnomalyResult[] {
  const habitatMissionIds = anomalyRepo.getMissionIdsForHabitat(habitatId);

  if (habitatMissionIds.length === 0) return [];

  const { pendingCount, activeAgents } = anomalyRepo.getBacklogStats(habitatMissionIds);

  if (activeAgents === 0) return [];

  const ratio = pendingCount / activeAgents;
  if (ratio > settings.thresholds.backlogToAgentRatio) {
    const severity: AnomalyResult["severity"] =
      ratio > settings.thresholds.backlogToAgentRatio * 3
        ? "critical"
        : ratio > settings.thresholds.backlogToAgentRatio * 2
          ? "high"
          : "medium";
    return [
      {
        type: "backlog_growth",
        severity,
        message: `Pending tasks (${pendingCount}) exceed ${settings.thresholds.backlogToAgentRatio}x active agents (${activeAgents})`,
        data: { pendingCount, activeAgents, ratio: Math.round(ratio * 10) / 10 },
      },
    ];
  }
  return [];
}

/**
 * Returns {@link AnomalyResult}s for agents whose `lastHeartbeat` is older than the `agentOfflineMinutes` threshold, with severity escalating as downtime grows.
 */
export function detectAgentOffline(habitatId: string, settings: AnomalySettings): AnomalyResult[] {
  const thresholdMs = settings.thresholds.agentOfflineMinutes * 60 * 1000;
  const now = Date.now();
  void habitatId;

  const agentRows = anomalyRepo.getAgentOfflineCandidates();

  const anomalies: AnomalyResult[] = [];
  for (const row of agentRows) {
    const elapsed = now - new Date(row.lastHeartbeat).getTime();
    if (elapsed > thresholdMs) {
      const elapsedMinutes = Math.round(elapsed / 60000);
      const severity: AnomalyResult["severity"] =
        elapsedMinutes > settings.thresholds.agentOfflineMinutes * 4
          ? "critical"
          : elapsedMinutes > settings.thresholds.agentOfflineMinutes * 2
            ? "high"
            : "medium";

      anomalies.push({
        type: "agent_offline",
        severity,
        message: `Agent "${row.name}" has been offline for ${elapsedMinutes} minutes (threshold: ${settings.thresholds.agentOfflineMinutes}m)`,
        data: {
          agentId: row.id,
          agentName: row.name,
          elapsedMinutes,
          activeTasks: row.activeTasks,
        },
      });
    }
  }
  return anomalies;
}

/**
 * Runs every detector and returns the combined {@link AnomalyResult}s, returning an empty list when anomaly detection is disabled in the habitat's settings.
 */
export function detectAnomalies(habitatId: string): AnomalyResult[] {
  const settings = getAnomalySettings(habitatId);
  if (!settings.enabled) return [];

  return [
    ...detectStaleInProgress(habitatId, settings),
    ...detectRejectionSpike(habitatId, settings),
    ...detectCycleTimeDegradation(habitatId, settings),
    ...detectBacklogGrowth(habitatId, settings),
    ...detectAgentOffline(habitatId, settings),
  ];
}

/**
 * Runs anomaly detection for a habitat and dispatches per-channel notifications — SSE broadcasts to subscribers, emails admins for high/critical severity, and posts chat alerts — returning the {@link AnomalyResult}s that were reported.
 */
export function scanHabitat(habitatId: string): AnomalyResult[] {
  const settings = getAnomalySettings(habitatId);
  if (!settings.enabled) return [];

  const anomalies = detectAnomalies(habitatId);
  if (anomalies.length === 0) return [];

  const habitat = habitatRepo.getHabitatById(habitatId);
  const habitatName = habitat?.name ?? "Unknown Habitat";
  const now = new Date().toISOString();

  for (const anomaly of anomalies) {
    if (settings.notifications.sse) {
      sseBroadcaster.publish(habitatId, {
        type: "anomaly.detected",
        data: { ...anomaly, habitatId, detectedAt: now },
      });
    }

    if (
      settings.notifications.email &&
      emailService.isConfigured() &&
      (anomaly.severity === "high" || anomaly.severity === "critical")
    ) {
      sendAnomalyEmails(habitatId, habitatName, anomaly);
    }

    if (settings.notifications.chat) {
      chatService.sendAnomalyAlert(habitatId, anomaly).catch((err) => {
        logger.error(
          { err, habitatId, anomalyType: anomaly.type },
          "Failed to send anomaly chat notification",
        );
      });
    }
  }

  return anomalies;
}

function sendAnomalyEmails(habitatId: string, habitatName: string, anomaly: AnomalyResult): void {
  const adminRows = anomalyRepo.getAdminEmailRecipients();
  for (const row of adminRows) {
    if (!row.email) continue;
    const payload = emailService.anomalyAlertTemplate(
      anomaly.type,
      anomaly.severity,
      anomaly.message,
      habitatName,
    );
    payload.to = row.email;
    emailService.sendEmail(payload).catch((err) => {
      logger.error({ err, habitatId, anomalyType: anomaly.type }, "Failed to send anomaly email");
    });
  }
}

/**
 * Scans every habitat via {@link scanHabitat} and returns only the entries that produced at least one {@link AnomalyResult}, skipping habitats with no anomalies or with detection disabled.
 */
export function scanAllHabitats(): { habitatId: string; anomalies: AnomalyResult[] }[] {
  const habitats = habitatRepo.listHabitats();
  const results: { habitatId: string; anomalies: AnomalyResult[] }[] = [];

  for (const habitat of habitats) {
    const anomalies = scanHabitat(habitat.id);
    if (anomalies.length > 0) {
      results.push({ habitatId: habitat.id, anomalies });
    }
  }

  return results;
}
