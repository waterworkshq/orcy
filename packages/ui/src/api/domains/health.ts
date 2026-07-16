import { request } from "../transport.js";

export const healthApi = {
  get: (habitatId: string) =>
    request<{
      habitatId: string;
      score: number;
      grade: string;
      dimensions: Record<string, { score: number } & Record<string, number>>;
      recommendations: string[];
      snapshotAt: string;
    }>(`/habitats/${habitatId}/health`),
  history: (habitatId: string, days?: number) => {
    const params = days ? `?days=${days}` : "";
    return request<{ snapshots: Array<{ score: number; grade: string; snapshotAt: string }> }>(
      `/habitats/${habitatId}/health/history${params}`,
    );
  },
};
