import * as prRepo from "../repositories/pullRequest.js";
import * as taskRepo from "../repositories/task.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import * as habitatRepo from "../repositories/habitat.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { CodeReviewSettings } from "../models/index.js";
import { verifyGitHubHmac } from "../config/integrationSecurity.js";
import * as codeEvidenceService from "./codeEvidenceService.js";
import { resolveCodeReviewHabitatIdsByGithubSignature } from "./habitatSecretCache.js";
import { isGithubRepoAllowed, normalizeProviderRepoId } from "./webhooks/repoAllowlist.js";
import { approveTaskForMergedPR } from "./webhooks/mergeApproval.js";

/** Verifies a GitHub webhook payload against its HMAC signature using the configured secret. */
export function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  return verifyGitHubHmac(payload, signature, secret);
}

/**
 * Ingress credentials for the GitHub PR/review webhook handlers (REC-06 C1).
 * The handlers verify these against the exact raw bytes the signature was
 * computed over — the first action of every PR-path handler, before any
 * write, task scan, evidence link, or SSE broadcast.
 */
export interface GitHubWebhookIngress {
  rawBody: string;
  signature: string | undefined;
}

interface GitHubPREvent {
  action: string;
  number: number;
  pull_request: {
    title: string;
    html_url: string;
    state: string;
    merged: boolean;
    head: { ref: string };
    base: { repo: { id?: number | string; full_name: string } };
  };
}

interface GitHubReviewEvent {
  action: string;
  pull_request: {
    number: number;
    html_url: string;
    title: string;
    state: string;
    merged: boolean;
    head: { ref: string };
    base: { repo: { id?: number | string; full_name: string } };
  };
  review: {
    state: string;
  };
}

function mapPRState(pr: { state: string; merged: boolean }): "open" | "merged" | "closed" {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  return "open";
}

function mapReviewState(reviewState: string): "pending" | "approved" | "changes_requested" {
  if (reviewState === "approved") return "approved";
  if (reviewState === "changes_requested") return "changes_requested";
  return "pending";
}

function getSettingsForHabitat(habitatId: string): CodeReviewSettings | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  return habitat?.codeReviewSettings ?? null;
}

/**
 * Ingress binding (REC-06 C1): resolves the EXACT ONE habitat whose
 * configured code-review GitHub secret verifies this request's signature.
 * Zero verifying habitats (unsigned, unverifiable, or unsigned local-dev
 * posture — this closes that allowance for the PR path, matching the release
 * path's precedent) and MORE than one (a duplicated secret across habitats)
 * are both refusals with zero writes. The resolved habitat is the only
 * habitat consulted for the rest of the request.
 */
function resolveIngressHabitat(
  ingress: GitHubWebhookIngress,
): { habitatId: string; settings: CodeReviewSettings } | { refusal: string } {
  const habitatIds = resolveCodeReviewHabitatIdsByGithubSignature(
    ingress.rawBody,
    ingress.signature,
  );
  if (habitatIds.length === 0) return { refusal: "no_matching_habitat" };
  if (habitatIds.length > 1) return { refusal: "ambiguous_signature_habitat" };
  const settings = getSettingsForHabitat(habitatIds[0]);
  if (!settings) return { refusal: "no_matching_habitat" };
  return { habitatId: habitatIds[0], settings };
}

/**
 * Repository allowlist gate (REC-06 C2): the event's immutable
 * `repository.id` must be trusted by the resolved habitat. Runs BEFORE task
 * extraction; a missing, malformed, unsafe-precision, or unlisted id refuses
 * with zero writes. An empty/absent (legacy) allowlist refuses everything —
 * the fail-closed default.
 */
function gateRepositoryId(
  settings: CodeReviewSettings,
  repoIdValue: unknown,
): { repoId: string } | { refusal: string } {
  const repoId = normalizeProviderRepoId(repoIdValue);
  if (!repoId) return { refusal: "invalid_repository_id" };
  if (!isGithubRepoAllowed(settings, repoId)) return { refusal: "repo_not_allowed" };
  return { repoId };
}

function findTaskInHabitat(
  branchName: string,
  prTitle: string,
  settings: CodeReviewSettings,
  habitatId: string,
): string | null {
  const pattern = settings.taskPattern || "[?&;]taskId=([0-9a-f-]{36})";
  const taskIdFromBranch = prRepo.findTaskIdByPattern(branchName, pattern);
  if (taskIdFromBranch) {
    const task = taskRepo.getTaskById(taskIdFromBranch);
    if (task && getHabitatIdForTask(taskIdFromBranch) === habitatId) return taskIdFromBranch;
  }
  const taskIdFromTitle = prRepo.findTaskIdByPattern(prTitle, pattern);
  if (taskIdFromTitle) {
    const task = taskRepo.getTaskById(taskIdFromTitle);
    if (task && getHabitatIdForTask(taskIdFromTitle) === habitatId) return taskIdFromTitle;
  }
  return null;
}

/** Links an incoming GitHub pull request to the matching Orcy task, updating pull request records and emitting SSE updates. Ingress binding, repository allowlist, and task resolution are scoped to the exactly-one habitat whose secret verified the request signature; a merged PR under `autoApproveOnMerge` approves the linked submitted task atomically with its audit event and the canonical post-commit effect mask. */
export function handlePullRequestEvent(
  body: GitHubPREvent,
  ingress: GitHubWebhookIngress,
): { status: string; taskId?: string } {
  const pr = body.pull_request;
  const repo = pr.base.repo.full_name;
  const branchName = pr.head.ref;
  const prTitle = pr.title;
  const prState = mapPRState(pr);
  const prNumber = body.number;
  const prUrl = pr.html_url;

  // C1: exact signature→habitat resolution is the FIRST action; no write of
  // any kind (PR record, evidence link, SSE, task scan) precedes it.
  const resolved = resolveIngressHabitat(ingress);
  if ("refusal" in resolved) return { status: resolved.refusal };

  // C2: trusted repository allowlist before task extraction.
  const gated = gateRepositoryId(resolved.settings, pr.base.repo.id);
  if ("refusal" in gated) return { status: gated.refusal };

  const taskId = findTaskInHabitat(branchName, prTitle, resolved.settings, resolved.habitatId);
  if (!taskId) return { status: "no_matching_task" };

  const task = taskRepo.getTaskById(taskId);
  if (!task) return { status: "task_not_found" };

  const existing = prRepo.findByProviderAndNumber("github", repo, prNumber);

  if (body.action === "opened" || body.action === "synchronize" || body.action === "reopened") {
    let prRecord: {
      id: string;
      taskId: string;
      provider: string;
      repo: string;
      prNumber: number;
      prTitle: string | null;
      prUrl: string;
      branchName: string | null;
    } | null = null;
    if (existing) {
      prRepo.updatePullRequest(existing.id, { prTitle, state: "open" });
      prRecord = existing;
    } else {
      prRecord = prRepo.createPullRequest({
        taskId,
        provider: "github",
        repo,
        prNumber,
        prTitle,
        prUrl,
        branchName,
        state: "open",
      });
    }

    const habitatId = getHabitatIdForTask(taskId);
    if (habitatId && prRecord) {
      try {
        codeEvidenceService.ensureEvidenceLinkForPullRequest(prRecord, "webhook", habitatId);
      } catch {
        /* non-blocking enrichment */
      }

      sseBroadcaster.publish(habitatId, {
        type: "task.updated",
        data: task,
      });
    }

    return { status: "linked", taskId };
  }

  if (body.action === "closed") {
    if (existing) {
      prRepo.updatePullRequest(existing.id, { state: prState, prTitle });

      if (prState === "merged") {
        const settingsHabitatId = getHabitatIdForTask(taskId);
        const settings = settingsHabitatId ? getSettingsForHabitat(settingsHabitatId) : null;
        if (settings?.autoApproveOnMerge) {
          approveTaskForMergedPR({
            taskId,
            habitatId: settingsHabitatId ?? resolved.habitatId,
            provenance: { provider: "github", repo, prNumber },
          });
        }
      }

      const habitatId3 = getHabitatIdForTask(taskId);
      if (habitatId3) {
        try {
          codeEvidenceService.ensureEvidenceLinkForPullRequest(existing, "webhook", habitatId3);
        } catch {
          /* non-blocking enrichment */
        }

        sseBroadcaster.publish(habitatId3, {
          type: "task.updated",
          data: task,
        });
      }
    }
    return { status: "closed", taskId };
  }

  return { status: "ignored" };
}

/** Records the latest review state on a linked GitHub pull request and broadcasts a task update to the habitat's SSE channel. Review events update `reviewStatus` only — they NEVER approve a task, whatever the review state says. Ingress binding and repository allowlist are enforced before any write. */
export function handlePullRequestReviewEvent(
  body: GitHubReviewEvent,
  ingress: GitHubWebhookIngress,
): {
  status: string;
  taskId?: string;
} {
  // C1/C2 gates first — same zero-write contract as the PR path.
  const resolved = resolveIngressHabitat(ingress);
  if ("refusal" in resolved) return { status: resolved.refusal };

  const pr = body.pull_request;
  const gated = gateRepositoryId(resolved.settings, pr.base.repo.id);
  if ("refusal" in gated) return { status: gated.refusal };

  const repo = pr.base.repo.full_name;
  const prNumber = pr.number;

  const existing = prRepo.findByProviderAndNumber("github", repo, prNumber);
  if (!existing) return { status: "pr_not_linked" };

  // The linked task must live in the signature-resolved habitat (the
  // cross-habitat binding applies to review updates too).
  if (getHabitatIdForTask(existing.taskId) !== resolved.habitatId) {
    return { status: "pr_not_linked" };
  }

  const reviewStatus = mapReviewState(body.review.state);
  prRepo.updatePullRequest(existing.id, { reviewStatus });

  const task = taskRepo.getTaskById(existing.taskId);
  if (task) {
    const habitatId = getHabitatIdForTask(existing.taskId);
    if (habitatId) {
      sseBroadcaster.publish(habitatId, {
        type: "task.updated",
        data: task,
      });
    }
  }

  return { status: "review_updated", taskId: existing.taskId };
}
