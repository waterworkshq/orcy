import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FINDING_TRIAGE_STATUSES,
  RELEASE_TYPES,
  DETECTOR_SOURCES,
  SUGGESTED_BUCKETS,
  type DetectorSource,
  type FindingTriageStatus,
  type ReleaseType,
  type SuggestedBucket,
} from "@orcy/shared";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as featureService from "../services/featureService.js";
import * as findingTriageService from "../services/findingTriageService.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { getHabitatById } from "../repositories/board.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import { notFound, badRequest, forbidden, unauthorized } from "../errors.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

/** Actor shared across triage write paths — derived from request auth context. */
type TriageActor = { type: "human" | "agent"; id: string };

function actorFromRequest(request: {
  agent?: { id: string } | null;
  user?: { id: string } | null;
}): TriageActor {
  if (request.agent) return { type: "agent", id: request.agent.id };
  if (request.user) return { type: "human", id: request.user.id };
  throw badRequest("Authenticated actor not found on request");
}

/**
 * Verifies that the authenticated requester has access to the given habitat.
 * Mirrors `authorizeHabitatAccess` middleware logic but callable inline for
 * routes where habitatId comes from querystring or a DB lookup (not path params).
 * Fast-follow from v0.23.0 — triage routes shipped without habitat-membership checks.
 */
function verifyHabitatAccess(request: FastifyRequest, habitatId: string): void {
  const habitat = getHabitatById(habitatId);
  if (!habitat) throw notFound("Habitat not found");

  if (request.agent) {
    if (!habitat.teamId) return;
    throw forbidden("Agents cannot access team habitats", "BOARD_ACCESS_DENIED");
  }

  if (request.user) {
    if (!habitat.teamId) return;
    if (isTeamMemberByHabitatId(habitatId, request.user.id)) return;
    throw forbidden("You do not have access to this habitat", "BOARD_ACCESS_DENIED");
  }

  throw unauthorized("Authentication required");
}

const listFindingsQuerySchema = z.object({
  habitatId: z.string().min(1),
  status: z
    .enum(FINDING_TRIAGE_STATUSES as unknown as [FindingTriageStatus, ...FindingTriageStatus[]])
    .optional(),
  bucket: z
    .enum(SUGGESTED_BUCKETS as unknown as [SuggestedBucket, ...SuggestedBucket[]])
    .optional(),
});

const patchFindingBodySchema = z.object({
  status: z
    .enum(FINDING_TRIAGE_STATUSES as unknown as [FindingTriageStatus, ...FindingTriageStatus[]])
    .optional(),
  bucket: z
    .enum(SUGGESTED_BUCKETS as unknown as [SuggestedBucket, ...SuggestedBucket[]])
    .optional(),
  targetRelease: z.string().max(100).nullable().optional(),
  targetReleaseType: z
    .enum(RELEASE_TYPES as unknown as [ReleaseType, ...ReleaseType[]])
    .nullable()
    .optional(),
});

const resolutionsQuerySchema = z.object({
  habitatId: z.string().min(1),
  clusterKey: z.string().min(1),
});

const topClustersQuerySchema = z.object({
  habitatId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

const releaseTriggerBodySchema = z.object({
  habitatId: z.string().min(1),
  version: z.string().min(1),
  releaseType: z.enum(RELEASE_TYPES as unknown as [ReleaseType, ...ReleaseType[]]).optional(),
  detectedBy: z
    .enum(DETECTOR_SOURCES as unknown as [DetectorSource, ...DetectorSource[]])
    .optional()
    .default("api"),
  releaseNotes: z.string().optional(),
});

/**
 * REST surface for the triage domain (ADR-0024 / ADR-0026 / ADR-0027). Finding
 * triage lifecycle, bucket routing, manual promotion (with corrective work
 * creation), historical resolution lookup, and a top-issues summary for the UI
 * and MCP tool layers.
 */
export async function triageRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /triage/findings — list finding triage records for a habitat. */
  fastify.get<{ Querystring: { habitatId: string; status?: string; bucket?: string } }>(
    "/triage/findings",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const parsed = listFindingsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      verifyHabitatAccess(request, parsed.data.habitatId);
      const findings = findingTriageRepo.findByHabitat(parsed.data.habitatId, {
        status: parsed.data.status,
        bucket: parsed.data.bucket,
      });
      return { findings };
    },
  );

  /** GET /triage/findings/:id — get a single finding triage record. */
  fastify.get<{ Params: { id: string } }>(
    "/triage/findings/:id",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const finding = findingTriageRepo.getById(request.params.id);
      if (!finding) throw notFound("Finding not found");
      verifyHabitatAccess(request, finding.habitatId);
      return { finding };
    },
  );

  /**
   * PATCH /triage/findings/:id — transition status and/or set bucket. At least
   * one of `status` / `bucket` must be provided. Status transitions are gated
   * by the state machine in the repository layer (throws conflict on invalid).
   */
  fastify.patch<{ Params: { id: string } }>(
    "/triage/findings/:id",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const parsed = patchFindingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      if (
        parsed.data.status === undefined &&
        parsed.data.bucket === undefined &&
        parsed.data.targetRelease === undefined &&
        parsed.data.targetReleaseType === undefined
      ) {
        throw badRequest(
          "Provide at least one of `status`, `bucket`, `targetRelease`, or `targetReleaseType`",
        );
      }

      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = actorFromRequest(request);
      let finding = existing;
      if (parsed.data.status !== undefined) {
        finding = findingTriageRepo.transitionStatus(request.params.id, parsed.data.status, actor);
      }
      if (parsed.data.bucket !== undefined) {
        finding = findingTriageRepo.setBucket(request.params.id, parsed.data.bucket);
      }
      if (parsed.data.targetRelease !== undefined) {
        finding = findingTriageRepo.setTargetRelease(request.params.id, parsed.data.targetRelease);
      }
      if (parsed.data.targetReleaseType !== undefined) {
        finding = findingTriageRepo.setTargetReleaseType(
          request.params.id,
          parsed.data.targetReleaseType,
        );
      }
      sseBroadcaster.publish(existing.habitatId, {
        type: "triage.finding_updated",
        data: {
          habitatId: existing.habitatId,
          findingId: finding.id,
          status: finding.status,
          bucket: finding.bucket,
        },
      });
      return { finding };
    },
  );

  /**
   * POST /triage/findings/:id/promote — manually promote a deferred (triaged)
   * finding into active corrective work. Transitions `triaged → in_progress`
   * and creates a corrective mission sourced from the finding's pulse, then
   * links the mission back onto the finding triage record.
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/promote",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = actorFromRequest(request);
      findingTriageService.promote(request.params.id, actor);

      // Build the corrective mission from the finding's source pulse so the
      // daemon agent has the original signal context for investigation.
      const pulse = pulseRepo.getPulseById(existing.pulseId);
      const title = `Corrective: ${pulse?.subject ?? existing.clusterKey}`;
      const description = [
        "## Finding Triage",
        `- Cluster: ${existing.clusterKey}`,
        `- Kind: ${existing.findingKind}`,
        `- Bucket: ${existing.bucket ?? "—"}`,
        `- Finding triage id: ${existing.id}`,
        "",
        "## Source Pulse",
        pulse?.body ?? "—",
        "",
        "## Task",
        "Address the deferred finding captured in the source pulse. Resolve or document and close the triage record.",
      ].join("\n");

      const mission = featureService.createMission({
        habitatId: existing.habitatId,
        title,
        description,
        labels: ["triage", existing.findingKind],
        createdBy: actor.id,
      });

      try {
        findingTriageRepo.setTriageMissionId(request.params.id, mission.id);
      } catch {
        // Mission created but back-link failed — the mission is usable, just
        // unlinked from the finding_triage record. Non-critical: the finding is
        // already promoted (in_progress) and the mission exists for work.
      }

      const finding = findingTriageRepo.getById(request.params.id);
      sseBroadcaster.publish(existing.habitatId, {
        type: "triage.finding_updated",
        data: {
          habitatId: existing.habitatId,
          findingId: request.params.id,
          status: finding?.status ?? "in_progress",
          bucket: finding?.bucket ?? null,
        },
      });
      return { finding, missionId: mission.id };
    },
  );

  /** GET /triage/resolutions — proactive lookup of historical resolutions. */
  fastify.get<{ Querystring: { habitatId: string; clusterKey: string } }>(
    "/triage/resolutions",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const parsed = resolutionsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      verifyHabitatAccess(request, parsed.data.habitatId);
      const resolutions = triageResolutionsRepo.findByClusterKey(
        parsed.data.habitatId,
        parsed.data.clusterKey,
      );
      return { resolutions };
    },
  );

  /**
   * GET /triage/clusters/top — top unresolved clusters for the UI/MCP summary.
   * Aggregated from open finding-triage records grouped by clusterKey, joined
   * with active cluster-mission suppression status.
   */
  fastify.get<{ Querystring: { habitatId: string; limit?: string } }>(
    "/triage/clusters/top",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      const parsed = topClustersQuerySchema.safeParse({
        ...request.query,
        limit: request.query.limit,
      });
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const { habitatId, limit } = parsed.data;
      verifyHabitatAccess(request, habitatId);

      const unresolved = findingTriageRepo.findByHabitatInStatus(habitatId, ["open", "triaged"]);

      const byCluster = new Map<
        string,
        {
          clusterKey: string;
          signalCount: number;
          statuses: Set<string>;
          findingKinds: Set<string>;
        }
      >();
      for (const f of unresolved) {
        const entry = byCluster.get(f.clusterKey) ?? {
          clusterKey: f.clusterKey,
          signalCount: 0,
          statuses: new Set<string>(),
          findingKinds: new Set<string>(),
        };
        entry.signalCount += 1 + f.corroboratingPulseIds.length;
        entry.statuses.add(f.status);
        entry.findingKinds.add(f.findingKind);
        byCluster.set(f.clusterKey, entry);
      }

      const sortedClusters = [...byCluster.values()]
        .sort((a, b) => b.signalCount - a.signalCount)
        .slice(0, limit);

      const activeKeys = triageClusterMissionsRepo.findActiveClusterKeys(
        habitatId,
        sortedClusters.map((c) => c.clusterKey),
      );

      const clusters = sortedClusters.map((c) => ({
        clusterKey: c.clusterKey,
        signalCount: c.signalCount,
        statuses: [...c.statuses],
        findingKinds: [...c.findingKinds],
        status: activeKeys.has(c.clusterKey)
          ? ("under_investigation" as const)
          : ("awaiting_triage" as const),
      }));

      return { clusters };
    },
  );

  /**
   * POST /triage/release-trigger — provider-agnostic release detection seam.
   * Converges the GitHub `release` webhook, the `workflow_run` release-workflow
   * convention, the CLI, and external callers. Classifies the release type
   * (caller-override or server-side semver-diff against the prior release),
   * records the `releases` row, runs the activation loop (promote matched
   * findings into corrective missions), posts a retrospective pulse, and fires
   * the `release.shipped` automation event. Idempotent on
   * `(habitatId, version)`.
   */
  fastify.post<{
    Body: {
      habitatId: string;
      version: string;
      releaseType?: ReleaseType;
      detectedBy?: DetectorSource;
      releaseNotes?: string;
    };
  }>("/triage/release-trigger", { preHandler: agentOrHumanAuth }, async (request) => {
    const parsed = releaseTriggerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Validation failed", parsed.error.flatten());
    }
    const body = parsed.data;
    verifyHabitatAccess(request, body.habitatId);
    const result = await releaseTriggerService.detectAndActivate(body.habitatId, body.version, {
      releaseType: body.releaseType,
      detectedBy: body.detectedBy,
      releaseNotes: body.releaseNotes,
    });
    return result;
  });
}
