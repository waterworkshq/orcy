import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "./queryKeys.js";
import {
  invalidateHabitatRepresentations,
  invalidateMissionRepresentations,
  isVersionConflict,
  patchMissionInHabitatDetail,
  resetArchivedForHabitat,
} from "./habitatMutations.js";
import type {
  CreateMissionInput,
  CreateTaskInMissionInput,
  EnrichedHabitatEvent,
  Mission,
  MissionWithProgress,
} from "../types/index.js";

export const ARCHIVED_PAGE_SIZE = 50;
export const EVENTS_PAGE_SIZE = 50;

export function useHabitats() {
  return useQuery({
    queryKey: queryKeys.habitats.list(),
    queryFn: ({ signal }: { signal?: AbortSignal }) => api.habitats.list(signal),
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

export function useHabitat(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.detail(habitatId ?? ""),
    queryFn: ({ signal }: { signal?: AbortSignal }) => api.habitats.get(habitatId!, signal),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useHabitatAgents(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    enabled: !!habitatId,
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

export function useHabitatEvents(
  habitatId: string | undefined,
  params?: { limit?: number; offset?: number; action?: string },
) {
  return useQuery({
    queryKey: [...queryKeys.habitats.events(habitatId ?? ""), params] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.habitats.events(habitatId!, params, signal),
    enabled: !!habitatId,
    staleTime: 30 * 1000,
  });
}

export function useHabitatEventsInfinite(
  habitatId: string | undefined,
  filters?: { action?: string },
) {
  const action = filters?.action;
  return useInfiniteQuery({
    queryKey: queryKeys.habitats.eventsInfinite(habitatId ?? "", action, EVENTS_PAGE_SIZE),
    queryFn: ({ pageParam, signal }) =>
      api.habitats.events(
        habitatId!,
        {
          limit: EVENTS_PAGE_SIZE,
          offset: pageParam,
          ...(action ? { action } : {}),
        },
        signal,
      ),
    initialPageParam: 0,
    enabled: !!habitatId,
    staleTime: 30 * 1000,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.events.length === 0) return undefined;
      const rawAccumulated = allPages.reduce((sum, page) => sum + page.events.length, 0);
      return rawAccumulated < lastPage.total ? rawAccumulated : undefined;
    },
  });
}

export function useMissions(
  habitatId: string | undefined,
  filters?: {
    status?: string;
    priority?: string;
    limit?: number;
    offset?: number;
    isArchived?: boolean;
  },
) {
  return useQuery({
    queryKey: [...queryKeys.missions.list(habitatId ?? ""), filters ?? {}] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      api.missions.list(habitatId!, filters, signal),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useMission(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.detail(missionId ?? ""),
    queryFn: ({ signal }: { signal?: AbortSignal }) => api.missions.get(missionId!, signal),
    enabled: !!missionId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useMissionDetails(missionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.missions.details(missionId ?? ""),
    queryFn: ({ signal }: { signal?: AbortSignal }) => api.missions.details(missionId!, signal),
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
      // Create returns a Mission without derived progress, so it cannot be
      // inserted into the active collection safely. Membership changed, so
      // reset the archived view and invalidate every affected representation.
      resetArchivedForHabitat(qc, habitatId);
      invalidateHabitatRepresentations(qc, habitatId);
    },
  });
}

export function useUpdateMission(missionId: string, habitatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Mission> & { version?: number }) =>
      api.missions.update(missionId, data),
    onSuccess: ({ mission }) => {
      // Consume the canonical { mission } entity. Guarded-merge into the
      // Habitat-detail active collection (version not older, progress preserved).
      patchMissionInHabitatDetail(qc, habitatId, mission);
      invalidateMissionRepresentations(qc, missionId);
      invalidateHabitatRepresentations(qc, habitatId);
    },
    onError: (err) => {
      // A conflict means another actor's version is authoritative; force the
      // cache to reconcile without overwriting their change.
      if (isVersionConflict(err)) {
        invalidateMissionRepresentations(qc, missionId);
        invalidateHabitatRepresentations(qc, habitatId);
      }
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

export function useHabitatPredictions(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.predictions(habitatId ?? ""),
    queryFn: () => api.habitats.predictions(habitatId!),
    enabled: !!habitatId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useHabitatBurndown(habitatId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.burndown(habitatId ?? ""), days] as const,
    queryFn: () => api.habitats.burndown(habitatId!, days),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCumulativeFlow(habitatId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.cumulativeFlow(habitatId ?? ""), days] as const,
    queryFn: () => api.habitats.cumulativeFlow(habitatId!, days),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBottlenecks(habitatId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.habitats.bottlenecks(habitatId ?? ""), days] as const,
    queryFn: () => api.habitats.bottlenecks(habitatId!, days),
    enabled: !!habitatId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useAgentQuality(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.agentQuality(habitatId ?? ""),
    queryFn: () => api.habitats.agentQuality(habitatId!),
    enabled: !!habitatId,
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

export function useHabitatAnomalies(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.anomalies(habitatId ?? ""),
    queryFn: () => api.habitats.anomalies(habitatId!),
    enabled: !!habitatId,
    staleTime: 60 * 1000,
  });
}

export function useHabitatCapacity(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.capacity(habitatId ?? ""),
    queryFn: () => api.habitats.capacity(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export interface HabitatTasksFilters {
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

export function useHabitatTasks(habitatId: string | undefined, filters?: HabitatTasksFilters) {
  return useQuery({
    queryKey: queryKeys.habitats.tasks(habitatId ?? "", filters),
    queryFn: () => api.habitats.tasks(habitatId!, filters),
    enabled: !!habitatId,
    staleTime: 30 * 1000,
  });
}

export function useHabitatTimeMetrics(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.habitats.metrics(habitatId ?? ""),
    queryFn: () => api.timeTracking.getHabitatMetrics(habitatId!),
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

export function useAgentsListWithTasks(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.listWithTasks(),
    queryFn: () => api.agents.listWithTasks(),
    enabled: !!habitatId,
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

export function useSavedFilters(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.savedFilters.list(habitatId ?? ""),
    queryFn: () => api.savedFilters.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useHabitatHealth(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.health.current(habitatId ?? ""),
    queryFn: () => api.health.get(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAuditSummary(
  habitatId: string | undefined,
  params?: { since?: string; until?: string },
) {
  return useQuery({
    queryKey: [...queryKeys.audit.summary(habitatId ?? ""), params] as const,
    queryFn: () => api.audit.summary(habitatId!, params),
    enabled: !!habitatId,
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

export function useInvalidateHabitat(habitatId: string) {
  const qc = useQueryClient();
  return () => {
    invalidateHabitatRepresentations(qc, habitatId);
    resetArchivedForHabitat(qc, habitatId);
  };
}

export function useInvalidateHabitats() {
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
    invalidateMissionRepresentations(qc, missionId);
  };
}

export function useTemplates(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.templates.list(habitatId ?? ""),
    queryFn: () => api.templates.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useChatIntegrations(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.chatIntegrations.list(habitatId ?? ""),
    queryFn: () => api.chatIntegrations.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useNotificationPrefs(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.notificationPrefs.habitat(habitatId ?? ""),
    queryFn: async () => {
      const [global, board] = await Promise.all([
        api.notifications.getGlobalPrefs(),
        api.notifications.getHabitatPrefs(habitatId!),
      ]);
      return { global, board };
    },
    enabled: !!habitatId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useScheduledTasks(habitatId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.scheduledTasks.list(habitatId ?? ""),
    queryFn: () => api.scheduledTasks.list(habitatId!),
    enabled: !!habitatId,
    staleTime: 30 * 1000,
  });
}

export function useArchivedMissionsInfinite(habitatId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: queryKeys.missions.archived(habitatId ?? "", ARCHIVED_PAGE_SIZE),
    queryFn: ({ pageParam, signal }) =>
      api.missions.list(
        habitatId!,
        { isArchived: true, limit: ARCHIVED_PAGE_SIZE, offset: pageParam },
        signal,
      ),
    initialPageParam: 0,
    enabled: !!habitatId,
    staleTime: 2 * 60 * 1000,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.missions.length === 0) return undefined;
      const rawAccumulated = allPages.reduce((sum, page) => sum + page.missions.length, 0);
      return rawAccumulated < lastPage.total ? rawAccumulated : undefined;
    },
  });

  return query;
}

export function useResetArchivedMissions(habitatId: string) {
  const qc = useQueryClient();
  return () => {
    resetArchivedForHabitat(qc, habitatId);
  };
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
