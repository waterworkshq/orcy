export interface WebhookSubscription {
  id: string;
  boardId: string | null;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  headers: Record<string, string>;
  format: 'standard' | 'slack' | 'discord';
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  status: 'pending' | 'success' | 'failed';
  statusCode: number | null;
  responseBody: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export type PipelineEventStatus = 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled';

export interface PipelineEvent {
  id: string;
  taskId: string;
  provider: 'github' | 'gitlab';
  repo: string;
  runId: string;
  status: PipelineEventStatus;
  branch: string;
  commitSha: string | null;
  createdAt: string;
}
