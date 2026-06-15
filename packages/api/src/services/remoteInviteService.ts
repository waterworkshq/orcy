import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import type { RemoteInviteType, ParticipantStanding, RemoteActionScope } from "@orcy/shared/types";
import * as inviteRepo from "../repositories/remoteInvite.js";
import type { RemoteInviteRow } from "../repositories/remoteInvite.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import { badRequest, notFound, conflict, forbidden } from "../errors.js";

const MANUAL_TOKEN_PREFIX = "orcy_invite_";

export interface CreateManualInviteInput {
  habitatId: string;
  baselineStanding: ParticipantStanding;
  baselineScopes?: RemoteActionScope[];
  invitedBy: string;
  podDisplayName?: string;
  expiresAt?: string | null;
}

export interface CreateProviderInviteInput {
  habitatId: string;
  providerId: string;
  baselineStanding: ParticipantStanding;
  baselineScopes?: RemoteActionScope[];
  invitedBy: string;
  expiresAt?: string | null;
}

export interface ManualInviteWithToken {
  invite: InviteView;
  oneTimeToken: string;
}

export interface InviteView {
  id: string;
  habitatId: string;
  inviteType: string;
  baselineStanding: string;
  baselineScopes: string[];
  providerId: string | null;
  invitedBy: string;
  status: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
}

function toView(row: RemoteInviteRow): InviteView {
  return {
    id: row.id,
    habitatId: row.habitatId,
    inviteType: row.inviteType,
    baselineStanding: row.baselineStanding,
    baselineScopes: row.baselineScopes,
    providerId: row.providerId,
    invitedBy: row.invitedBy,
    status: row.status,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedBy: row.acceptedBy,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    createdAt: row.createdAt,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateInviteToken(): { plaintextToken: string; tokenHash: string } {
  const plaintextToken = `${MANUAL_TOKEN_PREFIX}${uuid()}-${randomBytes(24).toString("hex")}`;
  const tokenHash = hashToken(plaintextToken);
  return { plaintextToken, tokenHash };
}

/**
 * Creates a pending manual invite and returns it together with the plaintext
 * one-time token that the invitee must present to accept.
 */
export function createManualInvite(input: CreateManualInviteInput): ManualInviteWithToken {
  const { plaintextToken, tokenHash } = generateInviteToken();

  const row = inviteRepo.createRemoteInvite({
    habitatId: input.habitatId,
    inviteType: "manual",
    baselineStanding: input.baselineStanding,
    baselineScopes: (input.baselineScopes ?? ["read"]).map((s) => s as string),
    tokenHash,
    providerId: null,
    invitedBy: input.invitedBy,
    expiresAt: input.expiresAt ?? null,
  });

  return { invite: toView(row), oneTimeToken: plaintextToken };
}

/**
 * Creates a pending provider invite bound to a specific external {@link RemoteInviteType provider}.
 */
export function createProviderInvite(input: CreateProviderInviteInput): InviteView {
  const row = inviteRepo.createRemoteInvite({
    habitatId: input.habitatId,
    inviteType: "provider",
    baselineStanding: input.baselineStanding,
    baselineScopes: (input.baselineScopes ?? ["read"]).map((s) => s as string),
    tokenHash: null,
    providerId: input.providerId,
    invitedBy: input.invitedBy,
    expiresAt: input.expiresAt ?? null,
  });

  return toView(row);
}

/**
 * Returns all invites belonging to the given habitat.
 */
export function listInvites(habitatId: string): InviteView[] {
  return inviteRepo.getRemoteInvitesByHabitat(habitatId).map((row) => toView(row));
}

/**
 * Marks a pending invite as revoked, preventing it from ever being accepted.
 */
export function revokeInvite(
  habitatId: string,
  inviteId: string,
  revokedBy: string,
  revokeReason?: string,
): InviteView {
  const invite = inviteRepo.getRemoteInviteById(inviteId);
  if (!invite || invite.habitatId !== habitatId) {
    throw notFound("Invite not found");
  }
  if (invite.status === "revoked") {
    throw conflict("Invite already revoked");
  }
  if (invite.status === "accepted") {
    throw conflict("Cannot revoke an already-accepted invite");
  }
  const revoked = inviteRepo.revokeRemoteInvite(inviteId, revokedBy, revokeReason);
  if (!revoked) throw notFound("Invite not found");
  return toView(revoked);
}

export interface InviteAcceptanceResult {
  invite: InviteView;
  remotePod: podRepo.RemotePodRow;
  remoteParticipant: participantRepo.RemoteParticipantRow;
}

/**
 * Redeems a manual one-time token by atomically claiming the invite and then
 * provisioning the corresponding remote pod and admin participant with the
 * invite's baseline {@link ParticipantStanding}.
 */
export function acceptManualInvite(
  token: string,
  acceptedBy: string,
  details: {
    podName: string;
    participantDisplayName: string;
    participantType?: "remote_human" | "remote_orcy";
    podDescription?: string;
  },
): InviteAcceptanceResult {
  if (!token || !token.startsWith(MANUAL_TOKEN_PREFIX)) {
    throw badRequest("Invalid invite token format", "INVALID_INVITE_TOKEN");
  }

  const tokenHash = hashToken(token);
  const invite = inviteRepo.getRemoteInviteByTokenHash(tokenHash);
  if (!invite) {
    throw badRequest("Invite token not recognized", "INVITE_NOT_FOUND");
  }
  if (invite.status === "revoked") {
    throw forbidden("Invite has been revoked", "INVITE_REVOKED");
  }
  if (invite.status === "accepted") {
    throw conflict("Invite has already been accepted", "INVITE_ALREADY_ACCEPTED");
  }
  if (invite.status === "expired") {
    throw forbidden("Invite has expired", "INVITE_EXPIRED");
  }

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    throw forbidden("Invite has expired", "INVITE_EXPIRED");
  }

  // Atomically claim the invite first — conditional UPDATE prevents race condition.
  // acceptRemoteInvite only succeeds if status is still "pending".
  const claimed = inviteRepo.acceptRemoteInvite(invite.id, acceptedBy);
  if (!claimed) {
    throw conflict("Invite was already accepted by another request", "INVITE_ALREADY_ACCEPTED");
  }

  // Create remote pod + admin participant after claiming
  let pod: podRepo.RemotePodRow | undefined;
  let participant: participantRepo.RemoteParticipantRow;
  try {
    pod = podRepo.createRemotePod({
      habitatId: invite.habitatId,
      name: details.podName,
      description: details.podDescription,
      defaultStanding: invite.baselineStanding as ParticipantStanding,
      inviteId: invite.id,
      createdBy: acceptedBy,
    });

    participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: invite.habitatId,
      participantType: details.participantType ?? "remote_human",
      displayName: details.participantDisplayName,
      standing: invite.baselineStanding as ParticipantStanding,
    });
  } catch (err) {
    try {
      if (typeof pod !== "undefined" && pod) {
        podRepo.revokeRemotePod(pod.id, "system", "Creation failed");
      }
    } catch {
      // best effort cleanup
    }
    inviteRepo.revokeRemoteInvite(invite.id, "system", "Pod/participant creation failed");
    throw err;
  }

  // Activate pod and participant
  const activatedPod = podRepo.activateRemotePod(pod.id);
  const activatedParticipant = participantRepo.activateRemoteParticipant(participant.id);

  return {
    invite: toView(claimed),
    remotePod: activatedPod ?? pod,
    remoteParticipant: activatedParticipant ?? participant,
  };
}

/**
 * Accepts a provider invite by id, atomically claiming it and provisioning the
 * corresponding remote pod and admin participant with the invite's baseline
 * {@link ParticipantStanding} and provider identity bindings.
 */
export function acceptProviderInvite(
  inviteId: string,
  acceptedBy: string,
  details: {
    podName: string;
    participantDisplayName: string;
    participantType?: "remote_human" | "remote_orcy";
    podDescription?: string;
    providerPodIdentity?: string;
    providerIdentityId?: string;
  },
): InviteAcceptanceResult {
  const invite = inviteRepo.getRemoteInviteById(inviteId);
  if (!invite) {
    throw notFound("Invite not found");
  }
  if (invite.inviteType !== "provider") {
    throw badRequest("Invite is not a provider invite", "WRONG_INVITE_TYPE");
  }
  if (invite.status === "revoked") {
    throw forbidden("Invite has been revoked", "INVITE_REVOKED");
  }
  if (invite.status === "accepted") {
    throw conflict("Invite has already been accepted", "INVITE_ALREADY_ACCEPTED");
  }

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    throw forbidden("Invite has expired", "INVITE_EXPIRED");
  }

  const claimed = inviteRepo.acceptRemoteInvite(invite.id, acceptedBy);
  if (!claimed) {
    throw conflict("Invite was already accepted by another request", "INVITE_ALREADY_ACCEPTED");
  }

  let pod: podRepo.RemotePodRow | undefined;
  let participant: participantRepo.RemoteParticipantRow;
  try {
    pod = podRepo.createRemotePod({
      habitatId: invite.habitatId,
      name: details.podName,
      description: details.podDescription,
      defaultStanding: invite.baselineStanding as ParticipantStanding,
      inviteId: invite.id,
      providerPodIdentity: details.providerPodIdentity ?? null,
      createdBy: acceptedBy,
    });

    participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: invite.habitatId,
      participantType: details.participantType ?? "remote_human",
      displayName: details.participantDisplayName,
      standing: invite.baselineStanding as ParticipantStanding,
      externalIdentityId: details.providerIdentityId ?? null,
    });
  } catch (err) {
    try {
      if (typeof pod !== "undefined" && pod) {
        podRepo.revokeRemotePod(pod.id, "system", "Creation failed");
      }
    } catch {
      // best effort cleanup
    }
    inviteRepo.revokeRemoteInvite(invite.id, "system", "Pod/participant creation failed");
    throw err;
  }

  const activatedPod = podRepo.activateRemotePod(pod.id);
  const activatedParticipant = participantRepo.activateRemoteParticipant(participant.id);

  return {
    invite: toView(claimed),
    remotePod: activatedPod ?? pod,
    remoteParticipant: activatedParticipant ?? participant,
  };
}

/**
 * Returns the invite with the given id if it belongs to the specified habitat.
 */
export function getInviteById(habitatId: string, inviteId: string): InviteView {
  const row = inviteRepo.getRemoteInviteById(inviteId);
  if (!row || row.habitatId !== habitatId) {
    throw notFound("Invite not found");
  }
  return toView(row);
}

/**
 * Returns a non-sensitive preview of a pending manual invite looked up by its
 * one-time token.
 */
export function previewInviteByToken(token: string): {
  inviteType: string;
  baselineStanding: string;
  baselineScopes: string[];
  expiresAt: string | null;
  status: string;
} {
  if (!token || !token.startsWith(MANUAL_TOKEN_PREFIX)) {
    throw badRequest("Invalid invite token format", "INVALID_INVITE_TOKEN");
  }

  const tokenHash = hashToken(token);
  const invite = inviteRepo.getRemoteInviteByTokenHash(tokenHash);
  if (!invite) {
    throw badRequest("Invite token not recognized", "INVITE_NOT_FOUND");
  }
  if (invite.status !== "pending") {
    throw badRequest(`Invite is ${invite.status}`, `INVITE_${invite.status.toUpperCase()}`);
  }
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    throw badRequest("Invite has expired", "INVITE_EXPIRED");
  }

  return {
    inviteType: invite.inviteType,
    baselineStanding: invite.baselineStanding,
    baselineScopes: invite.baselineScopes,
    expiresAt: invite.expiresAt,
    status: invite.status,
  };
}
