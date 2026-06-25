import { vi } from "vitest";
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
  WikiClient,
} from "../../api/interfaces.js";

function mockAll<T>(): T {
  const cache = new Map<string | symbol, ReturnType<typeof vi.fn>>();
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        let fn = cache.get(prop);
        if (!fn) {
          fn = vi.fn();
          cache.set(prop, fn);
        }
        return fn;
      },
    },
  ) as T;
}

export function createMockTaskClient(): TaskClient {
  return mockAll<TaskClient>();
}

export function createMockMissionClient(): MissionClient {
  return mockAll<MissionClient>();
}

export function createMockHabitatClient(): HabitatClient {
  return mockAll<HabitatClient>();
}

export function createMockPulseClient(): PulseClient {
  return mockAll<PulseClient>();
}

export function createMockCodeEvidenceClient(): CodeEvidenceClient {
  return mockAll<CodeEvidenceClient>();
}

export function createMockSkillClient(): SkillClient {
  return mockAll<SkillClient>();
}

export function createMockAgentClient(): AgentClient {
  return mockAll<AgentClient>();
}

export function createMockSprintClient(): SprintClient {
  return mockAll<SprintClient>();
}

export function createMockScheduledTaskClient(): ScheduledTaskClient {
  return mockAll<ScheduledTaskClient>();
}

export function createMockReviewClient(): ReviewClient {
  return mockAll<ReviewClient>();
}

export function createMockEffortClient(): EffortClient {
  return mockAll<EffortClient>();
}

export function createMockMessageClient(): MessageClient {
  return mockAll<MessageClient>();
}

export function createMockCommentClient(): CommentClient {
  return mockAll<CommentClient>();
}

export function createMockAuditClient(): AuditClient {
  return mockAll<AuditClient>();
}

export function createMockInsightClient(): InsightClient {
  return mockAll<InsightClient>();
}

export function createMockQualityClient(): QualityClient {
  return mockAll<QualityClient>();
}

export function createMockDependencyClient(): DependencyClient {
  return mockAll<DependencyClient>();
}

export function createMockHealthClient(): HealthClient {
  return mockAll<HealthClient>();
}

export function createMockDashboardClient(): DashboardClient {
  return mockAll<DashboardClient>();
}

export function createMockWebhookClient(): WebhookClient {
  return mockAll<WebhookClient>();
}

export function createMockTemplateClient(): TemplateClient {
  return mockAll<TemplateClient>();
}

export function createMockTimeTrackingClient(): TimeTrackingClient {
  return mockAll<TimeTrackingClient>();
}

export function createMockIntegrationClient(): IntegrationClient {
  return mockAll<IntegrationClient>();
}

export function createMockWikiClient(): WikiClient {
  return mockAll<WikiClient>();
}
