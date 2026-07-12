import { getDb } from "../../db/index.js";
import { agents, effortEntries, missions, tasks } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

export interface EffortAuditRow {
  id: string;
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string | null;
  actorName: string | null;
  minutes: number;
  source: string;
  note: string | null;
  correctsEntryId: string | null;
  correctionReason: string | null;
  metadata: Record<string, unknown> | null;
  recordedAt: string;
}

/**
 * Habitat-scoped join: every effort entry whose task belongs to a mission in the
 * habitat, with task/mission title and agent name resolved via inner/left joins.
 */
export function listForAudit(habitatId: string): EffortAuditRow[] {
  const db = getDb();
  return db
    .select({
      id: effortEntries.id,
      taskId: effortEntries.taskId,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      missionHabitatId: missions.habitatId,
      actorType: effortEntries.actorType,
      actorId: effortEntries.actorId,
      actorName: agents.name,
      minutes: effortEntries.minutes,
      source: effortEntries.source,
      note: effortEntries.note,
      correctsEntryId: effortEntries.correctsEntryId,
      correctionReason: effortEntries.correctionReason,
      metadata: effortEntries.metadata,
      recordedAt: effortEntries.recordedAt,
    })
    .from(effortEntries)
    .innerJoin(tasks, eq(effortEntries.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .leftJoin(agents, eq(effortEntries.actorId, agents.id))
    .where(eq(missions.habitatId, habitatId))
    .all() as EffortAuditRow[];
}