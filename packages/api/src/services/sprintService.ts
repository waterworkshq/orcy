import { getDb } from '../db/index.js';
import { sprints, missions } from '../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import * as sprintRepo from '../repositories/sprint.js';
import * as missionRepo from '../repositories/feature.js';
import * as habitatRepo from '../repositories/board.js';
import type { Sprint, SprintCreateInput, SprintUpdateInput, CarryOverPolicy } from '@orcy/shared';
import { logger } from '../lib/logger.js';
import { sseBroadcaster } from '../sse/broadcaster.js';

export function getSprint(sprintId: string): Sprint | null {
  return sprintRepo.getById(sprintId);
}

export function getSprintsForHabitat(habitatId: string): Sprint[] {
  return sprintRepo.getByHabitatId(habitatId);
}

export function getActiveSprint(habitatId: string): Sprint | null {
  return sprintRepo.getActiveForHabitat(habitatId);
}

export function createSprint(habitatId: string, input: SprintCreateInput, createdBy: string): Sprint {
  const existing = sprintRepo.getActiveForHabitat(habitatId);
  if (existing) {
    throw new Error('HABITAT_ALREADY_HAS_ACTIVE_SPRINT');
  }

  const sprint = sprintRepo.create(habitatId, {
    name: input.name,
    goal: input.goal,
    startDate: input.startDate,
    endDate: input.endDate,
    capacityMinutes: input.capacityMinutes,
    notes: input.notes,
    createdBy,
  });

  sseBroadcaster.publish(habitatId, {
    type: 'sprint.created',
    data: { sprintId: sprint.id, habitatId },
  });

  logger.info({ sprintId: sprint.id, habitatId, name: input.name }, 'Sprint created');
  return sprint;
}

export function updateSprint(sprintId: string, input: SprintUpdateInput): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error('SPRINT_NOT_FOUND');

  if (existing.status !== 'planning' && (input.startDate || input.endDate || input.name)) {
    throw new Error('CANNOT_MODIFY_ACTIVE_OR_COMPLETED_SPRINT');
  }

  const updated = sprintRepo.update(sprintId, input);
  if (!updated) throw new Error('SPRINT_UPDATE_FAILED');
  return updated;
}

export function deleteSprint(sprintId: string): void {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error('SPRINT_NOT_FOUND');

  if (existing.status === 'active') {
    throw new Error('CANNOT_DELETE_ACTIVE_SPRINT');
  }

  for (const missionId of existing.committedMissionIds) {
    const db = getDb();
    db.update(missions).set({ sprintId: null }).where(eq(missions.id, missionId)).run();
  }

  sprintRepo.remove(sprintId);
  logger.info({ sprintId }, 'Sprint deleted');
}

export function startSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error('SPRINT_NOT_FOUND');
  if (existing.status !== 'planning') throw new Error('SPRINT_NOT_IN_PLANNING');

  const updated = sprintRepo.update(sprintId, { status: 'active' });
  if (!updated) throw new Error('SPRINT_START_FAILED');

  sseBroadcaster.publish(updated.habitatId, {
    type: 'sprint.started',
    data: { sprintId: updated.id, habitatId: updated.habitatId },
  });

  logger.info({ sprintId, habitatId: updated.habitatId }, 'Sprint started');
  return updated;
}

export function completeSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error('SPRINT_NOT_FOUND');
  if (existing.status !== 'active') throw new Error('SPRINT_NOT_ACTIVE');

  const db = getDb();
  const completedMissionIds: string[] = [];
  const carriedOverMissionIds: string[] = [];

  for (const missionId of existing.committedMissionIds) {
    const mission = missionRepo.getMissionById(missionId);
    if (!mission) continue;

    if (mission.status === 'done') {
      completedMissionIds.push(missionId);
    } else {
      carriedOverMissionIds.push(missionId);
    }
  }

  const habitat = habitatRepo.getHabitatById(existing.habitatId);
  const carryOverPolicy: CarryOverPolicy = (habitat as any)?.carryOverPolicy ?? 'backlog';

  handleCarryOver(db, sprintId, existing.habitatId, carriedOverMissionIds, carryOverPolicy);

  sprintRepo.markMissionsCompleted(sprintId, completedMissionIds);

  const updated = sprintRepo.update(sprintId, { status: 'completed' });
  if (!updated) throw new Error('SPRINT_COMPLETE_FAILED');

  sseBroadcaster.publish(updated.habitatId, {
    type: 'sprint.completed',
    data: {
      sprintId: updated.id,
      habitatId: updated.habitatId,
      completedMissions: completedMissionIds.length,
      carriedOver: carriedOverMissionIds.length,
    },
  });

  logger.info({
    sprintId,
    completed: completedMissionIds.length,
    carriedOver: carriedOverMissionIds.length,
    policy: carryOverPolicy,
  }, 'Sprint completed');
  return updated;
}

function handleCarryOver(
  db: any,
  sprintId: string,
  habitatId: string,
  incompleteMissionIds: string[],
  policy: CarryOverPolicy
): void {
  if (incompleteMissionIds.length === 0) return;

  switch (policy) {
    case 'backlog': {
      for (const missionId of incompleteMissionIds) {
        db.update(missions).set({ sprintId: null }).where(eq(missions.id, missionId)).run();
      }
      const sprint = sprintRepo.getById(sprintId);
      if (sprint) {
        const remaining = sprint.committedMissionIds.filter(id => !incompleteMissionIds.includes(id));
        db.update(sprints).set({ committedMissionIds: remaining }).where(eq(sprints.id, sprintId)).run();
      }
      break;
    }
    case 'next_sprint': {
      const nextSprint = findNextPlanningSprint(habitatId, sprintId);
      if (nextSprint) {
        for (const missionId of incompleteMissionIds) {
          sprintRepo.addMission(nextSprint.id, missionId);
        }
      } else {
        for (const missionId of incompleteMissionIds) {
          db.update(missions).set({ sprintId: null }).where(eq(missions.id, missionId)).run();
        }
      }
      break;
    }
    case 'none':
    default:
      break;
  }
}

function findNextPlanningSprint(habitatId: string, excludeSprintId: string): Sprint | null {
  const sprints = sprintRepo.getByHabitatId(habitatId);
  const planning = sprints.find(s => s.status === 'planning' && s.id !== excludeSprintId);
  return planning ?? null;
}

export function cancelSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error('SPRINT_NOT_FOUND');
  if (existing.status !== 'planning' && existing.status !== 'active') {
    throw new Error('SPRINT_CANNOT_BE_CANCELLED');
  }

  const db = getDb();
  for (const missionId of existing.committedMissionIds) {
    db.update(missions).set({ sprintId: null }).where(eq(missions.id, missionId)).run();
  }

  const updated = sprintRepo.update(sprintId, { status: 'cancelled' });
  if (!updated) throw new Error('SPRINT_CANCEL_FAILED');

  logger.info({ sprintId, habitatId: updated.habitatId }, 'Sprint cancelled');
  return updated;
}

export function addMissionToSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw new Error('SPRINT_NOT_FOUND');
  if (sprint.status !== 'planning') throw new Error('CAN_ONLY_ADD_TO_PLANNING_SPRINT');

  const mission = missionRepo.getMissionById(missionId);
  if (!mission) throw new Error('MISSION_NOT_FOUND');
  if (mission.habitatId !== sprint.habitatId) throw new Error('MISSION_NOT_IN_SAME_HABITAT');

  const updated = sprintRepo.addMission(sprintId, missionId);
  if (!updated) throw new Error('ADD_MISSION_FAILED');
  return updated;
}

export function removeMissionFromSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw new Error('SPRINT_NOT_FOUND');
  if (sprint.status !== 'planning') throw new Error('CAN_ONLY_REMOVE_FROM_PLANNING_SPRINT');

  const updated = sprintRepo.removeMission(sprintId, missionId);
  if (!updated) throw new Error('REMOVE_MISSION_FAILED');
  return updated;
}
