/** A registered outbound webhook endpoint scoped to a habitat, with event filter, signing secret, and delivery format. */
export interface WebhookSubscription {
  id: string;
  habitatId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: "standard" | "slack" | "discord";
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

/** A single delivery attempt of an event payload to a {@link WebhookSubscription}, tracked for retries and audit. */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

/** Lifecycle states a pipeline run event can occupy, from queued through terminal outcomes. */
export type PipelineEventStatus = "queued" | "in_progress" | "success" | "failure" | "cancelled";

/** Normalized CI pipeline status update carried through the webhook layer; `status` is one of {@link PipelineEventStatus}. */
export interface PipelineEvent {
  id: string;
  taskId: string;
  provider: "github" | "gitlab";
  repo: string;
  runId: string;
  status: PipelineEventStatus;
  branch: string;
  commitSha: string | null;
  createdAt: string;
}
