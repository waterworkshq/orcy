/**
 * v0.29 Phase 1 — Characterize and Canonicalize.
 *
 * Byte-equality gate for the upcoming collector extraction (Phase 3). This
 * test seeds a habitat with one record of every current audit projection
 * family and snapshots the full `queryAuditEvents` output as inline golden
 * JSON. If any of the existing projector functions change shape, ID prefix,
 * linked-entity resolution, completeness status, or metadata allowlist,
 * the snapshot here will diverge and the Phase 3 refactor will be blocked
 * from claiming byte-equivalence.
 *
 * Capture protocol: run `pnpm --filter @orcy/api test auditQueryCharacterization -u`
 * to regenerate the inline snapshots after an intentional projection change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
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
  habitatCodeRepositories,
  habitatHealthSnapshots,
  habitats,
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
import { correctEffortEntry, logEffort } from "../services/effortService.js";
import { runWithAuditProvenance, setAuditActor } from "../services/auditProvenanceContext.js";

const HABITAT_FROZEN_NOW = new Date("2026-07-01T12:00:00.000Z");

/**
 * Replace generated UUIDs with a stable placeholder so the inline snapshot is
 * deterministic across runs. UUIDs are an external, runtime-mutable detail
 * — the byte-equality gate must lock down projection shape, link counts, and
 * field values, not row identities. Phase 3 cannot claim equivalence if any
 * normalized field diverges.
 */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function normalizeSnapshot<T>(value: T): T {
  const seen = new WeakSet();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "string") return v.replace(UUID_PATTERN, "<UUID>");
      return v;
    }
    if (seen.has(v as object)) return v;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      result[k] = walk(val);
    }
    return result;
  };
  return walk(value) as T;
}

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
  db.delete(users).run();
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
  const taskA = taskRepo.createTask({
    missionId: mission.id,
    title: "Task A",
    createdBy: "user-1",
  });
  const taskB = taskRepo.createTask({
    missionId: mission.id,
    title: "Task B",
    createdBy: "user-1",
  });
  return { habitat, column, mission, taskA, taskB };
}

function seedEverything(fixture: ReturnType<typeof createFixture>) {
  const db = getDb();

  // Resolve a human actor so legacy_partial event completeness surfaces.
  db.insert(users)
    .values({
      id: "user-1",
      username: "user-1",
      passwordHash: "hash",
      displayName: "User One",
    })
    .run();

  // Lifecycle: 2 tasks + 1 mission
  vi.setSystemTime(new Date("2026-07-01T12:01:00.000Z"));
  eventRepo.createEvent({
    taskId: fixture.taskA.id,
    actorType: "agent",
    actorId: "agent-1",
    action: "started",
  });
  vi.setSystemTime(new Date("2026-07-01T12:02:00.000Z"));
  eventRepo.createEvent({
    taskId: fixture.taskB.id,
    actorType: "agent",
    actorId: "agent-1",
    action: "updated",
  });
  vi.setSystemTime(new Date("2026-07-01T12:03:00.000Z"));
  eventRepo.createMissionEvent({
    missionId: fixture.mission.id,
    actorType: "system",
    actorId: "status-engine",
    action: "status_changed",
    metadata: { reason: "task_state_change" },
  });

  // Effort: 2 entries (logged + corrected)
  vi.setSystemTime(new Date("2026-07-01T12:04:00.000Z"));
  const entry = logEffort(fixture.taskA.id, "human", "user-1", {
    minutes: 30,
    source: "human_manual",
    note: "implementation",
  });
  vi.setSystemTime(new Date("2026-07-01T12:05:00.000Z"));
  correctEffortEntry(fixture.taskA.id, entry.id, "human", "user-1", {
    minutesDelta: -5,
    correctionReason: "over_reported",
  });

  // Code evidence repository + commit + changed file
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

  vi.setSystemTime(new Date("2026-07-01T12:06:00.000Z"));
  const commit = codeCommitRepo.create({
    repositoryId: "repo-1",
    provider: "github",
    repoSlug: "orcy/app",
    sha: "abcdef1234567890",
    message: "Implement audit evidence",
    authorName: "Dev",
    authoredAt: "2026-07-01T12:06:00.000Z",
    url: "https://github.com/orcy/app/commit/abcdef1234567890",
    verificationState: "verified",
    metadata: {
      rawProviderPayload: { enormous: true },
      audit: { source: "webhook", provider: "github", externalId: "delivery-1" },
    },
  });

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
      capturedAt: "2026-07-01T12:06:30.000Z",
      metadata: { diff: "not exported" },
    })
    .run();

  // Pull request
  const pullRequest = pullRequestRepo.createPullRequest({
    taskId: fixture.taskA.id,
    provider: "github",
    repo: "orcy/app",
    prNumber: 42,
    prTitle: "Audit evidence PR",
    prUrl: "https://github.com/orcy/app/pull/42",
    state: "open",
    reviewStatus: "approved",
  });

  // Code review
  vi.setSystemTime(new Date("2026-07-01T12:07:00.000Z"));
  const review = codeReviewRepo.create({
    pullRequestId: pullRequest.id,
    repositoryId: "repo-1",
    provider: "github",
    repoSlug: "orcy/app",
    reviewStatus: "approved",
    reviewerName: "Reviewer",
    reviewerId: "reviewer-1",
    submittedAt: "2026-07-01T12:07:00.000Z",
    metadata: { audit: { source: "webhook", provider: "github", externalId: "review-1" } },
  });

  // Code evidence link
  vi.setSystemTime(new Date("2026-07-01T12:08:00.000Z"));
  const link = codeEvidenceLinkRepo.create({
    targetType: "task",
    targetId: fixture.taskA.id,
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

  // Code evidence gap
  const gap = codeEvidenceGapRepo.create({
    targetType: "mission",
    targetId: fixture.mission.id,
    reasonCode: "provider_webhook_missing",
    reportedByType: "system",
    reportedById: "system:evidence-check",
  });

  // Pipeline event
  db.insert(pipelineEvents)
    .values({
      id: "pipeline-1",
      taskId: fixture.taskA.id,
      provider: "github",
      repo: "orcy/app",
      runId: "run-1",
      status: "success",
      branch: "main",
      commitSha: "abcdef1234567890",
      repositoryId: "repo-1",
      commitId: commit!.id,
      verificationState: "verified",
      metadata: {
        payload: { not: "exported" },
        audit: { source: "webhook", provider: "github", webhookDeliveryId: "delivery-1" },
      },
      createdAt: "2026-07-01T12:09:00.000Z",
      updatedAt: "2026-07-01T12:09:30.000Z",
    })
    .run();

  // Integration connection + sync run
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
      startedAt: "2026-07-01T12:10:00.000Z",
      finishedAt: "2026-07-01T12:10:30.000Z",
      createdCount: 1,
      updatedCount: 2,
      skippedCount: 3,
      failedCount: 1,
      error: "one issue failed",
    })
    .run();

  // Webhook subscription + delivery
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
      createdAt: "2026-07-01T12:11:00.000Z",
      lastAttemptAt: "2026-07-01T12:11:30.000Z",
    })
    .run();

  // Health snapshot (opt-in only by default)
  db.insert(habitatHealthSnapshots)
    .values({
      id: "health-1",
      habitatId: fixture.habitat.id,
      score: 91,
      grade: "A",
      dimensions: JSON.stringify({ flow: 90 }),
      metrics: JSON.stringify({ throughput: 4 }),
      recommendations: JSON.stringify([]),
      snapshotAt: "2026-07-01T12:12:00.000Z",
    })
    .run();

  return { commit, link, review, gap, pullRequest };
}

describe("auditQueryEvents characterization (v0.29 Phase 1 byte-equality gate)", () => {
  it("captures the full default projection output as a golden snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    const { commit, link, review, gap } = seedEverything(fixture);

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, order: "asc" });

    const eventIds = result.events.map((event) => event.id);

    // Sanity check: every known entity family is present.
    expect(eventIds).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^task_event:/),
        expect.stringMatching(/^task_event:/),
        expect.stringMatching(/^mission_event:/),
        expect.stringMatching(/^effort_entry:/),
        expect.stringMatching(/^effort_entry:/),
        `commit:${commit!.id}`,
        `changed_file:file-1`,
        `code_evidence_link:${link!.id}`,
        `code_review:${review!.id}`,
        `code_evidence_gap:${gap!.id}`,
        `pipeline_event:pipeline-1`,
        `integration_sync_run:sync-1`,
        `webhook_delivery:delivery-1`,
      ]),
    );

    // Health snapshot is opt-in only.
    expect(eventIds).not.toContain(`health_snapshot:health-1`);

    // Full byte-equal snapshot of the canonical output. Regenerate via
    // `pnpm --filter @orcy/api test auditQueryCharacterization -u` after an
    // intentional projection change. The shape is what Phase 3 must
    // preserve verbatim.
    expect(
      normalizeSnapshot({
        eventIds,
        events: result.events,
        warnings: result.warnings,
        completenessSummary: result.completenessSummary,
      }),
    ).toMatchInlineSnapshot(`
      {
        "completenessSummary": {
          "byStatus": {
            "complete": 7,
            "legacy_partial": 7,
            "source_unavailable": 0,
          },
          "caveats": [
            "Evidence row predates canonical provenance capture or lacks request metadata.",
            "Source/provenance metadata was not captured for this historical event.",
            "Webhook payload and response body are intentionally excluded from audit output.",
          ],
          "totalEvents": 14,
        },
        "eventIds": [
          "task_event:<UUID>",
          "task_event:<UUID>",
          "mission_event:<UUID>",
          "effort_entry:<UUID>",
          "effort_entry:<UUID>",
          "commit:<UUID>",
          "pull_request:<UUID>",
          "changed_file:file-1",
          "code_review:<UUID>",
          "code_evidence_gap:<UUID>",
          "code_evidence_link:<UUID>",
          "pipeline_event:pipeline-1",
          "integration_sync_run:sync-1",
          "webhook_delivery:delivery-1",
        ],
        "events": [
          {
            "action": "started",
            "actor": {
              "id": "agent-1",
              "type": "agent",
            },
            "completeness": {
              "caveats": [
                "Source/provenance metadata was not captured for this historical event.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Task A",
              "type": "task",
            },
            "habitatId": "<UUID>",
            "id": "task_event:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {},
            "occurredAt": "2026-07-01T12:01:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Task started: Task A",
          },
          {
            "action": "updated",
            "actor": {
              "id": "agent-1",
              "type": "agent",
            },
            "completeness": {
              "caveats": [
                "Source/provenance metadata was not captured for this historical event.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Task B",
              "type": "task",
            },
            "habitatId": "<UUID>",
            "id": "task_event:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {},
            "occurredAt": "2026-07-01T12:02:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Task updated: Task B",
          },
          {
            "action": "status_changed",
            "actor": {
              "id": "system:status-engine",
              "type": "system",
            },
            "completeness": {
              "caveats": [
                "Source/provenance metadata was not captured for this historical event.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Mission",
              "type": "mission",
            },
            "habitatId": "<UUID>",
            "id": "mission_event:<UUID>",
            "linkedEntities": [],
            "metadata": {
              "reason": "task_state_change",
            },
            "occurredAt": "2026-07-01T12:03:00.000Z",
            "provenance": {},
            "source": "system",
            "summary": "Mission status changed: Mission",
          },
          {
            "action": "logged",
            "actor": {
              "id": "user-1",
              "name": "User One",
              "type": "human",
            },
            "completeness": {
              "caveats": [
                "Source/provenance metadata was not captured for this historical event.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Effort logged for task: Task A",
              "type": "effort_entry",
            },
            "habitatId": "<UUID>",
            "id": "effort_entry:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {
              "correctionReason": null,
              "correctsEntryId": null,
              "effortSource": "human_manual",
              "minutes": 30,
              "note": "implementation",
            },
            "occurredAt": "2026-07-01T12:04:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Effort logged for task: Task A",
          },
          {
            "action": "corrected",
            "actor": {
              "id": "user-1",
              "name": "User One",
              "type": "human",
            },
            "completeness": {
              "caveats": [
                "Source/provenance metadata was not captured for this historical event.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Effort corrected for task: Task A",
              "type": "effort_entry",
            },
            "habitatId": "<UUID>",
            "id": "effort_entry:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
              {
                "id": "<UUID>",
                "title": "Corrected effort entry",
                "type": "effort_entry",
              },
            ],
            "metadata": {
              "correctionReason": "over_reported",
              "correctsEntryId": "<UUID>",
              "effortSource": "correction_adjustment",
              "minutes": -5,
              "note": null,
            },
            "occurredAt": "2026-07-01T12:05:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Effort corrected for task: Task A",
          },
          {
            "action": "observed",
            "actor": {
              "id": "system:github-code",
              "name": "Dev",
              "type": "system",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "<UUID>",
              "title": "abcdef123456",
              "type": "commit",
            },
            "habitatId": "<UUID>",
            "id": "commit:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
            ],
            "metadata": {
              "audit": {
                "externalId": "delivery-1",
                "provider": "github",
                "source": "webhook",
              },
              "authorName": "Dev",
              "authoredAt": "2026-07-01T12:06:00.000Z",
              "message": "Implement audit evidence",
              "provider": "github",
              "repoSlug": "orcy/app",
              "repositoryId": "repo-1",
              "repositoryName": "Orcy App",
              "sha": "abcdef1234567890",
              "url": "https://github.com/orcy/app/commit/abcdef1234567890",
              "verificationState": "verified",
            },
            "occurredAt": "2026-07-01T12:06:00.000Z",
            "provenance": {
              "externalId": "delivery-1",
              "provider": "github",
            },
            "source": "webhook",
            "summary": "Commit observed: abcdef123456",
          },
          {
            "action": "open",
            "actor": {
              "id": "system:github-code",
              "type": "system",
            },
            "completeness": {
              "caveats": [
                "Evidence row predates canonical provenance capture or lacks request metadata.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Audit evidence PR",
              "type": "pull_request",
            },
            "habitatId": "<UUID>",
            "id": "pull_request:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {
              "branchName": null,
              "prNumber": 42,
              "prUrl": "https://github.com/orcy/app/pull/42",
              "provider": "github",
              "repo": "orcy/app",
              "reviewStatus": "approved",
              "verificationState": null,
            },
            "occurredAt": "2026-07-01T12:06:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Pull request open: Audit evidence PR",
          },
          {
            "action": "observed",
            "actor": {
              "id": "system:github-code",
              "type": "system",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "file-1",
              "title": "packages/api/src/services/auditQueryService.ts",
              "type": "changed_file",
            },
            "habitatId": "<UUID>",
            "id": "changed_file:file-1",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "abcdef1234567890",
                "type": "commit",
              },
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
            ],
            "metadata": {
              "additions": 10,
              "changeType": "modified",
              "deletions": 2,
              "path": "packages/api/src/services/auditQueryService.ts",
              "previousPath": null,
              "provider": "github",
              "repoSlug": "orcy/app",
              "source": "webhook",
            },
            "occurredAt": "2026-07-01T12:06:30.000Z",
            "provenance": {
              "externalId": "delivery-1",
              "provider": "github",
              "source": "webhook",
            },
            "source": "webhook",
            "summary": "Changed file observed: packages/api/src/services/auditQueryService.ts",
          },
          {
            "action": "approved",
            "actor": {
              "id": "reviewer-1",
              "name": "Reviewer",
              "type": "system",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "<UUID>",
              "title": "approved",
              "type": "code_review",
            },
            "habitatId": "<UUID>",
            "id": "code_review:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Audit evidence PR",
                "type": "pull_request",
              },
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {
              "audit": {
                "externalId": "review-1",
                "provider": "github",
                "source": "webhook",
              },
              "provider": "github",
              "repoSlug": "orcy/app",
              "reviewUrl": null,
              "reviewerId": "reviewer-1",
              "reviewerName": "Reviewer",
              "submittedAt": "2026-07-01T12:07:00.000Z",
              "verificationState": "unverified",
            },
            "occurredAt": "2026-07-01T12:07:00.000Z",
            "provenance": {
              "externalId": "review-1",
              "provider": "github",
            },
            "source": "webhook",
            "summary": "Code review approved: Reviewer",
          },
          {
            "action": "reported",
            "actor": {
              "id": "system:evidence-check",
              "type": "system",
            },
            "completeness": {
              "caveats": [
                "Evidence row predates canonical provenance capture or lacks request metadata.",
              ],
              "status": "legacy_partial",
            },
            "entity": {
              "id": "<UUID>",
              "title": "provider_webhook_missing",
              "type": "code_evidence_gap",
            },
            "habitatId": "<UUID>",
            "id": "code_evidence_gap:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
            ],
            "metadata": {
              "reasonCode": "provider_webhook_missing",
              "reasonNote": null,
              "resolutionReason": null,
              "status": "active",
            },
            "occurredAt": "2026-07-01T12:08:00.000Z",
            "provenance": {},
            "source": "unknown",
            "summary": "Code evidence gap reported: provider_webhook_missing",
          },
          {
            "action": "linked",
            "actor": {
              "id": "agent-1",
              "type": "agent",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "<UUID>",
              "title": "Audit evidence commit",
              "type": "code_evidence_link",
            },
            "habitatId": "<UUID>",
            "id": "code_evidence_link:<UUID>",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
              {
                "id": "<UUID>",
                "title": "Audit evidence commit",
                "type": "commit",
              },
            ],
            "metadata": {
              "allowExternalRepository": false,
              "audit": {
                "source": "mcp_tool",
                "toolName": "orcy_evidence_link",
              },
              "confidence": 1,
              "correctionReason": null,
              "evidenceId": "<UUID>",
              "evidenceType": "commit",
              "externalUrl": "https://github.com/orcy/app/commit/abcdef1234567890",
              "linkSource": "api",
              "linkSources": [],
              "replacementLinkId": null,
              "verificationState": "verified",
            },
            "occurredAt": "2026-07-01T12:08:00.000Z",
            "provenance": {
              "toolName": "orcy_evidence_link",
            },
            "source": "mcp_tool",
            "summary": "Code evidence linked: Audit evidence commit",
          },
          {
            "action": "success",
            "actor": {
              "id": "system:github-ci",
              "type": "system",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "pipeline-1",
              "title": "github run-1",
              "type": "pipeline_event",
            },
            "habitatId": "<UUID>",
            "id": "pipeline_event:pipeline-1",
            "linkedEntities": [
              {
                "id": "<UUID>",
                "title": "Task A",
                "type": "task",
              },
              {
                "id": "<UUID>",
                "title": "Mission",
                "type": "mission",
              },
              {
                "id": "<UUID>",
                "title": "abcdef1234567890",
                "type": "commit",
              },
            ],
            "metadata": {
              "audit": {
                "provider": "github",
                "source": "webhook",
                "webhookDeliveryId": "delivery-1",
              },
              "branch": "main",
              "commitSha": "abcdef1234567890",
              "provider": "github",
              "repo": "orcy/app",
              "repositoryId": "repo-1",
              "runId": "run-1",
              "status": "success",
              "verificationState": "verified",
            },
            "occurredAt": "2026-07-01T12:09:30.000Z",
            "provenance": {
              "provider": "github",
              "webhookDeliveryId": "delivery-1",
            },
            "source": "webhook",
            "summary": "Pipeline success: github run-1",
          },
          {
            "action": "partial",
            "actor": {
              "id": "system:integration-sync",
              "type": "system",
            },
            "completeness": {
              "caveats": [],
              "status": "complete",
            },
            "entity": {
              "id": "sync-1",
              "title": "github sync",
              "type": "integration_sync_run",
            },
            "habitatId": "<UUID>",
            "id": "integration_sync_run:sync-1",
            "linkedEntities": [],
            "metadata": {
              "connectionId": "conn-1",
              "connectionName": "GitHub",
              "createdCount": 1,
              "error": "one issue failed",
              "failedCount": 1,
              "finishedAt": "2026-07-01T12:10:30.000Z",
              "provider": "github",
              "skippedCount": 3,
              "startedAt": "2026-07-01T12:10:00.000Z",
              "status": "partial",
              "trigger": "scheduled",
              "updatedCount": 2,
            },
            "occurredAt": "2026-07-01T12:10:30.000Z",
            "provenance": {
              "integrationSyncRunId": "sync-1",
              "provider": "github",
              "reason": "trigger:scheduled",
            },
            "source": "integration_sync",
            "summary": "Integration sync partial: GitHub",
          },
          {
            "action": "failed",
            "actor": {
              "id": "system:webhook-dispatcher",
              "type": "system",
            },
            "completeness": {
              "caveats": [
                "Webhook payload and response body are intentionally excluded from audit output.",
              ],
              "status": "complete",
            },
            "entity": {
              "id": "delivery-1",
              "title": "task.updated",
              "type": "webhook_delivery",
            },
            "habitatId": "<UUID>",
            "id": "webhook_delivery:delivery-1",
            "linkedEntities": [],
            "metadata": {
              "attempts": 2,
              "createdAt": "2026-07-01T12:11:00.000Z",
              "eventType": "task.updated",
              "lastAttemptAt": "2026-07-01T12:11:30.000Z",
              "nextRetryAt": null,
              "status": "failed",
              "statusCode": 500,
              "subscriptionId": "sub-1",
              "subscriptionName": "Audit sink",
            },
            "occurredAt": "2026-07-01T12:11:30.000Z",
            "provenance": {
              "reason": "subscription:sub-1",
              "webhookDeliveryId": "delivery-1",
            },
            "source": "webhook",
            "summary": "Webhook delivery failed: task.updated",
          },
        ],
        "warnings": [
          {
            "code": "legacy_partial_history",
            "message": "Some events predate canonical provenance capture and may have partial source data.",
          },
        ],
      }
    `);
  });

  it("includes health snapshots when includeHealthSnapshots is true", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    seedEverything(fixture);

    const result = queryAuditEvents({
      habitatId: fixture.habitat.id,
      order: "asc",
      includeHealthSnapshots: true,
    });

    expect(result.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([`health_snapshot:health-1`]),
    );
    expect(result.events.find((event) => event.id === `health_snapshot:health-1`)).toMatchObject({
      entity: { type: "health_snapshot", id: "health-1" },
      action: "snapshot_recorded",
      actor: { type: "system", id: "system:health-engine" },
      source: "system",
      completeness: { status: "complete" },
    });
  });

  it.each([
    "task",
    "mission",
    "effort_entry",
    "code_evidence_link",
    "code_evidence_gap",
    "commit",
    "changed_file",
    "pull_request",
    "code_review",
    "pipeline_event",
    "integration_sync_run",
    "webhook_delivery",
    "health_snapshot",
  ] as const)("filters by entityType %s", (entityType) => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    seedEverything(fixture);

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, entityType, order: "asc" });
    const ids = result.events.map((event) => event.id);

    for (const id of ids) {
      const event = result.events.find((e) => e.id === id);
      expect(event).toBeDefined();
      // The primary entity must match the requested filter.
      expect(event!.entity.type).toBe(entityType);
    }
    // No event from a different family should leak through.
    for (const id of ids) {
      const prefix = id.split(":")[0];
      const expectedPrefix: Record<typeof entityType, string> = {
        task: "task_event",
        mission: "mission_event",
        effort_entry: "effort_entry",
        code_evidence_link: "code_evidence_link",
        code_evidence_gap: "code_evidence_gap",
        commit: "commit",
        changed_file: "changed_file",
        pull_request: "pull_request",
        code_review: "code_review",
        pipeline_event: "pipeline_event",
        integration_sync_run: "integration_sync_run",
        webhook_delivery: "webhook_delivery",
        health_snapshot: "health_snapshot",
      };
      expect(prefix).toBe(expectedPrefix[entityType]);
    }
  });

  it("filters by source: mcp_tool", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    seedEverything(fixture);

    runWithAuditProvenance(
      { source: "mcp_tool", requestId: "req-1", method: "POST", toolName: "orcy_habitat_task" },
      () => {
        setAuditActor("agent", "agent-1");
        eventRepo.createEvent({
          taskId: fixture.taskA.id,
          actorType: "agent",
          actorId: "agent-1",
          action: "updated",
        });
      },
    );

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, source: "mcp_tool" });
    expect(result.events).toHaveLength(2); // 1 task event + 1 code_evidence_link
    for (const event of result.events) {
      expect(event.source).toBe("mcp_tool");
    }
  });

  it("filters by source: webhook", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    seedEverything(fixture);

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, source: "webhook" });
    for (const event of result.events) {
      expect(event.source).toBe("webhook");
    }
    // Commit, changed_file, code_review, pipeline_event, webhook_delivery
    expect(result.events.length).toBeGreaterThanOrEqual(5);
  });

  it("filters by actorType", () => {
    vi.useFakeTimers();
    vi.setSystemTime(HABITAT_FROZEN_NOW);
    const fixture = createFixture();
    seedEverything(fixture);

    const result = queryAuditEvents({ habitatId: fixture.habitat.id, actorType: "agent" });
    for (const event of result.events) {
      expect(event.actor.type).toBe("agent");
    }
  });
});
