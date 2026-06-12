import { getDb } from "../db/index.js";
import { habitats, missionEvents, taskEvents } from "../db/schema/index.js";
import { eq } from "drizzle-orm";

export interface ArchiveHabitatRetention {
  eventRetentionDays: number | null;
}

export interface DeleteArchivedSourceEventsInput {
  taskEventIds: string[];
  missionEventIds: string[];
}

export function getHabitatEventRetention(habitatId: string): ArchiveHabitatRetention | null {
  const db = getDb();
  const row = db
    .select({ eventRetentionDays: habitats.eventRetentionDays })
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get();
  return row ?? null;
}

export function listHabitatIdsForArchival(): string[] {
  const db = getDb();
  return db
    .select({ id: habitats.id })
    .from(habitats)
    .all()
    .map((row) => row.id);
}

export function deleteArchivedTaskEvent(taskEventId: string): void {
  const db = getDb();
  db.delete(taskEvents).where(eq(taskEvents.id, taskEventId)).run();
}

export function deleteArchivedMissionEvent(missionEventId: string): void {
  const db = getDb();
  db.delete(missionEvents).where(eq(missionEvents.id, missionEventId)).run();
}

export function deleteArchivedSourceEvents(input: DeleteArchivedSourceEventsInput): void {
  for (const id of input.taskEventIds) deleteArchivedTaskEvent(id);
  for (const id of input.missionEventIds) deleteArchivedMissionEvent(id);
}
