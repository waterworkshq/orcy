import * as connectionRepo from "../../repositories/integrationConnection.js";
import { syncExternalIssue } from "./syncService.js";
import { verifyGitHubHmac } from "../../config/integrationSecurity.js";
import { logger } from "../../lib/logger.js";
import type { ExternalIssue } from "@orcy/shared";

/** Subset of a GitHub issue payload received from issue webhook events. */
interface GitHubWebhookIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
  user: { login: string } | null;
  updated_at: string;
}

/** GitHub issue webhook payload containing the action, issue, and repository. */
interface GitHubWebhookPayload {
  action: string;
  issue?: GitHubWebhookIssue;
  repository?: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
}

export type { GitHubWebhookPayload, GitHubWebhookIssue };

function normalizeWebhookIssue(
  owner: string,
  repo: string,
  issue: GitHubWebhookIssue,
): ExternalIssue {
  return {
    provider: "github",
    externalId: issue.node_id ?? String(issue.id),
    externalKey: `${owner}/${repo}#${issue.number}`,
    title: issue.title,
    body: issue.body ?? "",
    status: issue.state === "closed" ? "closed" : "open",
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    url: issue.html_url,
    updatedAt: issue.updated_at,
    reporter: issue.user?.login ?? undefined,
  };
}

const SUPPORTED_ACTIONS = ["opened", "reopened", "edited", "labeled", "unlabeled", "closed"];

/** Handles a GitHub issue webhook, verifies signatures per connection, and syncs the issue into Orcy. */
export function handleGitHubIssueWebhook(
  rawBody: string,
  signature: string | undefined,
  payload: GitHubWebhookPayload,
): { statusCode: number; body: string } {
  if (!payload.issue || !payload.repository) {
    return { statusCode: 200, body: "No issue in payload" };
  }

  const action = payload.action;
  if (!SUPPORTED_ACTIONS.includes(action)) {
    return { statusCode: 200, body: `Action '${action}' not handled` };
  }

  const fullName = payload.repository.full_name;
  const [owner, repo] = fullName.split("/");

  const connections = connectionRepo.listEnabledByProviderAndRepo("github", owner, repo);
  if (connections.length === 0) {
    return { statusCode: 200, body: "No matching connections" };
  }

  const issue = payload.issue;
  if (issue.pull_request) {
    return { statusCode: 200, body: "Pull request ignored" };
  }

  const normalizedIssue = normalizeWebhookIssue(owner, repo, issue);

  for (const connection of connections) {
    if (!connection.webhookSecret) continue;

    if (!signature || !verifyGitHubHmac(rawBody, signature, connection.webhookSecret)) {
      logger.warn(
        { connectionId: connection.id },
        "GitHub issue webhook signature missing or invalid",
      );
      continue;
    }

    try {
      syncExternalIssue(connection, normalizedIssue);
    } catch (err: any) {
      logger.warn(
        { err, connectionId: connection.id, externalId: normalizedIssue.externalId },
        "Failed to process GitHub issue webhook",
      );
    }
  }

  return { statusCode: 200, body: "OK" };
}
