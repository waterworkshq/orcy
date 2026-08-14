import { request } from "../transport.js";
import type {
  FindingTriageView,
  TriageResolutionView,
  ClusterSummaryView,
  TriageRouteCommand,
  TriageActivationView,
} from "../../types/index.js";

/**
 * Triage domain client. Every Finding MUTATION crosses an explicit lifecycle
 * command endpoint (`/route`, `/activate`, `/resolve`, `/wontfix`) — the
 * state-shaped PATCH client was removed in the restored-lifecycle cutover so
 * no `{status: ...}`-only request can be constructed from the UI. Query
 * functions forward TanStack's AbortSignal (ADR-0040 cancel-before-patch).
 */
export const triageApi = {
  listFindings: (
    habitatId: string,
    filters?: { status?: string; bucket?: string },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    params.set("habitatId", habitatId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.bucket) params.set("bucket", filters.bucket);
    return request<{ findings: FindingTriageView[] }>(`/triage/findings?${params.toString()}`, {
      signal,
    }).then((r) => r.findings);
  },
  getFinding: (id: string, signal?: AbortSignal) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}`, { signal }).then(
      (r) => r.finding,
    ),

  /** POST /triage/findings/:id/route — explicit route intent (discriminated payload). */
  routeFinding: (id: string, route: TriageRouteCommand) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}/route`, {
      method: "POST",
      body: JSON.stringify(route),
    }).then((r) => r.finding),

  /** POST /triage/findings/:id/resolve — terminal resolution with the complete payload. */
  resolveFinding: (
    id: string,
    input: { resolution: string; resolutionKind: string; rootCause?: string },
  ) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.finding),

  /** POST /triage/findings/:id/wontfix — terminal wontfix with a required reason. */
  wontfixFinding: (id: string, input: { reason: string }) =>
    request<{ finding: FindingTriageView }>(`/triage/findings/${id}/wontfix`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.finding),

  /**
   * POST /triage/findings/:id/activate — manual activation of the Finding's
   * EXISTING corrective Mission. `expectedMissionVersion` is the Mission
   * version the caller observed (CAS); stale versions return 409 with the
   * X-Current-Version header, contention returns 409 LIFECYCLE_BUSY.
   */
  activateFinding: (id: string, input: { expectedMissionVersion: number }) =>
    request<{ activation: TriageActivationView }>(`/triage/findings/${id}/activate`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.activation),

  lookupResolutions: (habitatId: string, clusterKey: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ habitatId, clusterKey });
    return request<{ resolutions: TriageResolutionView[] }>(
      `/triage/resolutions?${params.toString()}`,
      { signal },
    ).then((r) => r.resolutions);
  },
  topIssues: (habitatId: string, limit?: number, signal?: AbortSignal) => {
    const params = new URLSearchParams({ habitatId });
    if (limit !== undefined) params.set("limit", String(limit));
    return request<{ clusters: ClusterSummaryView[] }>(
      `/triage/clusters/top?${params.toString()}`,
      { signal },
    ).then((r) => r.clusters);
  },
};
