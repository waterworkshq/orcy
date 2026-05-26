import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generatePKCEPair,
  getLinearAuthorizationUrl,
  exchangeLinearCode,
  refreshLinearToken,
  getLinearTeams,
} from '../services/integrations/linearOAuth.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generatePKCEPair', () => {
  it('produces valid verifier and challenge', () => {
    const pair = generatePKCEPair();

    expect(pair.codeVerifier).toBeTruthy();
    expect(pair.codeChallenge).toBeTruthy();
    expect(pair.codeVerifier).not.toBe(pair.codeChallenge);
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('produces different pairs each time', () => {
    const pair1 = generatePKCEPair();
    const pair2 = generatePKCEPair();
    expect(pair1.codeVerifier).not.toBe(pair2.codeVerifier);
  });
});

describe('getLinearAuthorizationUrl', () => {
  it('builds correct authorization URL with PKCE', () => {
    const url = getLinearAuthorizationUrl('lin-client-id', 'http://127.0.0.1:9999/callback', 'challenge-abc', 'state-123');

    expect(url).toContain('https://linear.app/oauth/authorize');
    expect(url).toContain('client_id=lin-client-id');
    expect(url).toContain('code_challenge=challenge-abc');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=state-123');
    expect(url).toContain('scope=read');
    expect(url).not.toContain('client_secret');
  });
});

describe('exchangeLinearCode', () => {
  it('exchanges code for token with PKCE verifier', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      access_token: 'lin-at',
      token_type: 'Bearer',
      expires_in: 31536000,
      scope: 'read',
    }));

    const result = await exchangeLinearCode('auth-code', 'lin-client', 'http://127.0.0.1:9999/callback', 'verifier-xyz');

    expect(result.access_token).toBe('lin-at');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.linear.app/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: expect.stringContaining('code_verifier'),
      })
    );
    const body = String(mockFetch.mock.calls[0][1].body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('client_id=lin-client');
    expect(body).not.toContain('client_secret');
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'invalid_grant',
      error_description: 'Invalid code',
    }));

    await expect(exchangeLinearCode('bad', 'cid', 'http://localhost/cb', 'verifier'))
      .rejects.toThrow('Invalid code');
  });
});

describe('refreshLinearToken', () => {
  it('refreshes a PKCE token without a client secret', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      access_token: 'lin-at-new',
      refresh_token: 'lin-rt-new',
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'read',
    }));

    const result = await refreshLinearToken('lin-rt', 'lin-client');

    expect(result.access_token).toBe('lin-at-new');
    const body = String(mockFetch.mock.calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=lin-client');
    expect(body).toContain('refresh_token=lin-rt');
    expect(body).not.toContain('client_secret');
  });
});

describe('getLinearTeams', () => {
  it('returns team list', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      data: {
        teams: {
          nodes: [
            { id: 'team-1', name: 'Platform', key: 'PLAT' },
            { id: 'team-2', name: 'Mobile', key: 'MOB' },
          ],
        },
      },
    }));

    const teams = await getLinearTeams('lin-at');
    expect(teams).toHaveLength(2);
    expect(teams[0].id).toBe('team-1');
    expect(teams[1].name).toBe('Mobile');
  });

  it('throws on GraphQL errors', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      data: { teams: { nodes: [] } },
      errors: [{ message: 'Not authenticated' }],
    }));

    await expect(getLinearTeams('bad')).rejects.toThrow('Not authenticated');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, {}));
    await expect(getLinearTeams('bad')).rejects.toThrow('teams query failed');
  });
});
