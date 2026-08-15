import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as columnRepo from "../repositories/column.js";
import * as eventRepo from "../repositories/event.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { emitMissionAuditEvent } from "./auditEventEmitter.js";
import {
  guardMissionDelete,
  guardCorrectiveMissionArchive,
  guardMissionGateEdit,
} from "./findingTriageHistoryGuards.js";
import type { Mission, MissionStatus, Task, TaskPriority } from "../models/index.js";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { isSqliteError } from "../errors/sqlite.js";

/** Input payload accepted by {@link createMission} describing the initial fields of a new mission. */
export interface CreateMissionInput {
  habitatId: string;
  columnId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string | null;
  slaMinutes?: number | null;
  createdBy: string;
  releaseGateType?: "patch" | "minor" | "major" | null;
  releaseGateVersion?: string | null;
  releaseDeadlineType?: "patch" | "minor" | "major" | null;
  releaseDeadlineVersion?: string | null;
}

/** {@link Mission} enriched with per-status task counts for UI progress display. */
export interface MissionWithProgress extends Mission {
  progress: {
    total: number;
    pending: number;
    claimed: number;
    inProgress: number;
    submitted: number;
    approved: number;
    done: number;
    failed: number;
    rejected: number;
  };
}

/** Derives the {@link MissionStatus} for a mission by inspecting the status of all its tasks, returning `"not_started"` when no tasks exist. */
export function deriveMissionStatus(missionId: string): MissionStatus {
  const tasks = taskRepo.getTasksByMissionId(missionId);

  if (tasks.length === 0) return "not_started";

  const statuses = tasks.map((t) => t.status);

  if (
    statuses.every((s) => s === "done" || s === "approved") &&
    statuses.some((s) => s === "done")
  ) {
    return "done";
  }

  if (statuses.every((s) => s === "submitted" || s === "approved" || s === "done")) {
    return "review";
  }

  if (
    statuses.some((s) => s === "failed") &&
    !statuses.some((s) => ["claimed", "in_progress", "submitted"].includes(s))
  ) {
    return "failed";
  }

  const nonPendingStatuses = [
    "claimed",
    "in_progress",
    "submitted",
    "approved",
    "done",
    "failed",
    "rejected",
  ];
  if (statuses.some((s) => nonPendingStatuses.includes(s))) {
    return "in_progress";
  }

  return "not_started";
}

/** Resolves the column id that should hold a mission in the given {@link MissionStatus} within a habitat's column layout, returning null when no suitable column exists. */
export function resolveTargetColumn(habitatId: string, status: MissionStatus): string | null {
  const habitatColumns = columnRepo.getColumnsByHabitatId(habitatId);
  if (habitatColumns.length === 0) return null;

  const nonTerminal = habitatColumns.filter((c) => !c.isTerminal);
  const terminal = habitatColumns.find((c) => c.isTerminal);

  switch (status) {
    case "not_started":
      return habitatColumns[0]?.id ?? null;
    case "in_progress":
      if (nonTerminal.length < 2) return null;
      return habitatColumns[1]?.id ?? null;
    case "review":
      if (nonTerminal.length < 3) return null;
      return nonTerminal[nonTerminal.length - 1]?.id ?? null;
    case "done":
      return terminal?.id ?? habitatColumns[habitatColumns.length - 1]?.id ?? null;
    case "failed":
      return null;
    default:
      return null;
  }
}

/** Moves a {@link Mission} to the column matching `newStatus` when it differs, with side effects: persists the column move, emits a `moved` mission event, and broadcasts a `mission.moved` SSE event to the habitat. The auto-advance path participates in the same repository optimistic-concurrency contract as explicit moves: it supplies the mission's currently observed {@link Mission.version} as the expected version, so a concurrent manual move that commits first produces a stale-version failure here (no write, no `mission.moved`/`mission.updated` event) rather than a silent overwrite. */
export function autoAdvanceMissionColumn(
  mission: Mission,
  newStatus: MissionStatus,
):
  | { mission: Mission; columnChanged: boolean }
  | { staleVersion: true; currentVersion: number }
  | null {
  if (newStatus === "failed") return { mission, columnChanged: false };

  const targetColumnId = resolveTargetColumn(mission.habitatId, newStatus);
  if (!targetColumnId || targetColumnId === mission.columnId) {
    return { mission, columnChanged: false };
  }

  const fromColumnId = mission.columnId;
  const result = missionRepo.moveMission(mission.id, targetColumnId, mission.version);
  if (!result.success) {
    if ("versionMismatch" in result) {
      return { staleVersion: true, currentVersion: result.currentVersion };
    }
    return { mission, columnChanged: false };
  }
  const updated = result.mission;

  eventRepo.createMissionEvent({
    missionId: mission.id,
    actorType: "system",
    actorId: "status-engine",
    action: "moved",
    fromColumnId,
    toColumnId: targetColumnId,
    metadata: { reason: "auto_advance", derivedStatus: newStatus },
  });

  sseBroadcaster.publish(mission.habitatId, {
    type: "mission.moved",
    data: { missionId: mission.id, fromColumnId, toColumnId: targetColumnId },
  });

  return { mission: updated, columnChanged: true };
}

/** Recalculates a mission's {@link MissionStatus} from its tasks and auto-advances its column when the derived status changes; side effects: persists status updates, emits `status_changed` and SSE `mission.status_changed` / `mission.progress` broadcasts, and may move the column via {@link autoAdvanceMissionColumn}. */
export function recalculateMissionStatus(
  missionId: string,
): { mission: Mission; statusChanged: boolean; columnChanged: boolean } | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const oldStatus = mission.status;
  const newStatus = deriveMissionStatus(missionId);

  let statusChanged = oldStatus !== newStatus;
  let columnChanged = false;

  if (statusChanged) {
    missionRepo.updateMission(missionId, { status: newStatus });

    eventRepo.createMissionEvent({
      missionId,
      actorType: "system",
      actorId: "status-engine",
      action: "status_changed",
      fromStatus: oldStatus,
      toStatus: newStatus,
      metadata: { reason: "task_state_change" },
    });

    sseBroadcaster.publish(mission.habitatId, {
      type: "mission.status_changed",
      data: { missionId, fromStatus: oldStatus, toStatus: newStatus },
    });
  }

  const updatedMission = missionRepo.getMissionById(missionId)!;

  const advanceResult = autoAdvanceMissionColumn(updatedMission, newStatus);
  if (advanceResult && "columnChanged" in advanceResult && advanceResult.columnChanged) {
    columnChanged = true;
  }

  const finalMission = missionRepo.getMissionById(missionId)!;

  const tasks = taskRepo.getTasksByMissionId(missionId);
  const doneCount = tasks.filter((t) => ["done", "approved"].includes(t.status)).length;
  sseBroadcaster.publish(mission.habitatId, {
    type: "mission.progress",
    data: { missionId, completed: doneCount, total: tasks.length },
  });

  return { mission: finalMission, statusChanged, columnChanged };
}

/** Creates a mission from a {@link CreateMissionInput} and persists it; side effects: emits a `created` mission event and broadcasts a `mission.created` SSE event to the habitat. */
export function createMission(input: CreateMissionInput): Mission {
  const mission = missionRepo.createMission(input);

  eventRepo.createMissionEvent({
    missionId: mission.id,
    actorType: "human",
    actorId: input.createdBy,
    action: "created",
    metadata: { title: mission.title },
  });

  sseBroadcaster.publish(mission.habitatId, { type: "mission.created", data: mission });

  return mission;
}

function withImmediateMissionWrite<T>(fn: () => T): T {
  const db = getDb();
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = fn();
    db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // already rolled back
    }
    throw err;
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  if (err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && /FOREIGN KEY constraint failed/i.test(cause.message)) return true;
  if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
  return false;
}

/** Updates editable fields of a mission with optimistic-concurrency version checks; side effects: persists the change, emits an `updated` mission event listing changed fields, and broadcasts a `mission.updated` SSE event. Generic gate edits are additionally guarded: clearing the last gate while linked Findings are non-terminal, or adding/replacing a gate while linked Findings are `in_progress`, reject before write (activation owns gate clearing — see `findingTriageHistoryGuards`). */
export function updateMission(
  missionId: string,
  input: Parameters<typeof missionRepo.updateMission>[1] & { version?: number },
  editorId: string,
):
  | { success: true; mission: Mission }
  | {
      success: false;
      notFound?: true;
      versionMismatch?: true;
      currentVersion?: number;
      archived?: true;
      gateGuard?: "gate_clear_blocked" | "gate_change_blocked";
      gateGuardFindingIds?: string[];
    } {
  const result = withImmediateMissionWrite(() => {
    const current = missionRepo.getMissionById(missionId);
    if (!current) return { success: false as const, notFound: true as const };
    if (current.isArchived) return { success: false as const, archived: true as const };

    const gateGuard = guardMissionGateEdit(missionId, current, {
      releaseGateType: input.releaseGateType,
      releaseGateVersion: input.releaseGateVersion,
    });
    if (!gateGuard.allowed) {
      return {
        success: false as const,
        gateGuard: gateGuard.reason,
        gateGuardFindingIds: gateGuard.findingIds,
      };
    }

    const { version, ...updateFields } = input;
    const written = missionRepo.updateMissionWithClient(
      getDb(),
      missionId,
      updateFields,
      version,
    );
    if (!written.success) return written;

    eventRepo.createMissionEvent({
      missionId,
      actorType: "human",
      actorId: editorId,
      action: "updated",
      metadata: { changedFields: Object.keys(input) },
    });
    return written;
  });

  if (result.success) {
    sseBroadcaster.publish(result.mission.habitatId, {
      type: "mission.updated",
      data: result.mission,
    });
  }
  return result;
}

/** Deletes a mission when no other mission depends on it AND no Finding links it as investigation or corrective work (any Finding state — deletion erases history; archive is the reversible alternative); side effects: emits a `deleted` audit event carrying the prior status and metadata, deletes the row, and broadcasts a `mission.deleted` SSE event to the habitat. */
export function deleteMission(
  missionId: string,
  actorId = "system",
  actorType: "human" | "agent" | "system" = "system",
): { success: true } | { success: false; reason: string } {
  let habitatId: string | null = null;
  try {
    const result = withImmediateMissionWrite(() => {
      const mission = missionRepo.getMissionById(missionId);
      if (!mission) return { success: false as const, reason: "not_found" };

      const dependents = missionRepo.getMissionsByDependency(missionId);
      if (dependents.length > 0) {
        return { success: false as const, reason: "has_dependents" };
      }

      const deleteGuard = guardMissionDelete(missionId);
      if (deleteGuard.blocked) {
        return { success: false as const, reason: "has_finding_links" };
      }

      emitMissionAuditEvent({
        missionId,
        actorType,
        actorId,
        action: "deleted",
        fromStatus: mission.status,
        metadata: {
          title: mission.title,
          habitatId: mission.habitatId,
          columnId: mission.columnId,
          labels: mission.labels,
        },
      });

      missionRepo.deleteMissionWithClient(getDb(), missionId);
      habitatId = mission.habitatId;
      return { success: true as const };
    });
    if (result.success && habitatId) {
      sseBroadcaster.publish(habitatId, { type: "mission.deleted", data: { missionId } });
    }
    return result;
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return { success: false, reason: "has_finding_links" };
    }
    throw err;
  }
}

/** Moves a mission to a specific target column; side effects: persists the move, emits a `moved` mission event, and broadcasts both `mission.moved` and `mission.updated` SSE events to the habitat. The supplied `expectedVersion` is required and passed through to the repository's optimistic-concurrency check; a stale version produces a `{ staleVersion: true }` outcome with no write and no event emission. A target column that does not belong to the mission's habitat is rejected with `{ invalidTarget: true }` before any write — the invariant is also enforced at the repository boundary. */
export function moveMissionToColumn(
  missionId: string,
  toColumnId: string,
  actorId: string,
  actorType: "human" | "agent" = "human",
  expectedVersion: number,
):
  | { mission: Mission }
  | { notFound: true }
  | { staleVersion: true; currentVersion: number }
  | { invalidTarget: true } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { notFound: true };

  const targetColumn = columnRepo.getColumnById(toColumnId);
  if (!targetColumn || targetColumn.habitatId !== mission.habitatId) {
    return { invalidTarget: true };
  }

  const fromColumnId = mission.columnId;
  const result = missionRepo.moveMission(missionId, toColumnId, expectedVersion);
  if (!result.success) {
    if ("versionMismatch" in result) {
      return { staleVersion: true, currentVersion: result.currentVersion };
    }
    if ("invalidTarget" in result) {
      return { invalidTarget: true };
    }
    return { notFound: true };
  }
  const updated = result.mission;

  eventRepo.createMissionEvent({
    missionId,
    actorType,
    actorId,
    action: "moved",
    fromColumnId,
    toColumnId,
  });

  sseBroadcaster.publish(mission.habitatId, {
    type: "mission.moved",
    data: { missionId, fromColumnId, toColumnId },
  });
  sseBroadcaster.publish(mission.habitatId, { type: "mission.updated", data: updated });

  return { mission: updated };
}

/** Returns the {@link Mission} with the given id, or null when it does not exist. */
export function getMission(missionId: string): Mission | null {
  return missionRepo.getMissionById(missionId);
}

function computeProgress(taskList: Task[]): MissionWithProgress["progress"] {
  return {
    total: taskList.length,
    pending: taskList.filter((t) => t.status === "pending").length,
    claimed: taskList.filter((t) => t.status === "claimed").length,
    inProgress: taskList.filter((t) => t.status === "in_progress").length,
    submitted: taskList.filter((t) => t.status === "submitted").length,
    approved: taskList.filter((t) => t.status === "approved").length,
    done: taskList.filter((t) => t.status === "done").length,
    failed: taskList.filter((t) => t.status === "failed").length,
    rejected: taskList.filter((t) => t.status === "rejected").length,
  };
}

/** Returns the {@link Mission} enriched with per-status task counts as a {@link MissionWithProgress}, or null when the mission does not exist. */
export function getMissionWithProgress(missionId: string): MissionWithProgress | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const tasks = taskRepo.getTasksByMissionId(missionId);
  return { ...mission, progress: computeProgress(tasks) };
}

/** Lists a paginated set of missions for a habitat, defaulting `isArchived` to `false` when unspecified, and decorates each result with aggregated progress to form {@link MissionWithProgress} entries. */
export function listMissions(
  habitatId: string,
  filters?: Parameters<typeof missionRepo.getMissionsByHabitatId>[1],
): { missions: MissionWithProgress[]; total: number } {
  const actualFilters = { ...filters };
  if (actualFilters.isArchived === undefined) {
    actualFilters.isArchived = false;
  }
  const { missions: rawMissions, total } = missionRepo.getMissionsByHabitatId(
    habitatId,
    actualFilters,
  );

  const missionIds = rawMissions.map((f) => f.id);
  const allTasks = taskRepo.getTasksByMissionIds(missionIds);

  const tasksByMission = new Map<string, Task[]>();
  for (const task of allTasks) {
    const list = tasksByMission.get(task.missionId) || [];
    list.push(task);
    tasksByMission.set(task.missionId, list);
  }

  const missionsWithProgress: MissionWithProgress[] = rawMissions.map((mission) => ({
    ...mission,
    progress: computeProgress(tasksByMission.get(mission.id) || []),
  }));

  return { missions: missionsWithProgress, total };
}

/** Archives a mission that is already in the `done` status AND has no non-terminal corrective Finding links (restored lifecycle T5 inverse guard — archive is allowed once every linked Finding is terminal, and the link stays queryable); side effects: flips `isArchived`, emits an `updated` mission event with `archived` reason metadata, and broadcasts a `mission.updated` SSE event. */
export function archiveMission(
  missionId: string,
  actorId: string,
): { success: true; mission: Mission } | { success: false; reason: string } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { success: false, reason: "not_found" };
  if (mission.status !== "done") return { success: false, reason: "not_done" };
  if (mission.isArchived) return { success: false, reason: "already_archived" };

  // Inverse guard: a corrective Mission with ANY non-terminal linked Finding
  // cannot be archived.
  const archiveGuard = guardCorrectiveMissionArchive(missionId);
  if (archiveGuard.blocked) {
    return { success: false, reason: archiveGuard.reason };
  }

  const result = missionRepo.updateMission(missionId, { isArchived: true });
  if (!result.success) return { success: false, reason: "update_failed" };

  eventRepo.createMissionEvent({
    missionId,
    actorType: "human",
    actorId,
    action: "updated",
    metadata: { reason: "archived" },
  });

  sseBroadcaster.publish(mission.habitatId, { type: "mission.updated", data: result.mission });
  return { success: true, mission: result.mission };
}

/** Unarchives a previously archived mission; side effects: clears `isArchived`, emits an `updated` mission event with `unarchived` reason metadata, and broadcasts a `mission.updated` SSE event. */
export function unarchiveMission(
  missionId: string,
  actorId: string,
): { success: true; mission: Mission } | { success: false; reason: string } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { success: false, reason: "not_found" };
  if (!mission.isArchived) return { success: false, reason: "not_archived" };

  const result = missionRepo.updateMission(missionId, { isArchived: false });
  if (!result.success) return { success: false, reason: "update_failed" };

  eventRepo.createMissionEvent({
    missionId,
    actorType: "human",
    actorId,
    action: "updated",
    metadata: { reason: "unarchived" },
  });

  sseBroadcaster.publish(mission.habitatId, { type: "mission.updated", data: result.mission });
  return { success: true, mission: result.mission };
}

/** Completion snapshot for a mission: completed/total counts, percentage, and per-status tallies. */
export interface MissionProgress {
  completed: number;
  total: number;
  percentage: number;
  byStatus: Record<string, number>;
}

/** Computes a {@link MissionProgress} snapshot for a mission containing completion counts, percentage, and per-status tallies, returning null when the mission does not exist. */
export function getMissionProgress(missionId: string): MissionProgress | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const tasks = taskRepo.getTasksByMissionId(missionId);

  const byStatus: Record<string, number> = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }
  const completed = tasks.filter((t) => ["done", "approved"].includes(t.status)).length;

  return {
    completed,
    total: tasks.length,
    percentage: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0,
    byStatus,
  };
}
