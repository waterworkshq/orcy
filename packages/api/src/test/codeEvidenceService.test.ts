import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as pipelineEventRepo from "../repositories/pipelineEvent.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import {
  linkTaskCodeEvidence,
  linkMissionCodeEvidence,
  getTaskCodeEvidence,
  getMissionCodeEvidence,
  correctEvidenceLink,
  markCodeEvidenceNotApplicable,
  clearCodeEvidenceNotApplicable,
  reportCodeEvidenceGap,
  resolveCodeEvidenceGap,
  ensureEvidenceLinkForPullRequest,
  ensureEvidenceLinkForPipelineEvent,
  mirrorArtifactsToCodeEvidence,
  backfillExistingCodeEvidence,
} from "../services/codeEvidenceService.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

function seedHabitatWithRepo() {
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  const col = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: col.id,
    title: "Test Mission",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Test Task",
    createdBy: "test",
  });
  const repo = codeEvidenceRepository.create({
    habitatId: habitat.id,
    provider: "github",
    repoSlug: "org/repo",
  });
  return { habitat, col, mission, task, repo };
}

const defaultActor = { type: "human" as const, id: "test-user" };

describe("URL Parsing via linkTaskCodeEvidence", () => {
  it("parses GitHub PR URL into pull_request evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/owner/repo/pull/123",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pull_request");
    expect(result.links[0].url).toBe("https://github.com/owner/repo/pull/123");
    expect(result.links[0].title).toContain("123");
  });

  it("parses GitHub commit URL into commit evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: [
          "https://github.com/owner/repo/commit/abc123def456789012345678901234567890abcd",
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("commit");
    expect(result.links[0].title).toContain("abc123de");
  });

  it("parses GitHub Actions run URL into pipeline_run evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pipelineUrl: "https://github.com/owner/repo/actions/runs/456",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pipeline_run");
    expect(result.links[0].url).toBe("https://github.com/owner/repo/actions/runs/456");
  });

  it("parses GitLab MR URL into pull_request evidence with gitlab provider", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://gitlab.com/owner/repo/-/merge_requests/789",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pull_request");
    expect(result.links[0].url).toBe("https://gitlab.com/owner/repo/-/merge_requests/789");
  });

  it("parses GitLab pipeline URL into pipeline_run evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: ["https://gitlab.com/owner/repo/-/pipelines/999"],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pipeline_run");
  });

  it("treats unknown URL as external_url evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: ["https://example.com/some-random-page"],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("external_url");
    expect(result.links[0].url).toBe("https://example.com/some-random-page");
  });

  it("treats unrecognized pullRequestUrl as external_url", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://bitbucket.org/owner/repo/pull-requests/5",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("external_url");
  });

  it("treats unrecognized pipelineUrl as external_url", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pipelineUrl: "https://custom-ci.example.com/build/42",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("external_url");
  });

  it("parses multiple external URLs of mixed types in one call", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: [
          "https://github.com/owner/repo/pull/100",
          "https://gitlab.com/owner/repo/-/merge_requests/200",
          "https://example.com/unknown-link",
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(3);
    const types = result.links.map((l) => l.evidenceType);
    expect(types).toContain("pull_request");
    expect(types).toContain("pull_request");
    expect(types).toContain("external_url");
  });

  it("parses GitLab commit URL via externalUrls", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: [
          "https://gitlab.com/owner/repo/-/commit/abcdef123456789012345678901234567890abcd",
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("commit");
  });
});

describe("Branch linking", () => {
  it("creates a branch evidence link", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        branch: {
          name: "feature/task-123-impl",
          headSha: "abc123def456",
          baseBranch: "main",
          url: "https://github.com/org/repo/tree/feature/task-123-impl",
        },
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("branch");
    expect(result.links[0].title).toBe("feature/task-123-impl");
  });

  it("creates branch link without optional fields", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "fix/bug-456" },
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("branch");
    expect(result.links[0].title).toBe("fix/bug-456");
  });
});

describe("Commit linking", () => {
  it("creates a commit evidence link", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [
          {
            sha: "abc123def456789012345678901234567890abcd",
            message: "Implement feature X",
            authorName: "Dev",
            authorEmail: "dev@example.com",
            url: "https://github.com/org/repo/commit/abc123def456789012345678901234567890abcd",
          },
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("commit");
    expect(result.links[0].title).toBe("abc123d");
  });

  it("creates commit link with minimal fields", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [{ sha: "deadbeef12345678" }],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("commit");
  });

  it("links commit trailers to other tasks and missions", () => {
    const { habitat, col, mission, task } = seedHabitatWithRepo();
    const task2 = taskRepo.createTask({
      missionId: mission.id,
      title: "Other Task",
      createdBy: "test",
    });
    const mission2 = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: col.id,
      title: "Other Mission",
      createdBy: "test",
    });

    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [
          {
            sha: "aaa111bbb222ccc333ddd444eee555fff666777",
            message: "Shared commit",
            trailers: [
              { key: "Orcy-Task", value: task2.id },
              { key: "Orcy-Mission", value: mission2.id },
            ],
          },
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(3);

    const linkToTask2 = result.links.find(
      (l) => l.linkId !== result.links[0].linkId && l.evidenceType === "commit",
    );
    expect(linkToTask2).toBeDefined();

    const task2Evidence = getTaskCodeEvidence(task2.id);
    expect(task2Evidence.summary.activeLinks).toBeGreaterThanOrEqual(1);

    const mission2Evidence = getMissionCodeEvidence(mission2.id);
    expect(mission2Evidence.summary.activeLinks).toBeGreaterThanOrEqual(1);
  });
});

describe("Bulk link", () => {
  it("links branch, commit, and PR in one call", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/bulk-test" },
        commits: [{ sha: "111222333444555666777888999000aaabbbccc", message: "Bulk commit" }],
        pullRequestUrl: "https://github.com/org/repo/pull/42",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(3);
    const types = result.links.map((l) => l.evidenceType);
    expect(types).toContain("branch");
    expect(types).toContain("commit");
    expect(types).toContain("pull_request");
  });

  it("links pipeline URL alongside other evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/10",
        pipelineUrl: "https://github.com/org/repo/actions/runs/99",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(2);
  });
});

describe("Duplicate detection", () => {
  it("does not create duplicate link for same PR URL", () => {
    const { task } = seedHabitatWithRepo();
    const actor = defaultActor;

    const result1 = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/55",
      },
      actor,
    );

    const result2 = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/55",
      },
      actor,
    );

    expect(result1.links.length).toBe(1);
    expect(result2.links.length).toBe(1);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });

  it("does not create duplicate link for same commit SHA", () => {
    const { task } = seedHabitatWithRepo();
    const sha = "fff111222333444555666777888999000aaabbb";

    linkTaskCodeEvidence(
      task.id,
      {
        commits: [{ sha }],
      },
      defaultActor,
    );

    linkTaskCodeEvidence(
      task.id,
      {
        commits: [{ sha }],
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });

  it("does not create duplicate link for same branch name", () => {
    const { task } = seedHabitatWithRepo();

    linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/dup-branch" },
      },
      defaultActor,
    );

    linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/dup-branch" },
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });

  it("corroborates existing link with additional source on re-link", () => {
    const { task } = seedHabitatWithRepo();

    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/77",
      },
      { type: "human", id: "user-1" },
    );

    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/77",
      },
      { type: "human", id: "user-2" },
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
    expect(evidence.groups[0].items[0].linkSources).toContain("human_manual");
    expect(evidence.groups[0].items[0].linkSources.length).toBe(1);

    const rawLink = codeEvidenceLinkRepo.getActiveByTarget("task", task.id);
    expect(rawLink[0].linkSources).toContain("human_manual");
  });
});

describe("Correction", () => {
  it("marks a link as incorrect", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/88",
      },
      defaultActor,
    );

    const linkId = result.links[0].linkId;
    const corrected = correctEvidenceLink(
      linkId,
      {
        status: "incorrect",
        reason: "wrong_task",
      },
      defaultActor,
    );

    expect(corrected).not.toBeNull();
    expect(corrected!.status).toBe("incorrect");
    expect(corrected!.correctionReason).toBe("wrong_task");
  });

  it("marks a link as removed", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/remove-me" },
      },
      defaultActor,
    );

    const corrected = correctEvidenceLink(
      result.links[0].linkId,
      {
        status: "removed",
        reason: "obsolete_link",
      },
      defaultActor,
    );

    expect(corrected!.status).toBe("removed");
  });

  it("marks a link as superseded with replacement", () => {
    const { task } = seedHabitatWithRepo();
    const r1 = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/91",
      },
      defaultActor,
    );

    const r2 = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/92",
      },
      defaultActor,
    );

    const corrected = correctEvidenceLink(
      r1.links[0].linkId,
      {
        status: "superseded",
        reason: "duplicate_evidence",
        replacementLinkId: r2.links[0].linkId,
      },
      defaultActor,
    );

    expect(corrected!.status).toBe("superseded");
    expect(corrected!.replacementLinkId).toBe(r2.links[0].linkId);
  });

  it("returns null for nonexistent link ID", () => {
    const result = correctEvidenceLink(
      "nonexistent-id",
      {
        status: "incorrect",
        reason: "wrong_task",
      },
      defaultActor,
    );

    expect(result).toBeNull();
  });

  it("corrected link no longer appears in active evidence", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/93",
      },
      defaultActor,
    );

    correctEvidenceLink(
      result.links[0].linkId,
      {
        status: "incorrect",
        reason: "wrong_task",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(0);
    expect(evidence.summary.correctedCount).toBe(1);
  });
});

describe("Not-applicable override", () => {
  it("marks a target as not_applicable", () => {
    const { task } = seedHabitatWithRepo();
    const result = markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "research_only",
        reasonNote: "No code changes expected",
      },
      defaultActor,
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe("not_applicable");
    expect(result!.reasonCode).toBe("research_only");
  });

  it("clears not_applicable override", () => {
    const { task } = seedHabitatWithRepo();
    markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "documentation_only_no_code",
      },
      defaultActor,
    );

    const before = codeEvidenceCompletenessRepo.getByTarget("task", task.id);
    expect(before).not.toBeNull();
    expect(before!.status).toBe("not_applicable");

    clearCodeEvidenceNotApplicable("task", task.id);

    const after = codeEvidenceCompletenessRepo.getByTarget("task", task.id);
    expect(after).toBeNull();
  });

  it("returns false when clearing nonexistent override", () => {
    const cleared = clearCodeEvidenceNotApplicable("task", "nonexistent-task");
    expect(cleared).toBe(false);
  });

  it("upserts over existing not_applicable override", () => {
    const { task } = seedHabitatWithRepo();
    markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "research_only",
      },
      defaultActor,
    );

    const updated = markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "other",
        reasonNote: "Changed reason",
      },
      defaultActor,
    );

    expect(updated!.reasonCode).toBe("other");
    expect(updated!.reasonNote).toBe("Changed reason");
  });
});

describe("Gap reporting and resolution", () => {
  it("reports a code evidence gap", () => {
    const { task } = seedHabitatWithRepo();
    const gap = reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "work_outside_orcy",
        reasonNote: "Work done locally",
      },
      defaultActor,
    );

    expect(gap).not.toBeNull();
    expect(gap!.reasonCode).toBe("work_outside_orcy");
    expect(gap!.status).toBe("active");
  });

  it("resolves a reported gap", () => {
    const { task } = seedHabitatWithRepo();
    const gap = reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "provider_webhook_missing",
      },
      defaultActor,
    );

    const resolved = resolveCodeEvidenceGap(
      gap!.id,
      {
        resolutionReason: "Webhook now configured",
      },
      defaultActor,
    );

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolutionReason).toBe("Webhook now configured");
  });

  it("returns null when resolving nonexistent gap", () => {
    const resolved = resolveCodeEvidenceGap(
      "nonexistent-gap-id",
      {
        resolutionReason: "N/A",
      },
      defaultActor,
    );

    expect(resolved).toBeNull();
  });

  it("resolved gap appears in history but not active gaps", () => {
    const { task } = seedHabitatWithRepo();
    const gap = reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "other",
      },
      defaultActor,
    );

    resolveCodeEvidenceGap(
      gap!.id,
      {
        resolutionReason: "Found",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.activeGaps.length).toBe(0);
  });

  it("auto-resolves eligible gaps when evidence is linked", () => {
    const { task } = seedHabitatWithRepo();
    reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "pr_commit_not_created_yet",
      },
      defaultActor,
    );

    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/44",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.activeGaps.length).toBe(0);
  });
});

describe("Completeness derivation", () => {
  it("returns unknown when no links and no gaps", () => {
    const { task } = seedHabitatWithRepo();
    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("unknown");
  });

  it("returns complete when links exist and no gaps", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/10",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("complete");
  });

  it("returns partial when links and gaps both exist", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/11",
      },
      defaultActor,
    );

    reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "other",
        reasonNote: "Missing tests",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("partial");
  });

  it("returns missing when no links but gaps exist", () => {
    const { task } = seedHabitatWithRepo();
    reportCodeEvidenceGap(
      "task",
      task.id,
      {
        reasonCode: "work_outside_orcy",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("missing");
  });

  it("returns not_applicable when override is set", () => {
    const { task } = seedHabitatWithRepo();
    markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "research_only",
        reasonNote: "Research task",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("not_applicable");
    expect(evidence.completeness.reasonCode).toBe("research_only");
    expect(evidence.completeness.reasonNote).toBe("Research task");
  });

  it("not_applicable override takes precedence even with links", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/12",
      },
      defaultActor,
    );

    markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "documentation_only_no_code",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.completeness.status).toBe("not_applicable");
  });

  it("reverts to link-based completeness after clearing not_applicable", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/test-clear-na" },
      },
      defaultActor,
    );

    markCodeEvidenceNotApplicable(
      "task",
      task.id,
      {
        reasonCode: "research_only",
      },
      defaultActor,
    );

    expect(getTaskCodeEvidence(task.id).completeness.status).toBe("not_applicable");

    clearCodeEvidenceNotApplicable("task", task.id);

    expect(getTaskCodeEvidence(task.id).completeness.status).toBe("complete");
  });
});

describe("getTaskCodeEvidence / getMissionCodeEvidence", () => {
  it("returns structured response for a task", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/20",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);

    expect(evidence.target.type).toBe("task");
    expect(evidence.target.id).toBe(task.id);
    expect(evidence.completeness.status).toBe("complete");
    expect(evidence.summary.totalLinks).toBe(1);
    expect(evidence.summary.activeLinks).toBe(1);
    expect(evidence.groups.length).toBe(1);
    expect(evidence.activeGaps).toEqual([]);
    expect(evidence.warnings).toEqual([]);
  });

  it("returns structured response for a mission", () => {
    const { mission, task } = seedHabitatWithRepo();
    linkMissionCodeEvidence(
      mission.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/30",
      },
      defaultActor,
    );

    const evidence = getMissionCodeEvidence(mission.id);

    expect(evidence.target.type).toBe("mission");
    expect(evidence.target.id).toBe(mission.id);
    expect(evidence.completeness.status).toBe("complete");
    expect(evidence.groups.length).toBe(1);
  });

  it("includes history when option is set", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/21",
      },
      defaultActor,
    );

    correctEvidenceLink(
      result.links[0].linkId,
      {
        status: "incorrect",
        reason: "wrong_task",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id, { includeHistory: true });

    expect(evidence.history).toBeDefined();
    expect(evidence.history!.links.length).toBe(1);
    expect(evidence.history!.links[0].status).toBe("incorrect");
  });

  it("groups evidence by type", () => {
    const { task } = seedHabitatWithRepo();
    linkTaskCodeEvidence(
      task.id,
      {
        branch: { name: "feature/group-test" },
        commits: [{ sha: "aaa111bbb222ccc333ddd444eee555fff666777" }],
        pullRequestUrl: "https://github.com/org/repo/pull/22",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    const groupTypes = evidence.groups.map((g) => g.evidenceType);

    expect(groupTypes).toContain("branch");
    expect(groupTypes).toContain("commit");
    expect(groupTypes).toContain("pull_request");
  });

  it("summary counts reflect corrected and history links", () => {
    const { task } = seedHabitatWithRepo();
    const r1 = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/23",
      },
      defaultActor,
    );

    correctEvidenceLink(
      r1.links[0].linkId,
      {
        status: "removed",
        reason: "obsolete_link",
      },
      defaultActor,
    );

    linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/24",
      },
      defaultActor,
    );

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
    expect(evidence.summary.correctedCount).toBe(1);
    expect(evidence.summary.historyCount).toBe(1);
  });
});

describe("PR evidence linking (ensureEvidenceLinkForPullRequest)", () => {
  it("creates evidence link from PR data", () => {
    const { task, habitat } = seedHabitatWithRepo();
    const pr = prRepo.createPullRequest({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 101,
      prTitle: "Add feature",
      prUrl: "https://github.com/org/repo/pull/101",
      branchName: "feature/add-feature",
    });

    const link = ensureEvidenceLinkForPullRequest(
      {
        id: pr.id,
        taskId: task.id,
        provider: "github",
        repo: "org/repo",
        prNumber: 101,
        prTitle: "Add feature",
        prUrl: "https://github.com/org/repo/pull/101",
        branchName: "feature/add-feature",
      },
      "webhook",
      habitat.id,
    );

    expect(link).not.toBeNull();
    expect(link!.evidenceType).toBe("pull_request");
    expect(link!.targetId).toBe(task.id);
    expect(link!.title).toBe("Add feature");
  });

  it("does not duplicate PR evidence on repeated calls", () => {
    const { task, habitat } = seedHabitatWithRepo();
    const prData = {
      id: "pr-dedup-id",
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 102,
      prTitle: "Fix bug",
      prUrl: "https://github.com/org/repo/pull/102",
      branchName: "fix/bug",
    };

    ensureEvidenceLinkForPullRequest(prData, "webhook", habitat.id);
    ensureEvidenceLinkForPullRequest(prData, "migration", habitat.id);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });

  it("uses fallback title when prTitle is null", () => {
    const { task, habitat } = seedHabitatWithRepo();
    const link = ensureEvidenceLinkForPullRequest(
      {
        id: "pr-no-title",
        taskId: task.id,
        provider: "github",
        repo: "org/repo",
        prNumber: 103,
        prTitle: null,
        prUrl: "https://github.com/org/repo/pull/103",
        branchName: null,
      },
      "webhook",
      habitat.id,
    );

    expect(link).not.toBeNull();
    expect(link!.title).toBe("PR #103");
  });
});

describe("Pipeline evidence linking (ensureEvidenceLinkForPipelineEvent)", () => {
  it("creates evidence link from pipeline event data", () => {
    const { task, habitat } = seedHabitatWithRepo();
    const event = pipelineEventRepo.createPipelineEvent({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      runId: "run-500",
      status: "success",
      branch: "main",
      commitSha: "abc123def456",
    });

    const link = ensureEvidenceLinkForPipelineEvent(
      {
        id: event.id,
        taskId: task.id,
        provider: "github",
        repo: "org/repo",
        runId: "run-500",
        branch: "main",
        commitSha: "abc123def456",
      },
      "webhook",
      habitat.id,
    );

    expect(link).not.toBeNull();
    expect(link!.evidenceType).toBe("pipeline_run");
    expect(link!.targetId).toBe(task.id);
    expect(link!.title).toBe("Pipeline run-500");
  });

  it("does not duplicate pipeline evidence on repeated calls", () => {
    const { task, habitat } = seedHabitatWithRepo();
    const data = {
      id: "pipeline-dedup",
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      runId: "run-501",
      branch: "main",
      commitSha: null,
    };

    ensureEvidenceLinkForPipelineEvent(data, "webhook", habitat.id);
    ensureEvidenceLinkForPipelineEvent(data, "migration", habitat.id);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });
});

describe("Artifact mirroring", () => {
  it("mirrors PR artifacts", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [{ type: "pr", url: "https://github.com/org/repo/pull/200", description: "PR artifact" }],
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pull_request");
  });

  it("mirrors commit artifacts", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [
        {
          type: "commit",
          url: "deadbeef123456789012345678901234567890ab",
          description: "Commit message",
        },
      ],
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("commit");
  });

  it("mirrors log artifacts as pipeline_run when URL matches", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [{ type: "log", url: "https://github.com/org/repo/actions/runs/600", description: "CI run" }],
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pipeline_run");
  });

  it("mirrors log artifacts as external_url when URL does not match pipeline pattern", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [{ type: "log", url: "https://custom-ci.example.com/build/123", description: "Custom CI" }],
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("external_url");
  });

  it("mirrors unknown PR URLs as external_url", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [{ type: "pr", url: "https://bitbucket.org/org/repo/pr/5", description: "Bitbucket PR" }],
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("external_url");
  });

  it("mirrors multiple artifacts in one call", () => {
    const { task } = seedHabitatWithRepo();
    const result = mirrorArtifactsToCodeEvidence(
      task.id,
      [
        { type: "pr", url: "https://github.com/org/repo/pull/210", description: "PR" },
        { type: "commit", url: "abc123def456789012345678901234567890abcd", description: "Commit" },
        {
          type: "log",
          url: "https://github.com/org/repo/actions/runs/610",
          description: "Pipeline",
        },
      ],
      defaultActor,
    );

    expect(result.links.length).toBe(3);
  });

  it("does not duplicate artifacts already linked", () => {
    const { task } = seedHabitatWithRepo();
    const artifacts = [
      { type: "pr", url: "https://github.com/org/repo/pull/211", description: "PR" },
    ];

    mirrorArtifactsToCodeEvidence(task.id, artifacts, defaultActor);
    const result = mirrorArtifactsToCodeEvidence(task.id, artifacts, defaultActor);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });
});

describe("Backfill", () => {
  it("backfills existing PRs as code evidence", () => {
    const { task, habitat } = seedHabitatWithRepo();
    prRepo.createPullRequest({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 300,
      prTitle: "Backfill PR",
      prUrl: "https://github.com/org/repo/pull/300",
      branchName: "feature/backfill",
    });

    const result = backfillExistingCodeEvidence();

    expect(result.prCount).toBe(1);
    expect(result.pipelineCount).toBe(0);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
    expect(evidence.groups[0].evidenceType).toBe("pull_request");
  });

  it("backfills existing pipeline events as code evidence", () => {
    const { task, habitat } = seedHabitatWithRepo();
    pipelineEventRepo.createPipelineEvent({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      runId: "run-backfill",
      status: "success",
      branch: "main",
      commitSha: "aaa111bbb222ccc",
    });

    const result = backfillExistingCodeEvidence();

    expect(result.prCount).toBe(0);
    expect(result.pipelineCount).toBe(1);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });

  it("backfills both PRs and pipelines together", () => {
    const { task, habitat } = seedHabitatWithRepo();
    prRepo.createPullRequest({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 400,
      prUrl: "https://github.com/org/repo/pull/400",
    });

    pipelineEventRepo.createPipelineEvent({
      taskId: task.id,
      provider: "gitlab",
      repo: "org/repo",
      runId: "run-both",
      status: "in_progress",
      branch: "develop",
    });

    const result = backfillExistingCodeEvidence();

    expect(result.prCount).toBe(1);
    expect(result.pipelineCount).toBe(1);

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(2);
  });

  it("skips PRs with unresolvable habitat and adds warning", () => {
    const result = backfillExistingCodeEvidence();

    expect(result.warnings.length).toBe(0);
  });

  it("does not duplicate evidence on repeated backfill", () => {
    const { task, habitat } = seedHabitatWithRepo();
    prRepo.createPullRequest({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 500,
      prUrl: "https://github.com/org/repo/pull/500",
    });

    backfillExistingCodeEvidence();
    backfillExistingCodeEvidence();

    const evidence = getTaskCodeEvidence(task.id);
    expect(evidence.summary.activeLinks).toBe(1);
  });
});

describe("Mission-level evidence", () => {
  it("links and retrieves mission-level evidence", () => {
    const { mission } = seedHabitatWithRepo();
    const result = linkMissionCodeEvidence(
      mission.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/600",
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("pull_request");

    const evidence = getMissionCodeEvidence(mission.id);
    expect(evidence.summary.activeLinks).toBe(1);
    expect(evidence.completeness.status).toBe("complete");
  });

  it("supports mission-level branch evidence", () => {
    const { mission } = seedHabitatWithRepo();
    const result = linkMissionCodeEvidence(
      mission.id,
      {
        branch: { name: "feature/mission-branch" },
      },
      defaultActor,
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].evidenceType).toBe("branch");
  });

  it("mission completeness derivation works identically to task", () => {
    const { mission } = seedHabitatWithRepo();

    expect(getMissionCodeEvidence(mission.id).completeness.status).toBe("unknown");

    reportCodeEvidenceGap(
      "mission",
      mission.id,
      {
        reasonCode: "other",
      },
      defaultActor,
    );
    expect(getMissionCodeEvidence(mission.id).completeness.status).toBe("missing");

    linkMissionCodeEvidence(
      mission.id,
      {
        commits: [{ sha: "abc1230000000000000000000000000000000000" }],
      },
      defaultActor,
    );
    expect(getMissionCodeEvidence(mission.id).completeness.status).toBe("partial");
  });
});

describe("Edge cases", () => {
  it("handles empty input gracefully", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(task.id, {}, defaultActor);

    expect(result.links.length).toBe(0);
    expect(result.warnings.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("handles empty commits array", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(0);
  });

  it("handles empty externalUrls array", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        externalUrls: [],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(0);
  });

  it("handles multiple commits in one call", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [
          { sha: "1111111111111111111111111111111111111111" },
          { sha: "2222222222222222222222222222222222222222" },
          { sha: "3333333333333333333333333333333333333333" },
        ],
      },
      defaultActor,
    );

    expect(result.links.length).toBe(3);
  });

  it("handles changed files without errors", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        changedFiles: [
          { path: "src/index.ts", changeType: "added" as const, additions: 10, deletions: 0 },
          { path: "src/old.ts", previousPath: "src/renamed.ts", changeType: "renamed" as const },
        ],
      },
      defaultActor,
    );

    expect(result.errors.length).toBe(0);
  });

  it("agent actor uses agent_reported source for commits", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        commits: [{ sha: "aaaa000000000000000000000000000000000000" }],
      },
      { type: "agent", id: "agent-42" },
    );

    expect(result.links.length).toBe(1);
    expect(result.links[0].linkSources).toContain("agent_reported");
  });

  it("link item contains all expected fields", () => {
    const { task } = seedHabitatWithRepo();
    const result = linkTaskCodeEvidence(
      task.id,
      {
        pullRequestUrl: "https://github.com/org/repo/pull/999",
      },
      defaultActor,
    );

    const link = result.links[0];
    expect(link).toHaveProperty("linkId");
    expect(link).toHaveProperty("evidenceType");
    expect(link).toHaveProperty("evidenceId");
    expect(link).toHaveProperty("title");
    expect(link).toHaveProperty("url");
    expect(link).toHaveProperty("verificationState");
    expect(link).toHaveProperty("linkSources");
    expect(link).toHaveProperty("confidence");
    expect(link).toHaveProperty("linkedBy");
    expect(link).toHaveProperty("linkedAt");
    expect(link).toHaveProperty("status");
    expect(link).toHaveProperty("correctionReason");
    expect(link).toHaveProperty("replacementLinkId");

    expect(link.linkedAt).toBeTruthy();
    expect(link.status).toBe("active");
    expect(link.correctionReason).toBeNull();
    expect(link.replacementLinkId).toBeNull();
  });
});
