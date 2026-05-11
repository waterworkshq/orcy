import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiClient, ApiClientError } from '../api-client.js';

const BASE_URL = 'http://localhost:9999';

describe('createApiClient', () => {
  let client: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    client = createApiClient({
      baseUrl: BASE_URL,
      timeoutMs: 2000,
      maxRetries: 2,
      baseDelay: 10,
      maxDelay: 50,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ApiClientError', () => {
    it('formats message as "API {status}: {message}"', () => {
      const err = new ApiClientError(404, 'Not Found');
      expect(err.message).toBe('API 404: Not Found');
      expect(err.status).toBe(404);
      expect(err.name).toBe('ApiClientError');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ApiClientError);
    });
  });

  describe('successful responses', () => {
    it('returns parsed JSON for 200', async () => {
      const body = { id: 'abc', title: 'test' };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = await client.get<{ id: string }>('/tasks');
      expect(result).toEqual(body);
    });

    it('returns undefined for 204', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );
      const result = await client.delete('/tasks/123');
      expect(result).toBeUndefined();
    });
  });

  describe('HTTP error responses', () => {
    it('throws ApiClientError for non-retryable status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Bad Request', { status: 400 }),
      );
      try {
        await client.get('/fail');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).status).toBe(400);
        expect((err as ApiClientError).message).toBe('API 400: Bad Request');
      }
    });

    it('retries and eventually throws ApiClientError for 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );
      try {
        await client.get('/fail');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).status).toBe(500);
      }
    });
  });

  describe('network failure after max retries', () => {
    it('wraps network TypeError in ApiClientError with status 0', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new TypeError('fetch failed'),
      );
      try {
        await client.get('/network-fail');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).status).toBe(0);
        expect((err as ApiClientError).message).toContain('fetch failed');
      }
    });

    it('preserves original TypeError as cause', async () => {
      const networkError = new TypeError('fetch failed');
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError);
      try {
        await client.get('/network-fail');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).cause).toBe(networkError);
      }
    });
  });

  describe('timeout', () => {
    it('throws ApiClientError with status 408 on abort', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('The operation was aborted', 'AbortError')), 50);
        });
      });
      const slowClient = createApiClient({
        baseUrl: BASE_URL,
        timeoutMs: 10,
        maxRetries: 0,
      });
      try {
        await slowClient.get('/slow');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        expect((err as ApiClientError).status).toBe(408);
      }
    });
  });

  describe('request methods', () => {
    it('POST sends body as JSON', async () => {
      const body = { title: 'new task' };
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '1', ...body }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await client.post('/tasks', body);
      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/tasks`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });

    it('does not set Content-Type when body is undefined', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await client.get('/tasks');
      const callArgs = mockFetch.mock.calls[0][1] as Record<string, unknown>;
      expect(callArgs.headers).toEqual({});
    });
  });
});
