import type { IntegrationConnection, ExternalIssue } from "@orcy/shared";
import type { IssueProviderAdapter } from "./types.js";
import { getLinearClientId, refreshLinearToken } from "./linearOAuth.js";
import * as connectionRepo from "../../repositories/integrationConnection.js";
import { logger } from "../../lib/logger.js";

const MAX_PAGES = 100;

/** Shape of a Linear issue node returned by the GraphQL API. */
interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string } | null;
  priority: number | null;
  estimate: number | null;
  assignee: { name: string; email: string } | null;
  creator: { name: string; email: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  project: { name: string } | null;
  cycle: { name: string; number: number } | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface LinearIssuesResponse {
  data: {
    team: {
      name: string;
      issues: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: LinearIssueNode[];
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

const LINEAR_PRIORITY_MAP: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function buildIssuesQuery(): string {
  return `
    query($teamId: String!, $after: String) {
      team(id: $teamId) {
        name
        issues(
          first: 50
          after: $after
          orderBy: updatedAt
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            identifier
            title
            description
            state { name type }
            priority
            estimate
            assignee { name email }
            creator { name email }
            labels { nodes { name } }
            project { name }
            cycle { name number }
            url
            createdAt
            updatedAt
          }
        }
      }
    }
  `;
}

/** Converts a raw Linear GraphQL issue node into the shared {@link ExternalIssue} shape. */
export function normalizeLinearIssue(issue: LinearIssueNode): ExternalIssue {
  const stateType = issue.state?.type ?? "";
  const labels = issue.labels?.nodes.map((l) => l.name) ?? [];

  return {
    provider: "linear",
    externalId: issue.id,
    externalKey: issue.identifier,
    title: issue.title,
    body: issue.description ?? "",
    status: stateType === "completed" ? "closed" : "open",
    labels,
    sourceKind: undefined,
    priority:
      issue.priority !== null ? (LINEAR_PRIORITY_MAP[issue.priority] ?? "Medium") : undefined,
    assignees: issue.assignee ? [issue.assignee.name] : [],
    reporter: issue.creator?.name,
    url: issue.url,
    updatedAt: issue.updatedAt,
    rawProviderPayload: issue as unknown as Record<string, unknown>,
  };
}

async function ensureFreshToken(connection: IntegrationConnection): Promise<string> {
  let token = connection.accessToken;
  if (!token) throw new Error("Linear connection has no access token");

  if (connection.tokenExpiresAt && connection.refreshToken) {
    const expiresAt = new Date(connection.tokenExpiresAt).getTime();
    if (Date.now() >= expiresAt - 60000) {
      try {
        const refreshed = await refreshLinearToken(connection.refreshToken, getLinearClientId());
        connectionRepo.update(connection.id, {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? connection.refreshToken,
          tokenExpiresAt: refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
            : null,
        });
        token = refreshed.access_token;
      } catch (err) {
        logger.warn({ err, connectionId: connection.id }, "Linear token refresh failed");
      }
    }
  }

  return token;
}

/** Adapter that lists and fetches Linear issues through the Linear GraphQL API. */
export const linearAdapter: IssueProviderAdapter = {
  provider: "linear",

  async listIssues(connection: IntegrationConnection): Promise<ExternalIssue[]> {
    const token = await ensureFreshToken(connection);

    const teamId = connection.teamId;
    if (!teamId) throw new Error("Linear connection has no team ID");

    const query = buildIssuesQuery();
    const allIssues: ExternalIssue[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      pageCount++;
      if (pageCount > MAX_PAGES) {
        logger.warn(
          { connectionId: connection.id, pageCount },
          "Linear pagination exceeded max pages, truncating",
        );
        break;
      }
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables: { teamId, after: cursor } }),
      });

      if (!response.ok) {
        throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as LinearIssuesResponse;

      if (data.errors?.length) {
        throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
      }

      if (!data.data.team) {
        throw new Error("Linear team not found");
      }

      for (const issue of data.data.team.issues.nodes) {
        allIssues.push(normalizeLinearIssue(issue));
      }

      const pageInfo = data.data.team.issues.pageInfo;
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (cursor);

    return allIssues;
  },

  async getIssue(
    connection: IntegrationConnection,
    externalId: string,
  ): Promise<ExternalIssue | null> {
    const token = await ensureFreshToken(connection);

    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state { name type }
          priority
          estimate
          assignee { name email }
          creator { name email }
          labels { nodes { name } }
          project { name }
          cycle { name number }
          url
          createdAt
          updatedAt
        }
      }
    `;

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: externalId } }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      data: { issue: LinearIssueNode | null };
      errors?: Array<{ message: string }>;
    };

    if (data.errors?.length) {
      throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
    }

    if (!data.data.issue) return null;
    return normalizeLinearIssue(data.data.issue);
  },
};

export type { LinearIssueNode };
