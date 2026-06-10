import { describe, it, expect, vi } from "vitest";
import {
  createMockTaskClient,
  createMockMissionClient,
  createMockHabitatClient,
  createMockPulseClient,
  createMockCodeEvidenceClient,
  createMockSkillClient,
  createMockAgentClient,
  createMockSprintClient,
  createMockScheduledTaskClient,
  createMockReviewClient,
  createMockEffortClient,
  createMockMessageClient,
  createMockCommentClient,
  createMockAuditClient,
  createMockInsightClient,
  createMockQualityClient,
  createMockDependencyClient,
  createMockHealthClient,
  createMockDashboardClient,
  createMockWebhookClient,
  createMockTemplateClient,
  createMockTimeTrackingClient,
  createMockIntegrationClient,
} from "../__tests__/__fixtures__/mock-domains.js";
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
} from "../api/interfaces.js";

describe("Per-domain mock factories", () => {
  it("createMockTaskClient returns a complete TaskClient", () => {
    const mock = createMockTaskClient() as TaskClient;
    expect(typeof mock.claimTask).toBe("function");
    expect(typeof mock.startTask).toBe("function");
    expect(typeof mock.submitTask).toBe("function");
    expect(typeof mock.completeTask).toBe("function");
    expect(typeof mock.deleteTask).toBe("function");
    expect(typeof mock.getTask).toBe("function");
  });

  it("createMockMissionClient returns a complete MissionClient", () => {
    const mock = createMockMissionClient() as MissionClient;
    expect(typeof mock.listMissions).toBe("function");
    expect(typeof mock.getMissionContext).toBe("function");
    expect(typeof mock.archiveMission).toBe("function");
  });

  it("createMockHabitatClient returns a complete HabitatClient", () => {
    const mock = createMockHabitatClient() as HabitatClient;
    expect(typeof mock.getHabitat).toBe("function");
    expect(typeof mock.getHabitatSettings).toBe("function");
  });

  it("createMockPulseClient returns a complete PulseClient", () => {
    const mock = createMockPulseClient() as PulseClient;
    expect(typeof mock.postPulse).toBe("function");
    expect(typeof mock.getPulseDigest).toBe("function");
    expect(typeof mock.reactToPulse).toBe("function");
  });

  it("createMockCodeEvidenceClient returns a complete CodeEvidenceClient", () => {
    const mock = createMockCodeEvidenceClient() as CodeEvidenceClient;
    expect(typeof mock.getTaskCodeEvidence).toBe("function");
    expect(typeof mock.linkTaskCodeEvidence).toBe("function");
    expect(typeof mock.resolveMissionEvidenceGap).toBe("function");
  });

  it("createMockSkillClient returns a complete SkillClient", () => {
    const mock = createMockSkillClient() as SkillClient;
    expect(typeof mock.getHabitatSkill).toBe("function");
    expect(typeof mock.refreshHabitatSkill).toBe("function");
  });

  it("createMockAgentClient returns a complete AgentClient", () => {
    const mock = createMockAgentClient() as AgentClient;
    expect(typeof mock.heartbeat).toBe("function");
    expect(typeof mock.getAgent).toBe("function");
    expect(typeof mock.registerAgent).toBe("function");
  });

  it("createMockSprintClient returns a complete SprintClient", () => {
    const mock = createMockSprintClient() as SprintClient;
    expect(typeof mock.listSprints).toBe("function");
    expect(typeof mock.startSprint).toBe("function");
  });

  it("createMockScheduledTaskClient returns a complete ScheduledTaskClient", () => {
    const mock = createMockScheduledTaskClient() as ScheduledTaskClient;
    expect(typeof mock.listScheduledTasks).toBe("function");
    expect(typeof mock.runScheduledTask).toBe("function");
  });

  it("createMockReviewClient returns a complete ReviewClient", () => {
    const mock = createMockReviewClient() as ReviewClient;
    expect(typeof mock.listReviewRules).toBe("function");
    expect(typeof mock.addTaskReviewer).toBe("function");
  });

  it("createMockEffortClient returns a complete EffortClient", () => {
    const mock = createMockEffortClient() as EffortClient;
    expect(typeof mock.logEffort).toBe("function");
    expect(typeof mock.correctEffortEntry).toBe("function");
  });

  it("createMockMessageClient returns a complete MessageClient", () => {
    const mock = createMockMessageClient() as MessageClient;
    expect(typeof mock.sendMessage).toBe("function");
    expect(typeof mock.getMessages).toBe("function");
  });

  it("createMockCommentClient returns a complete CommentClient", () => {
    const mock = createMockCommentClient() as CommentClient;
    expect(typeof mock.addComment).toBe("function");
    expect(typeof mock.addMissionComment).toBe("function");
  });

  it("createMockAuditClient returns a complete AuditClient", () => {
    const mock = createMockAuditClient() as AuditClient;
    expect(typeof mock.exportAuditLog).toBe("function");
    expect(typeof mock.getTaskAuditBundle).toBe("function");
  });

  it("createMockInsightClient returns a complete InsightClient", () => {
    const mock = createMockInsightClient() as InsightClient;
    expect(typeof mock.promoteInsight).toBe("function");
    expect(typeof mock.getRelevantInsights).toBe("function");
  });

  it("createMockQualityClient returns a complete QualityClient", () => {
    const mock = createMockQualityClient() as QualityClient;
    expect(typeof mock.validateQualityGates).toBe("function");
  });

  it("createMockDependencyClient returns a complete DependencyClient", () => {
    const mock = createMockDependencyClient() as DependencyClient;
    expect(typeof mock.getTaskDependencies).toBe("function");
  });

  it("createMockHealthClient returns a complete HealthClient", () => {
    const mock = createMockHealthClient() as HealthClient;
    expect(typeof mock.getHabitatHealth).toBe("function");
  });

  it("createMockDashboardClient returns a complete DashboardClient", () => {
    const mock = createMockDashboardClient() as DashboardClient;
    expect(typeof mock.getHabitatSummary).toBe("function");
  });

  it("createMockWebhookClient returns a complete WebhookClient", () => {
    const mock = createMockWebhookClient() as WebhookClient;
    expect(typeof mock.listWebhooks).toBe("function");
  });

  it("createMockTemplateClient returns a complete TemplateClient", () => {
    const mock = createMockTemplateClient() as TemplateClient;
    expect(typeof mock.listTemplates).toBe("function");
  });

  it("createMockTimeTrackingClient returns a complete TimeTrackingClient", () => {
    const mock = createMockTimeTrackingClient() as TimeTrackingClient;
    expect(typeof mock.getTaskTimeReport).toBe("function");
  });

  it("createMockIntegrationClient returns a complete IntegrationClient", () => {
    const mock = createMockIntegrationClient() as IntegrationClient;
    expect(typeof mock.inferRepositoryFromIntegration).toBe("function");
  });

  it("mock factory return values are chainable vi.fn() spies", async () => {
    const mock = createMockTaskClient() as TaskClient;
    (mock.claimTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      task: { id: "t1" } as never,
    });
    const result = await mock.claimTask("t1", "a1");
    expect(result).toEqual({ success: true, task: { id: "t1" } });
  });
});
