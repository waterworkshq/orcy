import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  RemoteActionScope,
  ParticipantStanding,
  RemoteParticipantType,
} from "@orcy/shared/types";
import { unauthorized, forbidden, isAppError, AppError } from "../errors.js";
import {
  setAuditActor,
  updateAuditProvenance,
  setRemoteAuditContext,
} from "../services/auditProvenanceContext.js";
import { extractAndVerifyJwt } from "./jwt-verification.js";
import * as agentService from "../services/agentService.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import type { RemoteParticipantRow } from "../repositories/remoteParticipant.js";
import * as podRepo from "../repositories/remotePod.js";
import type { RemotePodRow } from "../repositories/remotePod.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow } from "../repositories/remoteGrant.js";
import { getHabitatById } from "../repositories/habitat.js";
import { evaluateGrantTime, isEffectivelyUsable } from "../services/remoteGrantTime.js";

export interface RemoteParticipantContext {
  participant: RemoteParticipantRow;
  pod: RemotePodRow;
  credentialId: string;
  habitatId: string;
  grants: RemoteGrantRow[];
}

declare module "fastify" {
  interface FastifyRequest {
    remoteParticipant?: RemoteParticipantContext;
    /**
     * Trusted, route-owned mark identifying a request being admitted to the
     * remote SSE stream route.
     *
     * Set ONLY by that route's own `onRequest` hook, which runs before every
     * preHandler — including the policy-installed authentication guard, which
     * the route cannot wrap. It is never derived from a header, body, or query
     * value, it is absent by default on every other route, and it carries no
     * authority on its own: {@link isRemoteStreamAdmissionRequest} also requires
     * the remote-credential path, so a local human or agent stream is
     * unaffected.
     */
    remoteStreamAdmission?: true;
  }
}

const GRACE_ACTIONS: RemoteActionScope[] = ["heartbeat", "submit", "release"];

// ---------------------------------------------------------------------------
// Remote stream admission mapping
// ---------------------------------------------------------------------------

/**
 * Generic client-facing bodies for the remote stream. One message/code per
 * status: the remote client learns that it was refused, never WHY, so the
 * admission stages cannot be told apart to probe for grant, standing, Habitat
 * or credential state.
 */
export const REMOTE_STREAM_UNAUTHORIZED_MESSAGE = "Remote stream authentication failed";
export const REMOTE_STREAM_UNAUTHORIZED_CODE = "REMOTE_STREAM_UNAUTHORIZED";
export const REMOTE_STREAM_FORBIDDEN_MESSAGE = "Remote stream access denied";
export const REMOTE_STREAM_FORBIDDEN_CODE = "REMOTE_STREAM_FORBIDDEN";
export const REMOTE_STREAM_INTERNAL_MESSAGE = "Remote stream unavailable";
export const REMOTE_STREAM_INTERNAL_CODE = "REMOTE_STREAM_INTERNAL";

/**
 * True only for a request that (a) carries the trusted route-owned stream mark
 * AND (b) is actually attempting remote authentication — an established remote
 * context, or a presented remote credential. The header is used only to
 * recognise the remote AUTHENTICATION PATH here; the mark itself is never
 * attacker-influenced.
 */
export function isRemoteStreamAdmissionRequest(request: FastifyRequest): boolean {
  if (request.remoteStreamAdmission !== true) return false;
  if (request.remoteParticipant) return true;
  return typeof request.headers["x-orcy-remote-key"] === "string";
}

/**
 * Run one remote-stream admission step, translating any failure into the
 * bounded generic response. Covers EXPECTED denials and UNEXPECTED faults
 * alike: a database or validation fault surfacing from the authentication
 * guard, the Habitat preHandler, or the handler read gate becomes a generic
 * 500 with no exception text, and the original error is logged server-side.
 */
export async function guardRemoteStreamAdmission(
  request: FastifyRequest,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    const statusCode = isAppError(err) ? err.statusCode : 500;
    // The log is itself guarded: a failing logger must never replace the
    // deliberately mapped generic error below with its own exception, which
    // would surface as a bare INTERNAL_ERROR instead.
    try {
      (request.log ?? console).warn(
        {
          participantId: request.remoteParticipant?.participant.id,
          podId: request.remoteParticipant?.pod.id,
          habitatId: request.remoteParticipant?.habitatId,
          stage: "remote_stream_admission",
          originalStatus: statusCode,
          originalCode: isAppError(err) ? err.code : undefined,
          err,
        },
        "remote stream admission denied",
      );
    } catch {
      // A failing logger must not prevent the generic mapping.
    }

    if (statusCode === 401) {
      throw unauthorized(REMOTE_STREAM_UNAUTHORIZED_MESSAGE, REMOTE_STREAM_UNAUTHORIZED_CODE);
    }
    // 403 and 404 collapse to one 403: a distinct 404 would be an existence
    // oracle for the requested Habitat.
    if (statusCode === 403 || statusCode === 404) {
      throw forbidden(REMOTE_STREAM_FORBIDDEN_MESSAGE, REMOTE_STREAM_FORBIDDEN_CODE);
    }
    // internalError(message, details?) pins its code to INTERNAL_ERROR and
    // stores the second argument in `details` — the remote-stream contract
    // needs the code ITSELF to be the bounded generic one, so construct the
    // AppError explicitly with no details (the client body is exactly the
    // two-field generic object). Local error semantics elsewhere unchanged.
    throw new AppError(500, REMOTE_STREAM_INTERNAL_CODE, REMOTE_STREAM_INTERNAL_MESSAGE);
  }
}

export async function remoteParticipantAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const rawKey = request.headers["x-orcy-remote-key"] as string | undefined;
  if (!rawKey) {
    throw unauthorized("Missing X-Orcy-Remote-Key header", "MISSING_REMOTE_KEY");
  }

  const verified = credentialService.verifyRemoteKey(rawKey);
  if (!verified) {
    throw unauthorized("Invalid remote credential key", "INVALID_REMOTE_KEY");
  }

  const credential = verified.credential;
  const participant = participantRepo.getRemoteParticipantById(credential.remoteParticipantId);
  if (!participant) {
    throw unauthorized("Remote participant not found", "REMOTE_PARTICIPANT_NOT_FOUND");
  }
  if (participant.status !== "active") {
    throw forbidden("Remote participant is not active", "REMOTE_PARTICIPANT_INACTIVE");
  }

  const pod = podRepo.getRemotePodById(participant.remotePodId);
  if (!pod) {
    throw unauthorized("Remote pod not found", "REMOTE_POD_NOT_FOUND");
  }
  if (pod.status !== "active") {
    throw forbidden("Remote pod is not active", "REMOTE_POD_INACTIVE");
  }

  // Guard against habitat ID mismatch between participant, pod, and credential
  if (participant.habitatId !== pod.habitatId || participant.habitatId !== credential.habitatId) {
    throw forbidden(
      "Habitat ID mismatch between credential, participant, and pod",
      "HABITAT_MISMATCH",
    );
  }

  // Reject local_member standing on remote participants — they must not bypass scope checks
  if (participant.standing === "local_member") {
    throw forbidden("Remote participant cannot have local_member standing", "INVALID_STANDING");
  }

  const grants = loadRelevantGrants(participant, pod);

  credentialService.touchLastUsed(credential.id);

  request.remoteParticipant = {
    participant,
    pod,
    credentialId: credential.id,
    habitatId: credential.habitatId,
    grants,
  };

  const actorType = mapParticipantToActorType(participant.participantType as RemoteParticipantType);
  setAuditActor(actorType, participant.id);

  // Determine the most-relevant grant for the remote context. If multiple
  // grants apply, pick the first one for attribution; downstream event
  // creators can also include the full grants list.
  const primaryGrant = grants[0];

  setRemoteAuditContext({
    podId: pod.id,
    participantId: participant.id,
    standing: participant.standing as
      | "remote_observer"
      | "remote_contributor"
      | "remote_reviewer"
      | "trusted_remote_pod"
      | "local_member",
    credentialId: credential.id,
    grantId: primaryGrant?.id,
    actionKind: "execution",
    providerIdentity: participant.externalIdentityId,
  });

  updateAuditProvenance({
    source: "rest_api",
  });
}

function loadRelevantGrants(
  participant: RemoteParticipantRow,
  pod: RemotePodRow,
): RemoteGrantRow[] {
  const allGrants = grantRepo.getGrantsByHabitat(participant.habitatId);
  return allGrants.filter(
    (g) =>
      g.remoteParticipantId === participant.id ||
      (g.remotePodId === pod.id && g.remoteParticipantId === null),
  );
}

export function mapParticipantToActorType(
  participantType: RemoteParticipantType,
): "remote_orcy" | "remote_human" {
  return participantType === "remote_orcy" ? "remote_orcy" : "remote_human";
}

export function remoteActionScope(action: RemoteActionScope) {
  return async function remoteActionScopeMiddleware(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const ctx = request.remoteParticipant;
    if (!ctx) {
      throw unauthorized("Remote participant authentication required", "REMOTE_AUTH_REQUIRED");
    }

    const standing = ctx.participant.standing as ParticipantStanding;
    // One clock value per authorization decision, shared by every candidate
    // grant, so two grants in the same request can never be judged against two
    // different instants.
    const grantResult = evaluateGrantsForAction(ctx.grants, action, standing, Date.now());

    if (!grantResult.allowed) {
      // Log the detailed reason server-side, but return a generic message
      // to the caller. The code is safe to expose (non-sensitive identifier).
      // The detailed reason would leak grant status, scopes, and standing to
      // the remote actor, enabling probing attacks.
      const logger = request.log ?? console;
      logger.warn(
        {
          participantId: ctx.participant.id,
          podId: ctx.pod.id,
          habitatId: ctx.habitatId,
          action,
          code: grantResult.code,
          internalReason: grantResult.reason,
        },
        "remote action denied",
      );
      throw forbidden("Remote action not permitted", grantResult.code);
    }

    updateAuditProvenance({
      source: "rest_api",
    });
  };
}

interface GrantEvaluationResult {
  allowed: boolean;
  reason: string;
  code: string;
  grant?: RemoteGrantRow;
}

function evaluateGrantsForAction(
  grants: RemoteGrantRow[],
  action: RemoteActionScope,
  standing: ParticipantStanding,
  now: number,
): GrantEvaluationResult {
  if (grants.length === 0) {
    return {
      allowed: false,
      reason: "No grants found for this remote participant",
      code: "NO_ACTIVE_GRANTS",
    };
  }

  const priority: Record<string, number> = {
    GRANT_HARD_REVOKED: 5,
    GRANT_FROZEN: 5,
    GRANT_GRACE_ACTION_BLOCKED: 4,
    GRANT_GRACE_STANDING_INSUFFICIENT: 3,
    GRANT_NOT_EFFECTIVELY_ACTIVE: 3,
    GRACE_WINDOW_ELAPSED: 2,
    STANDING_ACTION_NOT_PERMITTED: 2,
    ACTION_NOT_IN_GRANT_SCOPES: 1,
  };

  let best: GrantEvaluationResult | null = null;

  for (const grant of grants) {
    const result = evaluateGrant(grant, action, standing, now);
    if (result.allowed) return result;
    if (!best || priority[result.code] > (priority[best.code] ?? 0)) {
      best = result;
    }
  }

  return best!;
}

function evaluateGrant(
  grant: RemoteGrantRow,
  action: RemoteActionScope,
  standing: ParticipantStanding,
  now: number,
): GrantEvaluationResult {
  const status = grant.status;

  if (status === "hard_revoked") {
    return {
      allowed: false,
      reason: "Grant is hard-revoked — all remote actions blocked",
      code: "GRANT_HARD_REVOKED",
    };
  }

  if (status === "frozen") {
    return {
      allowed: false,
      reason: "Grant is frozen — remote actions blocked pending host review",
      code: "GRANT_FROZEN",
    };
  }

  // Authority is a function of (stored status, stored timestamps, now) — the
  // persisted status alone never decides. A grant whose configured deadline has
  // passed contributes grace (or nothing), never ordinary authority, no matter
  // how recently a sweep stamped the row.
  const effective = evaluateGrantTime(grant, now);

  if (effective.state === "blocked") {
    return {
      allowed: false,
      reason: `Grant carries no effective authority (${effective.reason})`,
      code:
        effective.reason === "grace_window_elapsed"
          ? "GRACE_WINDOW_ELAPSED"
          : "GRANT_NOT_EFFECTIVELY_ACTIVE",
    };
  }

  const isGracePeriod = effective.state === "grace";

  if (isGracePeriod && !GRACE_ACTIONS.includes(action)) {
    return {
      allowed: false,
      reason: `Grant is in grace state — only heartbeat, submit, and release are allowed during grace`,
      code: "GRANT_GRACE_ACTION_BLOCKED",
    };
  }

  if (isGracePeriod && action === "submit" && standing !== "remote_contributor") {
    return {
      allowed: false,
      reason: "Submit during grace requires remote_contributor standing",
      code: "GRANT_GRACE_STANDING_INSUFFICIENT",
    };
  }

  const scopes = grant.actionScopes as RemoteActionScope[];
  if (!scopes.includes(action)) {
    return {
      allowed: false,
      reason: `Action '${action}' not in grant scopes [${scopes.join(", ")}]`,
      code: "ACTION_NOT_IN_GRANT_SCOPES",
    };
  }

  if (!isActionAllowedForStanding(action, standing)) {
    return {
      allowed: false,
      reason: `Action '${action}' not permitted for standing '${standing}'`,
      code: "STANDING_ACTION_NOT_PERMITTED",
    };
  }

  return {
    allowed: true,
    reason: "OK",
    code: "OK",
    grant,
  };
}

function isActionAllowedForStanding(
  action: RemoteActionScope,
  standing: ParticipantStanding,
): boolean {
  if (standing === "local_member") return true;

  const observerActions: RemoteActionScope[] = [
    "read",
    "comment",
    "pulse.post",
    "notification.write",
  ];
  const contributorActions: RemoteActionScope[] = [
    "read",
    "comment",
    "pulse.post",
    "claim",
    "heartbeat",
    "submit",
    "release",
    "evidence_link",
    "notification.write",
    "triage.route",
  ];

  if (standing === "remote_observer") return observerActions.includes(action);
  if (standing === "remote_contributor") return contributorActions.includes(action);

  return false;
}

export async function agentOrHumanOrRemoteAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const remoteKey = request.headers["x-orcy-remote-key"] as string | undefined;
  if (remoteKey) {
    await remoteParticipantAuth(request, _reply);
    return;
  }

  const apiKey = request.headers["x-agent-api-key"] as string | undefined;
  if (apiKey) {
    const agent = agentService.getAgentByApiKey(apiKey);
    if (agent) {
      request.agent = agent;
      setAuditActor("agent", agent.id);
      return;
    }
    throw unauthorized("Invalid API key", "INVALID_API_KEY");
  }

  const { user, error } = extractAndVerifyJwt(request, { allowBearer: true });
  if (error) {
    throw unauthorized(error.message, error.code ?? "UNAUTHORIZED");
  }
  request.user = { ...user!, role: user!.role as "admin" | "editor" | "viewer" };
  setAuditActor("human", user!.id);
}

export interface RemoteConnectionValidation {
  valid: boolean;
  reason: string;
  code: string;
}

export function isRemoteConnectionValid(ctx: RemoteParticipantContext): RemoteConnectionValidation {
  const credential = credentialService.verifyRemoteKeyById(ctx.credentialId);
  if (!credential) {
    return { valid: false, reason: "Credential no longer valid", code: "CREDENTIAL_INVALID" };
  }

  const participant = participantRepo.getRemoteParticipantById(ctx.participant.id);
  if (!participant || participant.status !== "active") {
    return { valid: false, reason: "Participant no longer active", code: "PARTICIPANT_INACTIVE" };
  }

  const pod = podRepo.getRemotePodById(ctx.pod.id);
  if (!pod || pod.status !== "active") {
    return { valid: false, reason: "Pod no longer active", code: "POD_INACTIVE" };
  }

  const grants = loadRelevantGrants(participant, pod);
  // Effective state, not the persisted status: a row still marked `active`
  // whose deadline has passed is only usable during grace, and a row with no
  // honest grace start is not usable at all. Connection validity deliberately
  // stays BROADER than read authority — it may be satisfied by grace, while a
  // remote stream additionally requires active read.
  const now = Date.now();
  const hasUsableGrant = grants.some((g) => isEffectivelyUsable(g, now));
  if (!hasUsableGrant) {
    return { valid: false, reason: "All grants are revoked or frozen", code: "ALL_GRANTS_BLOCKED" };
  }

  return { valid: true, reason: "OK", code: "OK" };
}

// ---------------------------------------------------------------------------
// Remote stream read refresh
// ---------------------------------------------------------------------------

/**
 * Immutable connection anchors captured when a remote stream was admitted. A
 * refresh compares current persisted state against THESE values and never
 * against a newer identity, so a rebound credential, a re-homed participant, or
 * a drifted Habitat binding invalidates the stream instead of being silently
 * adopted.
 */
export interface RemoteStreamAnchors {
  credentialId: string;
  participantId: string;
  podId: string;
  habitatId: string;
}

export interface RemoteStreamRefresh {
  valid: boolean;
  code: string;
  reason: string;
  /**
   * Freshly loaded context carrying the current participant, pod and the
   * stream-scoped relevant grants. Present only when `valid` is true.
   */
  ctx?: RemoteParticipantContext;
}

/**
 * Grants relevant AT THE STREAM BOUNDARY ONLY: same Habitat, same pod, and
 * either this exact participant or pod-wide (no participant). A
 * participant-specific grant bound to a DIFFERENT pod is inconsistent and is
 * excluded here. This composite filter is deliberately NOT applied to general
 * HTTP action/visibility helpers — their relevance universe is unchanged apart
 * from effective time.
 */
function loadStreamRelevantGrants(
  participantId: string,
  podId: string,
  habitatId: string,
): RemoteGrantRow[] {
  return grantRepo
    .getGrantsByHabitat(habitatId)
    .filter(
      (g) =>
        g.remotePodId === podId &&
        (g.remoteParticipantId === participantId || g.remoteParticipantId === null),
    );
}

/**
 * Re-establish remote stream READ authority from current persisted state.
 *
 * Read-only by construction: it deliberately does NOT go through
 * {@link remoteParticipantAuth}, which would mutate credential `lastUsedAt` and
 * stamp request-scoped audit provenance on what is a per-event visibility
 * decision. One clock value is captured and used for every check here.
 */
export function refreshRemoteStreamRead(
  anchors: RemoteStreamAnchors,
  now: number = Date.now(),
): RemoteStreamRefresh {
  const deny = (code: string, reason: string): RemoteStreamRefresh => ({
    valid: false,
    code,
    reason,
  });

  const credential = credentialService.verifyRemoteKeyById(anchors.credentialId);
  if (!credential) return deny("CREDENTIAL_INVALID", "Credential no longer valid");
  if (credential.remoteParticipantId !== anchors.participantId) {
    return deny("CREDENTIAL_REBOUND", "Credential was reassigned to another participant");
  }
  if (credential.habitatId !== anchors.habitatId) {
    return deny("HABITAT_DRIFT", "Credential Habitat no longer matches the stream Habitat");
  }

  const participant = participantRepo.getRemoteParticipantById(anchors.participantId);
  if (!participant) return deny("PARTICIPANT_GONE", "Participant no longer exists");
  if (participant.status !== "active") {
    return deny("PARTICIPANT_INACTIVE", "Participant is not active");
  }
  if (participant.remotePodId !== anchors.podId) {
    return deny("PARTICIPANT_REBOUND", "Participant was moved to a different pod");
  }
  if (participant.habitatId !== anchors.habitatId) {
    return deny("HABITAT_DRIFT", "Participant Habitat no longer matches the stream Habitat");
  }
  // Standing is re-read every time: a promotion or demotion must take effect on
  // the next event decision, not at the next reconnect.
  if (participant.standing === "local_member") {
    return deny("STANDING_NOT_REMOTE", "Participant standing is no longer a remote standing");
  }

  const pod = podRepo.getRemotePodById(anchors.podId);
  if (!pod) return deny("POD_GONE", "Pod no longer exists");
  if (pod.status !== "active") return deny("POD_INACTIVE", "Pod is not active");
  if (pod.habitatId !== anchors.habitatId) {
    return deny("HABITAT_DRIFT", "Pod Habitat no longer matches the stream Habitat");
  }

  if (!getHabitatById(anchors.habitatId)) {
    return deny("HABITAT_GONE", "Subscribed Habitat no longer exists");
  }

  const grants = loadStreamRelevantGrants(anchors.participantId, anchors.podId, anchors.habitatId);

  // Read authority requires an EFFECTIVELY ACTIVE grant carrying `read` for
  // this participant's current standing. Grace never buys a read or a stream.
  const readResult = evaluateGrantsForAction(
    grants,
    "read",
    participant.standing as ParticipantStanding,
    now,
  );
  if (!readResult.allowed) {
    return deny("NO_ACTIVE_READ_AUTHORITY", `No active read authority (${readResult.code})`);
  }

  return {
    valid: true,
    code: "OK",
    reason: "OK",
    ctx: {
      participant,
      pod,
      credentialId: anchors.credentialId,
      habitatId: anchors.habitatId,
      grants,
    },
  };
}
