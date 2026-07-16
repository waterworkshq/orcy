import { request } from "../transport.js";
import type { DashboardStats } from "../../types/index.js";

export const dashboardApi = {
  get: (params?: { habitatId?: string; period?: "7d" | "30d" | "90d" }) => {
    const queryParams = new URLSearchParams();
    if (params?.habitatId) queryParams.set("habitatId", params.habitatId);
    if (params?.period) queryParams.set("period", params.period);
    const qs = queryParams.toString();
    return request<DashboardStats>(`/dashboard${qs ? `?${qs}` : ""}`);
  },
};
