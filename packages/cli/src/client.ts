import { createApiClient, getOrcyConfig } from '@orcy/shared';

const config = getOrcyConfig();
const client = createApiClient({ baseUrl: config.apiUrl });

function withAuth(headers?: Record<string, string>): Record<string, string> {
  const h = { ...headers };
  if (config.apiKey) h['X-Agent-API-Key'] = config.apiKey;
  return h;
}

export const api = {
  get: <T>(path: string) => client.get<T>(path, withAuth()),
  post: <T>(path: string, body?: unknown) => client.post<T>(path, body, withAuth()),
  put: <T>(path: string, body?: unknown) => client.put<T>(path, body, withAuth()),
  patch: <T>(path: string, body?: unknown) => client.patch<T>(path, body, withAuth()),
  delete: <T>(path: string) => client.delete<T>(path, withAuth()),
};
