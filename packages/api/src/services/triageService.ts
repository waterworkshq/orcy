import type { ClusterPayload, ResolutionKind } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { triageClusterMissions } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { repositoryNotFoundError } from "../errors/repository.js";
import { TRIAGE_MISSION_TEMPLATE_ID, applyTemplate } from "../repositories/template.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as pulseRepo from "../repositories/pulse.js";

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
  const variables: Record<string, string> = {
    clusterSubject: payload.clusterKey,
    signalCount: String(payload.signalCount),
    provenanceBreakdown: JSON.stringify(payload.provenanceBreakdown),
    crossMissionCount: String(payload.crossMissionCount),
    agentIds: payload.agentIds.join(","),
  };

  const description = buildMissionDescription(habitatId, payload);

  const result = applyTemplate(
    TRIAGE_MISSION_TEMPLATE_ID,
    habitatId,
    {
      title: `Triage: ${payload.clusterKey}`,
      description,
      variables,
    },
    "system",
  );
  if (!result) {
    throw repositoryNotFoundError("missionTemplate", TRIAGE_MISSION_TEMPLATE_ID);
  }

  const missionId = result.mission.id;
  triageClusterMissionsRepo.create(habitatId, payload.clusterKey, missionId);
  return { missionId };
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

/**
 * Build the triage mission description from the cluster payload, attaching a
 * proactive-resolution suggestion block when historical resolutions exist for
 * this clusterKey.
 */
function buildMissionDescription(habitatId: string, payload: ClusterPayload): string {
  const lines: string[] = [
    "## Cluster",
    payload.clusterKey,
    "## Provenance Breakdown",
    JSON.stringify(payload.provenanceBreakdown, null, 2),
    "## Signal Count",
    String(payload.signalCount),
    "## Cross-Mission Count",
    String(payload.crossMissionCount),
    "## Distinct Agents",
    String(payload.distinctAgentCount),
    "## Affected Agents",
    payload.agentIds.join(", ") || "—",
    "## Affected Missions",
    payload.affectedMissionIds.join(", ") || "—",
    "## Time Window (days)",
    String(payload.timeWindowDays),
    "## First Seen",
    payload.firstSeenAt,
    "## Last Seen",
    payload.lastSeenAt,
  ];

  const proactive = triageResolutionsRepo.findByClusterKey(habitatId, payload.clusterKey);
  if (proactive.length > 0) {
    const top = proactive[0];
    lines.push(
      "## Proactive Suggestion (historical resolution)",
      `A prior resolution exists for this cluster (${top.resolvedAt}):`,
      `- Root cause: ${top.rootCause ?? "—"}`,
      `- Resolution: ${top.resolution ?? "—"}`,
      `- Kind: ${top.resolutionKind ?? "—"}`,
    );
  }

  lines.push(
    "## Task",
    "Investigate root cause, recommend a routing bucket, and post an analysis pulse with findings.",
  );

  return lines.join("\n");
}
