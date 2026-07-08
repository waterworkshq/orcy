import { request } from "../transport.js";
import type {
  CodeEvidenceCompletenessInfo,
  CodeEvidenceGapItem,
  CodeEvidenceLinkItem,
} from "../../types/index.js";

export const codeEvidenceApi = {
  getTaskEvidence: (taskId: string, includeHistory?: boolean) => {
    const qs = includeHistory ? "?includeHistory=true" : "";
    return request<import("../../types/index.js").CodeEvidenceResponse>(
      `/tasks/${taskId}/code-evidence${qs}`,
    );
  },
  linkTaskCode: (taskId: string, input: import("../../types/index.js").CodeEvidenceLinkInput) =>
    request<import("../../types/index.js").CodeEvidenceBulkResult>(
      `/tasks/${taskId}/code-evidence`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  correctTaskLink: (
    taskId: string,
    linkId: string,
    input: import("../../types/index.js").CodeEvidenceCorrectionInput,
  ) =>
    request<{ link: CodeEvidenceLinkItem }>(`/tasks/${taskId}/code-evidence/${linkId}/correct`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  markTaskNotApplicable: (
    taskId: string,
    input: import("../../types/index.js").CodeEvidenceNotApplicableInput,
  ) =>
    request<{ completeness: CodeEvidenceCompletenessInfo }>(
      `/tasks/${taskId}/code-evidence/not-applicable`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  clearTaskNotApplicable: (taskId: string) =>
    request<{ success: boolean }>(`/tasks/${taskId}/code-evidence/not-applicable`, {
      method: "DELETE",
    }),
  reportTaskGap: (taskId: string, input: import("../../types/index.js").CodeEvidenceGapInput) =>
    request<{ gap: CodeEvidenceGapItem }>(`/tasks/${taskId}/code-evidence/gaps`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  resolveTaskGap: (
    taskId: string,
    gapId: string,
    input: import("../../types/index.js").CodeEvidenceGapResolveInput,
  ) =>
    request<{ gap: CodeEvidenceGapItem }>(`/tasks/${taskId}/code-evidence/gaps/${gapId}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getMissionEvidence: (missionId: string, includeHistory?: boolean) => {
    const qs = includeHistory ? "?includeHistory=true" : "";
    return request<import("../../types/index.js").MissionCodeEvidenceResponse>(
      `/missions/${missionId}/code-evidence${qs}`,
    );
  },
  linkMissionCode: (
    missionId: string,
    input: import("../../types/index.js").CodeEvidenceLinkInput,
  ) =>
    request<import("../../types/index.js").CodeEvidenceBulkResult>(
      `/missions/${missionId}/code-evidence`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  correctMissionLink: (
    missionId: string,
    linkId: string,
    input: import("../../types/index.js").CodeEvidenceCorrectionInput,
  ) =>
    request<{ link: CodeEvidenceLinkItem }>(
      `/missions/${missionId}/code-evidence/${linkId}/correct`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  markMissionNotApplicable: (
    missionId: string,
    input: import("../../types/index.js").CodeEvidenceNotApplicableInput,
  ) =>
    request<{ completeness: CodeEvidenceCompletenessInfo }>(
      `/missions/${missionId}/code-evidence/not-applicable`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  clearMissionNotApplicable: (missionId: string) =>
    request<{ success: boolean }>(`/missions/${missionId}/code-evidence/not-applicable`, {
      method: "DELETE",
    }),
  reportMissionGap: (
    missionId: string,
    input: import("../../types/index.js").CodeEvidenceGapInput,
  ) =>
    request<{ gap: CodeEvidenceGapItem }>(`/missions/${missionId}/code-evidence/gaps`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getRepository: (habitatId: string) =>
    request<{ repository: import("../../types/index.js").RepositoryIdentity | null }>(
      `/habitats/${habitatId}/repository`,
    ),
  updateRepository: (
    habitatId: string,
    input: import("../../types/index.js").RepositoryIdentityInput,
  ) =>
    request<{ repository: import("../../types/index.js").RepositoryIdentity }>(
      `/habitats/${habitatId}/repository`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  inferFromWorktree: (habitatId: string, worktreePath?: string) =>
    request<{ repository: import("../../types/index.js").RepositoryIdentity }>(
      `/habitats/${habitatId}/repository/infer-from-worktree`,
      { method: "POST", body: JSON.stringify({ worktreePath }) },
    ),
  inferFromIntegration: (habitatId: string, integrationId?: string) =>
    request<{ repository: import("../../types/index.js").RepositoryIdentity }>(
      `/habitats/${habitatId}/repository/infer-from-integration`,
      { method: "POST", body: JSON.stringify({ integrationId }) },
    ),
};
