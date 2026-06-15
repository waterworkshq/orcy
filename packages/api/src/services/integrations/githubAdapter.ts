import type { IntegrationConnection, ExternalIssue } from "@orcy/shared";
import type { IssueProviderAdapter } from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

interface GitHubIssue {
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
  created_at: string;
  updated_at: string;
}

/** Converts a raw GitHub API issue into the normalized ExternalIssue shape. */
export function normalizeGitHubIssue(
  owner: string,
  repo: string,
  issue: GitHubIssue,
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

function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

function parseLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/** GitHub issue provider adapter that lists and fetches repository issues. */
export const githubAdapter: IssueProviderAdapter = {
  provider: "github",

  async listIssues(connection: IntegrationConnection): Promise<ExternalIssue[]> {
    const token = connection.accessToken;
    if (!token) throw new Error("GitHub connection has no access token");

    const owner = connection.repositoryOwner;
    const repo = connection.repositoryName;
    if (!owner || !repo) throw new Error("GitHub connection has no repository configured");

    const allIssues: ExternalIssue[] = [];
    let url: string | null =
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=open&per_page=100`;

    while (url) {
      const response = await fetch(url, { headers: buildHeaders(token) });
      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const issues = (await response.json()) as GitHubIssue[];
      for (const issue of issues) {
        if (issue.pull_request) continue;
        allIssues.push(normalizeGitHubIssue(owner, repo, issue));
      }

      url = parseLinkHeader(response.headers.get("link"));
    }

    return allIssues;
  },

  async getIssue(
    connection: IntegrationConnection,
    externalId: string,
  ): Promise<ExternalIssue | null> {
    const token = connection.accessToken;
    if (!token) throw new Error("GitHub connection has no access token");

    const owner = connection.repositoryOwner;
    const repo = connection.repositoryName;
    if (!owner || !repo) throw new Error("GitHub connection has no repository configured");

    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${externalId}`, {
      headers: buildHeaders(token),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const issue = (await response.json()) as GitHubIssue;
    if (issue.pull_request) return null;
    return normalizeGitHubIssue(owner, repo, issue);
  },
};

/** Creates a repository webhook for GitHub issues events. */
export async function createGitHubWebhook(
  connection: IntegrationConnection,
  webhookUrl: string,
): Promise<{ externalId: string; warning?: string }> {
  const token = connection.accessToken;
  if (!token) throw new Error("GitHub connection has no access token");

  const owner = connection.repositoryOwner;
  const repo = connection.repositoryName;
  if (!owner || !repo) throw new Error("GitHub connection has no repository configured");

  try {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/hooks`, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["issues"],
        config: {
          url: webhookUrl,
          content_type: "json",
          secret: connection.webhookSecret,
        },
      }),
    });

    if (response.status === 403) {
      return {
        externalId: "",
        warning:
          "Insufficient permissions to create webhook. Manual sync still works. Required scope: admin:repo_hook",
      };
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        externalId: "",
        warning: `Webhook creation failed: ${response.status} ${body}`,
      };
    }

    const hook = (await response.json()) as { id: number };
    return { externalId: String(hook.id) };
  } catch (err: any) {
    return {
      externalId: "",
      warning: `Webhook creation failed: ${err.message ?? String(err)}`,
    };
  }
}

export { buildHeaders, parseLinkHeader };
export type { GitHubIssue };
