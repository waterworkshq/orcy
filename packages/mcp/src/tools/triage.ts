import type { KanbanApiClient } from "../api.js";

/**
 * Triage surface handlers (v0.23 "Triage", six-action restoration). Actions
 * are habitat-scoped (`habitatId` required on every call) but NOT all
 * read-only: `insert_deferred_mission` routes a finding through ONE atomic
 * lifecycle command (creating + linking the gated corrective mission), and
 * `map_orphan_mission` positions an orphan mission in the roadmap DAG
 * through the bounded agent-owned triage route. The read actions —
 * `investigate`, `top_issues`, `resolution_lookup` — never mutate; writes
 * are authority-checked server-side against the calling agent's live claim
 * on the relevant investigation task.
 *
 * Backed by the REST surface under `/api/triage/*` and the bounded orphan
 * map route under `/api/habitats/:id/triage/orphans/:missionId/map`.
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
    // Cold-review M1: the branch verifies BOTH the roadmap shape AND the
    // current OPEN orphan investigation junction for the exact
    // (habitat, mission) pair before reporting an orphan as ready to map.
    // Zero dependency edges alone prove NOTHING about investigation state —
    // a merely-disconnected Mission with no open investigation is reported
    // as NOT investigable, with the actionable mapping instruction withheld.
    // (The map write re-verifies everything server-side under its writer
    // reservation; this read never grants anything.)
    const [roadmap, investigation] = await Promise.all([
      client.getRoadmapContext(habitatId),
      client.getTriageOrphanInvestigation(habitatId, orphanMissionId),
    ]);
    const roadmapMissions = roadmap.missions ?? [];
    const roadmapEdges = roadmap.dependencies ?? [];
    const orphan = roadmapMissions.find((m) => m.id === orphanMissionId);
    const investigationOpen = investigation?.open === true;
    // Fixup2 MEDIUM: the SAME mappable-status predicate the scan and the map
    // write enforce (served by the scoped investigation read) gates the
    // mapping advice — a done/failed target gets NO "verified unmapped" claim
    // and NO mapping instruction even while its junction is open (the write
    // would rightly refuse it).
    const targetEligible = investigation?.targetEligible === true;
    const roadmapContext = {
      nextInLine: roadmap.nextInLine,
      missions: roadmapMissions,
      dependencies: roadmapEdges,
      recentReleases: roadmap.recentReleases,
    };
    if (!orphan) {
      return {
        clusterKey,
        habitatId,
        orphanMissionId,
        orphanFound: false,
        investigationOpen,
        targetEligible,
        roadmap: roadmapContext,
        investigationNote:
          `Mission ${orphanMissionId} is not present in habitat ${habitatId}'s roadmap ` +
          `(not found or archived). No orphan investigation context is available for it here.`,
      };
    }
    const incidentEdges = roadmapEdges.filter(
      (e) => e.missionId === orphanMissionId || e.dependsOnId === orphanMissionId,
    );
    if (incidentEdges.length > 0) {
      return {
        clusterKey,
        habitatId,
        orphanMissionId,
        orphanFound: true,
        alreadyMapped: true,
        investigationOpen,
        targetEligible,
        incidentEdges,
        roadmap: roadmapContext,
        investigationNote:
          `Mission ${orphanMissionId} (${orphan.title}) is already positioned — it carries ` +
          `${incidentEdges.length} dependency edge(s). No mapping is needed; action=map_orphan_mission ` +
          `would be refused (not an unmapped orphan).`,
      };
    }
    if (!investigationOpen || !targetEligible) {
      const reason = !investigationOpen
        ? "NO open orphan investigation exists for it in this habitat (never admitted, already resolved, or a different habitat's target)"
        : "its current status is NOT mappable (completed/failed/archived targets are left alone)";
      return {
        clusterKey,
        habitatId,
        orphanMissionId,
        orphanFound: true,
        alreadyMapped: false,
        investigationOpen,
        targetEligible,
        roadmap: roadmapContext,
        investigationNote:
          `Mission ${orphanMissionId} (${orphan.title}) is disconnected from the roadmap DAG, but ${reason}. ` +
          `It is not authorized for map_orphan_mission here. ${
            !investigationOpen
              ? "Positioning it requires a human (generic mission edit) or a new investigation cycle."
              : "Positioning a completed/failed mission is not offered; reopen or re-scope it through normal mission lifecycle work first if it still needs placement."
          }`,
      };
    }
    return {
      clusterKey,
      habitatId,
      orphanMissionId,
      orphanFound: true,
      alreadyMapped: false,
      investigationOpen: true,
      targetEligible: true,
      roadmap: roadmapContext,
      investigationNote:
        `Orphan mission ${orphanMissionId} (${orphan.title}) has an OPEN investigation in this habitat ` +
        `and is verified unmapped in the roadmap DAG (zero incident dependency edges). Review the ` +
        `roadmap, decide where this mission fits, and position it via action=map_orphan_mission with ` +
        `the appropriate dependsOn (and a release-gate if release-coupling fits). Mapping is ` +
        `authorized only for the agent currently claiming this orphan's active investigation task.`,
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
  // ADR-0048 investigation identity: the cluster's investigation Mission is
  // `admittedByTriageMissionId` — the bounded investigation container — NOT
  // the corrective Mission (`correctiveMissionId`, separate provenance) and
  // never the deprecated `triageMissionId` alias. Derived from the actual
  // persisted field on an eligible finding; null when no finding carries an
  // admitted investigation.
  const clusterMissionId =
    openFindings.find((f) => f.admittedByTriageMissionId)?.admittedByTriageMissionId ?? null;

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
      // Canonical fields only (ADR-0048): corrective work identity and the
      // admitted investigation provenance. The deprecated triageMissionId
      // alias is not projected.
      correctiveMissionId: f.correctiveMissionId ?? null,
      admittedByTriageMissionId: f.admittedByTriageMissionId ?? null,
      admittedByInvestigationTaskId: f.admittedByInvestigationTaskId ?? null,
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
  // trap; see habitatCorrectTaskEvidenceLink precedent). The required MCP
  // `habitatId` rides as `expectedHabitatId`: the lifecycle kernel compares
  // it against the persisted Finding's ACTUAL habitat inside the writer
  // reservation BEFORE any write, so a mismatched habitat refuses with zero
  // writes instead of silently writing another habitat's finding.
  const { finding } = await client.routeTriageFinding(findingId, {
    bucket: releaseGateType === "patch" ? "defer_to_patch" : "defer_to_release",
    missionTitle,
    missionDescription,
    dependencies: args.dependsOn,
    releaseGateType,
    releaseGateVersion,
    expectedHabitatId: habitatId,
  });

  const actualHabitatId = (finding as { habitatId?: unknown }).habitatId;
  const depsList = (args.dependsOn ?? []).length;
  const placementNote =
    `Routed finding ${findingId} to ${releaseGateType === "patch" ? "defer_to_patch" : "defer_to_release"}` +
    ` with one gated corrective mission (${releaseGateType}` +
    (releaseGateVersion ? `@${releaseGateVersion}` : "") +
    `) carrying ${depsList} dependency edge(s); the mission, its placement, and the finding link committed atomically.`;

  return {
    // The persisted Finding's ACTUAL habitat (authoritative scope), not the
    // caller's expectation.
    habitatId: typeof actualHabitatId === "string" ? actualHabitatId : habitatId,
    finding,
    correctiveMissionId: (finding as { correctiveMissionId?: unknown }).correctiveMissionId ?? null,
    placementNote,
  };
}

/**
 * @requires TriageClient
 *
 * Positions an EXISTING orphan mission in the roadmap DAG (RM-7) through the
 * bounded agent-owned triage route — ONE command request; the server
 * verifies (inside its writer reservation) the target mission's actual
 * habitat, that it is an unmapped orphan (zero incident dependency edges),
 * that an OPEN orphan investigation junction exists for
 * `(habitatId, orphan-mission:{missionId})`, and that the CALLING agent
 * currently claims that investigation's single active task. Positioning is
 * the agent's judgment; this action only writes the chosen edges (and an
 * optional release gate). Any authority mismatch refuses with no write.
 *
 * Returns the updated mission, the verified identities, and a placementNote
 * the daemon echoes into its investigation output pulse.
 */
export async function triageMapOrphanMission(
  client: KanbanApiClient,
  args: {
    habitatId?: string;
    missionId?: string;
    dependsOn?: string[];
    releaseGateType?: "patch" | "minor" | "major";
    releaseGateVersion?: string;
    expectedVersion?: number;
  },
) {
  const habitatId = requireHabitatId(args);
  const missionId = args.missionId;
  if (!missionId || typeof missionId !== "string") {
    throw new Error("missionId is required");
  }
  if (
    args.dependsOn === undefined ||
    !Array.isArray(args.dependsOn) ||
    args.dependsOn.length === 0 ||
    !args.dependsOn.every((d) => typeof d === "string" && d.length > 0)
  ) {
    throw new Error("dependsOn is required (at least one mission id to position after)");
  }

  const result = await client.mapTriageOrphanMission(habitatId, missionId, {
    dependsOn: args.dependsOn,
    releaseGateType: args.releaseGateType ?? null,
    releaseGateVersion: args.releaseGateVersion ?? null,
    ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
  });

  const depsList = args.dependsOn.length;
  const placementNote =
    `Positioned orphan mission ${result.mission.id} with ${depsList} dependency edge(s)` +
    (args.releaseGateType
      ? ` + ${args.releaseGateType} gate${args.releaseGateVersion ? `@${args.releaseGateVersion}` : ""}`
      : "") +
    ` (verified habitat ${result.habitatId}; authorized by investigation task ${result.investigationTaskId}).`;
  return {
    habitatId: result.habitatId,
    mission: result.mission,
    clusterKey: result.clusterKey,
    investigationMissionId: result.investigationMissionId,
    investigationTaskId: result.investigationTaskId,
    placementNote,
  };
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
