import { getDb } from "../../db/index.js";
import { habitatHealthSnapshots } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

export type HabitatHealthSnapshotRow = typeof habitatHealthSnapshots.$inferSelect;

export function listForAudit(habitatId: string): HabitatHealthSnapshotRow[] {
  const db = getDb();
  return db
    .select()
    .from(habitatHealthSnapshots)
    .where(eq(habitatHealthSnapshots.habitatId, habitatId))
    .all() as HabitatHealthSnapshotRow[];
}