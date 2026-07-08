import { request } from "../transport.js";
import type {
  FindingTriageView,
  TriageResolutionView,
  ClusterSummaryView,
} from "../../types/index.js";

export const triageApi = {
  listFindings: (habitatId: string, filters?: { status?: string; bucket?: string }) => {
    const params = new URLSearchParams();
    params.set("habitatId", habitatId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.bucket) params.set("bucket", filters.bucket);
    return request<{ findings: FindingTriageView[] }>(`/triage/findings?${params.toString()}`).then(
      (r) => r.findings,
    );
  },
  getFinding: (id: string) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}`).then((r) => r.finding),
  transitionFinding: (
    id: string,
    body: { status?: string; bucket?: string; targetRelease?: string | null },
  ) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }).then((r) => r.finding),
  promoteFinding: (id: string) =>
    request<{ missionId: string }>(`/triage/findings/${id}/promote`, {
      method: "POST",
    }).then((r) => r.missionId),
  lookupResolutions: (habitatId: string, clusterKey: string) => {
    const params = new URLSearchParams({ habitatId, clusterKey });
    return request<{ resolutions: TriageResolutionView[] }>(
      `/triage/resolutions?${params.toString()}`,
    ).then((r) => r.resolutions);
  },
  topIssues: (habitatId: string, limit?: number) => {
    const params = new URLSearchParams({ habitatId });
    if (limit !== undefined) params.set("limit", String(limit));
    return request<{ clusters: ClusterSummaryView[] }>(
      `/triage/clusters/top?${params.toString()}`,
    ).then((r) => r.clusters);
  },
};
