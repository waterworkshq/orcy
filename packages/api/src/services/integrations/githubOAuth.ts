const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

function getClientId(): string {
  return process.env.ORCY_GITHUB_OAUTH_CLIENT_ID || "Ov23liwIyGIgEaZetUN7";
}

const DEFAULT_SCOPES = "repo read:user";

/** Initial response from GitHub's OAuth device authorization endpoint. */
export interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Response from polling GitHub's OAuth token endpoint during device flow. */
export interface GitHubDeviceFlowPollResult {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Authenticated GitHub user profile returned by the viewer API. */
export interface GitHubViewer {
  id: number;
  login: string;
  name: string | null;
}

/** Starts a GitHub OAuth device flow and returns the user verification payload. */
export async function startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart> {
  const clientId = getClientId();

  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: DEFAULT_SCOPES,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(
      body.error_description || body.error || `Device flow start failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<GitHubDeviceFlowStart>;
}

/** Polls GitHub's token endpoint for an access token using a device code. */
export async function pollGitHubDeviceFlow(
  deviceCode: string,
): Promise<GitHubDeviceFlowPollResult> {
  const clientId = getClientId();

  const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      return body as unknown as GitHubDeviceFlowPollResult;
    }
    throw new Error(
      body.error_description || body.error || `Token polling failed (HTTP ${res.status})`,
    );
  }

  return res.json() as Promise<GitHubDeviceFlowPollResult>;
}

/** Fetches the authenticated GitHub user's profile. */
export async function getGitHubViewer(accessToken: string): Promise<GitHubViewer> {
  const res = await fetch(`${GITHUB_API_URL}/user`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(body.message || `Failed to get GitHub user (HTTP ${res.status})`);
  }

  return res.json() as Promise<GitHubViewer>;
}
