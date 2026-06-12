import { logger } from "../lib/logger.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatRepo from "../repositories/board.js";
import type { Sprint, SprintCreateInput, SprintUpdateInput, CarryOverPolicy } from "@orcy/shared";

export function getSprint(sprintId: string): Sprint | null {
  return sprintRepo.getById(sprintId);
}

export function getSprintsForHabitat(habitatId: string): Sprint[] {
  return sprintRepo.getByHabitatId(habitatId);
}

export function getActiveSprint(habitatId: string): Sprint | null {
  return sprintRepo.getActiveForHabitat(habitatId);
}

export function createSprint(
  habitatId: string,
  input: SprintCreateInput,
  createdBy: string,
): Sprint {
  const existing = sprintRepo.getActiveForHabitat(habitatId);
  if (existing) {
    throw new Error("HABITAT_ALREADY_HAS_ACTIVE_SPRINT");
  }

  if (new Date(input.endDate) <= new Date(input.startDate)) {
    throw new Error("END_DATE_MUST_BE_AFTER_START_DATE");
  }

  const overlapping = sprintRepo.getOverlappingForHabitat(
    habitatId,
    input.startDate,
    input.endDate,
  );
  if (overlapping) {
    throw new Error("SPRINT_DATES_OVERLAP");
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
    type: "sprint.created",
    data: { sprintId: sprint.id, habitatId },
  });

  logger.info({ sprintId: sprint.id, habitatId, name: input.name }, "Sprint created");
  return sprint;
}

export function updateSprint(sprintId: string, input: SprintUpdateInput): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error("SPRINT_NOT_FOUND");

  if (existing.status !== "planning" && (input.startDate || input.endDate || input.name)) {
    throw new Error("CANNOT_MODIFY_ACTIVE_OR_COMPLETED_SPRINT");
  }

  const updated = sprintRepo.update(sprintId, input);
  if (!updated) throw new Error("SPRINT_UPDATE_FAILED");
  return updated;
}

export function deleteSprint(sprintId: string): void {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error("SPRINT_NOT_FOUND");

  if (existing.status === "active") {
    throw new Error("CANNOT_DELETE_ACTIVE_SPRINT");
  }

  sprintRepo.deleteSprintAndDetachMissions(sprintId, existing.committedMissionIds);

  logger.info({ sprintId }, "Sprint deleted");
}

export function startSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error("SPRINT_NOT_FOUND");
  if (existing.status !== "planning") throw new Error("SPRINT_NOT_IN_PLANNING");

  const updated = sprintRepo.update(sprintId, { status: "active" });
  if (!updated) throw new Error("SPRINT_START_FAILED");

  sseBroadcaster.publish(updated.habitatId, {
    type: "sprint.started",
    data: { sprintId: updated.id, habitatId: updated.habitatId },
  });

  logger.info({ sprintId, habitatId: updated.habitatId }, "Sprint started");
  return updated;
}

export function completeSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error("SPRINT_NOT_FOUND");
  if (existing.status !== "active") throw new Error("SPRINT_NOT_ACTIVE");

  const completedMissionIds: string[] = [];
  const carriedOverMissionIds: string[] = [];

  for (const missionId of existing.committedMissionIds) {
    const mission = missionRepo.getMissionById(missionId);
    if (!mission) continue;

    if (mission.status === "done") {
      completedMissionIds.push(missionId);
    } else {
      carriedOverMissionIds.push(missionId);
    }
  }

  const habitat = habitatRepo.getHabitatById(existing.habitatId);
  // Habitat DB row includes carryOverPolicy but the Habitat type doesn't expose it yet
  const carryOverPolicy: CarryOverPolicy =
    ((habitat as { carryOverPolicy?: string })?.carryOverPolicy as CarryOverPolicy) ?? "backlog";

  const now = new Date().toISOString();
  const nextSprint =
    carryOverPolicy === "next_sprint" ? findNextPlanningSprint(existing.habitatId, sprintId) : null;

  sprintRepo.completeSprintTransaction({
    sprintId,
    completedMissionIds,
    carryOver: {
      policy: carryOverPolicy,
      habitatId: existing.habitatId,
      currentSprintId: sprintId,
      nextSprintId: nextSprint?.id ?? null,
      incompleteMissionIds: carriedOverMissionIds,
    },
    now,
  });

  const updated = sprintRepo.getById(sprintId);
  if (!updated) throw new Error("SPRINT_COMPLETE_FAILED");

  sseBroadcaster.publish(updated.habitatId, {
    type: "sprint.completed",
    data: {
      sprintId: updated.id,
      habitatId: updated.habitatId,
      completedMissions: completedMissionIds.length,
      carriedOver: carriedOverMissionIds.length,
    },
  });

  logger.info(
    {
      sprintId,
      completed: completedMissionIds.length,
      carriedOver: carriedOverMissionIds.length,
      policy: carryOverPolicy,
    },
    "Sprint completed",
  );
  return updated;
}

function findNextPlanningSprint(habitatId: string, excludeSprintId: string): Sprint | null {
  const allSprints = sprintRepo.getByHabitatId(habitatId);
  return (
    allSprints
      .filter((s) => s.status === "planning" && s.id !== excludeSprintId)
      .toSorted((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
  );
}

export function cancelSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw new Error("SPRINT_NOT_FOUND");
  if (existing.status !== "planning" && existing.status !== "active") {
    throw new Error("SPRINT_CANNOT_BE_CANCELLED");
  }

  sprintRepo.cancelSprintAndDetachMissions(sprintId, existing.committedMissionIds);

  const updated = sprintRepo.getById(sprintId);
  if (!updated) throw new Error("SPRINT_CANCEL_FAILED");

  logger.info({ sprintId, habitatId: updated.habitatId }, "Sprint cancelled");
  return updated;
}

export function addMissionToSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw new Error("SPRINT_NOT_FOUND");
  if (sprint.status !== "planning") throw new Error("CAN_ONLY_ADD_TO_PLANNING_SPRINT");

  const mission = missionRepo.getMissionById(missionId);
  if (!mission) throw new Error("MISSION_NOT_FOUND");
  if (mission.habitatId !== sprint.habitatId) throw new Error("MISSION_NOT_IN_SAME_HABITAT");

  const updated = sprintRepo.addMission(sprintId, missionId);
  if (!updated) throw new Error("ADD_MISSION_FAILED");
  return updated;
}

export function removeMissionFromSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw new Error("SPRINT_NOT_FOUND");
  if (sprint.status !== "planning") throw new Error("CAN_ONLY_REMOVE_FROM_PLANNING_SPRINT");

  const updated = sprintRepo.removeMission(sprintId, missionId);
  if (!updated) throw new Error("REMOVE_MISSION_FAILED");
  return updated;
}

export function autoCompleteSprints(): number {
  const expired = sprintRepo.getExpiredActiveSprints();
  let completed = 0;

  for (const sprint of expired) {
    try {
      completeSprint(sprint.id);
      completed++;
    } catch (err) {
      logger.error({ err, sprintId: sprint.id }, "Failed to auto-complete expired sprint");
    }
  }

  if (completed > 0) {
    logger.info({ completed, total: expired.length }, "Auto-completed expired sprints");
  }

  return completed;
}
