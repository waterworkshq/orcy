import { and, asc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { cumulativeFlowSnapshots } from "../db/schema/index.js";

export interface AnalyticsWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface CumulativeFlowSnapshotInput {
  habitatId: string;
  snapshotDate: string;
  countsByColumn: Record<string, number>;
  countsByStatus: Record<string, number>;
  source?: "generated" | "backfilled" | "current_state";
  completeness?: "complete" | "partial";
  warnings?: AnalyticsWarning[];
}

export type CumulativeFlowSnapshot = typeof cumulativeFlowSnapshots.$inferSelect;

export function upsertSnapshot(input: CumulativeFlowSnapshotInput): CumulativeFlowSnapshot {
  const db = getDb();
  const id = uuid();
  db.insert(cumulativeFlowSnapshots)
    .values({
      id,
      habitatId: input.habitatId,
      snapshotDate: input.snapshotDate,
      countsByColumn: input.countsByColumn,
      countsByStatus: input.countsByStatus,
      source: input.source ?? "generated",
      completeness: input.completeness ?? "complete",
      warnings: input.warnings ?? [],
    })
    .onConflictDoUpdate({
      target: [cumulativeFlowSnapshots.habitatId, cumulativeFlowSnapshots.snapshotDate],
      set: {
        countsByColumn: input.countsByColumn,
        countsByStatus: input.countsByStatus,
        source: input.source ?? "generated",
        completeness: input.completeness ?? "complete",
        warnings: input.warnings ?? [],
      },
    })
    .run();

  const snapshot = db
    .select()
    .from(cumulativeFlowSnapshots)
    .where(
      and(
        eq(cumulativeFlowSnapshots.habitatId, input.habitatId),
        eq(cumulativeFlowSnapshots.snapshotDate, input.snapshotDate),
      ),
    )
    .get();
  if (!snapshot) throw new Error("CUMULATIVE_FLOW_SNAPSHOT_NOT_FOUND");
  return snapshot;
}

export function listSnapshotsForRange(
  habitatId: string,
  startDate: string,
  endDate: string,
): CumulativeFlowSnapshot[] {
  return getDb()
    .select()
    .from(cumulativeFlowSnapshots)
    .where(
      and(
        eq(cumulativeFlowSnapshots.habitatId, habitatId),
        sql`${cumulativeFlowSnapshots.snapshotDate} >= ${startDate}`,
        sql`${cumulativeFlowSnapshots.snapshotDate} <= ${endDate}`,
      ),
    )
    .orderBy(asc(cumulativeFlowSnapshots.snapshotDate))
    .all();
}
