import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getJiraAuthorizationUrl,
  exchangeJiraCode,
  discoverJiraCloudIds,
  refreshJiraToken,
} from '../services/integrations/jiraOAuth.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getJiraAuthorizationUrl', () => {
  it('builds correct authorization URL', () => {
    const url = getJiraAuthorizationUrl('my-client-id', 'http://127.0.0.1:1234/callback', 'state-xyz');

    expect(url).toContain('https://auth.atlassian.com/authorize');
    expect(url).toContain('client_id=my-client-id');
    expect(url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback');
    expect(url).toContain('state=state-xyz');
    expect(url).toContain('scope=read%3Ajira-work');
    expect(url).toContain('response_type=code');
    expect(url).toContain('prompt=consent');
  });
});

describe('exchangeJiraCode', () => {
  it('exchanges code for tokens', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      access_token: 'at-test',
      refresh_token: 'rt-test',
      expires_in: 3600,
      scope: 'read:jira-work',
      token_type: 'bearer',
    }));

    const result = await exchangeJiraCode('auth-code', 'cid', 'csecret', 'http://127.0.0.1:1234/callback');

    expect(result.access_token).toBe('at-test');
    expect(result.refresh_token).toBe('rt-test');
    expect(result.expires_in).toBe(3600);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.atlassian.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('authorization_code'),
      })
    );
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'invalid_grant',
      error_description: 'Invalid authorization code',
    }));

    await expect(exchangeJiraCode('bad', 'cid', 'csecret', 'http://127.0.0.1:1234/callback'))
      .rejects.toThrow('Invalid authorization code');
  });
});

describe('discoverJiraCloudIds', () => {
  it('returns cloud resources', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, [
      { id: 'cloud-123', name: 'mysite', url: 'https://mysite.atlassian.net', scopes: ['read:jira-work'] },
    ]));

    const resources = await discoverJiraCloudIds('at-test');

    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe('cloud-123');
    expect(resources[0].name).toBe('mysite');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, {}));
    await expect(discoverJiraCloudIds('bad')).rejects.toThrow('cloud discovery failed');
  });
});

describe('refreshJiraToken', () => {
  it('refreshes tokens', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      access_token: 'at-new',
      refresh_token: 'rt-new',
      expires_in: 3600,
      scope: 'read:jira-work',
      token_type: 'bearer',
    }));

    const result = await refreshJiraToken('rt-old', 'cid', 'csecret');

    expect(result.access_token).toBe('at-new');
    expect(result.refresh_token).toBe('rt-new');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, { error: 'invalid_grant' }));
    await expect(refreshJiraToken('bad', 'cid', 'csecret')).rejects.toThrow();
  });
});
