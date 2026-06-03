import * as effortRepo from "../repositories/effortEntry.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { getHabitatIdForTask } from "../repositories/task.js";
import { badRequest, notFound } from "../errors.js";
import type {
  EffortEntry,
  EffortEntryWithActor,
  EffortReport,
  MissionEffortReport,
  EffortSource,
  EffortActorType,
  LogEffortRequest,
  CorrectEffortRequest,
} from "../models/index.js";

export function logEffort(
  taskId: string,
  actorType: EffortActorType,
  actorId: string | null,
  input: LogEffortRequest,
): EffortEntry {
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    throw badRequest("minutes must be a positive integer");
  }

  if ((actorType === "human" || actorType === "agent") && !actorId) {
    throw badRequest("actor_id is required for human and agent effort entries");
  }

  const source: EffortSource =
    input.source ?? (actorType === "human" ? "human_manual" : "agent_reported");

  const entry = effortRepo.createEffortEntry({
    taskId,
    actorType,
    actorId: actorId ?? undefined,
    minutes: input.minutes,
    source,
    note: input.note,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  });

  eventRepo.createEvent({
    taskId,
    actorType,
    actorId: actorId ?? "system",
    action: "effort_logged",
    metadata: {
      effortEntryId: entry.id,
      minutes: input.minutes,
      source,
      note: input.note ?? null,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
    },
  });

  effortRepo.recalculateTaskEffortMetrics(taskId);

  const habitatId = getHabitatIdForTask(taskId);
  if (habitatId) {
    sseBroadcaster.publish(habitatId, {
      type: "effort.updated",
      data: { taskId, entryId: entry.id, actorType, actorId, source, minutes: input.minutes },
    });
  }

  return entry;
}

export function listEffortEntries(
  taskId: string,
  options?: { includeCorrections?: boolean; limit?: number; offset?: number },
): EffortEntryWithActor[] {
  return effortRepo.getEffortEntriesWithActorByTask(taskId, options);
}

export function countEffortEntries(
  taskId: string,
  options?: { includeCorrections?: boolean },
): number {
  return effortRepo.countEffortEntriesByTask(taskId, options);
}

export function correctEffortEntry(
  taskId: string,
  entryId: string,
  actorType: EffortActorType,
  actorId: string | null,
  input: CorrectEffortRequest,
): EffortEntry {
  const existing = effortRepo.getEffortEntryById(entryId);
  if (!existing) {
    throw notFound("Effort entry not found");
  }
  if (existing.taskId !== taskId) {
    throw badRequest("Effort entry does not belong to this task");
  }
  if (input.minutesDelta === 0) {
    throw badRequest("minutesDelta cannot be 0");
  }
  if (!input.correctionReason) {
    throw badRequest("correctionReason is required");
  }

  if ((actorType === "human" || actorType === "agent") && !actorId) {
    throw badRequest("actor_id is required for human and agent effort entries");
  }

  const correction = effortRepo.createEffortEntry({
    taskId,
    actorType,
    actorId: actorId ?? undefined,
    minutes: input.minutesDelta,
    source: "correction_adjustment",
    note: input.note,
    correctsEntryId: entryId,
    correctionReason: input.correctionReason,
  });

  eventRepo.createEvent({
    taskId,
    actorType,
    actorId: actorId ?? "system",
    action: "effort_corrected",
    metadata: {
      effortEntryId: correction.id,
      correctsEntryId: entryId,
      minutesDelta: input.minutesDelta,
      correctionReason: input.correctionReason,
      note: input.note ?? null,
    },
  });

  effortRepo.recalculateTaskEffortMetrics(taskId);

  const habitatId = getHabitatIdForTask(taskId);
  if (habitatId) {
    sseBroadcaster.publish(habitatId, {
      type: "effort.updated",
      data: {
        taskId,
        entryId: correction.id,
        actorType,
        actorId,
        source: "correction_adjustment",
        minutes: input.minutesDelta,
      },
    });
  }

  return correction;
}

export function getTaskEffortReport(taskId: string): EffortReport | null {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;

  const totals = effortRepo.getEffortTotalsForTask(taskId);
  const bySource = effortRepo.getEffortBySourceForTask(taskId);
  const byActor = effortRepo.getEffortByActorForTask(taskId);
  const entries = effortRepo.getEffortEntriesWithActorByTask(taskId, { limit: 1000 });

  const effortMetrics = effortRepo.getPersistedEffortMetricsForTask(taskId, task.estimatedMinutes);
  const basis: EffortReport["accuracy"]["basis"] = effortMetrics.basis;

  const warnings: string[] = [];
  if (totals.loggedEffortMinutes > 0 && totals.inferredPresenceMinutes > 0) {
    warnings.push("Logged effort and inferred presence may overlap.");
  }

  return {
    target: { type: "task", id: taskId },
    estimate: { plannedMinutes: task.estimatedMinutes ?? null },
    totals,
    elapsed: {
      cycleTimeMinutes: task.cycleTimeMinutes ?? null,
      leadTimeMinutes: task.leadTimeMinutes ?? null,
    },
    accuracy: { estimationAccuracy: effortMetrics.estimationAccuracy, basis },
    bySource,
    byActor,
    entries,
    warnings,
  };
}

export function getMissionEffortReport(missionId: string): MissionEffortReport | null {
  const missionTasks = taskRepo.getTasksByMissionId(missionId);
  if (!missionTasks || missionTasks.length === 0) return null;

  const taskReports: MissionEffortReport["tasks"] = [];
  let totalLogged = 0;
  let totalInferred = 0;
  let totalCorrection = 0;
  let totalAccounted = 0;
  const allWarnings: string[] = [];

  const actorMap = new Map<
    string,
    {
      actorType: EffortActorType;
      actorId: string | null;
      actorName: string | null;
      loggedEffortMinutes: number;
      inferredPresenceMinutes: number;
      correctionAdjustmentMinutes: number;
    }
  >();

  for (const task of missionTasks) {
    const totals = effortRepo.getEffortTotalsForTask(task.id);
    taskReports.push({
      taskId: task.id,
      taskTitle: task.title,
      totals,
    });
    totalLogged += totals.loggedEffortMinutes;
    totalInferred += totals.inferredPresenceMinutes;
    totalCorrection += totals.correctionAdjustmentMinutes;
    totalAccounted += totals.totalAccountedMinutes;

    const actors = effortRepo.getEffortByActorForTask(task.id);
    for (const a of actors) {
      const key = `${a.actorType}:${a.actorId ?? "null"}`;
      if (!actorMap.has(key)) {
        actorMap.set(key, { ...a });
      } else {
        const existing = actorMap.get(key)!;
        existing.loggedEffortMinutes += a.loggedEffortMinutes;
        existing.inferredPresenceMinutes += a.inferredPresenceMinutes;
        existing.correctionAdjustmentMinutes += a.correctionAdjustmentMinutes;
      }
    }

    if (totals.loggedEffortMinutes > 0 && totals.inferredPresenceMinutes > 0) {
      allWarnings.push(`Task "${task.title}": Logged effort and inferred presence may overlap.`);
    }
  }

  const plannedMinutes = missionTasks.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);

  return {
    target: { type: "mission", id: missionId },
    estimate: { plannedMinutes: plannedMinutes > 0 ? plannedMinutes : null },
    totals: {
      loggedEffortMinutes: totalLogged,
      inferredPresenceMinutes: totalInferred,
      correctionAdjustmentMinutes: totalCorrection,
      totalAccountedMinutes: totalAccounted,
    },
    tasks: taskReports,
    byActor: [...actorMap.values()],
    warnings: [...new Set(allWarnings)],
  };
}
