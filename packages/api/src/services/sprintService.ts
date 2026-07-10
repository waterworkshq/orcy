import { logger } from "../lib/logger.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as missionRepo from "../repositories/feature.js";
import * as habitatRepo from "../repositories/board.js";
import { badRequest, notFound, conflict, internalError } from "../errors.js";
import type { Sprint, SprintCreateInput, SprintUpdateInput, CarryOverPolicy } from "@orcy/shared";

/**
 * Returns the {@link Sprint} with the given id, or null when none exists.
 */
export function getSprint(sprintId: string): Sprint | null {
  return sprintRepo.getById(sprintId);
}

/**
 * Returns all {@link Sprint}s belonging to the given habitat.
 */
export function getSprintsForHabitat(habitatId: string): Sprint[] {
  return sprintRepo.getByHabitatId(habitatId);
}

/**
 * Returns the active {@link Sprint} for the given habitat, or null when none is active.
 */
export function getActiveSprint(habitatId: string): Sprint | null {
  return sprintRepo.getActiveForHabitat(habitatId);
}

/**
 * Creates a new {@link Sprint} after validating that the habitat has no active sprint
 * and the date range is valid and non-overlapping; side effect: publishes a `sprint.created` SSE event for the habitat.
 */
export function createSprint(
  habitatId: string,
  input: SprintCreateInput,
  createdBy: string,
): Sprint {
  const existing = sprintRepo.getActiveForHabitat(habitatId);
  if (existing) {
    throw conflict("Habitat already has an active sprint");
  }

  if (new Date(input.endDate) <= new Date(input.startDate)) {
    throw badRequest("End date must be after start date");
  }

  const overlapping = sprintRepo.getOverlappingForHabitat(
    habitatId,
    input.startDate,
    input.endDate,
  );
  if (overlapping) {
    throw conflict("Sprint dates overlap an existing sprint");
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

/**
 * Applies a partial {@link SprintUpdateInput} to a planning {@link Sprint}, rejecting modifications once the sprint is active or completed.
 */
export function updateSprint(sprintId: string, input: SprintUpdateInput): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw notFound("Sprint not found");

  if (existing.status !== "planning" && (input.startDate || input.endDate || input.name)) {
    throw badRequest("Cannot modify name or dates of an active or completed sprint");
  }

  const updated = sprintRepo.update(sprintId, input);
  if (!updated) throw internalError("Failed to update sprint");
  return updated;
}

/**
 * Deletes a non-active {@link Sprint} and detaches its committed missions back to their habitat.
 */
export function deleteSprint(sprintId: string): void {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw notFound("Sprint not found");

  if (existing.status === "active") {
    throw badRequest("Cannot delete an active sprint");
  }

  sprintRepo.deleteSprintAndDetachMissions(sprintId, existing.committedMissionIds);

  logger.info({ sprintId }, "Sprint deleted");
}

/**
 * Transitions a planning {@link Sprint} to active; side effect: publishes a `sprint.started` SSE event for the habitat.
 */
export function startSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw notFound("Sprint not found");
  if (existing.status !== "planning") throw badRequest("Sprint is not in planning status");

  const updated = sprintRepo.update(sprintId, { status: "active" });
  if (!updated) throw internalError("Failed to start sprint");

  sseBroadcaster.publish(updated.habitatId, {
    type: "sprint.started",
    data: { sprintId: updated.id, habitatId: updated.habitatId },
  });

  logger.info({ sprintId, habitatId: updated.habitatId }, "Sprint started");
  return updated;
}

/**
 * Completes an active {@link Sprint}, partitioning missions into completed and carried-over sets per the habitat's {@link CarryOverPolicy}; side effect: publishes a `sprint.completed` SSE event for the habitat.
 */
export function completeSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw notFound("Sprint not found");
  if (existing.status !== "active") throw badRequest("Sprint is not active");

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
  if (!updated) throw internalError("Failed to complete sprint");

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

/**
 * Cancels a planning or active {@link Sprint} and detaches its committed missions back to their habitat.
 */
export function cancelSprint(sprintId: string): Sprint {
  const existing = sprintRepo.getById(sprintId);
  if (!existing) throw notFound("Sprint not found");
  if (existing.status !== "planning" && existing.status !== "active") {
    throw badRequest("Sprint cannot be cancelled");
  }

  sprintRepo.cancelSprintAndDetachMissions(sprintId, existing.committedMissionIds);

  const updated = sprintRepo.getById(sprintId);
  if (!updated) throw internalError("Failed to cancel sprint");

  logger.info({ sprintId, habitatId: updated.habitatId }, "Sprint cancelled");
  return updated;
}

/**
 * Commits a mission from the same habitat to a planning {@link Sprint}.
 */
export function addMissionToSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw notFound("Sprint not found");
  if (sprint.status !== "planning") throw badRequest("Can only add missions to a planning sprint");

  const mission = missionRepo.getMissionById(missionId);
  if (!mission) throw notFound("Mission not found");
  if (mission.habitatId !== sprint.habitatId) {
    throw badRequest("Mission does not belong to the same habitat as the sprint");
  }

  const updated = sprintRepo.addMission(sprintId, missionId);
  if (!updated) throw internalError("Failed to add mission to sprint");
  return updated;
}

/**
 * Detaches a mission from a planning {@link Sprint}.
 */
export function removeMissionFromSprint(sprintId: string, missionId: string): Sprint {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) throw notFound("Sprint not found");
  if (sprint.status !== "planning") throw badRequest("Can only remove missions from a planning sprint");

  const updated = sprintRepo.removeMission(sprintId, missionId);
  if (!updated) throw internalError("Failed to remove mission from sprint");
  return updated;
}

/**
 * Scans for expired active {@link Sprint}s and completes each via {@link completeSprint}, returning the count successfully completed.
 */
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
