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

export function listInvites(habitatId: string): InviteView[] {
  return inviteRepo.getRemoteInvitesByHabitat(habitatId).map((row) => toView(row));
}

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

  // Create remote pod + admin participant
  const pod = podRepo.createRemotePod({
    habitatId: invite.habitatId,
    name: details.podName,
    description: details.podDescription,
    defaultStanding: invite.baselineStanding as ParticipantStanding,
    inviteId: invite.id,
    createdBy: acceptedBy,
  });

  const activatedPod = podRepo.activateRemotePod(pod.id);

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: invite.habitatId,
    participantType: details.participantType ?? "remote_human",
    displayName: details.participantDisplayName,
    standing: invite.baselineStanding as ParticipantStanding,
  });

  const activatedParticipant = participantRepo.activateRemoteParticipant(participant.id);

  const accepted = inviteRepo.acceptRemoteInvite(invite.id, acceptedBy);
  if (!accepted) throw notFound("Invite not found after acceptance");

  return {
    invite: toView(accepted),
    remotePod: activatedPod ?? pod,
    remoteParticipant: activatedParticipant ?? participant,
  };
}

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

  const pod = podRepo.createRemotePod({
    habitatId: invite.habitatId,
    name: details.podName,
    description: details.podDescription,
    defaultStanding: invite.baselineStanding as ParticipantStanding,
    inviteId: invite.id,
    providerPodIdentity: details.providerPodIdentity ?? null,
    createdBy: acceptedBy,
  });

  const activatedPod = podRepo.activateRemotePod(pod.id);

  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: invite.habitatId,
    participantType: details.participantType ?? "remote_human",
    displayName: details.participantDisplayName,
    standing: invite.baselineStanding as ParticipantStanding,
    externalIdentityId: details.providerIdentityId ?? null,
  });

  const activatedParticipant = participantRepo.activateRemoteParticipant(participant.id);

  const accepted = inviteRepo.acceptRemoteInvite(invite.id, acceptedBy);
  if (!accepted) throw notFound("Invite not found after acceptance");

  return {
    invite: toView(accepted),
    remotePod: activatedPod ?? pod,
    remoteParticipant: activatedParticipant ?? participant,
  };
}

export function getInviteById(habitatId: string, inviteId: string): InviteView {
  const row = inviteRepo.getRemoteInviteById(inviteId);
  if (!row || row.habitatId !== habitatId) {
    throw notFound("Invite not found");
  }
  return toView(row);
}
