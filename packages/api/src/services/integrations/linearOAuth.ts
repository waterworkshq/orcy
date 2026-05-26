import crypto from 'crypto';

const DEFAULT_LINEAR_OAUTH_CLIENT_ID = '9c05e7d93694e1fd091a189331fa45bd';

export function getLinearClientId(): string {
  return process.env.ORCY_LINEAR_OAUTH_CLIENT_ID || DEFAULT_LINEAR_OAUTH_CLIENT_ID;
}

export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export function getLinearAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

export interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export async function exchangeLinearCode(
  code: string,
  clientId: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<LinearTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(errorBody.error_description || errorBody.error || `Linear token exchange failed (HTTP ${res.status})`);
  }

  return res.json() as Promise<LinearTokenResponse>;
}

export async function refreshLinearToken(
  refreshToken: string,
  clientId: string,
): Promise<LinearTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(errorBody.error_description || errorBody.error || `Linear token refresh failed (HTTP ${res.status})`);
  }

  return res.json() as Promise<LinearTokenResponse>;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

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

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`Linear teams query failed (HTTP ${res.status})`);
  }

  const data = await res.json() as { data: { teams: { nodes: LinearTeam[] } }; errors?: Array<{ message: string }> };
  if (data.errors?.length) {
    throw new Error(`Linear GraphQL error: ${data.errors[0].message}`);
  }

  return data.data.teams.nodes;
}
