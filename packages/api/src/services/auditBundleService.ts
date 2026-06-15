import type {
  AuditCompletenessSummary,
  AuditEntityRef,
  AuditEvent,
  AuditWarning,
} from "@orcy/shared/types";
import * as missionRepo from "../repositories/feature.js";
import * as taskRepo from "../repositories/task.js";
import { notFound } from "../errors.js";
import { queryAuditEvents, summarizeAuditCompleteness } from "./auditQueryService.js";

/** Options controlling what an audit bundle query includes. */
export interface AuditBundleOptions {
  includeHealthSnapshots?: boolean;
}

/** Aggregated audit evidence for a single task: its chronologically sorted events, warnings, and completeness summary. */
export interface TaskAuditBundle {
  target: { type: "task"; id: string; title: string; missionId: string; habitatId: string };
  events: AuditEvent[];
  warnings: AuditWarning[];
  completenessSummary: AuditCompletenessSummary;
}

/** Aggregated audit evidence for a mission, split into direct mission events and rolled-up child-task evidence. */
export interface MissionAuditBundle {
  target: { type: "mission"; id: string; title: string; habitatId: string };
  directMissionEvidence: AuditEvent[];
  rolledUpTaskEvidence: AuditEvent[];
  warnings: AuditWarning[];
  completenessSummary: AuditCompletenessSummary;
}

function eventReferencesEntity(
  event: AuditEvent,
  type: AuditEntityRef["type"],
  id: string,
): boolean {
  if (event.entity.type === type && event.entity.id === id) return true;
  return event.linkedEntities.some((entity) => entity.type === type && entity.id === id);
}

function sortChronologically(events: AuditEvent[]): AuditEvent[] {
  return events.toSorted((a, b) => {
    const time = a.occurredAt.localeCompare(b.occurredAt);
    if (time !== 0) return time;
    return a.id.localeCompare(b.id);
  });
}

/** Builds the complete audit bundle for a task by filtering habitat events down to those referencing it. */
export function getTaskAuditBundle(
  taskId: string,
  options: AuditBundleOptions = {},
): TaskAuditBundle {
  const task = taskRepo.getTaskById(taskId);
  if (!task) throw notFound("Task not found");
  const mission = missionRepo.getMissionById(task.missionId);
  if (!mission) throw notFound("Mission not found");

  const result = queryAuditEvents({
    habitatId: mission.habitatId,
    order: "asc",
    includeHealthSnapshots: options.includeHealthSnapshots,
  });
  const events = sortChronologically(
    result.events.filter((event) => eventReferencesEntity(event, "task", task.id)),
  );

  return {
    target: {
      type: "task",
      id: task.id,
      title: task.title,
      missionId: task.missionId,
      habitatId: mission.habitatId,
    },
    events,
    warnings: result.warnings,
    completenessSummary: summarizeAuditCompleteness(events),
  };
}

/** Builds the complete audit bundle for a mission, separating direct mission evidence from rolled-up child-task evidence. */
export function getMissionAuditBundle(
  missionId: string,
  options: AuditBundleOptions = {},
): MissionAuditBundle {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) throw notFound("Mission not found");
  const tasks = taskRepo.getTasksByMissionId(mission.id);
  const taskIds = new Set(tasks.map((task) => task.id));

  const result = queryAuditEvents({
    habitatId: mission.habitatId,
    order: "asc",
    includeHealthSnapshots: options.includeHealthSnapshots,
  });

  const directMissionEvidence = result.events.filter((event) => {
    if (!eventReferencesEntity(event, "mission", mission.id)) return false;
    return !event.linkedEntities.some((entity) => entity.type === "task" && taskIds.has(entity.id));
  });

  const rolledUpTaskEvidence = result.events.filter((event) => {
    if (event.entity.type === "task" && taskIds.has(event.entity.id)) return true;
    return event.linkedEntities.some((entity) => entity.type === "task" && taskIds.has(entity.id));
  });

  const sortedDirectMissionEvidence = sortChronologically(directMissionEvidence);
  const sortedRolledUpTaskEvidence = sortChronologically(rolledUpTaskEvidence);
  const scopedEvents = [...sortedDirectMissionEvidence, ...sortedRolledUpTaskEvidence];

  return {
    target: { type: "mission", id: mission.id, title: mission.title, habitatId: mission.habitatId },
    directMissionEvidence: sortedDirectMissionEvidence,
    rolledUpTaskEvidence: sortedRolledUpTaskEvidence,
    warnings: result.warnings,
    completenessSummary: summarizeAuditCompleteness(scopedEvents),
  };
}
