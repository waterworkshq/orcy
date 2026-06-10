import type { KanbanApiClient } from "../api.js";
import type {
  TaskClient,
  MissionClient,
  HabitatClient,
  PulseClient,
  CodeEvidenceClient,
  SkillClient,
  AgentClient,
  SprintClient,
  ScheduledTaskClient,
  ReviewClient,
  EffortClient,
  MessageClient,
  CommentClient,
  AuditClient,
  InsightClient,
  QualityClient,
  DependencyClient,
  HealthClient,
  DashboardClient,
  WebhookClient,
  TemplateClient,
  TimeTrackingClient,
  IntegrationClient,
} from "./interfaces.js";

export type ApiClient = KanbanApiClient & ApiClientDomains;

export type ApiClientDomains =
  & TaskClient
  & MissionClient
  & HabitatClient
  & PulseClient
  & CodeEvidenceClient
  & SkillClient
  & AgentClient
  & SprintClient
  & ScheduledTaskClient
  & ReviewClient
  & EffortClient
  & MessageClient
  & CommentClient
  & AuditClient
  & InsightClient
  & QualityClient
  & DependencyClient
  & HealthClient
  & DashboardClient
  & WebhookClient
  & TemplateClient
  & TimeTrackingClient
  & IntegrationClient;

export function createFacade(client: KanbanApiClient): ApiClient {
  return client as ApiClient;
}
