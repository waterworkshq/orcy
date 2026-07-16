import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeBranchRepo from "../repositories/codeBranchRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeChangedFileRepo from "../repositories/codeChangedFileRepository.js";
import * as codeReviewRepo from "../repositories/codeReviewRepository.js";
import * as pullRequestRepo from "../repositories/pullRequest.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import {
  habitatCodeRepositories,
  codeBranches,
  codeCommits,
  codeChangedFiles,
  codeReviews,
  codeEvidenceLinks,
  codeEvidenceCompleteness,
  codeEvidenceGaps,
} from "../db/schema/index.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

function seedHabitat() {
  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  return habitat.id;
}

function seedRepo(habitatId?: string) {
  if (!habitatId) habitatId = seedHabitat();
  return codeEvidenceRepository.create({
    habitatId,
    provider: "github",
    repoSlug: "org/repo",
    displayName: "Test Repo",
  })!;
}

function seedTask(title: string) {
  const { habitat, columns } = habitatService.createHabitat({
    name: `${title} Habitat`,
    defaultColumns: true,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: columns[0].id,
    title: `${title} Mission`,
    createdBy: "test-user",
  });
  return taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "test-user",
  });
}

describe("CodeEvidenceRepository", () => {
  it("creates and retrieves a habitat code repository", () => {
    const habitatId = seedHabitat();
    const repo = codeEvidenceRepository.create({
      habitatId,
      provider: "github",
      providerBaseUrl: "https://github.com",
      repoSlug: "waterworkshq/orcy",
      displayName: "Orcy",
    });

    expect(repo).toBeDefined();
    expect(repo!.habitatId).toBe(habitatId);
    expect(repo!.provider).toBe("github");
    expect(repo!.repoSlug).toBe("waterworkshq/orcy");
    expect(repo!.verificationState).toBe("unverified");

    const fetched = codeEvidenceRepository.getByHabitatId(habitatId);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(repo!.id);
  });

  it("upserts a repository by habitat ID", () => {
    const habitatId = seedHabitat();
    codeEvidenceRepository.create({
      habitatId,
      provider: "github",
      repoSlug: "org/repo1",
    });

    const updated = codeEvidenceRepository.upsertByHabitatId({
      habitatId,
      provider: "gitlab",
      repoSlug: "org/repo2",
    });

    expect(updated!.provider).toBe("gitlab");
    expect(updated!.repoSlug).toBe("org/repo2");

    const all = getDb().select().from(habitatCodeRepositories).all();
    expect(all.length).toBe(1);
  });

  it("updates repository by habitat ID", () => {
    const habitatId = seedHabitat();
    codeEvidenceRepository.create({
      habitatId,
      provider: "local",
      repoSlug: "org/repo",
    });

    const updated = codeEvidenceRepository.updateByHabitatId(habitatId, {
      provider: "github",
      verificationState: "verified",
    });

    expect(updated!.provider).toBe("github");
    expect(updated!.verificationState).toBe("verified");
  });

  it("deletes a repository by ID", () => {
    const repo = seedRepo();

    codeEvidenceRepository.deleteById(repo.id);

    const fetched = codeEvidenceRepository.getById(repo.id);
    expect(fetched).toBeNull();
  });
});

describe("CodeBranchRepository", () => {
  it("creates and retrieves a branch", () => {
    const repo = seedRepo();
    const branch = codeBranchRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      name: "feature/test-123",
      baseBranch: "main",
      headSha: "abc123",
    });

    expect(branch).toBeDefined();
    expect(branch!.name).toBe("feature/test-123");
    expect(branch!.headSha).toBe("abc123");
  });

  it("upserts a branch by repository and name", () => {
    const repo = seedRepo();
    codeBranchRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      name: "feature/test-123",
    });

    const updated = codeBranchRepo.upsertByRepoAndName({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      name: "feature/test-123",
      headSha: "def456",
    });

    expect(updated!.headSha).toBe("def456");

    const all = getDb().select().from(codeBranches).all();
    expect(all.length).toBe(1);
  });

  it("keeps repository-less branch fallback behavior", () => {
    codeBranchRepo.create({
      provider: "github",
      repoSlug: "org/repo",
      name: "feature/no-repo",
      headSha: "abc123",
    });

    const branches = codeBranchRepo.findByRepoAndName(null, "feature/no-repo");

    expect(branches).toHaveLength(1);
    expect(branches[0].headSha).toBe("abc123");
  });
});

describe("CodeCommitRepository", () => {
  it("creates and retrieves a commit", () => {
    const repo = seedRepo();
    const commit = codeCommitRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "abc123def456",
      message: "Implement feature",
      authorName: "Test Author",
    });

    expect(commit!.sha).toBe("abc123def456");
    expect(commit!.message).toBe("Implement feature");
  });

  it("upserts a commit by repository and SHA", () => {
    const repo = seedRepo();
    codeCommitRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "abc123",
      message: "First message",
    });

    const updated = codeCommitRepo.upsertByRepoAndSha({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "abc123",
      message: "Updated message",
    });

    expect(updated!.message).toBe("Updated message");

    const all = getDb().select().from(codeCommits).all();
    expect(all.length).toBe(1);
  });

  it("keeps repository-less commit fallback behavior", () => {
    codeCommitRepo.create({
      provider: "github",
      repoSlug: "org/repo",
      sha: "no-repo-sha",
      message: "Repository-less commit",
    });

    const commits = codeCommitRepo.findByRepoAndSha(null, "no-repo-sha");

    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Repository-less commit");
  });
});

describe("CodeChangedFileRepository", () => {
  it("creates a changed file", () => {
    const repo = seedRepo();
    const commit = codeCommitRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "abc123",
    })!;

    const file = codeChangedFileRepo.create({
      repositoryId: repo.id,
      commitId: commit.id,
      provider: "github",
      repoSlug: "org/repo",
      path: "src/index.ts",
      changeType: "added",
      additions: 50,
      deletions: 0,
      source: "webhook",
    });

    expect(file!.path).toBe("src/index.ts");
    expect(file!.changeType).toBe("added");
  });

  it("creates changed files in a batch", () => {
    const repo = seedRepo();
    const commit = codeCommitRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "batch-sha",
    })!;

    codeChangedFileRepo.createMany([
      {
        repositoryId: repo.id,
        commitId: commit.id,
        provider: "github",
        repoSlug: "org/repo",
        path: "src/one.ts",
        changeType: "added",
        source: "webhook",
      },
      {
        repositoryId: repo.id,
        commitId: commit.id,
        provider: "github",
        repoSlug: "org/repo",
        path: "src/two.ts",
        changeType: "modified",
        source: "webhook",
      },
    ]);

    const files = codeChangedFileRepo.getByCommitId(commit.id);
    expect(files.map((file) => file.path).toSorted()).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("limits changed files returned by commit", () => {
    const repo = seedRepo();
    const commit = codeCommitRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      sha: "limited-files-sha",
    })!;

    codeChangedFileRepo.createMany([
      {
        repositoryId: repo.id,
        commitId: commit.id,
        provider: "github",
        repoSlug: "org/repo",
        path: "src/one.ts",
        changeType: "added",
        source: "webhook",
      },
      {
        repositoryId: repo.id,
        commitId: commit.id,
        provider: "github",
        repoSlug: "org/repo",
        path: "src/two.ts",
        changeType: "modified",
        source: "webhook",
      },
    ]);

    expect(codeChangedFileRepo.getByCommitId(commit.id, { limit: 1 })).toHaveLength(1);
  });
});

describe("CodeReviewRepository", () => {
  it("creates and retrieves a review", () => {
    const repo = seedRepo();
    const review = codeReviewRepo.create({
      repositoryId: repo.id,
      provider: "github",
      repoSlug: "org/repo",
      reviewStatus: "approved",
      reviewerName: "Reviewer",
    });

    expect(review!.reviewStatus).toBe("approved");
    expect(review!.reviewerName).toBe("Reviewer");
  });

  it("limits reviews returned by pull request", () => {
    const task = seedTask("Review limit task");
    const pr = pullRequestRepo.createPullRequest({
      taskId: task.id,
      provider: "github",
      repo: "org/repo",
      prNumber: 42,
      prUrl: "https://github.com/org/repo/pull/42",
    });

    codeReviewRepo.create({
      pullRequestId: pr.id,
      provider: "github",
      reviewStatus: "approved",
    });
    codeReviewRepo.create({
      pullRequestId: pr.id,
      provider: "github",
      reviewStatus: "commented",
    });

    expect(codeReviewRepo.getByPullRequestId(pr.id, { limit: 1 })).toHaveLength(1);
  });
});

describe("CodeEvidenceLinkRepository", () => {
  it("creates an active evidence link", () => {
    const link = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-1",
      evidenceType: "pull_request",
      evidenceId: "pr-1",
      externalUrl: "https://github.com/org/repo/pull/42",
      normalizedExternalUrl: "github.com/org/repo/pull/42",
      title: "PR #42",
      linkSource: "webhook",
      linkedByType: "system",
      linkedById: "github-webhook",
    });

    expect(link!.targetType).toBe("task");
    expect(link!.evidenceType).toBe("pull_request");
    expect(link!.status).toBe("active");
    expect(link!.confidence).toBeNull();
  });

  it("accepts confidence values in the inclusive range", () => {
    const link = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-confidence-valid",
      evidenceType: "commit",
      evidenceId: "commit-confidence-valid",
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "agent-1",
      confidence: 1,
    });

    expect(link!.confidence).toBe(1);
  });

  it("rejects confidence values outside the inclusive range", () => {
    expect(() =>
      codeEvidenceLinkRepo.create({
        targetType: "task",
        targetId: "task-confidence-invalid",
        evidenceType: "commit",
        evidenceId: "commit-confidence-invalid",
        linkSource: "agent_reported",
        linkedByType: "agent",
        linkedById: "agent-1",
        confidence: 1.1,
      }),
    ).toThrow("Code evidence confidence must be between 0 and 1");
  });

  it("detects duplicate active links", () => {
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-2",
      evidenceType: "commit",
      evidenceId: "commit-1",
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "agent-1",
    });

    const duplicate = codeEvidenceLinkRepo.findActiveDuplicate(
      "task",
      "task-2",
      "commit",
      "commit-1",
    );

    expect(duplicate).toBeDefined();
    expect(duplicate!.evidenceId).toBe("commit-1");
  });

  it("does not detect duplicate across different targets", () => {
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-3",
      evidenceType: "commit",
      evidenceId: "commit-2",
      linkSource: "human_manual",
      linkedByType: "human",
      linkedById: "user-1",
    });

    const duplicate = codeEvidenceLinkRepo.findActiveDuplicate(
      "task",
      "task-4",
      "commit",
      "commit-2",
    );

    expect(duplicate).toBeNull();
  });

  it("corrects a link", () => {
    const link = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-5",
      evidenceType: "branch",
      evidenceId: "branch-1",
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "agent-2",
    });

    const corrected = codeEvidenceLinkRepo.correctLink(
      link!.id,
      "incorrect",
      "human",
      "user-1",
      "wrong_task",
    );

    expect(corrected!.status).toBe("incorrect");
    expect(corrected!.correctedById).toBe("user-1");
    expect(corrected!.correctionReason).toBe("wrong_task");
  });

  it("gets active links by target", () => {
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-6",
      evidenceType: "commit",
      evidenceId: "commit-6a",
      linkSource: "webhook",
      linkedByType: "system",
      linkedById: "github",
    });

    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-6",
      evidenceType: "branch",
      evidenceId: "branch-6",
      linkSource: "branch_pattern",
      linkedByType: "system",
      linkedById: "orcy",
    });

    const active = codeEvidenceLinkRepo.getActiveByTarget("task", "task-6");
    expect(active.length).toBe(2);
  });

  it("limits active links returned by target", () => {
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-link-limit",
      evidenceType: "commit",
      evidenceId: "commit-link-limit-a",
      linkSource: "webhook",
      linkedByType: "system",
      linkedById: "github",
    });
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-link-limit",
      evidenceType: "commit",
      evidenceId: "commit-link-limit-b",
      linkSource: "webhook",
      linkedByType: "system",
      linkedById: "github",
    });

    expect(
      codeEvidenceLinkRepo.getActiveByTarget("task", "task-link-limit", { limit: 1 }),
    ).toHaveLength(1);
  });

  it("counts active links by target", () => {
    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-7",
      evidenceType: "commit",
      evidenceId: "commit-7a",
      linkSource: "webhook",
      linkedByType: "system",
      linkedById: "github",
    });

    codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: "task-7",
      evidenceType: "commit",
      evidenceId: "commit-7b",
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "agent-3",
    });

    const count = codeEvidenceLinkRepo.countActiveByTarget("task", "task-7");
    expect(count).toBe(2);
  });
});

describe("CodeEvidenceCompletenessRepository", () => {
  it("upserts not_applicable override", () => {
    const result = codeEvidenceCompletenessRepo.upsertNotApplicable({
      targetType: "task",
      targetId: "task-na-1",
      reasonCode: "research_only",
      reasonNote: "No code expected",
      markedByType: "human",
      markedById: "user-1",
    });

    expect(result!.status).toBe("not_applicable");
    expect(result!.reasonCode).toBe("research_only");
  });

  it("clears not_applicable override", () => {
    codeEvidenceCompletenessRepo.upsertNotApplicable({
      targetType: "task",
      targetId: "task-na-2",
      reasonCode: "documentation_only_no_code",
      markedByType: "human",
      markedById: "user-2",
    });

    const before = codeEvidenceCompletenessRepo.getByTarget("task", "task-na-2");
    expect(before).not.toBeNull();
    expect(before!.status).toBe("not_applicable");

    codeEvidenceCompletenessRepo.clearNotApplicable("task", "task-na-2");

    const fetched = codeEvidenceCompletenessRepo.getByTarget("task", "task-na-2");
    expect(fetched).toBeNull();
  });
});

describe("CodeEvidenceGapRepository", () => {
  it("creates a gap", () => {
    const gap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-1",
      reasonCode: "work_outside_orcy",
      reasonNote: "Work done on local machine",
      reportedByType: "human",
      reportedById: "user-1",
    });

    expect(gap!.reasonCode).toBe("work_outside_orcy");
    expect(gap!.status).toBe("active");
  });

  it("gets active gaps by target", () => {
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-2",
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "agent-1",
    });

    const active = codeEvidenceGapRepo.getActiveByTarget("task", "task-gap-2");
    expect(active.length).toBe(1);
    expect(active[0].status).toBe("active");
  });

  it("limits active gaps returned by target", () => {
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-limit",
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "agent-1",
    });
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-limit",
      reasonCode: "provider_webhook_missing",
      reportedByType: "agent",
      reportedById: "agent-1",
    });

    expect(
      codeEvidenceGapRepo.getActiveByTarget("task", "task-gap-limit", { limit: 1 }),
    ).toHaveLength(1);
  });

  it("resolves a gap", () => {
    const gap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-3",
      reasonCode: "provider_webhook_missing",
      reportedByType: "system",
      reportedById: "orcy",
    });

    const resolved = codeEvidenceGapRepo.resolveGap(
      gap!.id,
      "human",
      "user-1",
      "Webhook configured",
    );

    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolutionReason).toBe("Webhook configured");
  });

  it("auto-resolves eligible gap when evidence is linked", () => {
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-4",
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "agent-2",
    });

    codeEvidenceGapRepo.autoResolveByReasonCodes("task", "task-gap-4", [
      "pr_commit_not_created_yet",
      "provider_webhook_missing",
    ]);

    const active = codeEvidenceGapRepo.getActiveByTarget("task", "task-gap-4");
    expect(active.length).toBe(0);

    const resolved = codeEvidenceGapRepo.getResolvedByTarget("task", "task-gap-4");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolutionReason).toBe("Auto-resolved: evidence linked");
  });

  it("auto-resolves multiple matching gaps in one call", () => {
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-batch",
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "agent-2",
    });
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-batch",
      reasonCode: "provider_webhook_missing",
      reportedByType: "agent",
      reportedById: "agent-2",
    });
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-batch",
      reasonCode: "unrelated_gap",
      reportedByType: "agent",
      reportedById: "agent-2",
    });

    codeEvidenceGapRepo.autoResolveByReasonCodes("task", "task-gap-batch", [
      "pr_commit_not_created_yet",
      "provider_webhook_missing",
    ]);

    expect(codeEvidenceGapRepo.getResolvedByTarget("task", "task-gap-batch")).toHaveLength(2);
    expect(codeEvidenceGapRepo.getActiveByTarget("task", "task-gap-batch")).toHaveLength(1);
  });

  it("counts active gaps by target", () => {
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: "task-gap-5",
      reasonCode: "other",
      reportedByType: "human",
      reportedById: "user-3",
    });

    const count = codeEvidenceGapRepo.countActiveByTarget("task", "task-gap-5");
    expect(count).toBe(1);
  });
});
