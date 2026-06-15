/**
 * v0.19 Pod Bridge — Shared domain types.
 *
 * These types model provider-backed identity, pod affiliation, participant
 * standing, scoped grants, and remote actor identity for cross-pod habitat
 * collaboration. Local-only deployments are unaffected.
 */

// ---------------------------------------------------------------------------
// Affiliation & Standing
// ---------------------------------------------------------------------------

/** The set of participant affiliations, distinguishing native pod members from trusted external pod members. */
export type PodAffiliation = "local" | "remote";

/** The set of trust tiers a hosting habitat can grant, from local membership to remote observer/contributor roles. */
export type ParticipantStanding =
  | "local_member"
  | "remote_observer"
  | "remote_contributor"
  | "remote_reviewer"
  | "trusted_remote_pod";

// ---------------------------------------------------------------------------
// Remote principal model
// ---------------------------------------------------------------------------

/** The set of remote principal kinds extending the local principal model with pod-side, human-side, and orcy-side actors. */
export type RemotePrincipalType = "remote_pod" | "remote_human" | "remote_orcy";

/** The set of in-pod remote participant kinds: remote human or remote orcy. */
export type RemoteParticipantType = "remote_human" | "remote_orcy";

/** Lightweight reference to a remote actor for audit context and UI display, carrying its {@link RemotePrincipalType} and {@link ParticipantStanding}. */
export interface RemoteActorRef {
  podId: string;
  participantId: string;
  principalType: RemotePrincipalType;
  standing: ParticipantStanding;
  displayName?: string | null;
  providerIdentity?: string | null;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** The set of grant categories controlling the breadth of remote access. */
export type RemoteGrantType = "baseline_observer" | "scoped_elevation" | "permanent_execution";

/** The set of grant lifecycle states, including a grace window for expired grants. */
export type RemoteGrantStatus =
  | "active"
  | "expired"
  | "grace"
  | "soft_revoked"
  | "hard_revoked"
  | "frozen";

/** The set of host-chosen revocation strategies, from blocking new claims to immediate full shutdown. */
export type RemoteRevocationMode = "soft" | "hard" | "freeze";

/** The set of strategies a scoped elevation grant uses to determine task eligibility. */
export type RemoteGrantEligibilityMode = "allowlist" | "rule_based";

/** The set of boundary entities a grant target can reference within the habitat hierarchy. */
export type RemoteGrantTargetType = "habitat" | "mission" | "task";

// ---------------------------------------------------------------------------
// Action scopes
// ---------------------------------------------------------------------------

/** The set of fine-grained actions a remote participant may perform within a habitat boundary. */
export type RemoteActionScope =
  | "read"
  | "comment"
  | "pulse.post"
  | "claim"
  | "heartbeat"
  | "submit"
  | "release"
  | "evidence_link";

// ---------------------------------------------------------------------------
// Credentials & invites
// ---------------------------------------------------------------------------

/** The set of authentication paths for a remote orcy credential. */
export type RemoteCredentialType = "api" | "mcp";

/** The set of lifecycle states for a remote credential. */
export type RemoteCredentialStatus = "active" | "rotated" | "revoked" | "expired";

/** The set of paths by which a remote invite is initiated — provider-backed or manual token. */
export type RemoteInviteType = "provider" | "manual";

/** The set of lifecycle states for a remote invite. */
export type RemoteInviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** The set of lifecycle states for a trusted remote pod relationship. */
export type RemotePodStatus = "pending" | "active" | "suspended" | "revoked";

/** The set of lifecycle states for a remote participant within a pod. */
export type RemoteParticipantStatus = "pending" | "active" | "suspended" | "revoked";

// ---------------------------------------------------------------------------
// Identity providers
// ---------------------------------------------------------------------------

/** The set of identity provider presets, built on a generic OIDC core with GitHub OAuth as the first preset. */
export type IdentityProviderKind = "github" | "oidc";

/** The set of lifecycle states for a provider OAuth/OIDC auth-state record. */
export type IdentityProviderAuthStateStatus = "pending" | "consumed" | "expired";

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** The set of lifecycle states for a remote-pod webhook endpoint, which requires host admin approval. */
export type RemoteWebhookEndpointStatus =
  | "pending"
  | "approved"
  | "enabled"
  | "disabled"
  | "rejected";

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** The set of lifecycle states for a remote idempotency-key record used in cross-pod write retries. */
export type RemoteIdempotencyStatus = "pending" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** The set of code-evidence kinds a remote contributor may attach — v0.19 is limited to URL and metadata evidence. */
export type RemoteEvidenceKind = "url" | "metadata";

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** The set of audit provenance classifications for a remote action. */
export type RemoteActionKind = "advisory" | "execution" | "administrative";

/** Remote-participation context attached to an audit event, capturing {@link ParticipantStanding} and {@link RemoteActionKind}. */
export interface RemoteAuditMetadata {
  podId: string;
  participantId: string;
  standing: "remote_observer" | "remote_contributor";
  grantId?: string;
  credentialId?: string;
  actionKind: RemoteActionKind;
  providerIdentity?: string | null;
}
