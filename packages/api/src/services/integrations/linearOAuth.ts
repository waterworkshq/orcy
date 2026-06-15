import crypto from "crypto";
import * as connectionRepo from "../../repositories/integrationConnection.js";
import { badRequest } from "../../errors.js";

const DEFAULT_LINEAR_OAUTH_CLIENT_ID = "9c05e7d93694e1fd091a189331fa45bd";

/** Returns the configured Linear OAuth client ID, falling back to the default public app ID. */
export function getLinearClientId(): string {
  return process.env.ORCY_LINEAR_OAUTH_CLIENT_ID || DEFAULT_LINEAR_OAUTH_CLIENT_ID;
}

/** Generates a PKCE code verifier and challenge pair for the Linear OAuth flow. */
export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** Builds the Linear OAuth authorization URL with PKCE parameters. */
export function getLinearAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

/** Token payload returned by Linear when exchanging or refreshing an OAuth code. */
export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/** Exchanges a Linear authorization code and PKCE verifier for tokens. */
export async function exchangeLinearCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<LinearTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      errorBody.error_description ||
        errorBody.error ||
        `Linear token exchange failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<LinearTokenResponse>;
}

/** Exchanges a Linear refresh token for a new access token. */
export async function refreshLinearToken(
  refreshToken: string,
  clientId: string,
): Promise<LinearTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      errorBody.error_description ||
        errorBody.error ||
        `Linear token refresh failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<LinearTokenResponse>;
}

/** A Linear team that can be selected during OAuth connection setup. */
export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

/** Fetches the teams visible to the authenticated Linear user. */
export async function getLinearTeams(accessToken: string): Promise<LinearTeam[]> {
  const query = `
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`Linear teams query failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    data: { teams: { nodes: LinearTeam[] } };
    errors?: Array<{ message: string }>;
  };
  if (data.errors?.length) {
    throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
  }

  return data.data.teams.nodes;
}

/** Input required to finish the Linear OAuth callback and persist the connection. */
export interface CompleteLinearOAuthInput {
  code: string;
  redirectPort: number;
  habitatId: string;
  userId: string;
  codeVerifier: string;
}

/** Result of completing Linear OAuth, containing the persisted integration and available teams. */
export interface CompleteLinearOAuthResult {
  integration: ReturnType<typeof connectionRepo.toView>;
  teams: LinearTeam[];
}

/** Completes the Linear OAuth flow, creates the integration connection, and returns its view with teams. */
export async function completeLinearOAuth(
  input: CompleteLinearOAuthInput,
): Promise<CompleteLinearOAuthResult> {
  const clientId = getLinearClientId();
  const redirectUri = `http://127.0.0.1:${input.redirectPort}/callback`;

  const tokens = await exchangeLinearCode(input.code, clientId, redirectUri, input.codeVerifier);
  const teams = await getLinearTeams(tokens.access_token);

  const connection = connectionRepo.create({
    habitatId: input.habitatId,
    provider: "linear",
    name: teams.length > 0 ? `${teams[0].name}/linear` : "linear",
    authMethod: "oauth_pkce",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    tokenExpiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    teamId: teams.length > 0 ? teams[0].id : null,
    pullEnabled: true,
    autoImport: false,
    createdBy: input.userId,
  });

  return { integration: connectionRepo.toView(connection), teams };
}
