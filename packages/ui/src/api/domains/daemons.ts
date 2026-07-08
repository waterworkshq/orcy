import { request } from "../transport.js";

export const daemonsApi = {
  list: () => request<{ daemons: import("../../types/index.js").DaemonInfo[] }>("/daemons"),
  get: (id: string) => request<import("../../types/index.js").DaemonDetail>(`/daemons/${id}`),
  register: (data: {
    name: string;
    habitatIds: string[];
    maxConcurrent?: number;
    cliPreferences?: string[];
  }) =>
    request<{
      daemonId: string;
      agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
    }>("/daemons/register", { method: "POST", body: JSON.stringify(data) }),
  start: (id: string, dataDir?: string) =>
    request<{ status: string }>(`/daemons/${id}/start`, {
      method: "POST",
      body: JSON.stringify(dataDir ? { dataDir } : {}),
    }),
  stop: (id: string) => request<{ status: string }>(`/daemons/${id}/stop`, { method: "POST" }),
  detectClis: () =>
    request<{ clis: import("../../types/index.js").DetectedCli[] }>("/daemons/detect-clis"),
};
