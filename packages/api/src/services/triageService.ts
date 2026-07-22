import { randomUUID } from "node:crypto";
import type { ClusterPayload, ResolutionKind } from "@orcy/shared";
import type { Mission } from "../models/index.js";
import { getDb } from "../db/index.js";
import { triageClusterMissions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { repositoryNotFoundError } from "../errors/repository.js";
import { getTaskById } from "../repositories/taskCrud.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as pulseRepo from "../repositories/pulse.js";
import { publishTriageMission } from "./triageMissionPublication.js";
import { logger } from "../lib/logger.js";

/** Attribution actor shared across triage write paths. */
export type TriageActor = {
  type: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  id: string;
};

/**
 * Instantiate the triage-investigation mission for a detected cluster (ADR-0026),
 * build its description from the cluster payload, and register the active-triage
 * junction (clusterKey → missionId) so the scan suppresses re-firing while open.
 * Proactive historical resolutions, if any, are embedded as a suggestion block.
 */
export function createTriageMission(
  habitatId: string,
  payload: ClusterPayload,
): { missionId: string } {
  const result = publishTriageMission({ kind: "cluster", habitatId, payload });
  if (result.outcome === "published") {
    return { missionId: result.missionId };
  }
  // A prior publication under the same key already succeeded. Re-read the
  // Mission through the terminal Task so callers receive the existing Mission.
  if (result.outcome === "replayed" && result.terminal?.taskId) {
    const task = getTaskById(result.terminal.taskId);
    if (task) {
      return { missionId: task.missionId };
    }
  }
  // rejected_fingerprint: same clusterKey published before with different
  // rendered content (a new occurrence of a recurring cluster). Retry with
  // an occurrence-specific scope suffix so the new occurrence gets a fresh
  // attempt identity. The clusterKey is unchanged so the historical
  // resolution lookup still finds prior resolutions.
  if (result.outcome === "rejected_fingerprint") {
    const retry = publishTriageMission({
      kind: "cluster",
      habitatId,
      payload,
      scopeSuffix: randomUUID(),
    });
    if (retry.outcome === "published") {
      return { missionId: retry.missionId };
    }
    if (retry.outcome === "replayed" && retry.terminal?.taskId) {
      const task = getTaskById(retry.terminal.taskId);
      if (task) {
        return { missionId: task.missionId };
      }
    }
  }
  logger.warn(
    { habitatId, clusterKey: payload.clusterKey, outcome: result.outcome },
    "triageService.createTriageMission: triage publication non-terminal",
  );
  throw new Error(
    `Triage publication failed (clusterKey="${payload.clusterKey}", outcome=${result.outcome})`,
  );
}

/**
 * Instantiate a triage investigation that asks the daemon agent to POSITION an
 * orphan mission (RM-7) — one disconnected from the roadmap DAG. Reuses the triage
 * mission template (so the investigate task + daemon-claim flow are identical) and
 * the `triage_cluster_missions` junction for active-triage suppression, keyed
 * `orphan-mission:{missionId}`. The agent reads the roadmap DAG via
 * `orcy_triage investigate` (which branches on the `orphan-mission:` prefix) and
 * positions the orphan via `orcy_triage map_orphan_mission`. Positioning is the
 * agent's judgment, not a hardcoded heuristic.
 */
export function createOrphanTriageMission(
  habitatId: string,
  orphan: Mission,
): { missionId: string } {
  const result = publishTriageMission({ kind: "orphan", habitatId, orphan });
  if (result.outcome === "published") {
    return { missionId: result.missionId };
  }
  // A prior publication under the same key already succeeded. Re-read the
  // Mission through the terminal Task so callers receive the existing Mission.
  if (result.outcome === "replayed" && result.terminal?.taskId) {
    const task = getTaskById(result.terminal.taskId);
    if (task) {
      return { missionId: task.missionId };
    }
  }
  logger.warn(
    { habitatId, orphanId: orphan.id, outcome: result.outcome },
    "triageService.createOrphanTriageMission: triage publication non-terminal",
  );
  throw new Error(
    `Triage publication failed (orphan missionId="${orphan.id}", outcome=${result.outcome})`,
  );
}

/**
 * Record a cluster-triage resolution: resolve the open cluster-mission junction
 * and write a {@link triageResolutionsRepo} row keyed by clusterKey for proactive
 * matching on future recurrences (PRD AC-PROACTIVE).
 */
export function recordResolution(
  missionId: string,
  input: {
    rootCause?: string;
    resolution?: string;
    resolutionKind?: ResolutionKind;
    skillCategory?: string;
  },
  actor: TriageActor,
): void {
  const junction = findClusterMissionByMissionId(missionId);
  if (!junction) {
    throw repositoryNotFoundError("triageClusterMission", missionId);
  }

  triageClusterMissionsRepo.resolveByMissionId(missionId);

  triageResolutionsRepo.create({
    habitatId: junction.habitatId,
    clusterKey: junction.clusterKey,
    skillCategory: input.skillCategory ?? "convention",
    source: "cluster_triage",
    sourceId: missionId,
    rootCause: input.rootCause,
    resolution: input.resolution,
    resolutionKind: input.resolutionKind,
    resolvedByType: actor.type,
    resolvedById: actor.id,
  });
}

/**
 * Post a source-tagged analysis pulse (loop guard 1, DESIGN.md). Analysis pulses
 * carry `metadata.triageGenerated: true` + `metadata.triageMissionId` so the
 * cluster scan excludes them from re-clustering by construction.
 */
export function postAnalysisPulse(missionId: string, habitatId: string, content: string): void {
  pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    signalType: "context",
    fromType: "system",
    fromId: "triage",
    subject: "Triage analysis",
    body: content,
    metadata: { triageGenerated: true, triageMissionId: missionId },
  });
}

/**
 * Resolve the cluster-mission junction row for a given missionId. The Phase 2
 * repo exposes lookups by clusterKey only, so this is a direct query.
 */
function findClusterMissionByMissionId(
  missionId: string,
): { habitatId: string; clusterKey: string } | null {
  const db = getDb();
  const row = db
    .select()
    .from(triageClusterMissions)
    .where(eq(triageClusterMissions.missionId, missionId))
    .get();
  if (!row) return null;
  return {
    habitatId: row.habitatId as string,
    clusterKey: row.clusterKey as string,
  };
}
