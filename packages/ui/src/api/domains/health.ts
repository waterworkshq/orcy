import { request } from "../transport.js";

export const healthApi = {
  get: (boardId: string) =>
    request<{
      boardId: string;
      score: number;
      grade: string;
      dimensions: Record<string, { score: number } & Record<string, number>>;
      recommendations: string[];
      snapshotAt: string;
    }>(`/habitats/${boardId}/health`),
  history: (boardId: string, days?: number) => {
    const params = days ? `?days=${days}` : "";
    return request<{ snapshots: Array<{ score: number; grade: string; snapshotAt: string }> }>(
      `/habitats/${boardId}/health/history${params}`,
    );
  },
};
