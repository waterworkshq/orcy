import type { KanbanApiClient } from "../api.js";
import type { Sprint } from "@orcy/shared";

export async function listSprints(
  client: KanbanApiClient,
  args: { boardId: string },
): Promise<{ sprints: Sprint[] }> {
  return client.listSprints(args.boardId);
}

export async function getActiveSprint(
  client: KanbanApiClient,
  args: { boardId: string },
): Promise<{ sprint: Sprint | null }> {
  return client.getActiveSprint(args.boardId);
}

export async function getSprint(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<{ sprint: Sprint }> {
  return client.getSprint(args.sprintId);
}

export async function getSprintMetrics(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<Record<string, unknown>> {
  return client.getSprintMetrics(args.sprintId);
}

export async function getSprintBurndown(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<Record<string, unknown>> {
  const burndown = await client.getSprintBurndown(args.sprintId);
  return {
    sprintId: args.sprintId,
    totalTasks: burndown.totalTasks,
    completedTasks: burndown.completedTasks,
    remainingTasks: burndown.remainingTasks,
    averageDailyVelocity: burndown.averageDailyVelocity,
    estimatedCompletionDate: burndown.estimatedCompletionDate,
  };
}

export async function getSprintCarryOver(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<Record<string, unknown>> {
  return client.getSprintCarryOver(args.sprintId);
}

export async function createSprint(
  client: KanbanApiClient,
  args: {
    boardId: string;
    name: string;
    goal?: string;
    startDate: string;
    endDate: string;
    capacityMinutes?: number | null;
    notes?: string;
  },
): Promise<{ sprint: Sprint }> {
  return client.createSprint(args.boardId, {
    name: args.name,
    goal: args.goal,
    startDate: args.startDate,
    endDate: args.endDate,
    capacityMinutes: args.capacityMinutes,
    notes: args.notes,
  });
}

export async function updateSprint(
  client: KanbanApiClient,
  args: {
    sprintId: string;
    name?: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
    capacityMinutes?: number | null;
    notes?: string;
  },
): Promise<{ sprint: Sprint }> {
  return client.updateSprint(args.sprintId, {
    name: args.name,
    goal: args.goal,
    startDate: args.startDate,
    endDate: args.endDate,
    capacityMinutes: args.capacityMinutes,
    notes: args.notes,
  });
}

export async function deleteSprint(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<Record<string, unknown>> {
  await client.deleteSprint(args.sprintId);
  return { success: true, sprintId: args.sprintId, message: `Sprint ${args.sprintId} deleted` };
}

export async function startSprint(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<{ sprint: Sprint }> {
  return client.startSprint(args.sprintId);
}

export async function completeSprint(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<{ sprint: Sprint }> {
  return client.completeSprint(args.sprintId);
}

export async function cancelSprint(
  client: KanbanApiClient,
  args: { sprintId: string },
): Promise<{ sprint: Sprint }> {
  return client.cancelSprint(args.sprintId);
}

export async function addMissionToSprint(
  client: KanbanApiClient,
  args: { sprintId: string; missionId: string },
): Promise<{ sprint: Sprint }> {
  return client.addMissionToSprint(args.sprintId, args.missionId);
}

export async function removeMissionFromSprint(
  client: KanbanApiClient,
  args: { sprintId: string; missionId: string },
): Promise<{ sprint: Sprint }> {
  return client.removeMissionFromSprint(args.sprintId, args.missionId);
}
