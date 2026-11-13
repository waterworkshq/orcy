import * as taskRepo from "../../repositories/task.js";
import * as missionRepo from "../../repositories/mission.js";
import * as habitatRepo from "../../repositories/habitat.js";
import * as columnRepo from "../../repositories/column.js";
import * as subtaskRepo from "../../repositories/subtask.js";
import * as pullRequestRepo from "../../repositories/pullRequest.js";
import * as pipelineEventRepo from "../../repositories/pipelineEvent.js";
import * as eventRepo from "../../repositories/event.js";
import * as commentRepo from "../../repositories/comment.js";
import * as attachmentRepo from "../../repositories/attachment.js";
import * as watcherRepo from "../../repositories/watcher.js";
import { getDb } from "../../db/index.js";
import { metadataEditSnapshotWithClient } from "./humanTaskMetadata.js";
import type { Task } from "../../models/index.js";

/** Enriched task payload returned by getTaskDetails, including mission and habitat context. */
export interface TaskWithMissionContext {
  task: Task;
  mission: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    status: string;
    dueAt: string | null;
    slaMinutes: number | null;
  } | null;
  siblingTasks: {
    id: string;
    title: string;
    status: string;
    result: string | null;
  }[];
  subtasks: any[];
  pullRequests: any[];
  pipelineEvents: any[];
  events: any[];
  comments: any[];
  totalComments: number;
  attachments: any[];
  watchers: any[];
  isWatching: boolean;
  habitatContext: {
    name: string;
    columns: { name: string; missionCount: number }[];
  };
  /** Edit hint (human reads only): authorization + eligibility held across assembly. */
  canEditMetadata: boolean;
  /** Identity fence token; present only when canEditMetadata is true. */
  metadataEditIdentity?: string;
}

/** Loads a task and assembles its full mission and habitat context, including related entities and watcher state. */
export async function getTaskDetails(
  taskId: string,
  userId?: string,
): Promise<TaskWithMissionContext | null> {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;

  const mission = missionRepo.getMissionById(task.missionId);
  const habitatId = mission?.habitatId;
  const habitat = habitatId ? habitatRepo.getHabitatById(habitatId) : null;

  // Edit hint: coherent snapshot BEFORE async assembly — captured right after
  // the habitat read, above the Promise.all. `task.id` is the alias-resolved
  // canonical ID (getTaskById normalizes `feat-` aliases), so an alias GET
  // hints for the row it actually returns while the write path stays exact-ID.
  const snapshot = userId ? metadataEditSnapshotWithClient(getDb(), task.id, userId) : null;

  const [subtasks, pullRequests, pipelineEvents, taskEvents, commentsResult, attachments] =
    await Promise.all([
      subtaskRepo.getSubtasksByTaskId(taskId),
      pullRequestRepo.getByTaskId(taskId),
      pipelineEventRepo.getByTaskId(taskId),
      eventRepo.getEventsByTaskId(taskId, 50),
      commentRepo.getCommentsByTaskId(taskId, 100),
      attachmentRepo.getAttachmentsByTaskId(taskId),
    ]);

  const watchers = watcherRepo.getWatchersForTask(taskId);
  const isWatching = userId ? watcherRepo.isWatching(taskId, userId) : false;

  let missionContext: TaskWithMissionContext["mission"] = null;
  if (mission) {
    missionContext = {
      id: mission.id,
      title: mission.title,
      description: mission.description,
      acceptanceCriteria: mission.acceptanceCriteria,
      priority: mission.priority,
      status: mission.status,
      dueAt: mission.dueAt,
      slaMinutes: mission.slaMinutes,
    };
  }

  const allMissionTasks = mission ? taskRepo.getTasksByMissionId(mission.id) : [];
  const siblingTasks = allMissionTasks
    .filter((t) => t.id !== taskId)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      result: t.result,
    }));

  const habitatColumns = habitat
    ? columnRepo.getColumnsByHabitatId(habitat.id).map((col) => {
        const missionCount = missionRepo.getMissionsByHabitatId(habitat.id, {
          columnId: col.id,
        }).total;
        return { name: col.name, missionCount };
      })
    : [];

  const result: TaskWithMissionContext = {
    task,
    mission: missionContext,
    siblingTasks,
    subtasks,
    pullRequests,
    pipelineEvents,
    events: taskEvents.events,
    comments: commentsResult.comments,
    totalComments: commentsResult.total,
    attachments,
    watchers,
    isWatching,
    habitatContext: habitat
      ? { name: habitat.name, columns: habitatColumns }
      : { name: "", columns: [] },
    canEditMetadata: false,
  };

  // Post-assembly recheck on the synchronous tail (no await before return):
  // permission, eligibility, identity, version, and the editable values must
  // all still match the pre-assembly snapshot, or no token is issued.
  let canEditMetadata = false;
  let metadataEditIdentity: string | undefined;
  if (
    userId &&
    snapshot &&
    snapshot.allowed &&
    snapshot.version === result.task.version &&
    snapshot.title === result.task.title &&
    snapshot.description === result.task.description &&
    snapshot.priority === result.task.priority
  ) {
    const recheck = metadataEditSnapshotWithClient(getDb(), task.id, userId);
    if (
      recheck &&
      recheck.allowed &&
      recheck.identity === snapshot.identity &&
      recheck.missionId === snapshot.missionId &&
      recheck.habitatId === snapshot.habitatId &&
      recheck.missionId === result.task.missionId &&
      result.mission?.id === snapshot.missionId &&
      recheck.version === snapshot.version &&
      recheck.title === snapshot.title &&
      recheck.title === result.task.title &&
      recheck.description === snapshot.description &&
      recheck.description === result.task.description &&
      recheck.priority === snapshot.priority &&
      recheck.priority === result.task.priority &&
      result.task.id === task.id
    ) {
      canEditMetadata = true;
      metadataEditIdentity = snapshot.identity;
    }
  }
  result.canEditMetadata = canEditMetadata;
  if (metadataEditIdentity) result.metadataEditIdentity = metadataEditIdentity;
  return result;
}
