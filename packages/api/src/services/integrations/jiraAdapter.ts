import type { IntegrationConnection, ExternalIssue } from "@orcy/shared";
import type { IssueProviderAdapter } from "./types.js";
import { refreshJiraToken, getJiraCredentials } from "./jiraOAuth.js";
import * as connectionRepo from "../../repositories/integrationConnection.js";
import { logger } from "../../lib/logger.js";
import { fetchValidated } from "../../config/integrationSecurity.js";

const MAX_PAGES = 100;

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

/** Extracts plain text from an Atlassian Document Format node tree. */
export function extractAdfText(doc: AdfNode | null): string {
  if (!doc) return "";
  if (doc.type === "text") return doc.text || "";
  if (doc.content) return doc.content.map(extractAdfText).join("\n");
  return "";
}

interface JiraIssueFields {
  summary: string;
  description: AdfNode | null;
  status: { name: string; statusCategory: { name: string } } | null;
  priority: { name: string; id: string } | null;
  issuetype: { name: string; id: string } | null;
  labels: string[];
  components: Array<{ name: string }>;
  assignee: { accountId: string; displayName: string } | null;
  reporter: { accountId: string; displayName: string } | null;
  project: { key: string; name: string; id: string };
  created: string;
  updated: string;
}

interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

interface JiraSearchResponse {
  isLast: boolean;
  nextPageToken?: string;
  issues: JiraIssue[];
  warningMessages?: string[];
  errorMessages?: string[];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Structural known-good check for API-key Jira connections: ONLY Jira Cloud
 * tenant URLs (https://<tenant>.atlassian.net) are accepted. This is what
 * makes a member-supplied URL safe without an allowlist — Atlassian's own
 * servers receive every credentialed request, so neither internal-network
 * targets nor token-capture hosts can be configured. OAuth connections are
 * inherently safe (fixed api.atlassian.com host). Self-hosted Jira is
 * unsupported; reintroduce deliberately if ever needed.
 */
export function isJiraCloudSiteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // Port 443 is the only acceptable port (or none, which defaults to 443).
    // Any explicit other port is rejected: https://x.atlassian.net:8443 is
    // not the Jira API surface and should not receive credentials.
    if (parsed.port && parsed.port !== "443") return false;
    const host = parsed.hostname.toLowerCase();
    return host.endsWith(".atlassian.net") && host.length > ".atlassian.net".length;
  } catch {
    return false;
  }
}

function getJiraRequestConfig(
  connection: IntegrationConnection,
  accessTokenOverride?: string,
): { baseUrl: string; headers: Record<string, string> } {
  const token = accessTokenOverride ?? connection.accessToken;
  if (!token) throw new Error("Jira connection has no access token");

  if (connection.authMethod === "api_key") {
    // Legacy rows (saved before the known-good-host rule) fail safely here:
    // no fetch is attempted for non-Atlassian base URLs.
    if (!isJiraCloudSiteUrl(connection.externalBaseUrl ?? "")) {
      throw new Error(
        "Jira connection uses an unsupported site URL — reconnect using a Jira Cloud tenant URL (https://<tenant>.atlassian.net)",
      );
    }
    const email = connection.externalAccountName;
    if (!email) throw new Error("Jira API token connection has no account email");
    if (!connection.externalBaseUrl) throw new Error("Jira API token connection has no site URL");

    return {
      baseUrl: `${trimTrailingSlash(connection.externalBaseUrl)}/rest/api/3`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
    };
  }

  const cloudId = connection.externalTenantId;
  if (!cloudId) throw new Error("Jira connection has no cloud ID");

  return {
    baseUrl: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };
}

function buildJql(projectKey: string, providerConfig: Record<string, unknown>): string {
  const customJql = providerConfig.jql as string | undefined;
  if (customJql) return customJql;
  return `project = "${escapeJqlValue(projectKey)}" ORDER BY updated DESC`;
}

/** Converts a raw Jira API issue into the normalized ExternalIssue shape. */
export function normalizeJiraIssue(
  issue: JiraIssue,
  connection: IntegrationConnection,
): ExternalIssue {
  const fields = issue.fields;
  const baseUrl = connection.externalBaseUrl || "";
  const externalUrl = baseUrl ? `${baseUrl}/browse/${issue.key}` : issue.self;

  return {
    provider: "jira",
    externalId: issue.id,
    externalKey: issue.key,
    title: fields.summary,
    body: extractAdfText(fields.description),
    status: fields.status?.statusCategory?.name === "Done" ? "closed" : "open",
    labels: [...fields.labels, ...fields.components.map((c) => c.name)],
    sourceKind: fields.issuetype?.name,
    priority: fields.priority?.name,
    assignees: fields.assignee ? [fields.assignee.displayName] : [],
    reporter: fields.reporter?.displayName,
    url: externalUrl,
    updatedAt: fields.updated,
    rawProviderPayload: fields as unknown as Record<string, unknown>,
  };
}

function escapeJqlValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

async function ensureFreshToken(connection: IntegrationConnection): Promise<string> {
  let token = connection.accessToken;
  if (!token) throw new Error("Jira connection has no access token");

  if (connection.tokenExpiresAt && connection.refreshToken) {
    const expiresAt = new Date(connection.tokenExpiresAt).getTime();
    if (Date.now() >= expiresAt - 60000) {
      try {
        const { clientId, clientSecret } = getJiraCredentials();
        const refreshed = await refreshJiraToken(connection.refreshToken, clientId, clientSecret);
        connectionRepo.update(connection.id, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        });
        token = refreshed.access_token;
      } catch (err) {
        logger.warn({ err, connectionId: connection.id }, "Jira token refresh failed");
      }
    }
  }

  return token;
}

/** Jira issue provider adapter that lists and fetches project issues. */
export const jiraAdapter: IssueProviderAdapter = {
  provider: "jira",

  async listIssues(connection: IntegrationConnection): Promise<ExternalIssue[]> {
    let token: string | undefined;
    if (connection.authMethod !== "api_key") {
      token = await ensureFreshToken(connection);
    }

    const projectKey = connection.projectKey;
    if (!projectKey) throw new Error("Jira connection has no project key");

    const jql = buildJql(projectKey, connection.providerConfig);
    const requestConfig = getJiraRequestConfig(connection, token);
    const searchUrl = `${requestConfig.baseUrl}/search/jql`;

    const allIssues: ExternalIssue[] = [];
    let nextToken: string | null = null;
    let pageCount = 0;

    do {
      pageCount++;
      if (pageCount > MAX_PAGES) {
        logger.warn(
          { connectionId: connection.id, pageCount },
          "Jira pagination exceeded max pages, truncating",
        );
        break;
      }

      const params = new URLSearchParams({
        jql,
        fields: "*all",
        maxResults: "50",
      });
      if (nextToken) params.set("nextPageToken", nextToken);

      const response = await fetchValidated(`${searchUrl}?${params.toString()}`, {
        headers: requestConfig.headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Jira API error: ${response.status} ${body}`);
      }

      const data = (await response.json()) as JiraSearchResponse;

      if (data.errorMessages?.length) {
        throw new Error(`Jira JQL error: ${data.errorMessages.join("; ")}`);
      }

      for (const issue of data.issues) {
        allIssues.push(normalizeJiraIssue(issue, connection));
      }

      nextToken = data.isLast ? null : (data.nextPageToken ?? null);
    } while (nextToken);

    return allIssues;
  },

  async getIssue(
    connection: IntegrationConnection,
    externalId: string,
  ): Promise<ExternalIssue | null> {
    let token: string | undefined;
    if (connection.authMethod !== "api_key") {
      token = await ensureFreshToken(connection);
    }

    const requestConfig = getJiraRequestConfig(connection, token);
    const url = `${requestConfig.baseUrl}/issue/${externalId}`;

    const response = await fetchValidated(url, {
      headers: requestConfig.headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
    }

    const issue = (await response.json()) as JiraIssue;
    return normalizeJiraIssue(issue, connection);
  },
};

export type { JiraIssue, JiraIssueFields, AdfNode };
