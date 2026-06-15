import type {
  RemotePodStatus,
  RemoteParticipantStatus,
  ParticipantStanding,
  RemoteActionScope,
  RemoteGrantType,
  RemoteGrantEligibilityMode,
  RemoteGrantTargetType,
  RemoteRevocationMode,
} from "@orcy/shared/types";
import * as podRepo from "../repositories/remotePod.js";
import type { RemotePodRow } from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import type { RemoteParticipantRow } from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import type { RemoteGrantRow, RemoteGrantRuleRow } from "../repositories/remoteGrant.js";
import { notFound, badRequest, conflict } from "../errors.js";

// ---------------------------------------------------------------------------
// View Models
// ---------------------------------------------------------------------------

/** Read model for a remote pod as exposed to the admin API, including derived participant and active-grant counts. */
export interface RemotePodView {
  id: string;
  habitatId: string;
  name: string;
  description: string;
  status: string;
  defaultStanding: string;
  inviteId: string | null;
  providerPodIdentity: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  participantCount: number;
  activeGrantCount: number;
}

/** Read model for a remote participant as exposed to the admin API, carrying proposed/approved capabilities and active-grant count. */
export interface RemoteParticipantView {
  id: string;
  remotePodId: string;
  habitatId: string;
  participantType: string;
  displayName: string;
  standing: string;
  proposedCapabilities: string[];
  proposedDomains: string[];
  approvedCapabilities: string[];
  approvedDomains: string[];
  status: string;
  externalIdentityId: string | null;
  registeredBy: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
  hasActiveCredential: boolean;
  activeGrantCount: number;
}

/** Read model for a remote grant as exposed to the admin API, expanded with its targets, rule, and task-snapshot count. */
export interface RemoteGrantView {
  id: string;
  habitatId: string;
  remotePodId: string;
  remoteParticipantId: string | null;
  grantType: string;
  standing: string;
  actionScopes: string[];
  eligibilityMode: string;
  includeFutureMatches: boolean;
  graceWindowHours: number;
  status: string;
  expiresAt: string | null;
  expiredAt: string | null;
  revocationMode: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  targets: { targetType: string; targetId: string }[];
  rule: RemoteGrantRuleRow | null;
  taskSnapshotCount: number;
  isPodWide: boolean;
  isPermanent: boolean;
}

/** Aggregated remote-access dashboard payload for a habitat: all pods, participants, grants, and total/active summary counts. */
export interface RemoteAccessManagementView {
  pods: RemotePodView[];
  participants: RemoteParticipantView[];
  grants: RemoteGrantView[];
  summary: {
    totalPods: number;
    activePods: number;
    totalParticipants: number;
    activeParticipants: number;
    totalGrants: number;
    activeGrants: number;
  };
}

// ---------------------------------------------------------------------------
// Pod Management
// ---------------------------------------------------------------------------

function toPodView(row: RemotePodRow): RemotePodView {
  const participants = participantRepo.getRemoteParticipantsByPod(row.id);
  const grants = grantRepo.getActiveGrantsByPod(row.id);
  return {
    id: row.id,
    habitatId: row.habitatId,
    name: row.name,
    description: row.description,
    status: row.status,
    defaultStanding: row.defaultStanding,
    inviteId: row.inviteId,
    providerPodIdentity: row.providerPodIdentity,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
    revokeReason: row.revokeReason,
    participantCount: participants.length,
    activeGrantCount: grants.length,
  };
}

/**
 * Returns all remote pods in a habitat, optionally filtered by {@link RemotePodStatus}.
 */
export function listPods(habitatId: string, status?: RemotePodStatus): RemotePodView[] {
  return podRepo.getRemotePodsByHabitat(habitatId, status).map((row) => toPodView(row));
}

/**
 * Returns a single remote pod by id, throwing {@link NotFoundError} if it does not exist or belongs to a different habitat.
 */
export function getPod(habitatId: string, podId: string): RemotePodView {
  const row = podRepo.getRemotePodById(podId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote pod not found");
  return toPodView(row);
}

/**
 * Updates mutable fields (name, description, default {@link ParticipantStanding}) on a remote pod and persists the change.
 */
export function updatePod(
  habitatId: string,
  podId: string,
  patch: { name?: string; description?: string; defaultStanding?: ParticipantStanding },
): RemotePodView {
  const row = podRepo.getRemotePodById(podId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote pod not found");
  const updated = podRepo.updateRemotePod(podId, patch);
  if (!updated) throw notFound("Remote pod not found");
  return toPodView(updated);
}

/**
 * Marks a remote pod as suspended in the database; refuses pods that are already suspended.
 */
export function suspendPod(habitatId: string, podId: string): RemotePodView {
  const row = podRepo.getRemotePodById(podId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote pod not found");
  if (row.status === "suspended") throw conflict("Pod is already suspended");
  const updated = podRepo.suspendRemotePod(podId);
  if (!updated) throw notFound("Remote pod not found");
  return toPodView(updated);
}

/**
 * Transitions a suspended or pending pod to active, refusing to activate a previously revoked pod.
 */
export function activatePod(habitatId: string, podId: string): RemotePodView {
  const row = podRepo.getRemotePodById(podId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote pod not found");
  if (row.status === "revoked") throw conflict("Cannot activate a revoked pod");
  const updated = podRepo.activateRemotePod(podId);
  if (!updated) throw notFound("Remote pod not found");
  return toPodView(updated);
}

/**
 * Permanently revokes a remote pod, recording the actor and optional reason; refuses already-revoked pods.
 */
export function revokePod(
  habitatId: string,
  podId: string,
  revokedBy: string,
  revokeReason?: string,
): RemotePodView {
  const row = podRepo.getRemotePodById(podId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote pod not found");
  if (row.status === "revoked") throw conflict("Pod is already revoked");
  const updated = podRepo.revokeRemotePod(podId, revokedBy, revokeReason);
  if (!updated) throw notFound("Remote pod not found");
  return toPodView(updated);
}

// ---------------------------------------------------------------------------
// Participant Management
// ---------------------------------------------------------------------------

function toParticipantView(row: RemoteParticipantRow): RemoteParticipantView {
  const grants = grantRepo.getActiveGrantsByParticipant(row.id);
  return {
    id: row.id,
    remotePodId: row.remotePodId,
    habitatId: row.habitatId,
    participantType: row.participantType,
    displayName: row.displayName,
    standing: row.standing,
    proposedCapabilities: row.proposedCapabilities,
    proposedDomains: row.proposedDomains,
    approvedCapabilities: row.approvedCapabilities,
    approvedDomains: row.approvedDomains,
    status: row.status,
    externalIdentityId: row.externalIdentityId,
    registeredBy: row.registeredBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    suspendedAt: row.suspendedAt,
    revokedAt: row.revokedAt,
    hasActiveCredential: false, // Populated by route layer if needed
    activeGrantCount: grants.length,
  };
}

/**
 * Returns remote participants in a habitat, optionally filtered by pod and {@link RemoteParticipantStatus}.
 */
export function listParticipants(
  habitatId: string,
  options?: { podId?: string; status?: RemoteParticipantStatus },
): RemoteParticipantView[] {
  let rows: RemoteParticipantRow[];
  if (options?.podId) {
    rows = participantRepo.getRemoteParticipantsByPod(options.podId, options.status);
    // Still filter by habitat
    rows = rows.filter((r) => r.habitatId === habitatId);
  } else {
    rows = participantRepo.getRemoteParticipantsByHabitat(habitatId, options?.status);
  }
  return rows.map((row) => toParticipantView(row));
}

/**
 * Returns a single remote participant by id, throwing {@link NotFoundError} if it does not exist or belongs to a different habitat.
 */
export function getParticipant(habitatId: string, participantId: string): RemoteParticipantView {
  const row = participantRepo.getRemoteParticipantById(participantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote participant not found");
  return toParticipantView(row);
}

/**
 * Applies host-approved capabilities, domains, and/or {@link ParticipantStanding} to a participant and auto-activates it if still pending.
 */
export function approveParticipant(
  habitatId: string,
  participantId: string,
  patch: {
    approvedCapabilities?: string[];
    approvedDomains?: string[];
    standing?: ParticipantStanding;
  },
): RemoteParticipantView {
  const row = participantRepo.getRemoteParticipantById(participantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote participant not found");

  let updated = row;
  if (patch.approvedCapabilities !== undefined || patch.approvedDomains !== undefined) {
    updated =
      participantRepo.updateHostApprovedCapabilities(
        participantId,
        patch.approvedCapabilities ?? row.approvedCapabilities,
        patch.approvedDomains ?? row.approvedDomains,
      ) ?? updated;
  }
  if (patch.standing !== undefined) {
    updated =
      participantRepo.updateRemoteParticipantStanding(participantId, patch.standing) ?? updated;
  }

  // Auto-activate if pending
  if (updated.status === "pending") {
    updated = participantRepo.activateRemoteParticipant(participantId) ?? updated;
  }

  return toParticipantView(updated);
}

/**
 * Marks an active remote participant as suspended; refuses participants that are already suspended.
 */
export function suspendParticipant(
  habitatId: string,
  participantId: string,
): RemoteParticipantView {
  const row = participantRepo.getRemoteParticipantById(participantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote participant not found");
  if (row.status === "suspended") throw conflict("Participant is already suspended");
  const updated = participantRepo.suspendRemoteParticipant(participantId);
  if (!updated) throw notFound("Remote participant not found");
  return toParticipantView(updated);
}

/**
 * Transitions a suspended or pending participant to active, refusing to activate a previously revoked participant.
 */
export function activateParticipant(
  habitatId: string,
  participantId: string,
): RemoteParticipantView {
  const row = participantRepo.getRemoteParticipantById(participantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote participant not found");
  if (row.status === "revoked") throw conflict("Cannot activate a revoked participant");
  const updated = participantRepo.activateRemoteParticipant(participantId);
  if (!updated) throw notFound("Remote participant not found");
  return toParticipantView(updated);
}

/**
 * Permanently revokes a remote participant; refuses participants that are already revoked.
 */
export function revokeParticipant(habitatId: string, participantId: string): RemoteParticipantView {
  const row = participantRepo.getRemoteParticipantById(participantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Remote participant not found");
  if (row.status === "revoked") throw conflict("Participant is already revoked");
  const updated = participantRepo.revokeRemoteParticipant(participantId);
  if (!updated) throw notFound("Remote participant not found");
  return toParticipantView(updated);
}

// ---------------------------------------------------------------------------
// Grant Management
// ---------------------------------------------------------------------------

function toGrantView(row: RemoteGrantRow): RemoteGrantView {
  const targets = grantRepo.getRemoteGrantTargets(row.id);
  const rule = grantRepo.getRemoteGrantRule(row.id);
  const snapshots = grantRepo.getGrantTaskSnapshots(row.id);
  return {
    id: row.id,
    habitatId: row.habitatId,
    remotePodId: row.remotePodId,
    remoteParticipantId: row.remoteParticipantId,
    grantType: row.grantType,
    standing: row.standing,
    actionScopes: row.actionScopes,
    eligibilityMode: row.eligibilityMode,
    includeFutureMatches: row.includeFutureMatches,
    graceWindowHours: row.graceWindowHours,
    status: row.status,
    expiresAt: row.expiresAt,
    expiredAt: row.expiredAt,
    revocationMode: row.revocationMode,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    targets: targets.map((t) => ({ targetType: t.targetType, targetId: t.targetId })),
    rule,
    taskSnapshotCount: snapshots.length,
    isPodWide: row.remoteParticipantId === null,
    isPermanent: row.grantType === "permanent_execution",
  };
}

/**
 * Returns all remote grants within a habitat, expanded with targets, rule, and task-snapshot counts.
 */
export function listGrants(habitatId: string): RemoteGrantView[] {
  return grantRepo.getGrantsByHabitat(habitatId).map((row) => toGrantView(row));
}

/**
 * Returns a single remote grant by id, throwing {@link NotFoundError} if it does not exist or belongs to a different habitat.
 */
export function getGrant(habitatId: string, grantId: string): RemoteGrantView {
  const row = grantRepo.getRemoteGrantById(grantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Grant not found");
  return toGrantView(row);
}

/** Input payload accepted by {@link createGrant} to validate and persist a new remote grant with optional targets and rule. */
export interface CreateGrantInput {
  habitatId: string;
  remotePodId: string;
  remoteParticipantId?: string | null;
  grantType: RemoteGrantType;
  standing: ParticipantStanding;
  actionScopes: RemoteActionScope[];
  eligibilityMode?: RemoteGrantEligibilityMode;
  includeFutureMatches?: boolean;
  graceWindowHours?: number;
  expiresAt?: string | null;
  targets?: { targetType: RemoteGrantTargetType; targetId: string }[];
  rule?: {
    domains?: string[];
    labels?: string[];
    capabilities?: string[];
    timeWindowStart?: string | null;
    timeWindowEnd?: string | null;
  };
  createdBy?: string | null;
}

/**
 * Validates and persists a new remote grant (with optional targets and rule), enforcing that the participant belongs to the pod and that {@link RemoteGrantType} `permanent_execution` includes the `submit` {@link RemoteActionScope}.
 */
export function createGrant(input: CreateGrantInput): RemoteGrantView {
  const pod = podRepo.getRemotePodById(input.remotePodId);
  if (!pod || pod.habitatId !== input.habitatId) {
    throw notFound("Remote pod not found for grant");
  }

  if (input.remoteParticipantId) {
    const participant = participantRepo.getRemoteParticipantById(input.remoteParticipantId);
    if (!participant || participant.remotePodId !== input.remotePodId) {
      throw badRequest(
        "Participant does not belong to the specified pod",
        "PARTICIPANT_POD_MISMATCH",
      );
    }
  }

  // Permanent execution grants require explicit confirmation
  if (input.grantType === "permanent_execution" && !input.actionScopes.includes("submit")) {
    throw badRequest(
      "Permanent execution grants must include 'submit' scope",
      "PERMANENT_GRANT_REQUIRES_SUBMIT",
    );
  }

  const grant = grantRepo.createRemoteGrant({
    habitatId: input.habitatId,
    remotePodId: input.remotePodId,
    remoteParticipantId: input.remoteParticipantId ?? null,
    grantType: input.grantType,
    standing: input.standing,
    actionScopes: input.actionScopes,
    eligibilityMode: input.eligibilityMode ?? "allowlist",
    includeFutureMatches: input.includeFutureMatches ?? false,
    graceWindowHours: input.graceWindowHours ?? 24,
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy ?? null,
  });

  // Add targets
  if (input.targets) {
    for (const target of input.targets) {
      grantRepo.addRemoteGrantTarget(grant.id, target.targetType, target.targetId);
    }
  }

  // Add rule for rule-based grants
  if (input.eligibilityMode === "rule_based" && input.rule) {
    grantRepo.setRemoteGrantRule(grant.id, input.rule);
  }

  return getGrant(input.habitatId, grant.id);
}

/**
 * Applies a {@link RemoteRevocationMode} to an active grant, recording the actor and optional reason; refuses grants that are already revoked or frozen.
 */
export function revokeGrant(
  habitatId: string,
  grantId: string,
  mode: RemoteRevocationMode,
  revokedBy: string,
  revokeReason?: string,
): RemoteGrantView {
  const row = grantRepo.getRemoteGrantById(grantId);
  if (!row || row.habitatId !== habitatId) throw notFound("Grant not found");

  if (row.status === "hard_revoked" || row.status === "soft_revoked" || row.status === "frozen") {
    throw conflict("Grant is already revoked or frozen");
  }

  const revoked = grantRepo.revokeRemoteGrant(grantId, mode, revokedBy, revokeReason);
  if (!revoked) throw notFound("Grant not found");
  return toGrantView(revoked);
}

// ---------------------------------------------------------------------------
// Grant Preview
// ---------------------------------------------------------------------------

/** Input payload accepted by {@link previewGrant} describing the rule and/or targets to simulate matching against. */
export interface GrantPreviewInput {
  habitatId: string;
  rule: {
    domains?: string[];
    labels?: string[];
    capabilities?: string[];
  };
  targets?: { targetType: RemoteGrantTargetType; targetId: string }[];
}

/** Preview result returned by {@link previewGrant}: matched task ids, match count, and a human-readable scope warning. */
export interface GrantPreviewResult {
  matchedTaskIds: string[];
  matchCount: number;
  warning: string | null;
}

/**
 * Returns a UI-facing preview of which tasks a rule-based or target-scoped grant would match, plus a human-readable warning about the grant's scope.
 */
export function previewGrant(input: GrantPreviewInput): GrantPreviewResult {
  // For Phase C, preview uses task targets and rule domain/capability filters.
  // Actual task matching requires querying the task repository.
  // This returns a structured preview that the UI can display.
  const targetTaskIds =
    input.targets?.filter((t) => t.targetType === "task").map((t) => t.targetId) ?? [];

  const warning =
    input.rule.capabilities && input.rule.capabilities.length > 0
      ? "Rule-based grant will match tasks with the specified capabilities. Future tasks matching the rule will NOT be included unless includeFutureMatches is set."
      : targetTaskIds.length > 0
        ? "Grant will be scoped to the specified task allowlist."
        : "Grant has no targets or rules. It will apply to all tasks in the habitat boundary.";

  return {
    matchedTaskIds: targetTaskIds,
    matchCount: targetTaskIds.length,
    warning,
  };
}

// ---------------------------------------------------------------------------
// Management View
// ---------------------------------------------------------------------------

/**
 * Returns the aggregated remote access dashboard for a habitat — pods, participants, grants, and the total/active summary counts.
 */
export function getManagementView(habitatId: string): RemoteAccessManagementView {
  const pods = listPods(habitatId);
  const participants = listParticipants(habitatId);
  const grants = listGrants(habitatId);

  return {
    pods,
    participants,
    grants,
    summary: {
      totalPods: pods.length,
      activePods: pods.filter((p) => p.status === "active").length,
      totalParticipants: participants.length,
      activeParticipants: participants.filter((p) => p.status === "active").length,
      totalGrants: grants.length,
      activeGrants: grants.filter((g) => g.status === "active").length,
    },
  };
}
