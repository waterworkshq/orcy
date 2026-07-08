import { request } from "../transport.js";

export const workflowsApi = {
  getForMission: (missionId: string) =>
    request<{
      workflow: {
        id: string;
        missionId: string;
        habitatId: string;
        status: string;
        version: number;
        failureHandler: unknown;
        joinSpecs: Record<string, { mode: string; n?: number }> | null;
        createdAt: string;
      };
      gates: Array<{
        id: string;
        workflowId: string;
        upstreamTaskId: string;
        downstreamTaskId: string;
        gateType: string;
        satisfied: boolean;
        satisfiedAt: string | null;
        satisfiedByEventId: string | null;
        matchConfig: Record<string, unknown> | null;
        condition: unknown;
        recoveryTaskId: string | null;
        recoveryDepth: number | null;
      }>;
    }>(`/missions/${missionId}/workflow`),
  detach: (workflowId: string) =>
    request<{ detached: boolean }>(`/workflows/${workflowId}`, { method: "DELETE" }),
  unblockGate: (workflowId: string, gateId: string) =>
    request<{ satisfied: boolean }>(`/workflows/${workflowId}/gates/${gateId}/unblock`, {
      method: "POST",
    }),
};
