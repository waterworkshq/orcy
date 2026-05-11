import { getOrcyConfig } from '@orcy/shared';

const config = getOrcyConfig();
const API_URL = config.apiUrl;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = config.apiKey;
  const agentId = config.agentId;
  const url = `${API_URL.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-Agent-API-Key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
