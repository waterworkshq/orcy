import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { habitats } from "./board.js";
import { users } from "./user.js";

// ---------------------------------------------------------------------------
// Identity Providers
// ---------------------------------------------------------------------------

export const identityProviders = sqliteTable(
  "identity_providers",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    issuer: text("issuer"),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_identity_providers_habitat").on(table.habitatId, table.enabled),
    index("idx_identity_providers_kind").on(table.habitatId, table.kind),
  ],
);

export const identityProviderAuthStates = sqliteTable(
  "identity_provider_auth_states",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    nonce: text("nonce"),
    pkceVerifier: text("pkce_verifier"),
    inviteId: text("invite_id"),
    context: text("context", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    status: text("status").notNull().default("pending"),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("idx_identity_provider_auth_states_state").on(table.state),
    index("idx_identity_provider_auth_states_provider").on(table.providerId, table.status),
    index("idx_identity_provider_auth_states_expires").on(table.status, table.expiresAt),
  ],
);

export const externalIdentities = sqliteTable(
  "external_identities",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => identityProviders.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    externalSubject: text("external_subject").notNull(),
    accountLogin: text("account_login"),
    accountName: text("account_name"),
    email: text("email"),
    profileData: text("profile_data", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    localUserId: text("local_user_id").references(() => users.id, { onDelete: "set null" }),
    remoteParticipantId: text("remote_participant_id"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("idx_external_identities_provider_subject").on(
      table.providerId,
      table.externalSubject,
    ),
    index("idx_external_identities_habitat").on(table.habitatId),
    index("idx_external_identities_local_user").on(table.localUserId),
  ],
);

// ---------------------------------------------------------------------------
// Remote Invites
// ---------------------------------------------------------------------------

export const remoteInvites = sqliteTable(
  "remote_invites",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    inviteType: text("invite_type").notNull(),
    baselineStanding: text("baseline_standing").notNull(),
    baselineScopes: text("baseline_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    tokenHash: text("token_hash"),
    providerId: text("provider_id"),
    invitedBy: text("invited_by").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: text("expires_at"),
    acceptedAt: text("accepted_at"),
    acceptedBy: text("accepted_by"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_invites_habitat_status").on(table.habitatId, table.status),
    index("idx_remote_invites_token_hash").on(table.tokenHash),
    index("idx_remote_invites_provider").on(table.providerId),
  ],
);

// ---------------------------------------------------------------------------
// Remote Pods
// ---------------------------------------------------------------------------

export const remotePods = sqliteTable(
  "remote_pods",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    trustMetadata: text("trust_metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    status: text("status").notNull().default("pending"),
    defaultStanding: text("default_standing").notNull().default("remote_observer"),
    inviteId: text("invite_id"),
    providerPodIdentity: text("provider_pod_identity"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    index("idx_remote_pods_habitat_status").on(table.habitatId, table.status),
    index("idx_remote_pods_invite").on(table.inviteId),
  ],
);

// ---------------------------------------------------------------------------
// Remote Participants
// ---------------------------------------------------------------------------

export const remoteParticipants = sqliteTable(
  "remote_participants",
  {
    id: text("id").primaryKey(),
    remotePodId: text("remote_pod_id")
      .notNull()
      .references(() => remotePods.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    participantType: text("participant_type").notNull(),
    displayName: text("display_name").notNull(),
    standing: text("standing").notNull().default("remote_observer"),
    proposedCapabilities: text("proposed_capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    proposedDomains: text("proposed_domains", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    approvedCapabilities: text("approved_capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    approvedDomains: text("approved_domains", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status").notNull().default("pending"),
    externalIdentityId: text("external_identity_id"),
    registeredBy: text("registered_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    suspendedAt: text("suspended_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("idx_remote_participants_pod").on(table.remotePodId, table.status),
    index("idx_remote_participants_habitat").on(table.habitatId, table.status),
    index("idx_remote_participants_standing").on(table.habitatId, table.standing),
  ],
);

// ---------------------------------------------------------------------------
// Remote Credentials
// ---------------------------------------------------------------------------

export const remoteCredentials = sqliteTable(
  "remote_credentials",
  {
    id: text("id").primaryKey(),
    remoteParticipantId: text("remote_participant_id")
      .notNull()
      .references(() => remoteParticipants.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    credentialType: text("credential_type").notNull(),
    secretHash: text("secret_hash").notNull(),
    label: text("label").notNull().default(""),
    status: text("status").notNull().default("active"),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    rotatedFromId: text("rotated_from_id"),
    rotatedAt: text("rotated_at"),
    rotatedBy: text("rotated_by"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_credentials_participant").on(table.remoteParticipantId, table.status),
    index("idx_remote_credentials_type").on(table.habitatId, table.credentialType, table.status),
    index("idx_remote_credentials_hash").on(table.secretHash),
  ],
);

// ---------------------------------------------------------------------------
// Remote Grants
// ---------------------------------------------------------------------------

export const remoteGrants = sqliteTable(
  "remote_grants",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    remotePodId: text("remote_pod_id")
      .notNull()
      .references(() => remotePods.id, { onDelete: "cascade" }),
    remoteParticipantId: text("remote_participant_id").references(() => remoteParticipants.id, {
      onDelete: "cascade",
    }),
    grantType: text("grant_type").notNull(),
    standing: text("standing").notNull(),
    actionScopes: text("action_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    eligibilityMode: text("eligibility_mode").notNull().default("allowlist"),
    includeFutureMatches: integer("include_future_matches", { mode: "boolean" })
      .notNull()
      .default(false),
    graceWindowHours: integer("grace_window_hours").notNull().default(24),
    status: text("status").notNull().default("active"),
    expiresAt: text("expires_at"),
    expiredAt: text("expired_at"),
    revocationMode: text("revocation_mode"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_grants_habitat").on(table.habitatId, table.status),
    index("idx_remote_grants_pod").on(table.remotePodId, table.status),
    index("idx_remote_grants_participant").on(table.remoteParticipantId, table.status),
    index("idx_remote_grants_type").on(table.habitatId, table.grantType, table.status),
    index("idx_remote_grants_expires").on(table.status, table.expiresAt),
  ],
);

export const remoteGrantTargets = sqliteTable(
  "remote_grant_targets",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => remoteGrants.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_grant_targets_grant").on(table.grantId),
    uniqueIndex("idx_remote_grant_targets_unique").on(
      table.grantId,
      table.targetType,
      table.targetId,
    ),
  ],
);

export const remoteGrantRules = sqliteTable(
  "remote_grant_rules",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => remoteGrants.id, { onDelete: "cascade" }),
    domains: text("domains", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    labels: text("labels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    capabilities: text("capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    timeWindowStart: text("time_window_start"),
    timeWindowEnd: text("time_window_end"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [uniqueIndex("idx_remote_grant_rules_grant").on(table.grantId)],
);

export const remoteGrantTaskSnapshots = sqliteTable(
  "remote_grant_task_snapshots",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => remoteGrants.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    matchedAt: text("matched_at").notNull(),
    matchReason: text("match_reason").notNull().default(""),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_grant_task_snapshots_grant").on(table.grantId),
    uniqueIndex("idx_remote_grant_task_snapshots_unique").on(table.grantId, table.taskId),
  ],
);

// ---------------------------------------------------------------------------
// Remote Idempotency Keys
// ---------------------------------------------------------------------------

export const remoteIdempotencyKeys = sqliteTable(
  "remote_idempotency_keys",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    remoteParticipantId: text("remote_participant_id").notNull(),
    remoteCredentialId: text("remote_credential_id"),
    action: text("action").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    errorMessage: text("error_message"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("idx_remote_idempotency_keys_key").on(
      table.remoteParticipantId,
      table.action,
      table.idempotencyKey,
    ),
    index("idx_remote_idempotency_keys_expires").on(table.status, table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Remote Webhook Endpoints
// ---------------------------------------------------------------------------

export const remoteWebhookEndpoints = sqliteTable(
  "remote_webhook_endpoints",
  {
    id: text("id").primaryKey(),
    remotePodId: text("remote_pod_id")
      .notNull()
      .references(() => remotePods.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    events: text("events", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status").notNull().default("pending"),
    secretHash: text("secret_hash"),
    encryptedSecret: text("encrypted_secret"),
    lastTestAt: text("last_test_at"),
    lastTestStatus: text("last_test_status"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    enabledBy: text("enabled_by"),
    enabledAt: text("enabled_at"),
    rejectedAt: text("rejected_at"),
    rejectedBy: text("rejected_by"),
    rejectReason: text("reject_reason"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_remote_webhook_endpoints_pod").on(table.remotePodId, table.status),
    index("idx_remote_webhook_endpoints_habitat").on(table.habitatId, table.status),
  ],
);
