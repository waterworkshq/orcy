import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  FINDING_TRIAGE_STATUSES,
  RELEASE_TYPES,
  RESOLUTION_KINDS,
  SUGGESTED_BUCKETS,
  type FindingTriageStatus,
  type ReleaseType,
  type ResolutionKind,
  type SuggestedBucket,
} from "@orcy/shared";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as triageResolutionsRepo from "../repositories/triageResolutions.js";
import * as triageClusterMissionsRepo from "../repositories/triageClusterMissions.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import {
  routeFinding as routeFindingLifecycle,
  resolveFinding as resolveFindingLifecycle,
  markFindingWontfix as markFindingWontfixLifecycle,
  activateCorrectiveMission as activateCorrectiveMissionLifecycle,
  type LifecycleOutcome,
} from "../services/findingTriageLifecycle.js";
import {
  checkRouteAuthority,
  checkManualCommandAuthority,
  defaultHabitatAccessChecker,
  type AuthorityActor,
  type AuthorityFindingShape,
} from "../services/triageLifecycleAuthority.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { getHabitatById } from "../repositories/habitat.js";
import { isTeamMemberByHabitatId } from "../repositories/teamMember.js";
import {
  AppError,
  notFound,
  badRequest,
  badRequestWithCode,
  forbidden,
  unauthorized,
  conflictWithCode,
} from "../errors.js";
import { logger } from "../lib/logger.js";

/**
 * Derives the canonical lifecycle actor for a Finding write. Local agents map
 * to `agent`; humans map to `human`. `system` is reserved for the Release
 * Activation transport (T6) and never arrives from the HTTP surface.
 *
 * FU6: the human actor carries the JWT role claim so the authority predicate
 * can deny read-only viewers at the transport (the in-tx re-check separately
 * re-reads `users.role` under the writer reservation).
 */
function authorityActorFromRequest(request: FastifyRequest): AuthorityActor {
  if (request.agent) return { type: "agent", id: request.agent.id };
  if (request.user) {
    const role = request.user.role;
    return {
      type: "human",
      id: request.user.id,
      ...(role === "admin" || role === "editor" || role === "viewer" ? { role } : {}),
    };
  }
  throw badRequest("Authenticated actor not found on request");
}

/**
 * Map a {@link LifecycleOutcome} to the HTTP response. Lives at the transport
 * seam so the lifecycle kernel stays free of HTTP concerns. Anti-probing:
 * `not_found` and `not_authorized` are both surfaced as 403 (single code)
 * when the caller is a remote participant (caller passes `isRemote`); the
 * local surface maps not-found → 404 and not-authorized → 403.
 */
function mapLifecycleOutcome<T>(
  outcome: LifecycleOutcome<T>,
  reply: FastifyReply,
  ctx: { actorId: string; findingId: string; isRemote?: boolean },
): T | never {
  if (outcome.outcome === "applied" || outcome.outcome === "replayed") {
    return outcome.value;
  }

  if (outcome.outcome === "busy") {
    const retryAfterSeconds = Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
    reply.header("Retry-After", String(retryAfterSeconds));
    // Contract (plan + T4): busy → 503 + Retry-After — matches the remote mapper.
    throw new AppError(
      503,
      "LIFECYCLE_BUSY",
      `Lifecycle writer reservation exhausted; retry after ${retryAfterSeconds}s`,
    );
  }

  // outcome === "conflict"
  const { reason, current } = outcome;

  if (reason === "not_found") {
    if (ctx.isRemote) {
      // Anti-probing: collapse not-found into a generic 403 so the remote
      // surface cannot be used as a Finding existence oracle.
      throw forbidden("Triage action not permitted");
    }
    throw notFound("Finding not found");
  }

  if (reason === "not_authorized") {
    if (ctx.isRemote) {
      throw forbidden("Triage action not permitted");
    }
    throw forbidden(
      typeof current === "string" ? current : "Not authorized for this triage action",
      "TRIAGE_NOT_AUTHORIZED",
    );
  }

  if (reason === "terminal") {
    throw conflictWithCode(
      "FINDING_TERMINAL",
      `Finding is in terminal state (${typeof current === "string" ? current : "resolved|wontfix"}). Recurrence creates a new row.`,
    );
  }

  if (reason === "legacy_lineage_repair_required") {
    throw conflictWithCode(
      "LEGACY_LINEAGE_REPAIR_REQUIRED",
      "Finding legacy lineage repair required before automatic routing; operator action needed.",
    );
  }

  if (reason === "different_route") {
    throw conflictWithCode(
      "DIFFERENT_ROUTE",
      "Finding already routed with a different bucket/fingerprint.",
    );
  }

  if (reason === "different_payload") {
    throw conflictWithCode("DIFFERENT_PAYLOAD", "Resolution payload differs from existing record.");
  }

  if (reason === "invalid_input") {
    throw badRequestWithCode(
      "INVALID_INPUT",
      typeof current === "string" ? current : "Invalid triage command input",
    );
  }

  if (reason === "invalid_dependency") {
    // Anti-probing: missing-id and cross-Habitat produce ONE indistinguishable
    // 409 — never the id, never which condition failed, only the position.
    const index =
      current && typeof current === "object" && "index" in current
        ? (current as { index: number }).index
        : null;
    throw conflictWithCode(
      "INVALID_DEPENDENCY",
      typeof index === "number"
        ? `Dependency at position ${index} is not a valid same-Habitat Mission.`
        : "One or more dependencies are not valid same-Habitat Missions.",
    );
  }

  // Activation-specific conflicts (restored lifecycle T5).
  if (reason === "missing_link") {
    throw conflictWithCode(
      "FINDING_NOT_LINKED",
      typeof current === "string"
        ? current
        : "Finding has no corrective Mission link; route it to a work-bearing bucket first.",
    );
  }

  if (reason === "stale_mission_version") {
    const currentVersion =
      current && typeof current === "object" && "currentVersion" in current
        ? String((current as { currentVersion: number }).currentVersion)
        : "unknown";
    reply.header("X-Current-Version", currentVersion);
    throw conflictWithCode(
      "MISSION_VERSION_MISMATCH",
      `Corrective Mission version mismatch (current ${currentVersion}); reload and retry.`,
    );
  }

  if (reason === "mission_not_activatable") {
    throw conflictWithCode(
      "MISSION_NOT_ACTIVATABLE",
      "Corrective Mission is archived or terminal and cannot be activated.",
    );
  }

  if (reason === "mixed_group") {
    throw conflictWithCode(
      "MIXED_LINKED_GROUP",
      "Every Finding linked to this corrective Mission must be `triaged` and eligible to activate as one group; mixed states reject without writes.",
    );
  }

  if (reason === "gate_proof_mismatch") {
    throw conflictWithCode(
      "GATE_PROOF_MISMATCH",
      "Release gate proof does not match the Mission's live gate.",
    );
  }

  throw conflictWithCode("TRIAGE_CONFLICT", "Triage command conflict");
}

/**
 * Resolves the authority policy for a local route call. Returns the finding
 * (re-read under the auth context) and the authority actor. Throws
 * `notFound` for missing findings, `forbidden` for unauthorized actors, and
 * `badRequest` for legacy-lineage rows whose admitted Task is null (humans
 * with write access are allowed there; agents and unknown actors are not).
 */
function authorizeLocalRoute(args: {
  finding: ReturnType<typeof findingTriageRepo.getById>;
  request: FastifyRequest;
}): {
  finding: NonNullable<ReturnType<typeof findingTriageRepo.getById>>;
  actor: AuthorityActor;
} {
  if (!args.finding) throw notFound("Finding not found");
  verifyHabitatAccess(args.request, args.finding.habitatId);

  const actor = authorityActorFromRequest(args.request);
  const findingShape: AuthorityFindingShape = {
    id: args.finding.id,
    habitatId: args.finding.habitatId,
    admittedByInvestigationTaskId: args.finding.admittedByInvestigationTaskId,
  };

  const result = checkRouteAuthority({
    finding: findingShape,
    actor,
    access: defaultHabitatAccessChecker(),
  });

  if (result.kind === "deny") {
    throw forbidden(result.message, result.code);
  }
  return { finding: args.finding, actor };
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
  version: z.string().min(1).max(64),
  releaseType: z.enum(RELEASE_TYPES as unknown as [ReleaseType, ...ReleaseType[]]).optional(),
  releaseNotes: z.string().max(10000).optional(),
});

// ---------------------------------------------------------------------------
// Local intent route payloads (restored lifecycle T4)
// ---------------------------------------------------------------------------

const fixNowRouteSchema = z
  .object({
    bucket: z.literal("fix_now"),
    missionTitle: z.string().min(1).max(500),
    missionDescription: z.string().min(1).max(20000),
    dependencies: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();

const deferRouteSchema = z
  .object({
    bucket: z.enum(["defer_to_patch", "defer_to_release"]),
    missionTitle: z.string().min(1).max(500),
    missionDescription: z.string().min(1).max(20000),
    dependencies: z.array(z.string().max(200)).max(50).optional(),
    releaseGateType: z.enum(["patch", "minor", "major"]),
    releaseGateVersion: z.string().min(1).max(64),
  })
  .strict();

const noWorkRouteSchema = z
  .object({
    bucket: z.literal("document_as_known_limitation"),
  })
  .strict();

const investigationRouteSchema = z
  .object({
    bucket: z.literal("needs_investigation"),
  })
  .strict();

const routeFindingBodySchema = z.union([
  fixNowRouteSchema,
  deferRouteSchema,
  noWorkRouteSchema,
  investigationRouteSchema,
]);

const resolveFindingBodySchema = z
  .object({
    resolution: z.string().min(1).max(10000),
    resolutionKind: z.enum(RESOLUTION_KINDS as unknown as [ResolutionKind, ...ResolutionKind[]]),
    rootCause: z.string().max(10000).optional(),
  })
  .strict();

const wontfixFindingBodySchema = z
  .object({
    reason: z.string().min(1).max(10000),
  })
  .strict();

const activateFindingBodySchema = z
  .object({
    expectedMissionVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

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
   * PATCH /triage/findings/:id — RETIRED (legacy adapter window closed).
   *
   * The legacy compatibility window declared in v0.40.0 is closed: the two
   * retained adapter shapes (no-work `{status:'triaged', bucket}` dispatch
   * and first link-only `{triageMissionId, expectedMissionVersion}`) are
   * gone, along with every shape-guard that existed only to serve them and
   * the atomic link writer they used. EVERY legacy PATCH shape — no-work,
   * link-only, unlink, mixed, terminal, target-release — gets ONE typed
   * retirement response with ZERO writes; the body is not parsed. The four
   * lifecycle command endpoints are the only Finding mutation surface.
   * Remediation is a client upgrade (see docs/API.md + docs/TROUBLESHOOTING.md).
   */
  fastify.patch<{ Params: { id: string } }>(
    "/triage/findings/:id",
    { preHandler: agentOrHumanAuth },
    async (request) => {
      logger.warn(
        { findingId: request.params.id },
        "triage legacy PATCH retired (LEGACY_PATCH_RETIRED); use the lifecycle command endpoints",
      );
      throw badRequestWithCode(
        "LEGACY_PATCH_RETIRED",
        "The legacy PATCH /triage/findings/:id adapter was retired. Use POST /triage/findings/:id/route, /activate, /resolve, or /wontfix.",
      );
    },
  );

  /**
   * POST /triage/findings/:id/route — explicit lifecycle route intent.
   * Backed ONLY by `routeFinding`. The transport cannot supply actor type/id
   * or release activation cause; both are derived from the auth context.
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/route",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = routeFindingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const existing = findingTriageRepo.getById(request.params.id);
      const { actor, finding } = authorizeLocalRoute({ finding: existing, request });

      const outcome = routeFindingLifecycle({
        findingId: finding.id,
        actor: { ...actor, authority: {} },
        route: parsed.data,
      });
      const updated = mapLifecycleOutcome(outcome, reply, {
        actorId: actor.id,
        findingId: finding.id,
      });
      return { finding: updated };
    },
  );

  /**
   * POST /triage/findings/:id/activate — manual activation of the Finding's
   * EXISTING corrective Mission (restored lifecycle T5).
   *
   * Backed ONLY by `activateCorrectiveMission`: one immediate transaction
   * over the Mission and ALL its linked non-terminal Findings. The Mission id
   * never changes, only the gate fields clear, and the complete eligible
   * group activates atomically. Human-only (Habitat write); the transport
   * derives the actor from the auth context and cannot supply actor type/id
   * or a Release attribution (Release activation is internal-only).
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/activate",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = activateFindingBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = authorityActorFromRequest(request);
      const result = checkManualCommandAuthority({
        finding: {
          id: existing.id,
          habitatId: existing.habitatId,
          admittedByInvestigationTaskId: existing.admittedByInvestigationTaskId,
        },
        actor,
        access: defaultHabitatAccessChecker(),
        command: "activate",
      });
      if (result.kind === "deny") {
        throw forbidden(result.message, result.code);
      }

      if (parsed.data.expectedMissionVersion === undefined) {
        throw badRequestWithCode(
          "EXPECTED_MISSION_VERSION_REQUIRED",
          "Manual activation requires `expectedMissionVersion` (the Mission version the caller observed).",
        );
      }

      // Lifecycle actor type comes from the auth context, never the body.
      const lifecycleActor =
        actor.type === "human" ? { type: "human" as const, id: actor.id } : null;
      if (!lifecycleActor) {
        // Already gated by checkManualCommandAuthority; defensive only.
        throw forbidden("Activate is human-only");
      }
      const outcome = activateCorrectiveMissionLifecycle({
        findingId: existing.id,
        actor: { ...lifecycleActor, authority: {} },
        expectedMissionVersion: parsed.data.expectedMissionVersion,
      });
      const activation = mapLifecycleOutcome(outcome, reply, {
        actorId: lifecycleActor.id,
        findingId: existing.id,
      });
      return { activation };
    },
  );

  /**
   * POST /triage/findings/:id/resolve — terminal resolution (human-only).
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/resolve",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = resolveFindingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = authorityActorFromRequest(request);
      const result = checkManualCommandAuthority({
        finding: {
          id: existing.id,
          habitatId: existing.habitatId,
          admittedByInvestigationTaskId: existing.admittedByInvestigationTaskId,
        },
        actor,
        access: defaultHabitatAccessChecker(),
        command: "resolve",
      });
      if (result.kind === "deny") {
        throw forbidden(result.message, result.code);
      }

      // Lifecycle actor type comes from the auth context, never the request body.
      const lifecycleActor =
        actor.type === "human" ? { type: "human" as const, id: actor.id } : null;
      if (!lifecycleActor) {
        // Already gated by checkManualCommandAuthority; defensive only.
        throw forbidden("Resolve is human-only");
      }
      const outcome = resolveFindingLifecycle({
        findingId: existing.id,
        actor: { ...lifecycleActor, authority: {} },
        resolution: parsed.data.resolution,
        resolutionKind: parsed.data.resolutionKind,
        rootCause: parsed.data.rootCause,
      });
      const updated = mapLifecycleOutcome(outcome, reply, {
        actorId: lifecycleActor.id,
        findingId: existing.id,
      });
      return { finding: updated };
    },
  );

  /**
   * POST /triage/findings/:id/wontfix — terminal wontfix (human-only).
   */
  fastify.post<{ Params: { id: string } }>(
    "/triage/findings/:id/wontfix",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = wontfixFindingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }
      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = authorityActorFromRequest(request);
      const result = checkManualCommandAuthority({
        finding: {
          id: existing.id,
          habitatId: existing.habitatId,
          admittedByInvestigationTaskId: existing.admittedByInvestigationTaskId,
        },
        actor,
        access: defaultHabitatAccessChecker(),
        command: "wontfix",
      });
      if (result.kind === "deny") {
        throw forbidden(result.message, result.code);
      }

      const lifecycleActor =
        actor.type === "human" ? { type: "human" as const, id: actor.id } : null;
      if (!lifecycleActor) {
        throw forbidden("Wontfix is human-only");
      }
      const outcome = markFindingWontfixLifecycle({
        findingId: existing.id,
        actor: { ...lifecycleActor, authority: {} },
        reason: parsed.data.reason,
      });
      const updated = mapLifecycleOutcome(outcome, reply, {
        actorId: lifecycleActor.id,
        findingId: existing.id,
      });
      return { finding: updated };
    },
  );

  // NOTE (writer closure, restored lifecycle T8): the superseded
  // `POST /triage/findings/:id/promote` route was REMOVED. It promoted the
  // Finding and then created a REPLACEMENT corrective Mission with a
  // swallow-on-failure back-link (the partial-state defect from the candidate
  // investigation). Manual activation now crosses
  // `POST /triage/findings/:id/activate`, which activates the Finding's
  // EXISTING corrective Mission and never creates or replaces the link.

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
        .toSorted((a, b) => b.signalCount - a.signalCount)
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
      detectedBy: "api",
      releaseNotes: body.releaseNotes,
    });
    return result;
  });
}
