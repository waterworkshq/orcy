import type { IntegrationProvider, ExternalIssue, IntegrationConnection } from "@orcy/shared";

export type { IntegrationConnection };

/**
 * Adapter interface for fetching individual issues and issue lists from a specific
 * {@link IntegrationProvider} using an {@link IntegrationConnection}.
 */
export interface IssueProviderAdapter {
  provider: IntegrationProvider;
  listIssues(connection: IntegrationConnection): Promise<ExternalIssue[]>;
  getIssue(connection: IntegrationConnection, externalId: string): Promise<ExternalIssue | null>;
}

/** Shape of a webhook event emitted by an external issue provider. */
export interface ExternalIssueWebhookEvent {
  action: "opened" | "reopened" | "edited" | "labeled" | "unlabeled" | "closed";
  issue: ExternalIssue;
}

/** Aggregate counts and status returned by an integration sync run. */
export interface IntegrationSyncResult {
  syncRunId: string;
  status: "success" | "partial" | "failed";
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  error?: string;
}

/** Per-issue outcome produced when an {@link ExternalIssue} is synchronized. */
export interface ExternalIssueSyncResult {
  action: "created" | "updated" | "closed" | "warning" | "skipped";
  missionId: string;
  linkId: string;
}
