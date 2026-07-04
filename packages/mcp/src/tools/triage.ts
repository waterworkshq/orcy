import type { KanbanApiClient } from "../api.js";

/**
 * Triage investigation handlers (v0.23 "Triage"). All actions are READ-ONLY and
 * habitat-scoped: `habitatId` is required on every call. The `investigate`
 * action returns cluster context for an agent that has claimed (or is about to
 * claim) a triage investigation task; it does NOT create new missions — the
 * scan already did that. `top_issues` surfaces unresolved clusters ranked by
 * signal volume, and `resolution_lookup` retrieves historical resolutions for a
 * cluster so agents can apply prior fixes before starting work in a domain.
 *
 * Backed by the Phase 5 REST surface under `/api/triage/*`.
 */

function requireHabitatId(args: { habitatId?: string }): string {
  const habitatId = args.habitatId;
  if (!habitatId || typeof habitatId !== "string") {
    throw new Error("habitatId is required");
  }
  return habitatId;
}

function requireClusterKey(args: { clusterKey?: string }): string {
  const clusterKey = args.clusterKey;
  if (!clusterKey || typeof clusterKey !== "string") {
    throw new Error("clusterKey is required");
  }
  return clusterKey;
}

/**
 * @requires TriageClient
 *
 * READ-ONLY cluster context for an agent performing an investigation. Composes
 * the cluster summary (from the top-clusters aggregation), the open/triaged
 * finding triage records for the cluster, and any historical resolution. Does
 * NOT create a mission — the signal_pattern_clustered scan already did that. If
 * no cluster mission exists yet, the response notes it so the agent can verify.
 *
 * v0.25 Phase 3: the response now also carries a `roadmap` section with the
 * habitat's DAG (missions, dependency edges, gate-satisfied `nextInLine`, and
 * recent detected releases) so the agent can position any deferred corrective
 * work it chooses to insert.
 */
export async function triageInvestigate(
  client: KanbanApiClient,
  args: { habitatId?: string; clusterKey?: string },
) {
  const habitatId = requireHabitatId(args);
  const clusterKey = requireClusterKey(args);

  // RM-7 orphan-mapping branch: a clusterKey of the form `orphan-mission:{missionId}`
  // denotes a triage investigation asking the agent to POSITION an existing orphan
  // mission in the roadmap DAG. Return orphan context (the mission to position + the
  // roadmap) instead of signal-cluster data; the agent positions it via
  // `map_orphan_mission`.
  if (clusterKey.startsWith("orphan-mission:")) {
    const orphanMissionId = clusterKey.slice("orphan-mission:".length);
    const roadmap = await client.getRoadmapContext(habitatId);
    return {
      clusterKey,
      habitatId,
      orphanMissionId,
      roadmap: {
        nextInLine: roadmap.nextInLine,
        missions: roadmap.missions,
        dependencies: roadmap.dependencies,
        recentReleases: roadmap.recentReleases,
      },
      investigationNote:
        `Orphan mission ${orphanMissionId} is unmapped in the roadmap DAG (no dependency edges). ` +
        `Review the roadmap, decide where this mission fits, and position it via ` +
        `action=map_orphan_mission with the appropriate dependsOn (and a release-gate if release-coupling fits).`,
    };
  }

  const [topResp, findingsResp, resolutionsResp, roadmap] = await Promise.all([
    client.getTopTriageClusters(habitatId),
    client.listTriageFindings(habitatId),
    client.getTriageResolutions(habitatId, clusterKey),
    // RM-14: the signal-cluster investigation only needs nextInLine + counts, not
    // the raw mission/edge arrays — summary mode bounds the payload on large habitats.
    // (The orphan-mission branch below uses full mode — it needs edges for positioning.)
    client.getRoadmapContext(habitatId, true),
  ]);

  const clusterSummary = topResp.clusters.find((c) => c.clusterKey === clusterKey);
  const findings = findingsResp.findings.filter(
    (f) => (f.clusterKey as string | undefined) === clusterKey,
  );

  const activeStatuses = new Set(["open", "triaged", "in_progress"]);
  const openFindings = findings.filter((f) =>
    activeStatuses.has((f.status as string | undefined) ?? ""),
  );

  const affectedTaskIds = new Set<string>();
  const affectedMissionIds = new Set<string>();
  const agentIds = new Set<string>();
  const findingKinds = new Set<string>();
  for (const f of findings) {
    const meta = (f.metadata as Record<string, unknown> | null) ?? {};
    const taskIds = Array.isArray(meta.affectedTaskIds) ? (meta.affectedTaskIds as string[]) : [];
    const missionIds = Array.isArray(meta.affectedMissionIds)
      ? (meta.affectedMissionIds as string[])
      : [];
    const ids = Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : [];
    taskIds.forEach((t) => affectedTaskIds.add(t));
    missionIds.forEach((m) => affectedMissionIds.add(m));
    ids.forEach((a) => agentIds.add(a));
    if (typeof f.findingKind === "string") findingKinds.add(f.findingKind);
  }

  const hasActiveMission = clusterSummary?.status === "under_investigation";
  const clusterMissionId = openFindings.find((f) => f.triageMissionId)?.triageMissionId ?? null;

  return {
    clusterKey,
    habitatId,
    signalCount: clusterSummary?.signalCount ?? openFindings.length,
    status: clusterSummary?.status ?? "awaiting_triage",
    clusterMissionId,
    findingKinds: [...findingKinds],
    affectedTaskIds: [...affectedTaskIds],
    affectedMissionIds: [...affectedMissionIds],
    agentIds: [...agentIds],
    openFindings: openFindings.map((f) => ({
      id: f.id,
      pulseId: f.pulseId,
      clusterKey: f.clusterKey,
      findingKind: f.findingKind,
      status: f.status,
      bucket: f.bucket,
      targetRelease: f.targetRelease,
      triageMissionId: f.triageMissionId,
      corroboratingPulseIds: f.corroboratingPulseIds,
      createdAt: f.createdAt,
    })),
    historicalResolutions: resolutionsResp.resolutions.map((r) => ({
      id: r.id,
      resolutionKind: r.resolutionKind,
      rootCause: r.rootCause,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt,
    })),
    // RM-14: spread the roadmap as-returned — in summary mode this carries
    // missionCount/dependencyCount/nextInLine/recentReleases (no raw arrays);
    // in full mode it carries the arrays too.
    roadmap,
    investigationNote: hasActiveMission
      ? "A triage mission already exists for this cluster — claim it and use this context during the investigation."
      : "No active triage mission detected. The scan may not have crossed threshold yet; check the mission board before starting new work.",
  };
}

/**
 * @requires TriageClient
 *
 * Returns the top unresolved triage clusters for a habitat, ranked by signal
 * volume. Summaries only — drill into a cluster via `investigate` for full
 * context (findings, affected tasks, historical resolutions).
 */
export async function triageTopIssues(
  client: KanbanApiClient,
  args: { habitatId?: string; limit?: number },
) {
  const habitatId = requireHabitatId(args);
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
      ? Math.floor(args.limit)
      : 10;
  const resp = await client.getTopTriageClusters(habitatId, limit);
  return {
    habitatId,
    clusters: resp.clusters,
    hint: "Use action=investigate with a clusterKey to drill into a cluster's findings and historical resolutions.",
  };
}

/**
 * @requires TriageClient
 *
 * Retrieves historical triage resolutions recorded against a cluster key.
 * Returns an empty array when no prior resolution exists. Agents call this
 * before starting work in a domain to surface known fixes for recurring pain
 * points.
 */
export async function triageResolutionLookup(
  client: KanbanApiClient,
  args: { habitatId?: string; clusterKey?: string },
) {
  const habitatId = requireHabitatId(args);
  const clusterKey = requireClusterKey(args);
  const resp = await client.getTriageResolutions(habitatId, clusterKey);
  return {
    habitatId,
    clusterKey,
    resolutions: resp.resolutions,
    count: resp.resolutions.length,
  };
}

/**
 * @requires TriageClient
 *
 * The bootstrapping path (ADR-0033). Creates a gated corrective mission
 * positioned in the habitat's roadmap DAG and links the source finding to it.
 * The mission carries `releaseGateType` / `releaseGateVersion` so the gate
 * resolution derived at read-time controls when it becomes actionable, and a
 * `dependsOn` list so the agent can place it after the in-flight work it
 * corrects. The finding's `triageMissionId` is set so subsequent investigations
 * surface the mission as the cluster's active corrective track.
 *
 * Returns the created mission, the updated finding, and a placementNote that
 * the daemon agent echoes into its investigation output pulse.
 */
export async function triageInsertDeferredMission(
  client: KanbanApiClient,
  args: {
    habitatId?: string;
    findingId?: string;
    missionTitle?: string;
    missionDescription?: string;
    dependsOn?: string[];
    releaseGateType?: "patch" | "minor" | "major";
    releaseGateVersion?: string;
  },
) {
  const habitatId = requireHabitatId(args);
  const findingId = args.findingId;
  const missionTitle = args.missionTitle;
  const releaseGateType = args.releaseGateType;
  if (!findingId || typeof findingId !== "string") {
    throw new Error("findingId is required");
  }
  if (!missionTitle || typeof missionTitle !== "string") {
    throw new Error("missionTitle is required");
  }
  if (!releaseGateType) {
    throw new Error("releaseGateType is required (patch | minor | major)");
  }

  const { mission } = await client.createMission(habitatId, {
    title: missionTitle,
    description: args.missionDescription,
    labels: ["triage", "deferred"],
    dependsOn: args.dependsOn,
    releaseGateType,
    releaseGateVersion: args.releaseGateVersion,
  });

  const { finding } = await client.updateTriageFinding(findingId, {
    triageMissionId: mission.id,
  });

  const depsList = (args.dependsOn ?? []).length;
  const placementNote =
    `Inserted deferred mission ${mission.id} gated on ${releaseGateType}` +
    (args.releaseGateVersion ? `@${args.releaseGateVersion}` : "") +
    ` with ${depsList} dependency edge(s); linked to finding ${findingId}.`;

  return {
    mission,
    finding,
    placementNote,
  };
}

/**
 * @requires TriageClient
 *
 * Positions an EXISTING orphan mission in the roadmap DAG (RM-7). Sets the
 * mission's `dependsOn` (and optionally a release-gate) via PATCH, recording the
 * placement. The daemon triage agent calls this after investigating the roadmap
 * context for a `orphan-mission:{id}` cluster. Positioning is the agent's
 * judgment; this action only writes the chosen edges.
 *
 * Returns the updated mission and a placementNote the daemon echoes into its
 * investigation output pulse.
 */
export async function triageMapOrphanMission(
  client: KanbanApiClient,
  args: {
    habitatId?: string;
    missionId?: string;
    dependsOn?: string[];
    releaseGateType?: "patch" | "minor" | "major";
    releaseGateVersion?: string;
  },
) {
  const habitatId = requireHabitatId(args);
  const missionId = args.missionId;
  if (!missionId || typeof missionId !== "string") {
    throw new Error("missionId is required");
  }

  const { mission } = await client.updateMission(missionId, {
    dependsOn: args.dependsOn,
    releaseGateType: args.releaseGateType,
    releaseGateVersion: args.releaseGateVersion,
  });

  const depsList = (args.dependsOn ?? []).length;
  const placementNote =
    `Positioned orphan mission ${mission.id} with ${depsList} dependency edge(s)` +
    (args.releaseGateType
      ? ` + ${args.releaseGateType} gate${args.releaseGateVersion ? `@${args.releaseGateVersion}` : ""}`
      : "") +
    ".";
  void habitatId;
  return { mission, placementNote };
}
