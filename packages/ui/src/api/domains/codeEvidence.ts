import { request } from "../transport.js";
import type {
  CodeEvidenceCompletenessInfo,
  CodeEvidenceGapItem,
  CodeEvidenceLinkItem,
} from "../../types/index.js";

/**
 * The ONE evidence-only persisted-ID adapter. Task evidence inputs that
 * originate from a fetched Task row (`TaskDetailPanel` → `TaskCodeEvidence`
 * → this panel's API calls) are PERSISTED row ids, not admitted URL
 * spellings. Sending `feat-${persistedId}` lets the server's one-strip
 * resolver select exactly that row for every spelling — plain `X` and
 * literal `feat-X` alike (`feat-feat-X` strips once to `feat-X`). Without
 * this, a detail view of a literal `feat-X` Task would address Task `X`.
 *
 * Deliberately NOT applied to Mission ids (no strip grammar) or to generic
 * Task consumers outside the evidence surface.
 */
function persistedTaskEvidenceId(persistedTaskId: string): string {
  return `feat-${persistedTaskId}`;
}

export const codeEvidenceApi = {
  getTaskEvidence: (taskId: string, includeHistory?: boolean) => {
    const qs = includeHistory ? "?includeHistory=true" : "";
    return request<import("../../types/index.js").CodeEvidenceResponse>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence${qs}`,
    );
  },
  linkTaskCode: (taskId: string, input: import("../../types/index.js").CodeEvidenceLinkInput) =>
    request<import("../../types/index.js").CodeEvidenceBulkResult>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  correctTaskLink: (
    taskId: string,
    linkId: string,
    input: import("../../types/index.js").CodeEvidenceCorrectionInput,
  ) =>
    request<{ link: CodeEvidenceLinkItem }>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence/${linkId}/correct`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  markTaskNotApplicable: (
    taskId: string,
    input: import("../../types/index.js").CodeEvidenceNotApplicableInput,
  ) =>
    request<{ completeness: CodeEvidenceCompletenessInfo }>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence/not-applicable`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  clearTaskNotApplicable: (taskId: string) =>
    request<{ success: boolean }>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence/not-applicable`,
      {
        method: "DELETE",
      },
    ),
  reportTaskGap: (taskId: string, input: import("../../types/index.js").CodeEvidenceGapInput) =>
    request<{ gap: CodeEvidenceGapItem }>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence/gaps`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  resolveTaskGap: (
    taskId: string,
    gapId: string,
    input: import("../../types/index.js").CodeEvidenceGapResolveInput,
  ) =>
    request<{ gap: CodeEvidenceGapItem }>(
      `/tasks/${persistedTaskEvidenceId(taskId)}/code-evidence/gaps/${gapId}/resolve`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),

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
