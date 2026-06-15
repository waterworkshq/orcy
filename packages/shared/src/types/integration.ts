/** Identifiers for the external providers supported by the integration layer. */
export type IntegrationProvider = "github" | "jira" | "linear";
/** The credential strategy used to authenticate an {@link IntegrationConnection}. */
export type IntegrationAuthMethod =
  | "oauth_device"
  | "oauth_code"
  | "oauth_pkce"
  | "gh_cli"
  | "pat"
  | "api_key";
/** Rolling health of the most recent sync on an {@link IntegrationConnection}, including the "never run" case. */
export type IntegrationSyncStatus = "never" | "running" | "success" | "partial" | "failed";
/** Terminal-or-active outcome of a single {@link IntegrationSyncRun}. */
export type IntegrationSyncRunStatus = "running" | "success" | "partial" | "failed";
/** The event that initiated an {@link IntegrationSyncRun}. */
export type IntegrationSyncTrigger = "manual" | "webhook" | "scheduled" | "oauth_complete";
/** The open/closed lifecycle of an issue as reported by the external provider. */
export type ExternalIssueStatus = "open" | "closed";
/** Per-link sync health for an {@link ExternalIssueLink}. */
export type ExternalIssueLinkSyncStatus = "synced" | "warning" | "failed";
/** Human-review state of an {@link ExternalIntakeCandidate} as it moves toward promotion. */
export type ExternalIntakeReviewStatus =
  | "new"
  | "needs_clarification"
  | "ready"
  | "promoted"
  | "ignored";

/** A persisted link between a habitat and one {@link IntegrationProvider}, including credentials and sync settings. */
export interface IntegrationConnection {
  id: string;
  habitatId: string;
  provider: IntegrationProvider;
  name: string;
  authMethod: IntegrationAuthMethod;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  externalAccountId: string | null;
  externalAccountName: string | null;
  externalTenantId: string | null;
  externalTenantName: string | null;
  externalBaseUrl: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  projectKey: string | null;
  teamId: string | null;
  providerConfig: Record<string, unknown>;
  enabled: boolean;
  pullEnabled: boolean;
  autoImport: boolean;
  webhookSecret: string | null;
  webhookExternalId: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: IntegrationSyncStatus;
  lastSyncError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A redacted, UI-safe projection of an {@link IntegrationConnection} with secrets replaced by presence flags. */
export interface IntegrationConnectionView extends Omit<
  IntegrationConnection,
  "accessToken" | "refreshToken" | "webhookSecret"
> {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasWebhookSecret: boolean;
}

/** A normalized, provider-agnostic snapshot of an issue fetched from an external provider. */
export interface ExternalIssue {
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string;
  title: string;
  body: string;
  status: ExternalIssueStatus;
  labels: string[];
  sourceKind?: string;
  priority?: string;
  assignees?: string[];
  reporter?: string;
  url: string;
  updatedAt: string;
  rawProviderPayload?: Record<string, unknown>;
}

/** A persisted external item awaiting human review in the intake queue. */
export interface ExternalIntakeCandidate {
  id: string;
  connectionId: string;
  habitatId: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string;
  externalUrl: string;
  sourceKind: string | null;
  sourceStatus: string | null;
  sourcePriority: string | null;
  sourceAssignees: string[];
  sourceReporter: string | null;
  sourceLabels: string[];
  sourceTitle: string;
  sourceBody: string | null;
  normalizedSummary: string | null;
  recommendedMissionTitle: string | null;
  recommendedMissionDescription: string | null;
  reviewStatus: ExternalIntakeReviewStatus;
  promotedMissionId: string | null;
  rawProviderPayload: Record<string, unknown> | null;
  externalUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted two-way link between a local mission and an external issue, tracked for ongoing sync. */
export interface ExternalIssueLink {
  id: string;
  connectionId: string;
  habitatId: string;
  missionId: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string;
  externalUrl: string;
  externalStatus: ExternalIssueStatus;
  externalUpdatedAt: string | null;
  providerLabels: string[];
  lastSyncedAt: string | null;
  syncStatus: ExternalIssueLinkSyncStatus;
  syncWarning: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Record of a single sync execution against an {@link IntegrationConnection}. */
export interface IntegrationSyncRun {
  id: string;
  connectionId: string;
  habitatId: string;
  trigger: IntegrationSyncTrigger;
  status: IntegrationSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
}
