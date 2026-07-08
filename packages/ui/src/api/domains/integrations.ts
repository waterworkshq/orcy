import { request } from "../transport.js";
import type {
  IntegrationConnectionView,
  ExternalIssueLink,
  ExternalIntakeCandidate,
  IntegrationSyncRun,
  Mission,
} from "../../types/index.js";

export const integrationsApi = {
  list: (habitatId: string) =>
    request<{ integrations: IntegrationConnectionView[] }>(`/habitats/${habitatId}/integrations`),
  createGitHubPat: (
    habitatId: string,
    data: {
      name: string;
      token: string;
      repositoryOwner: string;
      repositoryName: string;
      autoImport?: boolean;
      pullEnabled?: boolean;
    },
  ) =>
    request<{ integration: IntegrationConnectionView }>(
      `/habitats/${habitatId}/integrations/github/pat`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  startGitHubDeviceFlow: (habitatId: string) =>
    request<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresIn: number;
      interval: number;
    }>(`/habitats/${habitatId}/integrations/github/oauth/device/start`, { method: "POST" }),
  pollGitHubDeviceFlow: (habitatId: string, data: { deviceCode: string }) =>
    request<{ status?: string; integration?: IntegrationConnectionView }>(
      `/habitats/${habitatId}/integrations/github/oauth/device/poll`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  update: (
    connectionId: string,
    data: {
      name?: string;
      enabled?: boolean;
      pullEnabled?: boolean;
      autoImport?: boolean;
    },
  ) =>
    request<{ integration: IntegrationConnectionView }>(`/integrations/${connectionId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  disable: (connectionId: string) =>
    request<void>(`/integrations/${connectionId}`, { method: "DELETE" }),
  sync: (connectionId: string) =>
    request<{ created: number; updated: number; skipped: number; failed: number }>(
      `/integrations/${connectionId}/sync`,
      {
        method: "POST",
      },
    ),
  listSyncRuns: (connectionId: string) =>
    request<{ syncRuns: IntegrationSyncRun[] }>(`/integrations/${connectionId}/sync-runs`),
  listMissionLinks: (missionId: string) =>
    request<{ externalLinks: ExternalIssueLink[] }>(`/missions/${missionId}/external-links`),
  startJiraOAuth: (habitatId: string) =>
    request<{ authUrl: string; state: string; redirectPort: number }>(
      `/habitats/${habitatId}/integrations/jira/oauth/start`,
      { method: "POST" },
    ),
  completeJiraOAuth: (
    habitatId: string,
    data: { code: string; state: string; redirectPort: number },
  ) =>
    request<{ integration: IntegrationConnectionView }>(
      `/habitats/${habitatId}/integrations/jira/oauth/complete`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  createJiraApiKey: (
    habitatId: string,
    data: {
      name: string;
      email: string;
      token: string;
      siteUrl: string;
      projectKey: string;
      autoImport?: boolean;
      pullEnabled?: boolean;
    },
  ) =>
    request<{ integration: IntegrationConnectionView }>(
      `/habitats/${habitatId}/integrations/jira/api-key`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  startLinearOAuth: (habitatId: string) =>
    request<{ authUrl: string; state: string; redirectPort: number }>(
      `/habitats/${habitatId}/integrations/linear/oauth/start`,
      { method: "POST" },
    ),
  completeLinearOAuth: (
    habitatId: string,
    data: { code: string; state: string; redirectPort: number },
  ) =>
    request<{
      integration: IntegrationConnectionView;
      teams: Array<{ id: string; name: string; key: string }>;
    }>(`/habitats/${habitatId}/integrations/linear/oauth/complete`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  createLinearApiKey: (
    habitatId: string,
    data: {
      name: string;
      token: string;
      teamId: string;
      autoImport?: boolean;
      pullEnabled?: boolean;
    },
  ) =>
    request<{ integration: IntegrationConnectionView }>(
      `/habitats/${habitatId}/integrations/linear/api-key`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  listIntakeCandidates: (
    habitatId: string,
    filters?: { reviewStatus?: string; provider?: string },
  ) => {
    const params = new URLSearchParams();
    if (filters?.reviewStatus) params.set("reviewStatus", filters.reviewStatus);
    if (filters?.provider) params.set("provider", filters.provider);
    const qs = params.toString();
    return request<{ candidates: ExternalIntakeCandidate[]; total: number }>(
      `/habitats/${habitatId}/intake-candidates${qs ? `?${qs}` : ""}`,
    );
  },
  getIntakeCandidate: (candidateId: string) =>
    request<{ candidate: ExternalIntakeCandidate }>(`/intake-candidates/${candidateId}`),
  promoteCandidate: (candidateId: string) =>
    request<{ mission: Mission; link: ExternalIssueLink; candidate: ExternalIntakeCandidate }>(
      `/intake-candidates/${candidateId}/promote`,
      { method: "POST" },
    ),
  ignoreCandidate: (candidateId: string) =>
    request<{ candidate: ExternalIntakeCandidate }>(`/intake-candidates/${candidateId}/ignore`, {
      method: "POST",
    }),
  markCandidateNeedsClarification: (candidateId: string) =>
    request<{ candidate: ExternalIntakeCandidate }>(
      `/intake-candidates/${candidateId}/needs-clarification`,
      { method: "POST" },
    ),
};
