export type IntegrationProvider = 'github' | 'jira' | 'linear';
export type IntegrationAuthMethod = 'oauth_device' | 'oauth_code' | 'oauth_pkce' | 'gh_cli' | 'pat' | 'api_key';
export type IntegrationSyncStatus = 'never' | 'running' | 'success' | 'partial' | 'failed';
export type IntegrationSyncRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type IntegrationSyncTrigger = 'manual' | 'webhook' | 'scheduled' | 'oauth_complete';
export type ExternalIssueStatus = 'open' | 'closed';
export type ExternalIssueLinkSyncStatus = 'synced' | 'warning' | 'failed';
export type ExternalIntakeReviewStatus = 'new' | 'needs_clarification' | 'ready' | 'promoted' | 'ignored';

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

export interface IntegrationConnectionView extends Omit<IntegrationConnection, 'accessToken' | 'refreshToken' | 'webhookSecret'> {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasWebhookSecret: boolean;
}

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
