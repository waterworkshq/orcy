import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeBranchRepo from "../repositories/codeBranchRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeChangedFileRepo from "../repositories/codeChangedFileRepository.js";
import * as codeReviewRepo from "../repositories/codeReviewRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as habitatRepo from "../repositories/board.js";
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
