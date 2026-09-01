import * as connectionRepo from "../../repositories/integrationConnection.js";
import { syncExternalIssue } from "./syncService.js";
import { verifyGitHubHmac } from "../../config/integrationSecurity.js";
import { logger } from "../../lib/logger.js";
import type { ExternalIssue, IntegrationConnection } from "@orcy/shared";

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

/**
 * True when the payload would reach credential resolution under the
 * historical handler order: it carries an issue and a repository and its
 * action is supported. Non-actionable events were answered with a no-op
 * BEFORE any connection lookup or signature work — the verified-ingress
 * guard shares this predicate so it does not duplicate the allowlist.
 */
export function isActionableGitHubIssueEvent(payload: GitHubWebhookPayload): boolean {
  return Boolean(
    payload?.issue &&
      payload?.repository &&
      SUPPORTED_ACTIONS.includes(payload?.action),
  );
}

/** Credential resolution for the `github_issues_hmac` verified-ingress verifier. Fail-soft by design. */
export interface GitHubIssueIngressResolution {
  /** Enabled connections for the payload's repository, in listing order. */
  connections: IntegrationConnection[];
  /** Every connection whose webhook secret verified the signature, in listing order. */
  matched: IntegrationConnection[];
}

/**
 * Resolves every enabled connection whose webhook secret verifies the
 * request's HMAC signature over the exact raw bytes. Never rejects — this
 * family is fail-soft: an unverified request is acknowledged without
 * syncing, and one connection's failed verification never stops later
 * connections from being checked.
 */
export function resolveGitHubIssueIngress(
  rawBody: string,
  signature: string | undefined,
  payload: GitHubWebhookPayload,
): GitHubIssueIngressResolution {
  const fullName = payload.repository?.full_name;
  if (!fullName) {
    return { connections: [], matched: [] };
  }
  const [owner, repo] = fullName.split("/");
  const connections = connectionRepo.listEnabledByProviderAndRepo("github", owner, repo);

  const matched: IntegrationConnection[] = [];
  for (const connection of connections) {
    if (!connection.webhookSecret) continue;

    if (!signature || !verifyGitHubHmac(rawBody, signature, connection.webhookSecret)) {
      logger.warn(
        { connectionId: connection.id },
        "GitHub issue webhook signature missing or invalid",
      );
      continue;
    }

    matched.push(connection);
  }
  return { connections, matched };
}

/**
 * Dispatch tail for requests whose credentials the verified-ingress policy
 * guard has already resolved: every matched connection is synced exactly
 * once, with the historical per-connection fault containment — one
 * connection's processing failure is logged and cannot suppress later
 * matches.
 */
export function dispatchGitHubIssueWebhook(
  payload: GitHubWebhookPayload,
  resolution: GitHubIssueIngressResolution,
): { statusCode: number; body: string } {
  if (!payload.issue || !payload.repository) {
    return { statusCode: 200, body: "No issue in payload" };
  }

  const action = payload.action;
  if (!SUPPORTED_ACTIONS.includes(action)) {
    return { statusCode: 200, body: `Action '${action}' not handled` };
  }

  if (resolution.connections.length === 0) {
    return { statusCode: 200, body: "No matching connections" };
  }

  const issue = payload.issue;
  if (issue.pull_request) {
    return { statusCode: 200, body: "Pull request ignored" };
  }

  const fullName = payload.repository.full_name;
  const [owner, repo] = fullName.split("/");
  const normalizedIssue = normalizeWebhookIssue(owner, repo, issue);

  for (const connection of resolution.matched) {
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
