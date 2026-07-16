import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeReviewRepo from "../repositories/codeReviewRepository.js";
import * as pullRequestRepo from "../repositories/pullRequest.js";
import {
  codeChangedFiles,
  codeCommits,
  codeEvidenceGaps,
  codeEvidenceLinks,
  codeReviews,
  columns,
  habitats,
  habitatCodeRepositories,
  habitatHealthSnapshots,
  integrationConnections,
  integrationSyncRuns,
  missionEvents,
  missions,
  pipelineEvents,
  pullRequests,
  taskEvents,
  tasks,
  webhookDeliveries,
  webhookSubscriptions,
} from "../db/schema/index.js";
import { queryAuditEvents } from "../services/auditQueryService.js";
import { users } from "../db/schema/index.js";
import { deleteMission } from "../services/featureService.js";
import { correctEffortEntry, logEffort } from "../services/effortService.js";
import { runWithAuditProvenance, setAuditActor } from "../services/auditProvenanceContext.js";

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(webhookDeliveries).run();
  db.delete(webhookSubscriptions).run();
  db.delete(integrationSyncRuns).run();
  db.delete(integrationConnections).run();
  db.delete(habitatHealthSnapshots).run();
  db.delete(pipelineEvents).run();
  db.delete(codeReviews).run();
  db.delete(codeChangedFiles).run();
  db.delete(codeEvidenceGaps).run();
  db.delete(codeEvidenceLinks).run();
  db.delete(pullRequests).run();
  db.delete(codeCommits).run();
  db.delete(habitatCodeRepositories).run();
  db.delete(taskEvents).run();
  db.delete(missionEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function createFixture() {
  const habitat = habitatRepo.createHabitat({ name: "Habitat" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Mission",
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "user-1" });
  return { habitat, column, mission, task };
}

describe("auditQueryService", () => {
  it("projects task and mission events into canonical audit events", () => {
    vi.useFakeTimers();
    const fixture = createFixture();

    vi.setSystemTime(new Date("2026-06-04T01:00:00.000Z"));
    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "agent",
      actorId: "agent-1",
      action: "started",
    });
    vi.setSystemTime(new Date("2026-06-04T02:00:00.000Z"));
    eventRepo.createMissionEvent({
      missionId: fixture.mission.id,
      actorType: "system",
      actorId: "status-engine",
      action: "status_changed",
      metadata: { reason: "task_state_change" },
    });

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });

    expect(result.events.map((event) => event.id)).toEqual([
      expect.stringMatching(/^task_event:/),
      expect.stringMatching(/^mission_event:/),
    ]);
    expect(result.events[0]).toMatchObject({
      habitatId: fixture.habitat.id,
      entity: { type: "task", id: fixture.task.id, title: "Task" },
      linkedEntities: [{ type: "mission", id: fixture.mission.id, title: "Mission" }],
      source: "unknown",
      completeness: { status: "legacy_partial" },
    });
    expect(result.events[1]).toMatchObject({
      entity: { type: "mission", id: fixture.mission.id, title: "Mission" },
      actor: { type: "system", id: "system:status-engine" },
      source: "system",
      summary: "Mission status changed: Mission",
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "legacy_partial_history" }),
    );
    expect(result.completenessSummary).toEqual({
      totalEvents: 2,
      byStatus: { complete: 0, legacy_partial: 2, source_unavailable: 0 },
      caveats: ["Source/provenance metadata was not captured for this historical event."],
    });
  });

  it("uses request provenance metadata for source filters", () => {
    const fixture = createFixture();

    runWithAuditProvenance(
      { source: "mcp_tool", requestId: "req-1", method: "POST", toolName: "orcy_habitat_task" },
      () => {
        setAuditActor("agent", "agent-1");
        eventRepo.createEvent({
          taskId: fixture.task.id,
          actorType: "agent",
          actorId: "agent-1",
          action: "updated",
        });
      },
    );

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, source: "mcp_tool" });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      source: "mcp_tool",
      provenance: { requestId: "req-1", method: "POST", toolName: "orcy_habitat_task" },
      completeness: { status: "complete", caveats: [] },
    });
  });

  it("validates taskId alias conflicts", () => {
    const fixture = createFixture();

    expect(() =>
      queryAuditEvents({
        habitatId: fixture.habitat.id,
        taskId: fixture.task.id,
        entityType: "mission",
        entityId: fixture.mission.id,
      }),
    ).toThrow("taskId conflicts");
  });

  it("projects effort entries and suppresses mirrored task effort events by default", () => {
    const fixture = createFixture();

    const entry = logEffort(fixture.task.id, "human", "user-1", {
      minutes: 30,
      source: "human_manual",
      note: "implementation",
    });
    correctEffortEntry(fixture.task.id, entry.id, "human", "user-1", {
      minutesDelta: -5,
      correctionReason: "over_reported",
    });

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });

    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.id)).toEqual([
      `effort_entry:${entry.id}`,
      expect.stringMatching(/^effort_entry:/),
    ]);
    expect(result.events[0]).toMatchObject({
      entity: { type: "effort_entry", id: entry.id },
      action: "logged",
      summary: "Effort logged for task: Task",
      linkedEntities: [
        { type: "task", id: fixture.task.id, title: "Task" },
        { type: "mission", id: fixture.mission.id, title: "Mission" },
      ],
      metadata: { minutes: 30, effortSource: "human_manual", note: "implementation" },
    });
    expect(result.events[1]).toMatchObject({
      action: "corrected",
      summary: "Effort corrected for task: Task",
      linkedEntities: expect.arrayContaining([
        { type: "effort_entry", id: entry.id, title: "Corrected effort entry" },
      ]),
    });
  });

  it("projects retained delete events after the mission row is gone", () => {
    const fixture = createFixture();

    deleteMission(fixture.mission.id, "user-1", "human");

    const result = queryAuditEvents({
      habitatId: fixture.habitat.id,
      missionId: fixture.mission.id,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      entity: { type: "mission", id: fixture.mission.id, title: "Mission" },
      action: "deleted",
      summary: "Mission deleted: Mission",
      metadata: { habitatId: fixture.habitat.id },
    });
  });

  it("projects code evidence records with safe metadata and explicit provenance caveats", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const db = getDb();

    db.insert(habitatCodeRepositories)
      .values({
        id: "repo-1",
        habitatId: fixture.habitat.id,
        provider: "github",
        repoSlug: "orcy/app",
        displayName: "Orcy App",
        verificationState: "verified",
      })
      .run();

    vi.setSystemTime(new Date("2026-06-04T03:00:00.000Z"));
    const commit = codeCommitRepo.create({
      repositoryId: "repo-1",
      provider: "github",
      repoSlug: "orcy/app",
      sha: "abcdef1234567890",
      message: "Implement audit evidence",
      authorName: "Dev",
      authoredAt: "2026-06-04T03:00:00.000Z",
      url: "https://github.com/orcy/app/commit/abcdef1234567890",
      verificationState: "verified",
      metadata: {
        rawProviderPayload: { enormous: true },
        audit: { source: "webhook", provider: "github", externalId: "delivery-1" },
      },
    });
    expect(commit).not.toBeNull();

    db.insert(codeChangedFiles)
      .values({
        id: "file-1",
        repositoryId: "repo-1",
        commitId: commit!.id,
        provider: "github",
        repoSlug: "orcy/app",
        path: "packages/api/src/services/auditQueryService.ts",
        changeType: "modified",
        additions: 10,
        deletions: 2,
        source: "webhook",
        capturedAt: "2026-06-04T03:01:00.000Z",
        metadata: { diff: "not exported" },
      })
      .run();

    vi.setSystemTime(new Date("2026-06-04T03:02:00.000Z"));
    const link = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: fixture.task.id,
      evidenceType: "commit",
      evidenceId: commit!.id,
      title: "Audit evidence commit",
      externalUrl: "https://github.com/orcy/app/commit/abcdef1234567890",
      linkSource: "api",
      linkedByType: "agent",
      linkedById: "agent-1",
      verificationState: "verified",
      confidence: 1,
      metadata: {
        rawPayload: { unsafe: true },
        audit: { source: "mcp_tool", toolName: "orcy_evidence_link" },
      },
    });
    expect(link).not.toBeNull();

    const pullRequest = pullRequestRepo.createPullRequest({
      taskId: fixture.task.id,
      provider: "github",
      repo: "orcy/app",
      prNumber: 42,
      prTitle: "Audit evidence PR",
      prUrl: "https://github.com/orcy/app/pull/42",
      state: "open",
      reviewStatus: "approved",
    });

    const review = codeReviewRepo.create({
      pullRequestId: pullRequest.id,
      repositoryId: "repo-1",
      provider: "github",
      repoSlug: "orcy/app",
      reviewStatus: "approved",
      reviewerName: "Reviewer",
      reviewerId: "reviewer-1",
      submittedAt: "2026-06-04T03:03:00.000Z",
      metadata: { audit: { source: "webhook", provider: "github", externalId: "review-1" } },
    });
    expect(review).not.toBeNull();

    const gap = codeEvidenceGapRepo.create({
      targetType: "mission",
      targetId: fixture.mission.id,
      reasonCode: "provider_webhook_missing",
      reportedByType: "system",
      reportedById: "system:evidence-check",
    });
    expect(gap).not.toBeNull();

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });

    expect(result.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        `commit:${commit!.id}`,
        "changed_file:file-1",
        `code_evidence_link:${link!.id}`,
        `pull_request:${pullRequest.id}`,
        `code_review:${review!.id}`,
        `code_evidence_gap:${gap!.id}`,
      ]),
    );
    expect(
      result.events.find((event) => event.id === `code_evidence_link:${link!.id}`),
    ).toMatchObject({
      entity: { type: "code_evidence_link", id: link!.id, title: "Audit evidence commit" },
      action: "linked",
      source: "mcp_tool",
      linkedEntities: expect.arrayContaining([
        { type: "task", id: fixture.task.id, title: "Task" },
        { type: "commit", id: commit!.id, title: "Audit evidence commit" },
      ]),
      completeness: { status: "complete", caveats: [] },
    });
    expect(result.events.find((event) => event.id === `commit:${commit!.id}`)).toMatchObject({
      source: "webhook",
      completeness: { status: "complete", caveats: [] },
      metadata: expect.not.objectContaining({ rawProviderPayload: expect.anything() }),
    });
    expect(result.events.find((event) => event.id === "changed_file:file-1")).toMatchObject({
      source: "webhook",
      completeness: { status: "complete", caveats: [] },
      metadata: expect.not.objectContaining({ diff: expect.anything() }),
    });
    expect(
      result.events.find((event) => event.id === `pull_request:${pullRequest.id}`),
    ).toMatchObject({
      entity: { type: "pull_request", id: pullRequest.id, title: "Audit evidence PR" },
      linkedEntities: expect.arrayContaining([
        { type: "task", id: fixture.task.id, title: "Task" },
      ]),
      completeness: { status: "legacy_partial" },
    });
    expect(
      result.events.find((event) => event.id === `code_evidence_gap:${gap!.id}`),
    ).toMatchObject({
      entity: { type: "code_evidence_gap", id: gap!.id, title: "provider_webhook_missing" },
      action: "reported",
      completeness: { status: "legacy_partial" },
    });
  });

  it("projects pipeline, integration sync, webhook delivery, and opt-in health snapshots", () => {
    const fixture = createFixture();
    const db = getDb();

    db.insert(habitatCodeRepositories)
      .values({
        id: "repo-1",
        habitatId: fixture.habitat.id,
        provider: "github",
        repoSlug: "orcy/app",
        displayName: "Orcy App",
      })
      .run();
    const commit = codeCommitRepo.create({
      repositoryId: "repo-1",
      provider: "github",
      repoSlug: "orcy/app",
      sha: "feedface12345678",
      metadata: {
        audit: { source: "webhook", provider: "github", webhookDeliveryId: "delivery-1" },
      },
    });
    expect(commit).not.toBeNull();

    db.insert(pipelineEvents)
      .values({
        id: "pipeline-1",
        taskId: fixture.task.id,
        provider: "github",
        repo: "orcy/app",
        runId: "run-1",
        status: "success",
        branch: "main",
        commitSha: "feedface12345678",
        repositoryId: "repo-1",
        commitId: commit!.id,
        verificationState: "verified",
        metadata: {
          payload: { not: "exported" },
          audit: { source: "webhook", provider: "github", webhookDeliveryId: "delivery-1" },
        },
        createdAt: "2026-06-04T04:00:00.000Z",
        updatedAt: "2026-06-04T04:01:00.000Z",
      })
      .run();

    db.insert(integrationConnections)
      .values({
        id: "conn-1",
        habitatId: fixture.habitat.id,
        provider: "github",
        name: "GitHub",
        authMethod: "gh_cli",
        createdBy: "user-1",
      })
      .run();
    db.insert(integrationSyncRuns)
      .values({
        id: "sync-1",
        connectionId: "conn-1",
        habitatId: fixture.habitat.id,
        trigger: "scheduled",
        status: "partial",
        startedAt: "2026-06-04T04:02:00.000Z",
        finishedAt: "2026-06-04T04:03:00.000Z",
        createdCount: 1,
        updatedCount: 2,
        skippedCount: 3,
        failedCount: 1,
        error: "one issue failed",
      })
      .run();

    db.insert(webhookSubscriptions)
      .values({
        id: "sub-1",
        habitatId: fixture.habitat.id,
        name: "Audit sink",
        url: "https://example.com/webhook",
        events: ["task.updated"],
        headers: { Authorization: "secret" },
      })
      .run();
    db.insert(webhookDeliveries)
      .values({
        id: "delivery-1",
        subscriptionId: "sub-1",
        eventType: "task.updated",
        payload: JSON.stringify({ raw: "not exported" }),
        status: "failed",
        statusCode: 500,
        responseBody: "not exported",
        attempts: 2,
        createdAt: "2026-06-04T04:04:00.000Z",
        lastAttemptAt: "2026-06-04T04:05:00.000Z",
      })
      .run();

    db.insert(habitatHealthSnapshots)
      .values({
        id: "health-1",
        habitatId: fixture.habitat.id,
        score: 91,
        grade: "A",
        dimensions: JSON.stringify({ flow: 90 }),
        metrics: JSON.stringify({ throughput: 4 }),
        recommendations: JSON.stringify([]),
        snapshotAt: "2026-06-04T04:06:00.000Z",
      })
      .run();

    const defaultResult = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });

    expect(defaultResult.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        "pipeline_event:pipeline-1",
        "integration_sync_run:sync-1",
        "webhook_delivery:delivery-1",
      ]),
    );
    expect(defaultResult.events.map((event) => event.id)).not.toContain("health_snapshot:health-1");
    expect(
      defaultResult.events.find((event) => event.id === "pipeline_event:pipeline-1"),
    ).toMatchObject({
      entity: { type: "pipeline_event", id: "pipeline-1", title: "github run-1" },
      action: "success",
      source: "webhook",
      linkedEntities: expect.arrayContaining([
        { type: "task", id: fixture.task.id, title: "Task" },
        { type: "commit", id: commit!.id, title: "feedface12345678" },
      ]),
      metadata: expect.not.objectContaining({ payload: expect.anything() }),
    });
    expect(
      defaultResult.events.find((event) => event.id === "integration_sync_run:sync-1"),
    ).toMatchObject({
      actor: { type: "system", id: "system:integration-sync" },
      source: "integration_sync",
      provenance: {
        provider: "github",
        integrationSyncRunId: "sync-1",
        reason: "trigger:scheduled",
      },
      metadata: { createdCount: 1, updatedCount: 2, skippedCount: 3, failedCount: 1 },
    });
    expect(
      defaultResult.events.find((event) => event.id === "webhook_delivery:delivery-1"),
    ).toMatchObject({
      source: "webhook",
      metadata: expect.not.objectContaining({
        payload: expect.anything(),
        responseBody: expect.anything(),
      }),
      completeness: { status: "complete" },
    });

    const healthResult = queryAuditEvents({
      habitatId: fixture.habitat.id,
      entityType: "health_snapshot",
      order: "asc",
    });
    expect(healthResult.events).toHaveLength(1);
    expect(healthResult.events[0]).toMatchObject({
      id: "health_snapshot:health-1",
      action: "snapshot_recorded",
      actor: { type: "system", id: "system:health-engine" },
      source: "system",
    });
  });

  it("resolves human actor names from users table", async () => {
    const db = getDb();
    const fixture = createFixture();
    db.insert(users)
      .values({
        id: "human-test-user",
        username: "testhuman",
        passwordHash: "hash",
        displayName: "Test Human",
      })
      .run();

    eventRepo.createEvent({
      taskId: fixture.task.id,
      actorType: "human",
      actorId: "human-test-user",
      action: "started",
    });

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });
    const humanEvent = result.events.find((e) => e.actor.id === "human-test-user");
    expect(humanEvent).toBeDefined();
    expect(humanEvent!.actor.name).toBe("Test Human");
  });
});
