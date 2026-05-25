import type { IntegrationProvider, ExternalIssue, IntegrationConnection } from '@orcy/shared';

export type { IntegrationConnection };

export interface IssueProviderAdapter {
  provider: IntegrationProvider;
  listIssues(connection: IntegrationConnection): Promise<ExternalIssue[]>;
  getIssue(connection: IntegrationConnection, externalId: string): Promise<ExternalIssue | null>;
}

export interface ExternalIssueWebhookEvent {
  action: 'opened' | 'reopened' | 'edited' | 'labeled' | 'unlabeled' | 'closed';
  issue: ExternalIssue;
}

export interface IntegrationSyncResult {
  syncRunId: string;
  status: 'success' | 'partial' | 'failed';
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  error?: string;
}

export interface ExternalIssueSyncResult {
  action: 'created' | 'updated' | 'closed' | 'warning' | 'skipped';
  missionId: string;
  linkId: string;
}
