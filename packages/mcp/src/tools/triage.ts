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
  // Canonical read: correctiveMissionId (the physical column's canonical name,
  // ADR-0048). The deprecated triageMissionId alias is not consumed here.
  const clusterMissionId =
    openFindings.find((f) => f.correctiveMissionId)?.correctiveMissionId ?? null;

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
      correctiveMissionId: f.correctiveMissionId ?? f.triageMissionId ?? null,
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
 * The bootstrapping path (ADR-0033). Performs EXACTLY ONE command request:
 * `POST /triage/findings/:id/route` with a deferred route payload. The
 * lifecycle kernel atomically creates the gated corrective Mission, positions
 * its dependencies, links the source finding, and commits the routing state —
 * the old two-call flow (create Mission, then PATCH the link) is gone, so a
 * mid-flow failure can no longer leave an orphaned Mission or an unlinked
 * finding.
 *
 * Wire→backend mapping (guarded explicitly at this seam — wire names are
 * agent-facing and drift from the backend Zod schema):
 *   - `dependsOn` (wire)            → `dependencies` (backend)
 *   - `releaseGateType` (wire)      → derives the route bucket:
 *       patch            → `defer_to_patch`
 *       minor | major    → `defer_to_release`
 *   - `missionTitle` / `missionDescription` / `releaseGateVersion` map 1:1.
 *
 * Returns the updated finding (with the linked corrective Mission id) and a
 * placementNote the daemon agent echoes into its investigation output pulse.
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
  const missionDescription = args.missionDescription;
  const releaseGateType = args.releaseGateType;
  const releaseGateVersion = args.releaseGateVersion;
  if (!findingId || typeof findingId !== "string") {
    throw new Error("findingId is required");
  }
  if (!missionTitle || typeof missionTitle !== "string") {
    throw new Error("missionTitle is required");
  }
  if (!missionDescription || typeof missionDescription !== "string") {
    throw new Error("missionDescription is required");
  }
  if (!releaseGateType || !["patch", "minor", "major"].includes(releaseGateType)) {
    throw new Error("releaseGateType is required (patch | minor | major)");
  }
  if (!releaseGateVersion || typeof releaseGateVersion !== "string") {
    throw new Error(
      'releaseGateVersion is required (e.g. "v0.25" — the version the gate waits on)',
    );
  }

  // Explicit wire→backend mapping — never rest-spread `args` (wire-name drift
  // trap; see habitatCorrectTaskEvidenceLink precedent).
  const { finding } = await client.routeTriageFinding(findingId, {
    bucket: releaseGateType === "patch" ? "defer_to_patch" : "defer_to_release",
    missionTitle,
    missionDescription,
    dependencies: args.dependsOn,
    releaseGateType,
    releaseGateVersion,
  });

  const depsList = (args.dependsOn ?? []).length;
  const placementNote =
    `Routed finding ${findingId} to ${releaseGateType === "patch" ? "defer_to_patch" : "defer_to_release"}` +
    ` with one gated corrective mission (${releaseGateType}` +
    (releaseGateVersion ? `@${releaseGateVersion}` : "") +
    `) carrying ${depsList} dependency edge(s); the mission, its placement, and the finding link committed atomically.`;

  return {
    habitatId,
    finding,
    correctiveMissionId: (finding as { correctiveMissionId?: unknown }).correctiveMissionId ?? null,
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

/**
 * @requires TriageClient
 *
 * Sets the habitat's roadmap focus goal (RM-15). Pass a missionId to designate
 * it as the focus (goal_directed scoring will boost its prerequisite chain), or
 * null to clear the focus (revert to auto-derive — highest-fan-out mission).
 */
export async function triageSetFocusMission(
  client: KanbanApiClient,
  args: { habitatId?: string; missionId?: string | null },
) {
  const habitatId = requireHabitatId(args);
  const focusMissionId = args.missionId ?? null;
  const { roadmapSettings } = await client.setRoadmapFocus(habitatId, focusMissionId);
  return {
    habitatId,
    focusMissionId,
    roadmapSettings,
    note:
      focusMissionId === null
        ? "Focus cleared — goal_directed scoring will auto-derive the highest-fan-out mission each pass."
        : `Focus set to mission ${focusMissionId}. goal_directed scoring boosts its prerequisite chain.`,
  };
}
