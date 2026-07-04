import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "./queryKeys.js";
import type { CreateMissionInput, CreateTaskInMissionInput, Mission } from "../types/index.js";

export function useBoards() {
  return useQuery({
    queryKey: queryKeys.habitats.list(),
    queryFn: () => api.habitats.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useMyTeams() {
  return useQuery({
    queryKey: queryKeys.teams.myTeams(),
    queryFn: () => api.myTeams(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.detail(boardId ?? ""),
    queryFn: () => api.habitats.get(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardAgents(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useHabitatStats(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.stats(habitatId ?? ""),
    queryFn: () => api.habitats.stats(habitatId!),
    enabled: !!habitatId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardEvents(
  boardId: string | undefined,
  params?: { limit?: number; offset?: number; action?: string },
) {
  return useQuery({
    queryKey: [...queryKeys.habitats.events(boardId ?? ""), params] as const,
    queryFn: () => api.habitats.events(boardId!, params),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useMissions(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.list(habitatId ?? ""),
    queryFn: () => api.missions.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useMission(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.detail(missionId ?? ""),
    queryFn: () => api.missions.get(missionId!),
    enabled: !!missionId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useMissionDetails(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.details(missionId ?? ""),
    queryFn: () => api.missions.details(missionId!),
    enabled: !!missionId,
    staleTime: 30 * 1000,
  });
}

export function useMissionTasks(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.tasks(missionId ?? ""),
    queryFn: () => api.missions.tasks(missionId!),
    enabled: !!missionId,
    staleTime: 30 * 1000,
  });
}

export function useMissionProgress(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.progress(missionId ?? ""),
    queryFn: () => api.missions.progress(missionId!),
    enabled: !!missionId,
    staleTime: 30 * 1000,
  });
}

export function useCreateMission(habitatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMissionInput) => api.missions.create(habitatId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.missions.list(habitatId) });
      qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(habitatId) });
    },
  });
}

export function useUpdateMission(missionId: string, habitatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Mission> & { version?: number }) =>
      api.missions.update(missionId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
      qc.invalidateQueries({ queryKey: queryKeys.missions.list(habitatId) });
    },
  });
}

export function useCreateTaskInMission(missionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskInMissionInput) => api.missions.createTask(missionId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(missionId) });
      qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
      qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgent(agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.detail(agentId ?? ""),
    queryFn: () => api.agents.get(agentId!),
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDashboardStats() {
  return useQuery({
    queryKey: queryKeys.dashboard.stats(),
    queryFn: () => api.dashboard.get(),
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardPredictions(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.predictions(boardId ?? ""),
    queryFn: () => api.habitats.predictions(boardId!),
    enabled: !!boardId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardBurndown(boardId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.burndown(boardId ?? ""), days] as const,
    queryFn: () => api.habitats.burndown(boardId!, days),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCumulativeFlow(boardId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.cumulativeFlow(boardId ?? ""), days] as const,
    queryFn: () => api.habitats.cumulativeFlow(boardId!, days),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBottlenecks(boardId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.bottlenecks(boardId ?? ""), days] as const,
    queryFn: () => api.habitats.bottlenecks(boardId!, days),
    enabled: !!boardId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useAgentQuality(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.agentQuality(boardId ?? ""),
    queryFn: () => api.habitats.agentQuality(boardId!),
    enabled: !!boardId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useSprintMetrics(sprintId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sprints.metrics(sprintId ?? ""),
    queryFn: () => api.sprints.metrics(sprintId!),
    enabled: !!sprintId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useSprintBurndown(sprintId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sprints.burndown(sprintId ?? ""),
    queryFn: () => api.sprints.burndown(sprintId!),
    enabled: !!sprintId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSprintCarryOver(sprintId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sprints.carryOver(sprintId ?? ""),
    queryFn: () => api.sprints.carryOver(sprintId!),
    enabled: !!sprintId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardAnomalies(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.anomalies(boardId ?? ""),
    queryFn: () => api.habitats.anomalies(boardId!),
    enabled: !!boardId,
    staleTime: 60 * 1000,
  });
}

export function useBoardCapacity(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.capacity(boardId ?? ""),
    queryFn: () => api.habitats.capacity(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface BoardTasksFilters {
  status?: string;
  priority?: string;
  search?: string;
  assignedAgentId?: string;
  isArchived?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export function useBoardTasks(boardId: string | undefined, filters?: BoardTasksFilters) {
  return useQuery({
    queryKey: queryKeys.habitats.tasks(boardId ?? "", filters),
    queryFn: () => api.habitats.tasks(boardId!, filters),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useHabitatTimeMetrics(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.metrics(habitatId ?? ""),
    queryFn: () => api.timeTracking.getBoardMetrics(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgentStats(agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.stats(agentId ?? ""),
    queryFn: () => api.agents.stats(agentId!),
    enabled: !!agentId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useAgentsListWithTasks(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.listWithTasks(),
    queryFn: () => api.agents.listWithTasks(),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.organizations.list(),
    queryFn: () => api.organizations.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useOrganizationTeams(orgId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.organizations.teams(orgId ?? ""),
    queryFn: () => api.organizations.listTeams(orgId!),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useTeamMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.organizations.members(teamId ?? ""),
    queryFn: () => api.teams.listMembers(teamId!),
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUserProfile() {
  return useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSavedFilters(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.savedFilters.list(boardId ?? ""),
    queryFn: () => api.savedFilters.list(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardHealth(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.health.current(boardId ?? ""),
    queryFn: () => api.health.get(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAuditSummary(
  boardId: string | undefined,
  params?: { since?: string; until?: string },
) {
  return useQuery({
    queryKey: [...queryKeys.audit.summary(boardId ?? ""), params] as const,
    queryFn: () => api.audit.summary(boardId!, params),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useMissionComments(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missionComments.list(missionId ?? ""),
    queryFn: () => api.missionComments.list(missionId!),
    enabled: !!missionId,
    staleTime: 30 * 1000,
  });
}

export function useInvalidateBoard(boardId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.habitats.stats(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.habitats.events(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.list(boardId) });
  };
}

export function useInvalidateBoards() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.habitats.list() });
  };
}

export function useInvalidateAgents() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.agents.list() });
  };
}

export function useInvalidateMission(missionId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.details(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.tasks(missionId) });
    qc.invalidateQueries({ queryKey: queryKeys.missions.progress(missionId) });
  };
}

export function useTemplates(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.templates.list(boardId ?? ""),
    queryFn: () => api.templates.list(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useChatIntegrations(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.chatIntegrations.list(boardId ?? ""),
    queryFn: () => api.chatIntegrations.list(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useNotificationPrefs(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.notificationPrefs.board(boardId ?? ""),
    queryFn: async () => {
      const [global, board] = await Promise.all([
        api.notifications.getGlobalPrefs(),
        api.notifications.getBoardPrefs(boardId!),
      ]);
      return { global, board };
    },
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useScheduledTasks(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.list(boardId ?? ""),
    queryFn: () => api.scheduledTasks.list(boardId!),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useArchivedMissions(habitatId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.missions.all, "archived", habitatId ?? ""] as const,
    queryFn: () => api.missions.list(habitatId!, { isArchived: true }),
    enabled: !!habitatId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useIntegrations(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.integrations.list(habitatId ?? ""),
    queryFn: () => api.integrations.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useIntegrationSyncRuns(connectionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.integrations.syncRuns(connectionId ?? ""),
    queryFn: () => api.integrations.listSyncRuns(connectionId!),
    enabled: !!connectionId,
    staleTime: 30 * 1000,
  });
}

export function useMissionExternalLinks(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.integrations.missionLinks(missionId ?? ""),
    queryFn: () => api.integrations.listMissionLinks(missionId!),
    enabled: !!missionId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useIntakeCandidates(
  habitatId: string | undefined,
  filters?: { reviewStatus?: string; provider?: string },
) {
  const filterRecord: Record<string, string> = {};
  if (filters?.reviewStatus) filterRecord.reviewStatus = filters.reviewStatus;
  if (filters?.provider) filterRecord.provider = filters.provider;

  return useQuery({
    queryKey: queryKeys.integrations.intakeCandidates(habitatId ?? "", filterRecord),
    queryFn: () => api.integrations.listIntakeCandidates(habitatId!, filters),
    enabled: !!habitatId,
    staleTime: 30 * 1000,
  });
}

export function useDaemons() {
  return useQuery({
    queryKey: queryKeys.daemons.list(),
    queryFn: () => api.daemons.list(),
    staleTime: 30 * 1000,
  });
}

export function useDaemon(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.daemons.detail(id ?? ""),
    queryFn: () => api.daemons.get(id!),
    enabled: !!id,
    staleTime: 30 * 1000,
  });
}

// ---------------------------------------------------------------------------
// Phase E — Remote Access hooks
// ---------------------------------------------------------------------------

export function useRemoteAccessManagement(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.remoteAccess.management(habitatId ?? ""),
    queryFn: () => api.remoteAccess.getManagement(habitatId!),
    enabled: !!habitatId,
    staleTime: 30 * 1000,
  });
}

export function useRemoteAccessReadiness(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.remoteAccess.readiness(habitatId ?? ""),
    queryFn: () => api.remoteAccess.getReadiness(habitatId!),
    enabled: !!habitatId,
    staleTime: 60 * 1000,
  });
}

export function useInvalidateRemoteAccess() {
  const qc = useQueryClient();
  return (habitatId: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.remoteAccess.management(habitatId) });
    qc.invalidateQueries({ queryKey: queryKeys.remoteAccess.pods(habitatId) });
    qc.invalidateQueries({ queryKey: queryKeys.remoteAccess.grants(habitatId) });
  };
}

export function useCreateGrant(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.remoteAccess.createGrant(habitatId, body),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useRevokeGrant(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({ grantId, mode, reason }: { grantId: string; mode: string; reason?: string }) =>
      api.remoteAccess.revokeGrant(habitatId, grantId, { mode, reason }),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useCreateCredential(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({
      participantId,
      body,
    }: {
      participantId: string;
      body: Record<string, unknown>;
    }) => api.remoteAccess.createCredential(habitatId, participantId, body),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useRevokeCredential(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({ credentialId, reason }: { credentialId: string; reason?: string }) =>
      api.remoteAccess.revokeCredential(habitatId, credentialId, reason ? { reason } : undefined),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useRotateCredential(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({ credentialId, clients }: { credentialId: string; clients?: string[] }) =>
      api.remoteAccess.rotateCredential(habitatId, credentialId, clients ? { clients } : undefined),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useUpdateParticipant(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({
      participantId,
      body,
    }: {
      participantId: string;
      body: Record<string, unknown>;
    }) => api.remoteAccess.updateParticipant(habitatId, participantId, body),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useUpdatePod(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({ podId, body }: { podId: string; body: Record<string, unknown> }) =>
      api.remoteAccess.updatePod(habitatId, podId, body),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useCreateInvite(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.remoteAccess.createInvite(habitatId, body),
    onSuccess: () => invalidate(habitatId),
  });
}

export function useRevokeInvite(habitatId: string) {
  const invalidate = useInvalidateRemoteAccess();
  return useMutation({
    mutationFn: ({ inviteId, revokeReason }: { inviteId: string; revokeReason?: string }) =>
      api.remoteAccess.revokeInvite(
        habitatId,
        inviteId,
        revokeReason ? { revokeReason } : undefined,
      ),
    onSuccess: () => invalidate(habitatId),
  });
}
