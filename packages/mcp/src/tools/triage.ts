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
 */
export async function triageInvestigate(
  client: KanbanApiClient,
  args: { habitatId?: string; clusterKey?: string },
) {
  const habitatId = requireHabitatId(args);
  const clusterKey = requireClusterKey(args);

  const [topResp, findingsResp, resolutionsResp] = await Promise.all([
    client.getTopTriageClusters(habitatId),
    client.listTriageFindings(habitatId),
    client.getTriageResolutions(habitatId, clusterKey),
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

  return {
    clusterKey,
    habitatId,
    signalCount: clusterSummary?.signalCount ?? openFindings.length,
    status: clusterSummary?.status ?? "awaiting_triage",
    findingKinds: [...findingKinds],
    affectedTaskIds: [...affectedTaskIds],
    affectedMissionIds: [...affectedMissionIds],
    agentIds: [...agentIds],
    openFindings: openFindings.map((f) => ({
      id: f.id,
      findingKind: f.findingKind,
      status: f.status,
      bucket: f.bucket,
      targetRelease: f.targetRelease,
      triageMissionId: f.triageMissionId,
      createdAt: f.createdAt,
    })),
    historicalResolutions: resolutionsResp.resolutions.map((r) => ({
      id: r.id,
      resolutionKind: r.resolutionKind,
      rootCause: r.rootCause,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt,
    })),
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
