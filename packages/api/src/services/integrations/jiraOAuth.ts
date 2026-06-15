import * as connectionRepo from "../../repositories/integrationConnection.js";
import { badRequest } from "../../errors.js";

/** Returns the Jira OAuth client credentials from environment variables, throwing if either is missing. */
export function getJiraCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.ORCY_JIRA_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ORCY_JIRA_OAUTH_CLIENT_SECRET;
  if (!clientId) throw new Error("ORCY_JIRA_OAUTH_CLIENT_ID is not configured");
  if (!clientSecret) throw new Error("ORCY_JIRA_OAUTH_CLIENT_SECRET is not configured");
  return { clientId, clientSecret };
}

/** Builds the Atlassian authorization URL that starts the Jira OAuth flow. */
export function getJiraAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: "read:jira-work offline_access",
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `https://auth.atlassian.com/authorize?${params.toString()}`;
}

/** Token payload returned by Atlassian when exchanging or refreshing a Jira OAuth code. */
export interface JiraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Exchanges a Jira authorization code for access and refresh tokens. */
export async function exchangeJiraCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<JiraTokenResponse> {
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      body.error_description || body.error || `Jira token exchange failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<JiraTokenResponse>;
}

/** A Jira Cloud site the authenticated user can access. */
export interface JiraCloudResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

/** Fetches the Jira Cloud sites accessible to the bearer token. */
export async function discoverJiraCloudIds(accessToken: string): Promise<JiraCloudResource[]> {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Jira cloud discovery failed (HTTP ${res.status})`);
  }

  return res.json() as Promise<JiraCloudResource[]>;
}

/** Exchanges a Jira refresh token for a new access token. */
export async function refreshJiraToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<JiraTokenResponse> {
  const res = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      body.error_description || body.error || `Jira token refresh failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<JiraTokenResponse>;
}

/** Input required to finish the Jira OAuth callback and persist the connection. */
export interface CompleteJiraOAuthInput {
  code: string;
  redirectPort: number;
  habitatId: string;
  userId: string;
}

/** Result of completing Jira OAuth, containing the persisted integration connection. */
export interface CompleteJiraOAuthResult {
  integration: ReturnType<typeof connectionRepo.toView>;
}

/** Completes the Jira OAuth flow, creates the integration connection, and returns its view. */
export async function completeJiraOAuth(
  input: CompleteJiraOAuthInput,
): Promise<CompleteJiraOAuthResult> {
  const { clientId, clientSecret } = getJiraCredentials();
  const redirectUri = `http://127.0.0.1:${input.redirectPort}/callback`;

  const tokens = await exchangeJiraCode(input.code, clientId, clientSecret, redirectUri);
  const resources = await discoverJiraCloudIds(tokens.access_token);

  if (resources.length === 0) {
    throw badRequest("No accessible Jira Cloud instances found");
  }

  const resource = resources[0];

  const connection = connectionRepo.create({
    habitatId: input.habitatId,
    provider: "jira",
    name: `${resource.name}/jira`,
    authMethod: "oauth_code",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    externalTenantId: resource.id,
    externalTenantName: resource.name,
    externalBaseUrl: resource.url,
    pullEnabled: true,
    autoImport: false,
    createdBy: input.userId,
  });

  return { integration: connectionRepo.toView(connection) };
}
