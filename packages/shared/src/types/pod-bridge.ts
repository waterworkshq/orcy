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

/**
 * Discriminates local participants (native pod members) from remote
 * participants (belonging to a trusted external pod).
 */
export type PodAffiliation = "local" | "remote";

/**
 * Trust tier the hosting habitat grants to a participant.
 *
 * `local_member` is existing behavior. v0.19 ships `remote_observer` and
 * `remote_contributor`. `remote_reviewer` and `trusted_remote_pod` are modeled
 * now but are future scope — not granted in v0.19.
 */
export type ParticipantStanding =
  | "local_member"
  | "remote_observer"
  | "remote_contributor"
  | "remote_reviewer"
  | "trusted_remote_pod";

// ---------------------------------------------------------------------------
// Remote principal model
// ---------------------------------------------------------------------------

/**
 * Canonical remote principal types. These extend the local principal model
 * (human, local_agent, daemon_agent, integration_account) with remote-side
 * actors that are persisted in dedicated Pod Bridge tables.
 */
export type RemotePrincipalType = "remote_pod" | "remote_human" | "remote_orcy";

/**
 * Distinguishes a remote human participant from a remote orcy participant
 * within a remote pod.
 */
export type RemoteParticipantType = "remote_human" | "remote_orcy";

/**
 * Reference to a remote actor for audit context, notification attribution,
 * and inline UI display.
 */
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

/**
 * Grant type controls what category of access a remote participant has.
 *
 * - `baseline_observer` — longer-lived visibility plus optional advisory feedback
 * - `scoped_elevation` — bounded execution authority (time, mission, task, actions)
 * - `permanent_execution` — long-lived execution; high-risk, must be explicitly marked
 */
export type RemoteGrantType = "baseline_observer" | "scoped_elevation" | "permanent_execution";

/**
 * Lifecycle status of a grant.
 *
 * `grace` means the grant has expired but already-claimed tasks may still be
 * submitted/released during the configurable grace window (default 24h).
 */
export type RemoteGrantStatus =
  | "active"
  | "expired"
  | "grace"
  | "soft_revoked"
  | "hard_revoked"
  | "frozen";

/**
 * Host-chosen revocation mode when actively revoking a grant (distinct from
 * normal expiry).
 *
 * - `soft` — block new claims; claimed work can submit/release during grace
 * - `hard` — block all remote actions immediately and release claimed tasks
 * - `freeze` — block remote actions but keep claimed tasks assigned for host decision
 */
export type RemoteRevocationMode = "soft" | "hard" | "freeze";

/**
 * How a scoped elevation grant determines which tasks/missions are eligible.
 *
 * - `allowlist` — explicit mission/task IDs selected by host (safe default)
 * - `rule_based` — domain/label/capability/time filters (advanced)
 */
export type RemoteGrantEligibilityMode = "allowlist" | "rule_based";

/**
 * Boundary entity a grant target references.
 */
export type RemoteGrantTargetType = "habitat" | "mission" | "task";

// ---------------------------------------------------------------------------
// Action scopes
// ---------------------------------------------------------------------------

/**
 * Action scopes that can be granted to a remote participant. These control
 * what the participant can do within a habitat boundary, independent of any
 * Git provider repository permissions.
 *
 * Note: `pulse.post` is a dot-separated scope to distinguish posting from
 * pulse read access.
 */
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

/**
 * Remote orcy credential type — controls the authentication path used.
 */
export type RemoteCredentialType = "api" | "mcp";

/**
 * Lifecycle status of a remote credential.
 */
export type RemoteCredentialStatus = "active" | "rotated" | "revoked" | "expired";

/**
 * How a remote invite was initiated.
 *
 * - `provider` — provider-backed identity (GitHub OAuth / OIDC)
 * - `manual` — manual invite token (advanced local-first fallback)
 */
export type RemoteInviteType = "provider" | "manual";

/**
 * Lifecycle status of a remote invite.
 */
export type RemoteInviteStatus = "pending" | "accepted" | "revoked" | "expired";

/**
 * Lifecycle status of a trusted remote pod relationship.
 */
export type RemotePodStatus = "pending" | "active" | "suspended" | "revoked";

/**
 * Lifecycle status of a remote participant within a remote pod.
 */
export type RemoteParticipantStatus = "pending" | "active" | "suspended" | "revoked";

// ---------------------------------------------------------------------------
// Identity providers
// ---------------------------------------------------------------------------

/**
 * Identity provider preset. v0.19 ships a generic OIDC core with GitHub OAuth
 * as the first polished preset.
 */
export type IdentityProviderKind = "github" | "oidc";

/**
 * Lifecycle status of a provider OAuth/OIDC auth state (state/nonce/PKCE).
 */
export type IdentityProviderAuthStateStatus = "pending" | "consumed" | "expired";

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a remote-pod-provided webhook endpoint. Host admin
 * approval is required before delivery is enabled.
 */
export type RemoteWebhookEndpointStatus =
  | "pending"
  | "approved"
  | "enabled"
  | "disabled"
  | "rejected";

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Status of a remote idempotency key record for cross-pod write retries.
 */
export type RemoteIdempotencyStatus = "pending" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Kind of code evidence a remote contributor may attach. v0.19 allows URL and
 * metadata evidence only — no broad repository discovery, backfill, scanning,
 * or provider-side mutation.
 */
export type RemoteEvidenceKind = "url" | "metadata";

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Classification of a remote action for audit provenance.
 *
 * - `advisory` — observer feedback (comments, review notes)
 * - `execution` — contributor execution (claim, submit, evidence link)
 * - `administrative` — pod/grant/credential management
 */
export type RemoteActionKind = "advisory" | "execution" | "administrative";

/**
 * Remote context attached to audit event metadata when a remote participant
 * performs an action. See techspec §2.4.
 */
export interface RemoteAuditMetadata {
  podId: string;
  participantId: string;
  standing: "remote_observer" | "remote_contributor";
  grantId?: string;
  credentialId?: string;
  actionKind: RemoteActionKind;
  providerIdentity?: string | null;
}
