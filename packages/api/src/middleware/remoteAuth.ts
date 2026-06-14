import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  RemoteActionScope,
  ParticipantStanding,
  RemoteParticipantType,
} from "@orcy/shared/types";
import { unauthorized, forbidden } from "../errors.js";
import { setAuditActor, updateAuditProvenance } from "../services/auditProvenanceContext.js";
import { extractAndVerifyJwt } from "./jwt-verification.js";
import * as agentService from "../services/agentService.js";
import * as credentialService from "../services/remoteCredentialService.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import type { RemoteParticipantRow } from "../repositories/remoteParticipant.js";
import * as podRepo from "../repositories/remotePod.js";
import type { RemotePodRow } from "../repositories/remotePod.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow } from "../repositories/remoteGrant.js";

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
  }
}

const GRACE_ACTIONS: RemoteActionScope[] = ["heartbeat", "submit", "release"];

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

function mapParticipantToActorType(
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
    const grantResult = evaluateGrantsForAction(ctx.grants, action, standing);

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
    STANDING_ACTION_NOT_PERMITTED: 2,
    ACTION_NOT_IN_GRANT_SCOPES: 1,
  };

  let best: GrantEvaluationResult | null = null;

  for (const grant of grants) {
    const result = evaluateGrant(grant, action, standing);
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

  const isGracePeriod = status === "expired" || status === "soft_revoked" || status === "grace";

  if (isGracePeriod && !GRACE_ACTIONS.includes(action)) {
    return {
      allowed: false,
      reason: `Grant is in ${status} state — only heartbeat, submit, and release are allowed during grace`,
      code: "GRANT_GRACE_ACTION_BLOCKED",
    };
  }

  // Enforce grace window timeout — grace actions are blocked after graceWindowHours elapses
  if (isGracePeriod) {
    const graceStartTime = grant.expiredAt ?? grant.revokedAt;
    if (graceStartTime) {
      const elapsedMs = Date.now() - new Date(graceStartTime).getTime();
      const graceMs = grant.graceWindowHours * 3_600_000;
      if (elapsedMs > graceMs) {
        return {
          allowed: false,
          reason: `Grant grace window (${grant.graceWindowHours}h) has elapsed`,
          code: "GRACE_WINDOW_ELAPSED",
        };
      }
    }
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

  const observerActions: RemoteActionScope[] = ["read", "comment", "pulse.post"];
  const contributorActions: RemoteActionScope[] = [
    "read",
    "comment",
    "pulse.post",
    "claim",
    "heartbeat",
    "submit",
    "release",
    "evidence_link",
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
  const hasUsableGrant = grants.some((g) => g.status !== "hard_revoked" && g.status !== "frozen");
  if (!hasUsableGrant) {
    return { valid: false, reason: "All grants are revoked or frozen", code: "ALL_GRANTS_BLOCKED" };
  }

  return { valid: true, reason: "OK", code: "OK" };
}
