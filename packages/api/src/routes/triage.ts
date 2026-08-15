import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "crypto";
import { z } from "zod";
import {
  FINDING_TRIAGE_STATUSES,
  RELEASE_TYPES,
  RESOLUTION_KINDS,
  SUGGESTED_BUCKETS,
  TERMINAL_FINDING_TRIAGE_STATUSES,
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
  withImmediateLifecycleTransaction,
  type RoutePayload,
  type LifecycleOutcome,
} from "../services/findingTriageLifecycle.js";
import {
  checkRouteAuthority,
  checkManualCommandAuthority,
  defaultHabitatAccessChecker,
  habitatAccessCheckerWithClient,
  type AuthorityActor,
  type AuthorityFindingShape,
} from "../services/triageLifecycleAuthority.js";
import { agentOrHumanAuth } from "../middleware/auth.js";
import { getHabitatById } from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
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
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";

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

const patchFindingBodySchema = z
  .object({
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
    triageMissionId: z.string().max(200).nullable().optional(),
    expectedMissionVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

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
   * PATCH /triage/findings/:id — strict legacy compatibility matrix
   * (restored lifecycle T4; unlink shape REMOVED in FU6). Only two narrow
   * shapes are accepted:
   *
   *   1. No-work: `{status: 'triaged', bucket: 'document_as_known_limitation' | 'needs_investigation'}`
   *   2. First link-only: `{triageMissionId: string, expectedMissionVersion: number}`
   *
   * The former unlink shape `{triageMissionId: null}` is REJECTED with 400
   * `LEGACY_PATCH_UNLINK_REMOVED` (zero writes) — it exceeded the approved
   * compatibility matrix, had zero production callers post-T8, and bypassed
   * the actor matrix. Corrective links are managed by the lifecycle commands.
   *
   * Everything else is rejected before write with 400 + deprecation telemetry.
   * Mixed/multi-intent shapes, target-release mutations, terminal→non-terminal
   * transitions, fix_now/deferral-without-Mission-placement, and
   * status=resolved/wontfix-without-Resolution are all rejected.
   *
   * Stored-fingerprint replay wins before the no-link/version predicates —
   * a committed legacy link with a lost response replays despite later
   * legitimate Mission edits.
   */
  fastify.patch<{ Params: { id: string } }>(
    "/triage/findings/:id",
    { preHandler: agentOrHumanAuth },
    async (request, reply) => {
      const parsed = patchFindingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Validation failed", parsed.error.flatten());
      }

      // Reject target-release mutations (superseded by the restored lifecycle).
      if (parsed.data.targetRelease !== undefined || parsed.data.targetReleaseType !== undefined) {
        logger.warn(
          { findingId: request.params.id },
          "triage legacy PATCH: target-release mutation superseded by POST /triage/findings/:id/route",
        );
        throw badRequestWithCode(
          "LEGACY_PATCH_TARGET_RELEASE_SUPERSEDED",
          "Target-release mutations are superseded; use POST /triage/findings/:id/route instead.",
        );
      }

      const hasStatusOrBucket =
        parsed.data.status !== undefined || parsed.data.bucket !== undefined;
      const hasLink = parsed.data.triageMissionId !== undefined;
      if (!hasStatusOrBucket && !hasLink) {
        throw badRequest(
          "Provide one of `status`+`bucket`, or `triageMissionId` (+ `expectedMissionVersion` for non-null link).",
        );
      }

      // Mixed/multi-intent shapes are rejected before write.
      if (hasStatusOrBucket && hasLink) {
        logger.warn(
          { findingId: request.params.id },
          "triage legacy PATCH: mixed/multi-intent shape rejected",
        );
        throw badRequestWithCode(
          "LEGACY_PATCH_MIXED",
          "Mixed legacy PATCH shapes are rejected; use one of the dedicated intent endpoints.",
        );
      }

      // FU6 — unlink shape REMOVED. `{triageMissionId: null}` was never part
      // of the approved compatibility matrix, has zero production callers
      // post-T8, and bypassed the actor matrix (any local agent key in a
      // non-team Habitat could sever another Finding's corrective link).
      // Rejected before any DB read/write with a stable code; remediation is
      // a client upgrade, NOT re-adding the shape (see docs/API.md +
      // docs/TROUBLESHOOTING.md).
      if (parsed.data.triageMissionId === null) {
        logger.warn(
          { findingId: request.params.id },
          "triage legacy PATCH: unlink shape removed (LEGACY_PATCH_UNLINK_REMOVED); use the lifecycle commands",
        );
        throw badRequestWithCode(
          "LEGACY_PATCH_UNLINK_REMOVED",
          "The legacy unlink shape (`triageMissionId: null`) was removed. Corrective Mission links are managed by the triage lifecycle commands (route/activate); upgrade the client.",
        );
      }

      // Terminal status via PATCH without a full Resolution payload is rejected —
      // the resolve/wontfix endpoints own the canonical terminalization shape.
      if (parsed.data.status === "resolved" || parsed.data.status === "wontfix") {
        logger.warn(
          { findingId: request.params.id, status: parsed.data.status },
          "triage legacy PATCH: terminal status without full Resolution payload rejected",
        );
        throw badRequestWithCode(
          "LEGACY_PATCH_TERMINAL_REQUIRES_RESOLUTION",
          "Terminal status requires full Resolution payload; use POST /triage/findings/:id/resolve or /wontfix.",
        );
      }

      // Fix_now or deferral buckets via PATCH are illegal — they require complete
      // Mission placement, which the lifecycle kernel owns.
      if (
        parsed.data.bucket !== undefined &&
        (parsed.data.bucket === "fix_now" ||
          parsed.data.bucket === "defer_to_patch" ||
          parsed.data.bucket === "defer_to_release")
      ) {
        logger.warn(
          { findingId: request.params.id, bucket: parsed.data.bucket },
          "triage legacy PATCH: work-bearing bucket rejected — must route through POST /triage/findings/:id/route",
        );
        throw badRequestWithCode(
          "LEGACY_PATCH_WORK_BEARING_REJECTED",
          "Work-bearing buckets require complete Mission placement; use POST /triage/findings/:id/route.",
        );
      }

      const existing = findingTriageRepo.getById(request.params.id);
      if (!existing) throw notFound("Finding not found");
      verifyHabitatAccess(request, existing.habitatId);

      const actor = actorFromRequest(request);

      // Terminal immutability: any status transition OUT of a terminal state
      // is rejected (recurrence creates a new row).
      if (
        parsed.data.status !== undefined &&
        parsed.data.status !== existing.status &&
        (TERMINAL_FINDING_TRIAGE_STATUSES as readonly string[]).includes(existing.status)
      ) {
        throw conflictWithCode(
          "FINDING_TERMINAL",
          `Finding is in terminal state (${existing.status}). Recurrence creates a new row.`,
        );
      }

      // ---------------------------------------------------------------
      // No-work shape: dispatch through the lifecycle command kernel.
      // ---------------------------------------------------------------
      if (hasStatusOrBucket) {
        if (parsed.data.status !== "triaged" || parsed.data.bucket === undefined) {
          throw badRequestWithCode(
            "LEGACY_PATCH_INVALID_NO_WORK",
            "Legacy PATCH only accepts `{status:'triaged', bucket: <no-work>}` for the no-work shape.",
          );
        }
        const routePayload: RoutePayload =
          parsed.data.bucket === "document_as_known_limitation"
            ? { bucket: "document_as_known_limitation" }
            : { bucket: "needs_investigation" };

        const { actor: authActor, finding } = authorizeLocalRoute({ finding: existing, request });
        const outcome = routeFindingLifecycle({
          findingId: finding.id,
          actor: { ...authActor, authority: {} },
          route: routePayload,
        });
        const updated = mapLifecycleOutcome(outcome, reply, {
          actorId: actor.id,
          findingId: finding.id,
        });
        logger.info(
          { findingId: finding.id, bucket: routePayload.bucket, outcome: outcome.outcome },
          "triage legacy PATCH: no-work route dispatched",
        );
        return { finding: updated };
      }

      // ---------------------------------------------------------------
      // Link-only shape: {triageMissionId, expectedMissionVersion}.
      // (The unlink shape is rejected above — FU6.)
      // ---------------------------------------------------------------
      const expectedVersion = parsed.data.expectedMissionVersion;

      // ---- ACTOR MATRIX (FU6) ----
      // First-link is human Habitat-write authority (editor/admin at minimum;
      // viewers and local agent keys are denied — the legacy adapter used to
      // perform only generic habitat visibility, letting any local agent key
      // first-link an eligible deferral to an arbitrary gated Mission).
      const linkActor = authorityActorFromRequest(request);
      const linkAuthority = checkManualCommandAuthority({
        finding: {
          id: existing.id,
          habitatId: existing.habitatId,
          admittedByInvestigationTaskId: existing.admittedByInvestigationTaskId,
        },
        actor: linkActor,
        access: defaultHabitatAccessChecker(),
        command: "link",
      });
      if (linkAuthority.kind === "deny") {
        throw forbidden(linkAuthority.message, linkAuthority.code);
      }

      // Non-null link requires expectedMissionVersion + same-Habitat +
      // version-matched + non-archived + non-terminal gated Mission.
      if (
        typeof expectedVersion !== "number" ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw badRequestWithCode(
          "LEGACY_LINK_VERSION_REQUIRED",
          "Legacy link-only PATCH requires `expectedMissionVersion` (non-negative integer).",
        );
      }

      // ---- STORED-FINGERPRINT REPLAY (BEFORE no-link/version predicates) ----
      // If the Finding already has a correctiveMissionId === requested AND a
      // stored fingerprint, this is a lost-response replay — succeed even if
      // the Mission has been edited since.
      if (
        existing.correctiveMissionId === parsed.data.triageMissionId &&
        existing.routeFingerprint !== null
      ) {
        logger.info(
          { findingId: existing.id, missionId: existing.correctiveMissionId },
          "triage legacy PATCH: stored-fingerprint replay before no-link/version predicates",
        );
        return { finding: existing, replay: true };
      }

      // ---- NO-LINK PREDICATE: first apply requires no current link ----
      if (existing.correctiveMissionId !== null) {
        throw conflictWithCode(
          "LEGACY_PATCH_ALREADY_LINKED",
          "Finding already linked; legacy PATCH first-apply requires an unlinked Finding.",
        );
      }

      // ---- First-apply validation: triaged deferral bucket ----
      if (
        existing.status !== "triaged" ||
        (existing.bucket !== "defer_to_patch" && existing.bucket !== "defer_to_release")
      ) {
        throw badRequestWithCode(
          "LEGACY_LINK_NOT_TRIAGED_DEFERRAL",
          "Legacy link-only first apply requires a Finding in `triaged` state with a deferral bucket (defer_to_patch or defer_to_release).",
        );
      }

      if (existing.legacyLineageRepairRequired) {
        throw conflictWithCode(
          "LEGACY_LINK_LINEAGE_REPAIR_REQUIRED",
          "Legacy first link requires a Finding whose lineage is repaired.",
        );
      }

      const targetMissionId: string = parsed.data.triageMissionId as string;
      const targetMission = missionRepo.getMissionById(targetMissionId);
      if (!targetMission) {
        throw notFound("Target mission not found");
      }
      if (targetMission.habitatId !== existing.habitatId) {
        throw badRequestWithCode(
          "LEGACY_LINK_HABITAT_MISMATCH",
          "Target mission must belong to the same habitat as the finding.",
        );
      }
      if (targetMission.version !== expectedVersion) {
        throw conflictWithCode(
          "LEGACY_LINK_VERSION_MISMATCH",
          `Target mission version mismatch (expected ${expectedVersion}, got ${targetMission.version}).`,
        );
      }
      if (targetMission.isArchived) {
        throw conflictWithCode("LEGACY_LINK_ARCHIVED", "Cannot link an archived mission.");
      }
      const missionTerminal = targetMission.status === "done" || targetMission.status === "failed";
      if (missionTerminal) {
        throw conflictWithCode(
          "LEGACY_LINK_MISSION_TERMINAL",
          "Cannot link a terminal-status mission.",
        );
      }
      if (targetMission.releaseGateType === null || targetMission.releaseGateVersion === null) {
        throw conflictWithCode(
          "LEGACY_LINK_NOT_GATED",
          "Legacy link-only first apply requires a gated Mission (non-null releaseGateType/Version).",
        );
      }

      // ---- HOMOGENEOUS GROUP CHECK ----
      // Every other linked (non-terminal) Finding on this Mission must also be
      // triaged and group-eligible. Mixed groups reject before write.
      const allLinked = findingTriageRepo.findByTriageMissionId(targetMission.id).filter(
        (f) => f.id !== existing.id,
      );
      const nonTerminalLinked = allLinked.filter(
        (f) => !(TERMINAL_FINDING_TRIAGE_STATUSES as readonly string[]).includes(f.status),
      );
      const mixedGroup = nonTerminalLinked.some(
        (f) => f.status !== "triaged" || f.legacyLineageRepairRequired,
      );
      if (mixedGroup) {
        throw conflictWithCode(
          "LEGACY_LINK_MIXED_GROUP",
          "Shared Mission has mixed linked Finding states; legacy first link cannot activate.",
        );
      }

      // ---- ATOMIC APPLY (FU6) ----
      // Link + fingerprint are ONE writer-reserved write: the load-bearing
      // predicates (no current link, Mission version/archived/terminal/gate)
      // are re-verified under `BEGIN IMMEDIATE` and both columns land in a
      // single UPDATE (`applyLegacyLinkWithClient`). The former two
      // sequential writes had a crash window that could commit a link with
      // no fingerprint — impossible by construction now.
      const legacyFingerprint = createHash("sha256")
        .update(`${request.params.id}|${targetMission.id}|${expectedVersion}|legacy_link`)
        .digest("hex");
      const linkOutcome = withImmediateLifecycleTransaction((client) => {
        const current = findingTriageRepo.getByIdWithClient(client, request.params.id);
        if (!current) {
          return { outcome: "conflict" as const, reason: "not_found" as const };
        }
        const inTxAuthority = checkManualCommandAuthority({
          finding: {
            id: current.id,
            habitatId: current.habitatId,
            admittedByInvestigationTaskId: current.admittedByInvestigationTaskId,
          },
          actor: linkActor,
          access: habitatAccessCheckerWithClient(client),
          command: "link",
        });
        if (inTxAuthority.kind === "deny") {
          throw forbidden(inTxAuthority.message, inTxAuthority.code);
        }
        // Stored-fingerprint replay re-check under the reservation — BEFORE
        // all state predicates (terminal included), matching the outer path:
        // a same-link retry stays idempotent even if a concurrent
        // terminalization, lineage repair, or other eligibility state moved
        // under us between the precheck read and this reservation.
        if (
          current.correctiveMissionId === targetMission.id &&
          current.routeFingerprint !== null
        ) {
          return { outcome: "replayed" as const, value: current };
        }
        if ((TERMINAL_FINDING_TRIAGE_STATUSES as readonly string[]).includes(current.status)) {
          return {
            outcome: "conflict" as const,
            reason: "terminal" as const,
            current: current.status,
          };
        }
        if (
          current.status !== "triaged" ||
          (current.bucket !== "defer_to_patch" && current.bucket !== "defer_to_release")
        ) {
          throw badRequestWithCode(
            "LEGACY_LINK_NOT_TRIAGED_DEFERRAL",
            "Legacy link-only first apply requires a Finding in `triaged` state with a deferral bucket (defer_to_patch or defer_to_release).",
          );
        }
        if (current.legacyLineageRepairRequired) {
          throw conflictWithCode(
            "LEGACY_LINK_LINEAGE_REPAIR_REQUIRED",
            "Legacy first link requires a Finding whose lineage is repaired.",
          );
        }
        if (current.correctiveMissionId !== null) {
          throw conflictWithCode(
            "LEGACY_PATCH_ALREADY_LINKED",
            "Finding already linked; legacy PATCH first-apply requires an unlinked Finding.",
          );
        }
        const peers = findingTriageRepo
          .listNonTerminalByCorrectiveMissionIdWithClient(client, targetMission.id)
          .filter((f) => f.id !== current.id);
        if (peers.some((f) => f.status !== "triaged" || f.legacyLineageRepairRequired)) {
          throw conflictWithCode(
            "LEGACY_LINK_MIXED_GROUP",
            "Shared Mission has mixed linked Finding states; legacy first link cannot activate.",
          );
        }
        const mission = missionRepo.getMissionByIdWithClient(client, targetMission.id);
        if (!mission) {
          throw notFound("Target mission not found");
        }
        if (mission.version !== expectedVersion) {
          throw conflictWithCode(
            "LEGACY_LINK_VERSION_MISMATCH",
            `Target mission version mismatch (expected ${expectedVersion}, got ${mission.version}).`,
          );
        }
        if (mission.isArchived) {
          throw conflictWithCode("LEGACY_LINK_ARCHIVED", "Cannot link an archived mission.");
        }
        if (mission.status === "done" || mission.status === "failed") {
          throw conflictWithCode(
            "LEGACY_LINK_MISSION_TERMINAL",
            "Cannot link a terminal-status mission.",
          );
        }
        if (mission.releaseGateType === null || mission.releaseGateVersion === null) {
          throw conflictWithCode(
            "LEGACY_LINK_NOT_GATED",
            "Legacy link-only first apply requires a gated Mission (non-null releaseGateType/Version).",
          );
        }
        const updatedFinding = findingTriageRepo.applyLegacyLinkWithClient(
          client,
          request.params.id,
          targetMission.id,
          legacyFingerprint,
        );
        return { outcome: "applied" as const, value: updatedFinding };
      });
      const updated = mapLifecycleOutcome(linkOutcome, reply, {
        actorId: actor.id,
        findingId: request.params.id,
      });
      sseBroadcaster.publish(existing.habitatId, {
        type: "triage.finding_updated",
        data: {
          habitatId: existing.habitatId,
          findingId: updated.id,
          status: updated.status,
          bucket: updated.bucket,
        },
      });
      logger.info(
        {
          findingId: updated.id,
          missionId: targetMission.id,
          expectedVersion: expectedVersion,
        },
        "triage legacy PATCH: first link-only applied",
      );
      return { finding: updated };
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
