export interface ApiClientConfig {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

export class ApiClientError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(`API ${status}: ${message}`);
    this.name = 'ApiClientError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;

function isRetryable(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof TypeError && err.message.includes('fetch')) return true;
  if (err instanceof ApiClientError) {
    const status = err.status;
    if (status === 429 || status === 502 || status === 503) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true;
  }
  if (err instanceof Error && !(err instanceof ApiClientError)) return true;
  return false;
}

function getRetryDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  response?: Response
): number {
  if (response) {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, maxDelay);
      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        if (diff > 0) return Math.min(diff, maxDelay);
      }
    }
  }
  const delay = baseDelay * Math.pow(2, attempt);
  const jitter = delay * (0.5 + Math.random() * 0.5);
  return Math.min(jitter, maxDelay);
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiClient {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
  get<T>(path: string, headers?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  put<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  patch<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  delete<T>(path: string, headers?: Record<string, string>): Promise<T>;
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const {
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelay = DEFAULT_BASE_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
  } = config;

  const base = baseUrl.replace(/\/$/, '');

  async function request<T>(
    method: string,
    path: string,
    options?: RequestOptions
  ): Promise<T> {
    const url = `${base}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers: Record<string, string> = {
        ...options?.headers,
      };
      if (options?.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const error = new ApiClientError(response.status, errorText || response.statusText);
          if (attempt < maxRetries && isRetryable(error)) {
            const delay = getRetryDelay(attempt, baseDelay, maxDelay, response);
            clearTimeout(timeoutId);
            await new Promise(resolve => setTimeout(resolve, delay));
            lastError = error;
            continue;
          }
          throw error;
        }

        if (response.status === 204 || response.headers.get('content-length') === '0') {
          return undefined as T;
        }
        return response.json() as Promise<T>;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          const timeoutError = new ApiClientError(408, `Request to ${path} timed out after ${timeoutMs}ms`);
          if (attempt < maxRetries && isRetryable(timeoutError)) {
            const delay = getRetryDelay(attempt, baseDelay, maxDelay);
            clearTimeout(timeoutId);
            await new Promise(resolve => setTimeout(resolve, delay));
            lastError = timeoutError;
            continue;
          }
          throw timeoutError;
        }
        if (err instanceof ApiClientError) {
          throw err;
        }
        if (attempt < maxRetries && isRetryable(err)) {
          const delay = getRetryDelay(attempt, baseDelay, maxDelay);
          clearTimeout(timeoutId);
          await new Promise(resolve => setTimeout(resolve, delay));
          lastError = err;
          continue;
        }
        if (err instanceof Error) {
          const wrapped = new ApiClientError(0, err.message);
          wrapped.cause = err;
          throw wrapped;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    if (lastError instanceof ApiClientError) {
      throw lastError;
    }
    if (lastError instanceof Error) {
      const wrapped = new ApiClientError(0, lastError.message);
      wrapped.cause = lastError;
      throw wrapped;
    }
    throw lastError;
  }

  return {
    request,
    get: <T>(path: string, headers?: Record<string, string>) =>
      request<T>('GET', path, { headers }),
    post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('POST', path, { body, headers }),
    put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('PUT', path, { body, headers }),
    patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>('PATCH', path, { body, headers }),
    delete: <T>(path: string, headers?: Record<string, string>) =>
      request<T>('DELETE', path, { headers }),
  };
}
