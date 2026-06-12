import { getDb } from "../db/index.js";
import { habitatHealthSnapshots } from "../db/schema/index.js";
import { desc, eq, sql } from "drizzle-orm";

export interface CreateHealthSnapshotInput {
  id: string;
  habitatId: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  dimensions: string;
  metrics: string;
  recommendations: string;
  snapshotAt: string;
}

export interface HealthSnapshotRow {
  id: string;
  habitatId: string;
  score: number;
  grade: string;
  dimensions: string;
  metrics: string;
  recommendations: string;
  snapshotAt: string;
  createdAt: string;
}

export function createHealthSnapshot(input: CreateHealthSnapshotInput): void {
  const db = getDb();

  db.insert(habitatHealthSnapshots)
    .values({
      id: input.id,
      habitatId: input.habitatId,
      score: input.score,
      grade: input.grade,
      dimensions: input.dimensions,
      metrics: input.metrics,
      recommendations: input.recommendations,
      snapshotAt: input.snapshotAt,
      createdAt: input.snapshotAt,
    })
    .run();
}

export function getLatestHealthSnapshot(habitatId: string): HealthSnapshotRow | null {
  const db = getDb();
  return db
    .select()
    .from(habitatHealthSnapshots)
    .where(eq(habitatHealthSnapshots.habitatId, habitatId))
    .orderBy(desc(habitatHealthSnapshots.snapshotAt))
    .limit(1)
    .get() as HealthSnapshotRow | null;
}

export function getHealthSnapshotHistory(habitatId: string, since: string): HealthSnapshotRow[] {
  const db = getDb();
  return db
    .select()
    .from(habitatHealthSnapshots)
    .where(
      sql`${habitatHealthSnapshots.habitatId} = ${habitatId} AND ${habitatHealthSnapshots.snapshotAt} >= ${since}`,
    )
    .orderBy(desc(habitatHealthSnapshots.snapshotAt))
    .all() as HealthSnapshotRow[];
}
