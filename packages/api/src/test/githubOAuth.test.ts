import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startGitHubDeviceFlow,
  pollGitHubDeviceFlow,
  getGitHubViewer,
} from '../services/integrations/githubOAuth.js';

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

describe('startGitHubDeviceFlow', () => {
  it('returns device flow info on success', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      device_code: 'dc-test-123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }));

    const result = await startGitHubDeviceFlow();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('repo read:user'),
      })
    );
    expect(result.device_code).toBe('dc-test-123');
    expect(result.user_code).toBe('ABCD-1234');
    expect(result.verification_uri).toBe('https://github.com/login/device');
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'invalid_request',
      error_description: 'Client ID is required',
    }));

    await expect(startGitHubDeviceFlow()).rejects.toThrow('Client ID is required');
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    await expect(startGitHubDeviceFlow()).rejects.toThrow('Network failure');
  });
});

describe('pollGitHubDeviceFlow', () => {
  it('returns access token on success', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      access_token: 'gho_test_token',
      token_type: 'bearer',
      scope: 'repo,read:user',
    }));

    const result = await pollGitHubDeviceFlow('dc-test-123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('urn:ietf:params:oauth:grant-type:device_code'),
      })
    );
    expect(result.access_token).toBe('gho_test_token');
    expect(result.token_type).toBe('bearer');
  });

  it('returns pending when authorization_pending', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'authorization_pending',
      error_description: 'The user has not yet authorized',
    }));

    const result = await pollGitHubDeviceFlow('dc-test-123');

    expect(result.error).toBe('authorization_pending');
    expect(result.access_token).toBeUndefined();
  });

  it('returns pending when slow_down', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'slow_down',
      interval: 10,
    }));

    const result = await pollGitHubDeviceFlow('dc-test-123');

    expect(result.error).toBe('slow_down');
    expect(result.access_token).toBeUndefined();
  });

  it('throws on expired_token', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'expired_token',
    }));

    await expect(pollGitHubDeviceFlow('dc-expired')).rejects.toThrow();
  });

  it('throws on access_denied', async () => {
    mockFetch.mockResolvedValue(mockResponse(400, {
      error: 'access_denied',
      error_description: 'User denied authorization',
    }));

    await expect(pollGitHubDeviceFlow('dc-denied')).rejects.toThrow('User denied authorization');
  });
});

describe('getGitHubViewer', () => {
  it('returns user info on success', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, {
      id: 12345,
      login: 'testuser',
      name: 'Test User',
    }));

    const result = await getGitHubViewer('gho_token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer gho_token',
        }),
      })
    );
    expect(result.id).toBe(12345);
    expect(result.login).toBe('testuser');
    expect(result.name).toBe('Test User');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, {
      message: 'Bad credentials',
    }));

    await expect(getGitHubViewer('bad_token')).rejects.toThrow('Bad credentials');
  });
});
