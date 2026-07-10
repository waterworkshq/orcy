import { getDb } from "../../db/index.js";
import { taskTimeRecords, tasks, missions, agents } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

type TimeRecordRow = typeof taskTimeRecords.$inferSelect;

export interface TimeRecordAuditRow {
  record: TimeRecordRow;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  agentName: string | null;
}

export function listForAudit(habitatId: string): TimeRecordAuditRow[] {
  const db = getDb();
  return db
    .select({
      record: taskTimeRecords,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      missionHabitatId: missions.habitatId,
      agentName: agents.name,
    })
    .from(taskTimeRecords)
    .innerJoin(tasks, eq(taskTimeRecords.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .leftJoin(agents, eq(taskTimeRecords.agentId, agents.id))
    .where(eq(missions.habitatId, habitatId))
    .all() as TimeRecordAuditRow[];
}